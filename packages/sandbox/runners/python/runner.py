#!/usr/bin/env python3
"""
LeetMind Python harness runner — CONTRACTS.md §6 / §7.

Stdlib-only, dependency-free driver that runs a user's `solution.py` against a bundle of tests
and emits the sentinel result protocol. Designed to be checked into
packages/sandbox/runners/python/ and copied verbatim (never regenerated) into every bundle
directory, so both the judge and the content-verification worker exercise exactly one
implementation of "run this Python solution against these tests".

Bundle layout (see docs/CONTRACTS.md §7), all read from --bundle (default /bundle):
    signature.json    {"name": str, "params": [{"name": str, "type": str}], "returns": str}
    tests.json        [{"args": [...], "expected"?: <json>}, ...] — `expected` is OMITTED
                       entirely (not `null`) for a `run` against `custom_input` (CONTRACTS §4.5):
                       there is nothing to grade against, so that test is reported
                       `status: "completed"` rather than `passed`/`failed`.
    comparator.json   {"kind": "exact"|"float_tol"|"unordered"|"checker_py", "tol"?: number}
    config.json       {"per_test_timeout_ms"?: number}          (optional; a default is used)
    solution.py        user's (or reference/mutant) code
    checker.py          optional, required when comparator.kind == "checker_py"

Protocol: arbitrary user output may appear first, then EXACTLY ONE sentinel line, then EXACTLY
ONE JSON object on stdout:

    <<<LEETMIND_RESULT>>>
    {"ok": true, "tests": [...]}

The host parses the LAST occurrence of the sentinel, so nothing this program does before that
final write can spoof it — but this program still goes out of its way to make sure nothing can
land on real stdout after it, by permanently blackholing sys.stdout right before emitting the
protocol (see `emit`).

Local usage for manual testing:
    python3 runner.py --bundle ./some_bundle_dir
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import io
import json
import re
import resource
import signal
import sys
import threading
import time
import traceback
import types
from pathlib import Path
from typing import Any, Callable, Optional

RESULT_SENTINEL = "<<<LEETMIND_RESULT>>>"

MAX_TEST_STDOUT_BYTES = 4 * 1024
MAX_OUTPUT_JSON_BYTES = 2 * 1024
DEFAULT_PER_TEST_TIMEOUT_MS = 5000
RECURSION_LIMIT = 20000
# Generous C stack for the worker thread each test runs in — raising sys.setrecursionlimit
# without more C stack just trades a clean RecursionError for a hard segfault on deep
# recursion (e.g. an unbalanced-BST-shaped tree walk at ~5000+ frames).
THREAD_STACK_SIZE = 256 * 1024 * 1024

FLOAT_TOL_ABS_DEFAULT = 1e-6
FLOAT_TOL_REL_DEFAULT = 1e-6

_PATH_SCRUB_RE = re.compile(r"/(?:bundle|work)/")


class TestTimeout(Exception):
    """Raised inside the SIGALRM handler when a test exceeds its per-test wall budget."""


class _NullWriter:
    """A stdout-shaped black hole. Used to permanently absorb output from any daemon thread
    that outlives its test's timeout, so it can never land on real stdout after we've already
    emitted the protocol result (or between tests, once we know a thread is unaccounted for)."""

    def write(self, s: str) -> int:
        return len(s) if s else 0

    def flush(self) -> None:
        return None


def scrub_paths(text: Optional[str]) -> Optional[str]:
    """Removes absolute in-container path prefixes from any text that might reach a client."""
    if text is None:
        return text
    return _PATH_SCRUB_RE.sub("", text)


def truncate_utf8(s: str, max_bytes: int, suffix: str = "...[truncated]") -> str:
    encoded = s.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return s
    return encoded[:max_bytes].decode("utf-8", errors="ignore") + suffix


def last_frame_summary(tb_text: str) -> str:
    """Reduces a full traceback string to its last source frame + the final exception line,
    path-scrubbed. Keeps error diagnostics useful without leaking the container's filesystem
    layout or the full call stack of the harness itself."""
    lines = [ln for ln in tb_text.strip().splitlines() if ln.strip()]
    if not lines:
        return "unknown error"
    last_line = lines[-1].strip()
    frame_line = next((ln.strip() for ln in reversed(lines[:-1]) if ln.strip().startswith("File ")), None)
    parts = [p for p in (frame_line, last_line) if p]
    return scrub_paths(" | ".join(parts)) or "unknown error"


# ---------------------------------------------------------------------------
# LeetCode-style structures, injected into the user's solution module before it runs so user
# code can reference TreeNode / ListNode without defining them itself.
# ---------------------------------------------------------------------------


class TreeNode:
    def __init__(self, val: Any = 0, left: "Optional[TreeNode]" = None, right: "Optional[TreeNode]" = None):
        self.val = val
        self.left = left
        self.right = right

    def __repr__(self) -> str:
        return f"TreeNode({self.val!r})"


class ListNode:
    def __init__(self, val: Any = 0, next: "Optional[ListNode]" = None):
        self.val = val
        self.next = next

    def __repr__(self) -> str:
        return f"ListNode({self.val!r})"


def decode_tree(encoded: Optional[list]) -> Optional[TreeNode]:
    """Decodes a LeetCode-style level-order array with null holes, e.g. [1,2,3,null,null,4,5]."""
    if not encoded:
        return None
    it = iter(encoded)
    root_val = next(it)
    if root_val is None:
        return None
    root = TreeNode(root_val)
    queue = [root]
    while queue:
        node = queue.pop(0)
        try:
            left_val = next(it)
        except StopIteration:
            break
        if left_val is not None:
            node.left = TreeNode(left_val)
            queue.append(node.left)
        try:
            right_val = next(it)
        except StopIteration:
            break
        if right_val is not None:
            node.right = TreeNode(right_val)
            queue.append(node.right)
    return root


def encode_tree(root: Optional[TreeNode]) -> list:
    """Encodes to the same LeetCode-style level-order array `decode_tree` reads, with trailing
    null holes trimmed (a node's children are only enqueued when the node itself is non-null,
    matching how LeetCode itself renders trees). A null/empty tree encodes to `[]`, matching
    packages/shared/src/treecodec.ts's `encodeTree` exactly — NOT JSON `null` — so a `TreeNode?`
    test's `expected: []` (authored via that same shared codec) compares equal to a solution
    that correctly returns an empty tree."""
    if root is None:
        return []
    out: list = []
    queue: list = [root]
    while queue:
        node = queue.pop(0)
        if node is None:
            out.append(None)
            continue
        out.append(node.val)
        queue.append(node.left)
        queue.append(node.right)
    while out and out[-1] is None:
        out.pop()
    return out


def decode_list(encoded: Optional[list]) -> Optional[ListNode]:
    if not encoded:
        return None
    head = ListNode(encoded[0])
    cur = head
    for v in encoded[1:]:
        cur.next = ListNode(v)
        cur = cur.next
    return head


def encode_list(head: Optional[ListNode]) -> list:
    out: list = []
    cur = head
    seen = 0
    while cur is not None:
        out.append(cur.val)
        cur = cur.next
        seen += 1
        if seen > 2_000_000:
            raise ValueError("linked list output is too long (possible cycle)")
    return out


# ---------------------------------------------------------------------------
# Type system (CONTRACTS §4.1 / packages/shared/src/types/signature.ts's ParamTypeAst):
#   int | float | bool | str | list[<ParamType>] (nested) | TreeNode[?] | ListNode[?]
# `?` is only ever valid on TreeNode/ListNode (never on scalars or list[...]) — mirrored here
# from shared's parseParamType so both languages parse (and, critically, encode) identically.
# `nullable` is carried as a flag on the tree/linkedlist descriptor itself, not as a separate
# wrapping "nullable" kind: decode_tree/encode_tree and decode_list/encode_list are already
# null-safe (see their docstrings for the `[]`-not-`null` convention on encode), so nullability
# doesn't change decode/encode behavior — it's descriptive, matching the shared AST shape.
# ---------------------------------------------------------------------------

_TREE_NODE_RE = re.compile(r"^TreeNode(\?)?$")
_LINKED_LIST_NODE_RE = re.compile(r"^ListNode(\?)?$")
_LIST_WRAPPER_RE = re.compile(r"^list\[(.*)\]$", re.S)


def parse_type(t: str) -> dict:
    if t in ("int", "float", "bool", "str"):
        return {"kind": "scalar", "name": t}
    m = _TREE_NODE_RE.match(t)
    if m:
        return {"kind": "tree", "nullable": m.group(1) == "?"}
    m = _LINKED_LIST_NODE_RE.match(t)
    if m:
        return {"kind": "linkedlist", "nullable": m.group(1) == "?"}
    m = _LIST_WRAPPER_RE.match(t)
    if m:
        return {"kind": "list", "of": parse_type(m.group(1))}
    raise ValueError(f"unknown ParamType: {t!r}")


def decode_value(value: Any, ptype: dict) -> Any:
    kind = ptype["kind"]
    if kind == "scalar":
        if value is None:
            return None
        name = ptype["name"]
        if name == "int":
            return int(value)
        if name == "float":
            return float(value)
        if name == "bool":
            return bool(value)
        return value  # str
    if kind == "list":
        if value is None:
            return None
        return [decode_value(v, ptype["of"]) for v in value]
    if kind == "tree":
        return decode_tree(value)
    if kind == "linkedlist":
        return decode_list(value)
    raise ValueError(f"cannot decode value for type descriptor {ptype!r}")


def encode_value(value: Any, ptype: dict) -> Any:
    kind = ptype["kind"]
    if kind == "scalar":
        return value
    if kind == "list":
        if value is None:
            return None
        return [encode_value(v, ptype["of"]) for v in value]
    if kind == "tree":
        return encode_tree(value)
    if kind == "linkedlist":
        return encode_list(value)
    raise ValueError(f"cannot encode value for type descriptor {ptype!r}")


# ---------------------------------------------------------------------------
# Comparators
# ---------------------------------------------------------------------------


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def exact_equal(a: Any, b: Any) -> bool:
    """Default equality: structural, with int/float normalized against each other (1 == 1.0)
    but bool never conflated with a plain number (True != 1) even though Python's native `==`
    would say otherwise."""
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        return all(exact_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return False
        return all(exact_equal(a[k], b[k]) for k in a)
    a_is_bool, b_is_bool = isinstance(a, bool), isinstance(b, bool)
    if a_is_bool != b_is_bool:
        return False
    return a == b


def float_tol_equal(a: Any, b: Any, tol_abs: float, tol_rel: float) -> bool:
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        return all(float_tol_equal(x, y, tol_abs, tol_rel) for x, y in zip(a, b))
    if _is_number(a) and _is_number(b):
        return abs(a - b) <= max(tol_abs, tol_rel * max(abs(a), abs(b)))
    return exact_equal(a, b)


def _canonical_key(x: Any) -> str:
    return json.dumps(x, sort_keys=True, separators=(",", ":"))


def _normalize_for_unordered(x: Any) -> Any:
    if isinstance(x, list):
        normalized = [_normalize_for_unordered(v) for v in x]
        normalized.sort(key=_canonical_key)
        return normalized
    return x


def unordered_equal(a: Any, b: Any) -> bool:
    """Multiset comparison; recursive for lists of lists (each nested list is itself treated as
    an unordered multiset before the outer comparison), sorted by canonical JSON key."""
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        norm_a = sorted((_canonical_key(_normalize_for_unordered(x)) for x in a))
        norm_b = sorted((_canonical_key(_normalize_for_unordered(x)) for x in b))
        return norm_a == norm_b
    return exact_equal(a, b)


def compare(
    output: Any,
    expected: Any,
    args: list,
    comparator: dict,
    checker_fn: Optional[Callable[..., Any]],
) -> tuple[bool, Optional[str]]:
    kind = comparator.get("kind", "exact")
    if kind == "exact":
        return exact_equal(output, expected), None
    if kind == "float_tol":
        tol = comparator.get("tol", FLOAT_TOL_ABS_DEFAULT)
        return float_tol_equal(output, expected, tol_abs=tol, tol_rel=tol), None
    if kind == "unordered":
        return unordered_equal(output, expected), None
    if kind == "checker_py":
        if checker_fn is None:
            raise RuntimeError("comparator is checker_py but no checker function was loaded")
        result = checker_fn(args, output, expected)
        if isinstance(result, tuple):
            ok = bool(result[0])
            detail = str(result[1]) if len(result) > 1 and result[1] is not None else None
            return ok, detail
        return bool(result), None
    raise ValueError(f"unknown comparator kind: {kind!r}")


# ---------------------------------------------------------------------------
# Solution loading
# ---------------------------------------------------------------------------


def load_solution_module(bundle_dir: Path) -> types.ModuleType:
    import importlib.util

    solution_path = bundle_dir / "solution.py"
    spec = importlib.util.spec_from_file_location("solution", solution_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load spec for {solution_path}")
    module = importlib.util.module_from_spec(spec)
    # Inject TreeNode/ListNode BEFORE executing user code so it can reference them directly,
    # exactly like LeetCode's own harness does.
    module.TreeNode = TreeNode  # type: ignore[attr-defined]
    module.ListNode = ListNode  # type: ignore[attr-defined]
    sys.modules["solution"] = module
    spec.loader.exec_module(module)
    return module


def resolve_callable(module: types.ModuleType, name: str) -> tuple[Optional[Callable[..., Any]], Optional[str]]:
    """Resolves the target callable: a module-level function named `name`, else a method of
    that name on a class named `Solution` (instantiated once). Returns (callable, None) on
    success, or (None, error_message) when nothing usable was found — never raises, so a
    missing function is a structured result, not a crash."""
    fn = getattr(module, name, None)
    if callable(fn) and not isinstance(fn, type):
        return fn, None

    cls = getattr(module, "Solution", None)
    if isinstance(cls, type):
        method = getattr(cls, name, None)
        if callable(method):
            try:
                instance = cls()
            except Exception as e:  # noqa: BLE001 - reported, not re-raised
                return None, f"failed to instantiate Solution(): {type(e).__name__}: {e}"
            bound = getattr(instance, name, None)
            if callable(bound):
                return bound, None

    return None, f"no callable named {name!r} found (checked module-level function and Solution.{name})"


# ---------------------------------------------------------------------------
# Per-test execution
# ---------------------------------------------------------------------------


def run_one_test(
    fn: Callable[..., Any],
    raw_args: list,
    param_types: list,
    return_type: dict,
    per_test_timeout_ms: int,
) -> dict:
    """Runs fn(*decoded_args) with a per-test wall budget, isolated stdout capture, and peak
    memory sampling. Never raises — every failure mode becomes a structured dict."""
    # Deep-copy before decode: tests are independent by construction, but this makes it
    # impossible for one test's decoded (and possibly solution-mutated) argument objects to
    # ever be aliased with another test's, regardless of how tests.json was produced upstream.
    try:
        args_copy = copy.deepcopy(raw_args)
        decoded_args = [decode_value(v, pt) for v, pt in zip(args_copy, param_types)]
    except Exception as e:  # noqa: BLE001
        return {
            "status": "error",
            "time_ms": 0.0,
            "memory_kb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "stdout": "",
            "error": f"failed to decode test arguments: {type(e).__name__}: {e}",
            "output": None,
        }

    result_box: dict = {}

    def target() -> None:
        try:
            result_box["value"] = fn(*decoded_args)
        except BaseException as e:  # noqa: BLE001 - captured for structured reporting, not swallowed
            result_box["exc"] = e
            result_box["tb"] = traceback.format_exc()

    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    old_handler = signal.getsignal(signal.SIGALRM)

    def alarm_handler(signum: int, frame: Any) -> None:
        raise TestTimeout()

    timed_out = False
    started = time.perf_counter()

    signal.signal(signal.SIGALRM, alarm_handler)
    thread = threading.Thread(target=target, daemon=True)
    try:
        signal.setitimer(signal.ITIMER_REAL, per_test_timeout_ms / 1000.0)
        try:
            with contextlib.redirect_stdout(stdout_capture), contextlib.redirect_stderr(stderr_capture):
                thread.start()
                # The join timeout is a fallback in case, for any reason, SIGALRM delivery is
                # delayed or missed; the primary timeout mechanism is the alarm itself
                # interrupting this join.
                thread.join(timeout=(per_test_timeout_ms / 1000.0) + 1.0)
        except TestTimeout:
            timed_out = True
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    # ru_maxrss is a whole-process high-water mark, not a true per-call delta (a documented
    # limitation of this measurement, per CONTRACTS §7) — reporting it right after each test
    # still gives a useful (monotonically non-decreasing) per-test peak signal.
    memory_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    stdout_text = stdout_capture.getvalue()
    if stdout_text:
        stdout_text = truncate_utf8(stdout_text, MAX_TEST_STDOUT_BYTES)

    if timed_out or thread.is_alive():
        return {
            "status": "timeout",
            "time_ms": round(elapsed_ms, 3),
            "memory_kb": memory_kb,
            "stdout": stdout_text,
            "error": "time limit exceeded",
            "output": None,
        }

    if "exc" in result_box:
        exc = result_box["exc"]
        error_message = f"{type(exc).__name__}: {last_frame_summary(result_box['tb'])}"
        return {
            "status": "error",
            "time_ms": round(elapsed_ms, 3),
            "memory_kb": memory_kb,
            "stdout": stdout_text,
            "error": scrub_paths(error_message),
            "output": None,
        }

    raw_value = result_box.get("value")
    try:
        encoded = encode_value(raw_value, return_type)
    except Exception as e:  # noqa: BLE001
        return {
            "status": "error",
            "time_ms": round(elapsed_ms, 3),
            "memory_kb": memory_kb,
            "stdout": stdout_text,
            "error": f"failed to encode return value: {type(e).__name__}: {e}",
            "output": None,
        }

    return {
        "status": "ok",
        "time_ms": round(elapsed_ms, 3),
        "memory_kb": memory_kb,
        "stdout": stdout_text,
        "error": None,
        "output": encoded,
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main(argv: Optional[list] = None) -> None:
    parser = argparse.ArgumentParser(description="LeetMind Python harness runner")
    parser.add_argument("--bundle", default="/bundle", help="bundle directory (default: /bundle)")
    args = parser.parse_args(argv)
    bundle_dir = Path(args.bundle)

    real_stdout = sys.stdout

    def emit(payload: dict) -> None:
        # Permanently blackhole sys.stdout before writing the protocol result. Any daemon
        # thread left over from a timed-out test that eventually gets scheduled and prints
        # something can no longer land on real stdout after this point, so it can never race
        # with (or follow, and thereby spoof) the sentinel we're about to write.
        sys.stdout = _NullWriter()
        body = json.dumps(payload, separators=(",", ":"))
        # `payload` can legitimately contain user-controlled text (captured per-test stdout,
        # exception messages) that itself happens to contain the literal sentinel string — e.g.
        # a solution that does `print(RESULT_SENTINEL)` or raises an exception with it in the
        # message. Once JSON-escaped into `body`, that text would still contain the *exact*
        # sentinel substring (JSON string escaping doesn't touch plain ASCII like `<`/`>`),
        # which would break the host's "last occurrence wins" parse: it would find this
        # embedded copy — sitting later in the byte stream, inside our own real result — instead
        # of the genuine sentinel line below, and fail to parse the remainder as JSON. Redact
        # every occurrence of the sentinel out of the payload text itself so the line written
        # immediately below is guaranteed to be the only true occurrence in the whole stream.
        body = body.replace(RESULT_SENTINEL, "<<<LEETMIND_RESULT (redacted, embedded in output)>>>")
        real_stdout.write(RESULT_SENTINEL + "\n")
        real_stdout.write(body + "\n")
        real_stdout.flush()

    try:
        sys.setrecursionlimit(RECURSION_LIMIT)
        threading.stack_size(THREAD_STACK_SIZE)
    except (ValueError, RuntimeError):
        # Some platforms reject certain stack sizes; fall back to the interpreter default
        # rather than crashing the whole harness over it.
        pass

    try:
        _run(bundle_dir, emit)
    except Exception as e:  # noqa: BLE001 - last-resort guard so a harness bug still yields a
        # structured (if generic) sentinel result instead of a bare traceback with no result at
        # all.
        emit(
            {
                "ok": False,
                "error_kind": "harness_error",
                "error": scrub_paths(f"internal harness error: {type(e).__name__}: {e}"),
                "tests": [],
            }
        )


def _run(bundle_dir: Path, emit: Callable[[dict], None]) -> None:
    try:
        signature = json.loads((bundle_dir / "signature.json").read_text())
        tests = json.loads((bundle_dir / "tests.json").read_text())
        comparator = json.loads((bundle_dir / "comparator.json").read_text())
        config_path = bundle_dir / "config.json"
        config = json.loads(config_path.read_text()) if config_path.exists() else {}
    except Exception as e:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error_kind": "bundle_error",
                "error": f"failed to read bundle: {type(e).__name__}: {e}",
                "tests": [],
            }
        )
        return

    per_test_timeout_ms = config.get("per_test_timeout_ms", DEFAULT_PER_TEST_TIMEOUT_MS)

    try:
        param_types = [parse_type(p["type"]) for p in signature["params"]]
        return_type = parse_type(signature["returns"])
    except Exception as e:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error_kind": "bundle_error",
                "error": f"invalid signature: {type(e).__name__}: {e}",
                "tests": [],
            }
        )
        return

    fn_name = signature["name"]

    try:
        module = load_solution_module(bundle_dir)
    except SyntaxError as e:
        emit(
            {
                "ok": False,
                "error_kind": "syntax_error",
                "error": scrub_paths(f"SyntaxError: {e}"),
                "tests": [],
            }
        )
        return
    except Exception as e:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error_kind": "import_error",
                "error": scrub_paths(last_frame_summary(traceback.format_exc()) or f"{type(e).__name__}: {e}"),
                "tests": [],
            }
        )
        return

    fn, resolve_err = resolve_callable(module, fn_name)
    if fn is None:
        emit({"ok": False, "error_kind": "missing_function", "error": resolve_err, "tests": []})
        return

    checker_fn: Optional[Callable[..., Any]] = None
    if comparator.get("kind") == "checker_py":
        try:
            import importlib.util

            checker_path = bundle_dir / "checker.py"
            spec = importlib.util.spec_from_file_location("checker", checker_path)
            if spec is None or spec.loader is None:
                raise ImportError(f"could not load spec for {checker_path}")
            checker_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(checker_module)
            checker_fn = getattr(checker_module, "check", None)
            if checker_fn is None:
                emit(
                    {
                        "ok": False,
                        "error_kind": "checker_error",
                        "error": "checker.py has no top-level 'check' function",
                        "tests": [],
                    }
                )
                return
        except Exception as e:  # noqa: BLE001
            emit(
                {
                    "ok": False,
                    "error_kind": "checker_error",
                    "error": scrub_paths(f"failed to load checker.py: {type(e).__name__}: {e}"),
                    "tests": [],
                }
            )
            return

    results = []
    for idx, test in enumerate(tests):
        test_args = test.get("args", [])
        # CONTRACTS §4.5: a `run` against `custom_input` has no expected value to grade against.
        # Presence of the key — not its value — is what signals that: `expected: null` is a
        # legitimate (possibly correct) expected value, distinct from "no expected value at all".
        has_expected = "expected" in test
        expected = test.get("expected")

        outcome = run_one_test(fn, test_args, param_types, return_type, per_test_timeout_ms)

        if outcome["status"] == "ok":
            if not has_expected:
                # Nothing to grade against — report the run as `completed`, never `passed`/`failed`.
                outcome["status"] = "completed"
            else:
                try:
                    is_pass, _detail = compare(outcome["output"], expected, test_args, comparator, checker_fn)
                    outcome["status"] = "passed" if is_pass else "failed"
                except Exception as e:  # noqa: BLE001
                    outcome["status"] = "error"
                    outcome["error"] = scrub_paths(f"comparator failed: {type(e).__name__}: {e}")

        public = {
            "index": idx,
            "status": outcome["status"],
            "time_ms": outcome["time_ms"],
            "memory_kb": outcome["memory_kb"],
        }
        if outcome.get("stdout"):
            public["stdout"] = outcome["stdout"]
        if outcome.get("error"):
            public["error"] = outcome["error"]
        if outcome["status"] in ("passed", "failed", "completed"):
            # `expected` is NEVER emitted — only the actual (truncated) output, per CONTRACTS §6.
            out_json = json.dumps(outcome.get("output"))
            if len(out_json.encode("utf-8")) > MAX_OUTPUT_JSON_BYTES:
                public["output"] = None
                public["output_truncated"] = True
            else:
                public["output"] = outcome.get("output")

        results.append(public)

    emit({"ok": True, "tests": results})


if __name__ == "__main__":
    main()
