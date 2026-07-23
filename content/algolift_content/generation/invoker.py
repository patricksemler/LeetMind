"""Model invokers (docs/CONTRACTS.md §11): the `Invoker` protocol and its three implementations,
selected by `GENERATOR_INVOKER` via `get_invoker()`.

`ClaudeInvoker` shells out to the host's authenticated `claude` CLI via argv-array `subprocess.run`
(NEVER `shell=True` — CONTRACTS.md §11 is explicit about this). `CodexInvoker` is a documented
`NotImplementedError` stub wired into the factory (decision #3: the invoker is pluggable
specifically so `codex exec` can be swapped in later via config, without touching any other
generation code). `StubInvoker` is a deterministic, offline, no-subprocess implementation required
for tests and CI (which has no model access) — it returns a genuinely valid, gate-shaped
`ProblemVersion` built from a small internal template library.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from algolift_content.config import Settings, get_settings
from algolift_content.generation.envelope import render_envelope
from algolift_content.generation.prompts.v1 import REQUEST_JSON_BEGIN, REQUEST_JSON_END
from algolift_content.logging import get_logger

log = get_logger("content-generation-invoker")


class InvokerError(RuntimeError):
    """Raised for invoker-level *infrastructure* failures: missing/unauthenticated binary,
    process timeout, non-zero exit with no parseable envelope, or the target invoker being
    unimplemented (`CodexInvoker`). Distinct from a schema failure in the model's *content*
    (a successful invocation whose text just doesn't parse as a `ProblemVersion`), which the
    caller (`algolift_content.generation.generator`) handles via the schema-retry path, not this
    exception. `algolift_content.generation.handler.handle_generate` lets this class of error
    propagate so the job queue retries — see that module's docstring."""


@dataclass
class InvokeResult:
    """One model invocation's result — text plus whatever usage/cost metadata the invoker could
    recover, feeding directly into a `model_runs` row (CONTRACTS.md §3)."""

    text: str
    model: str | None
    #: TOTAL prompt tokens actually consumed: uncached `input_tokens` PLUS
    #: `cache_creation_input_tokens` PLUS `cache_read_input_tokens` (see `ClaudeInvoker`'s
    #: docstring — a real call showed `input_tokens=2` against ~25k cached tokens; recording
    #: `input_tokens` alone would silently under-count by however much of the prompt was cached).
    #: `None` only when the invoker could recover no usage information at all.
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    duration_ms: int
    #: Prompt tokens newly written to the cache this call (billed at ~1.25x normal input price).
    cache_creation_input_tokens: int | None = None
    #: Prompt tokens served FROM the cache this call (billed at ~0.1x normal input price).
    cache_read_input_tokens: int | None = None
    #: The envelope's raw `usage` object, verbatim, for full fidelity beyond the four fields
    #: broken out above (e.g. `iterations`, `service_tier`). Persisted by `generator.py` into
    #: `model_runs.request.usage` (that table has no dedicated usage column).
    usage: dict[str, Any] | None = None
    #: The envelope's raw `modelUsage` map, verbatim — a single `claude -p` call can involve MORE
    #: THAN ONE model (observed: a haiku sub-call plus the actual generating model), so `model`
    #: above is a best-effort single attribution (the entry with the most output tokens), and this
    #: field is the full picture. Persisted into `model_runs.request.model_usage`.
    model_usage: dict[str, Any] | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class Invoker(Protocol):
    def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult: ...


# ---------------------------------------------------------------------------
# ClaudeInvoker
# ---------------------------------------------------------------------------

_AUTH_FAILURE_MARKERS = ("not logged in", "unauthenticated", "please run", "authentication")


def _select_generation_model(model_usage: dict[str, Any]) -> str | None:
    """A single `claude -p` invocation can involve MORE THAN ONE model — observed on a real call:
    `modelUsage` held both `claude-haiku-4-5-20251001` (a cheap sub-call, e.g. for a title/routing
    step) and `claude-opus-4-8[1m]` (the model that did the actual generation work). Naively
    recording `next(iter(model_usage))` picks whichever key happens to sort/insert first, which is
    not necessarily the model that generated the content. Instead, attribute `model_runs.model` to
    whichever entry has the LARGEST output-token count — the model that did the most writing is
    the one that generated the problem. Ties keep the first-encountered entry. Returns `None` for
    an empty map."""
    if not model_usage:
        return None

    def _output_tokens(entry: Any) -> int:
        if not isinstance(entry, dict):
            return 0
        for key in ("outputTokens", "output_tokens"):
            value = entry.get(key)
            if isinstance(value, int):
                return value
        return 0

    return max(model_usage.keys(), key=lambda name: _output_tokens(model_usage[name]))


class ClaudeInvoker:
    """`claude -p <prompt> --output-format json`, via argv-array `subprocess.run` — never
    `shell=True` (the prompt is untrusted-length free text; shell interpolation of it would be a
    command-injection footgun even against ourselves).

    The `--output-format json` envelope (observed shape, Claude Code CLI, from a real generation
    call): a single JSON object on stdout with (at least) `result` (the assistant's final text),
    `is_error`, `duration_ms`, `total_cost_usd`, `modelUsage: {<model name>: {...}}` (CAN have more
    than one key — see `_select_generation_model`), and `usage`, which has MORE fields than just
    `input_tokens`/`output_tokens`:

        usage.input_tokens                    — UNCACHED prompt tokens only, NOT the total
        usage.cache_creation_input_tokens      — prompt tokens newly written to cache (~1.25x price)
        usage.cache_read_input_tokens          — prompt tokens served from cache (~0.1x price)
        usage.output_tokens
        usage.cache_creation, .iterations, .server_tool_use, .service_tier, .speed, .inference_geo

    A real call showed `input_tokens=2` (!) against `cache_creation_input_tokens=6236` and
    `cache_read_input_tokens=18689` on a ~2712-output-token turn — reading `usage.input_tokens`
    alone would have under-counted the prompt by ~25000 tokens. `InvokeResult.input_tokens` is
    therefore the SUM of all three input-token components (see `_parse_envelope`), and
    `InvokeResult.cost_usd` always prefers the envelope's own `total_cost_usd` over any
    self-computed figure. This shape is NOT contractually stable across CLI versions, so parsing
    is defensive throughout: any structural surprise falls back to treating raw stdout as the
    result text and logs a warning, rather than raising — a shape change should degrade prompt
    parsing (handled by the normal schema-retry path one layer up), not take down the invoker.
    """

    def __init__(
        self,
        *,
        claude_bin: str | None = None,
        model: str | None = None,
        settings: Settings | None = None,
    ) -> None:
        s = settings or get_settings()
        self.claude_bin = claude_bin or s.CLAUDE_BIN
        #: `None` ⇒ no `--model` flag at all, i.e. whatever the CLI defaults to. This is a
        #: deliberate, RECORDED choice, not an accident — the last real generation run silently
        #: used `claude-haiku-4-5-20251001` because nothing pinned it, and generation quality is
        #: the product's ceiling (PLAN.md §12 risk 1). Set `GENERATOR_MODEL` to control it.
        self.model = model if model is not None else s.GENERATOR_MODEL

    def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult:
        resolved_bin = self.claude_bin
        if shutil.which(resolved_bin) is None:
            raise InvokerError(
                f"claude CLI not found on PATH ({resolved_bin!r}). Set CLAUDE_BIN to its full "
                "path, or install/authenticate the Claude Code CLI "
                "(https://docs.claude.com/claude-code)."
            )

        argv = [resolved_bin, "-p", prompt, "--output-format", "json"]
        if self.model:
            argv.extend(["--model", self.model])
        start = time.monotonic()
        try:
            proc = subprocess.run(  # noqa: S603 - argv array, no shell, per CONTRACTS.md §11
                argv,
                capture_output=True,
                text=True,
                timeout=max(1.0, timeout_ms / 1000.0),
            )
        except subprocess.TimeoutExpired as exc:
            raise InvokerError(
                f"claude CLI did not return within GENERATOR_TIMEOUT_MS={timeout_ms}ms"
            ) from exc
        except FileNotFoundError as exc:
            raise InvokerError(
                f"failed to launch claude CLI ({resolved_bin!r} not found on PATH): {exc}"
            ) from exc
        fallback_duration_ms = int((time.monotonic() - start) * 1000)

        if proc.returncode != 0:
            stderr_tail = (proc.stderr or "")[-2000:]
            lowered = stderr_tail.lower()
            if any(marker in lowered for marker in _AUTH_FAILURE_MARKERS):
                raise InvokerError(f"claude CLI appears unauthenticated: {stderr_tail}")
            raise InvokerError(
                f"claude CLI exited {proc.returncode}: stderr_tail={stderr_tail!r}"
            )

        return self._parse_envelope(proc.stdout, fallback_duration_ms)

    @staticmethod
    def _parse_envelope(stdout: str, fallback_duration_ms: int) -> InvokeResult:
        stripped = stdout.strip()
        try:
            envelope = json.loads(stripped)
        except json.JSONDecodeError:
            log.warning(
                "claude CLI stdout was not valid JSON; falling back to raw stdout as result text",
                stdout_tail=stripped[-500:],
            )
            return InvokeResult(
                text=stdout,
                model=None,
                input_tokens=None,
                output_tokens=None,
                cost_usd=None,
                duration_ms=fallback_duration_ms,
                raw={"_parse_fallback": "non_json_stdout"},
            )

        if not isinstance(envelope, dict):
            log.warning(
                "claude CLI JSON envelope was not an object; falling back to raw stdout as "
                "result text",
                envelope_type=type(envelope).__name__,
            )
            return InvokeResult(
                text=stdout,
                model=None,
                input_tokens=None,
                output_tokens=None,
                cost_usd=None,
                duration_ms=fallback_duration_ms,
                raw={"_parse_fallback": "non_object_envelope"},
            )

        if envelope.get("is_error"):
            raise InvokerError(
                f"claude CLI reported an error result: {envelope.get('result') or envelope}"
            )

        text = envelope.get("result")
        if not isinstance(text, str):
            log.warning(
                "claude CLI envelope missing a string 'result' field; falling back to raw "
                "stdout as result text",
                envelope_keys=list(envelope.keys()),
            )
            text = stdout

        usage = envelope.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        model_usage = envelope.get("modelUsage")
        model_usage = model_usage if isinstance(model_usage, dict) else {}
        model = _select_generation_model(model_usage) or envelope.get("model")

        def _as_int(value: Any) -> int | None:
            return value if isinstance(value, int) else None

        # A real call showed `usage.input_tokens` reporting only the UNCACHED remainder of the
        # prompt (`input_tokens=2`) while `cache_creation_input_tokens=6236` and
        # `cache_read_input_tokens=18689` accounted for the other ~99.99% of the ~2712-output-
        # token turn's prompt. `input_tokens` alone is not "the input token count" — it's one of
        # three components that must be summed to get it.
        uncached_input_tokens = _as_int(usage.get("input_tokens"))
        cache_creation_input_tokens = _as_int(usage.get("cache_creation_input_tokens"))
        cache_read_input_tokens = _as_int(usage.get("cache_read_input_tokens"))
        output_tokens = _as_int(usage.get("output_tokens"))

        token_components = (
            uncached_input_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        )
        total_input_tokens = (
            None
            if all(t is None for t in token_components)
            else sum(t or 0 for t in token_components)
        )

        # Prefer the envelope's own total_cost_usd over computing anything ourselves — it already
        # accounts for cache-write (~1.25x) and cache-read (~0.1x) pricing correctly.
        cost_usd = envelope.get("total_cost_usd")
        cost_usd = float(cost_usd) if isinstance(cost_usd, int | float) else None

        env_duration_ms = envelope.get("duration_ms")
        duration_ms = env_duration_ms if isinstance(env_duration_ms, int) else fallback_duration_ms

        return InvokeResult(
            text=text,
            model=model,
            input_tokens=total_input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            duration_ms=duration_ms,
            cache_creation_input_tokens=cache_creation_input_tokens,
            cache_read_input_tokens=cache_read_input_tokens,
            usage=usage or None,
            model_usage=model_usage or None,
            raw=envelope,
        )


# ---------------------------------------------------------------------------
# CodexInvoker — wired into the factory, deliberately unimplemented (decision #3)
# ---------------------------------------------------------------------------


class CodexInvoker:
    """Not implemented. Wired into `get_invoker()` so switching `GENERATOR_INVOKER=codex` is a
    one-line config change once this lands (decision #3: the invoker is pluggable specifically
    so `codex exec` can be swapped in for `claude -p` without touching prompt building, the
    schema-retry loop, or persistence — see PLAN.md §6 backlog and CONTRACTS.md §11)."""

    def __init__(self, *, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult:
        raise NotImplementedError(
            "CodexInvoker ('codex exec' as an alternate generator, decision #3 / PLAN.md §6 "
            "backlog) is not implemented yet. Set GENERATOR_INVOKER=claude or "
            "GENERATOR_INVOKER=stub instead."
        )


# ---------------------------------------------------------------------------
# StubInvoker — required, deterministic, offline
# ---------------------------------------------------------------------------

_REQUEST_BLOCK_RE = re.compile(
    re.escape(REQUEST_JSON_BEGIN) + r"\n(.*?)\n" + re.escape(REQUEST_JSON_END), re.DOTALL
)

_DEFAULT_TEMPLATE_KEY = "sliding_window"


def _sliding_window_core() -> dict[str, Any]:
    """The "maximum sum of a length-k subarray" template — deliberately the same problem as
    `tests/fixtures/sample_problem.json`, a fixture that was hand-verified against exactly the
    kind of checks the six-stage gate performs (a genuinely optimal reference, an independent
    O(n*k) brute force, a generator whose outputs always satisfy the stated constraints, and
    mutants that are wrong but plausible). This is the template `StubInvoker` falls back to for
    any concept it doesn't have a dedicated template for."""
    return {
        "title": "Maximum Sum of a Length-K Subarray",
        "internal_name": "max_sum_length_k_subarray",
        "statement_md": (
            "Given an array of integers `nums` and an integer `k`, find the maximum possible "
            "sum of any `k` consecutive elements of `nums`.\n\nReturn that maximum sum as an "
            "integer."
        ),
        "constraints_md": "- `1 <= k <= len(nums) <= 50`\n- `-100 <= nums[i] <= 100`",
        "signature": {
            "name": "maxSumSubarray",
            "params": [{"name": "nums", "type": "list[int]"}, {"name": "k", "type": "int"}],
            "returns": "int",
        },
        "examples": [
            {
                "args": [[2, 1, 5, 1, 3, 2], 3],
                "expected": 9,
                "explanation": (
                    "The 3 consecutive elements [5, 1, 3] sum to 9, the largest sum of any 3 "
                    "consecutive elements."
                ),
            },
            {
                "args": [[2, 3, 4, 1, 5], 2],
                "expected": 7,
                "explanation": "The 2 consecutive elements [3, 4] sum to 7, the largest such pair.",
            },
        ],
        "target_complexity": {"time": "O(n)", "space": "O(1)"},
        "reference_solution_py": (
            "def maxSumSubarray(nums, k):\n"
            "    n = len(nums)\n"
            "    if k <= 0 or k > n:\n"
            "        raise ValueError(\"invalid k\")\n"
            "    window_sum = sum(nums[:k])\n"
            "    best = window_sum\n"
            "    for i in range(k, n):\n"
            "        window_sum += nums[i] - nums[i - k]\n"
            "        if window_sum > best:\n"
            "            best = window_sum\n"
            "    return best\n"
        ),
        "brute_force_py": (
            "def maxSumSubarray(nums, k):\n"
            "    n = len(nums)\n"
            "    if k <= 0 or k > n:\n"
            "        raise ValueError(\"invalid k\")\n"
            "    best = None\n"
            "    for i in range(n - k + 1):\n"
            "        s = sum(nums[i:i + k])\n"
            "        if best is None or s > best:\n"
            "            best = s\n"
            "    return best\n"
        ),
        "input_generator_py": (
            "def generate(rng):\n"
            "    n = rng.randint(1, 50)\n"
            "    k = rng.randint(1, n)\n"
            "    nums = [rng.randint(-100, 100) for _ in range(n)]\n"
            "    return [nums, k]\n"
        ),
        "comparator": "exact",
        "mutants_py": [
            (
                "def maxSumSubarray(nums, k):\n"
                "    n = len(nums)\n"
                "    if k <= 0 or k > n:\n"
                "        raise ValueError(\"invalid k\")\n"
                "    window_sum = sum(nums[:k])\n"
                "    best = window_sum\n"
                "    for i in range(k, n):\n"
                "        window_sum += nums[i]\n"
                "        if window_sum > best:\n"
                "            best = window_sum\n"
                "    return best\n"
            ),
            (
                "def maxSumSubarray(nums, k):\n"
                "    n = len(nums)\n"
                "    if k <= 0 or k > n:\n"
                "        raise ValueError(\"invalid k\")\n"
                "    window_sum = sum(nums[:k])\n"
                "    best = window_sum\n"
                "    for i in range(k, n):\n"
                "        window_sum += nums[i] - nums[i - k]\n"
                "        if window_sum < best:\n"
                "            best = window_sum\n"
                "    return best\n"
            ),
            (
                "def maxSumSubarray(nums, k):\n"
                "    n = len(nums)\n"
                "    if k <= 0 or k > n:\n"
                "        raise ValueError(\"invalid k\")\n"
                "    window_sum = sum(nums[:k])\n"
                "    best = window_sum\n"
                "    for i in range(k, n - 1):\n"
                "        window_sum += nums[i] - nums[i - k]\n"
                "        if window_sum > best:\n"
                "            best = window_sum\n"
                "    return best\n"
            ),
        ],
        "hints": {
            "l1_orientation": (
                "Think about which contiguous stretches of the array are even worth comparing, "
                "and whether recomputing each one's total from scratch every time is necessary."
            ),
            "l2_conceptual": (
                "As you move from one stretch of k elements to the next one over, only two "
                "elements actually change your running total: the one that's no longer "
                "included, and the one that's newly included."
            ),
            "l3_structural": (
                "Maintain a running total for a block of k elements. Start with the total of "
                "the first block, then repeatedly drop the value leaving on the left and add "
                "the value entering on the right, keeping track of the best total seen so far."
            ),
            "outline": (
                "1) Compute the sum of the first k elements and set it as both the running "
                "total and the best-so-far value.\n"
                "2) For each following starting position, update the running total by "
                "subtracting the element that just left the block and adding the element that "
                "just entered it.\n"
                "3) After each update, compare the running total to the best-so-far value and "
                "keep the larger one.\n"
                "4) Return the best-so-far value once every position has been considered."
            ),
            "editorial_md": (
                "## Approach\n\nEvery block of `k` consecutive elements overlaps its neighbor "
                "in `k - 1` positions. Recomputing each block's sum from scratch costs O(k) per "
                "block and O(n*k) overall. Instead, maintain one running total and update it in "
                "O(1) as the block shifts one position to the right: subtract the element that "
                "fell out of the block on the left, and add the element that entered on the "
                "right.\n\n## Complexity\n\n- Time: O(n) — a single pass over the array after "
                "the initial block sum.\n- Space: O(1) — only the running total and the "
                "best-so-far value are kept."
            ),
        },
        "_default_concepts": [
            {"id": "sliding_window", "role": "primary", "weight": 0.7},
            {"id": "arrays_hashing", "role": "secondary", "weight": 0.3},
        ],
    }


def _arrays_hashing_core() -> dict[str, Any]:
    """"Count pairs summing to a target" — a second, independently-authored template so the
    stub isn't a single point of coverage. Reference uses a running frequency count (checking
    the complement BEFORE recording the current value, so a value never pairs with itself);
    brute force is the straightforward independent O(n^2) nested-loop count."""
    return {
        "title": "Count Pairs Summing to a Target",
        "internal_name": "count_pairs_with_target_sum",
        "statement_md": (
            "Given an array of integers `nums` and an integer `target`, return the number of "
            "pairs of indices `(i, j)` with `i < j` such that `nums[i] + nums[j] == target`."
        ),
        "constraints_md": (
            "- `0 <= len(nums) <= 40`\n- `-50 <= nums[i] <= 50`\n- `-100 <= target <= 100`"
        ),
        "signature": {
            "name": "countPairsWithSum",
            "params": [{"name": "nums", "type": "list[int]"}, {"name": "target", "type": "int"}],
            "returns": "int",
        },
        "examples": [
            {
                "args": [[2, 7, 11, 15], 9],
                "expected": 1,
                "explanation": "Only the pair (2, 7) sums to 9.",
            },
            {
                "args": [[1, 1, 1], 2],
                "expected": 3,
                "explanation": (
                    "Every pair of indices among the three 1's sums to 2, giving 3 total pairs."
                ),
            },
        ],
        "target_complexity": {"time": "O(n)", "space": "O(n)"},
        "reference_solution_py": (
            "def countPairsWithSum(nums, target):\n"
            "    seen = {}\n"
            "    count = 0\n"
            "    for x in nums:\n"
            "        complement = target - x\n"
            "        if complement in seen:\n"
            "            count += seen[complement]\n"
            "        seen[x] = seen.get(x, 0) + 1\n"
            "    return count\n"
        ),
        "brute_force_py": (
            "def countPairsWithSum(nums, target):\n"
            "    n = len(nums)\n"
            "    count = 0\n"
            "    for i in range(n):\n"
            "        for j in range(i + 1, n):\n"
            "            if nums[i] + nums[j] == target:\n"
            "                count += 1\n"
            "    return count\n"
        ),
        "input_generator_py": (
            "def generate(rng):\n"
            "    n = rng.randint(0, 40)\n"
            "    nums = [rng.randint(-50, 50) for _ in range(n)]\n"
            "    target = rng.randint(-100, 100)\n"
            "    return [nums, target]\n"
        ),
        "comparator": "exact",
        "mutants_py": [
            (
                "def countPairsWithSum(nums, target):\n"
                "    seen = {}\n"
                "    count = 0\n"
                "    for x in nums:\n"
                "        seen[x] = seen.get(x, 0) + 1\n"
                "        complement = target - x\n"
                "        if complement in seen:\n"
                "            count += seen[complement]\n"
                "    return count\n"
            ),
            (
                "def countPairsWithSum(nums, target):\n"
                "    seen = set()\n"
                "    count = 0\n"
                "    for x in nums:\n"
                "        complement = target - x\n"
                "        if complement in seen:\n"
                "            count += 1\n"
                "        seen.add(x)\n"
                "    return count\n"
            ),
            (
                "def countPairsWithSum(nums, target):\n"
                "    seen = {}\n"
                "    count = 0\n"
                "    for x in (nums[:-1] if nums else nums):\n"
                "        complement = target - x\n"
                "        if complement in seen:\n"
                "            count += seen[complement]\n"
                "        seen[x] = seen.get(x, 0) + 1\n"
                "    return count\n"
            ),
            (
                "def countPairsWithSum(nums, target):\n"
                "    seen = {}\n"
                "    count = 0\n"
                "    for x in nums:\n"
                "        complement = target + x\n"
                "        if complement in seen:\n"
                "            count += seen[complement]\n"
                "        seen[x] = seen.get(x, 0) + 1\n"
                "    return count\n"
            ),
        ],
        "hints": {
            "l1_orientation": (
                "For each number, think about what other single number would complete a valid "
                "pair with it, and whether that value has already shown up earlier."
            ),
            "l2_conceptual": (
                "Instead of comparing every number against every other number, keep a running "
                "record of how many times each value has appeared so far, and use it to answer "
                "'has the number I need already shown up?' instantly."
            ),
            "l3_structural": (
                "Walk through the numbers once. At each number, look up how many times its "
                "complement (target minus the current number) has already appeared, add that "
                "many to a running count, and only then record the current number as having "
                "been seen."
            ),
            "outline": (
                "1) Initialize an empty running record of counts and a running total of "
                "matching pairs.\n"
                "2) For each number in the list, compute the value that would complete a pair "
                "with it.\n"
                "3) Add however many times that completing value has already appeared to the "
                "running total.\n"
                "4) Record the current number in the running record, then continue to the next "
                "number.\n"
                "5) Return the running total once every number has been processed."
            ),
            "editorial_md": (
                "## Approach\n\nMaintain a running frequency count of values seen so far. For "
                "each new value `x`, every occurrence of `target - x` seen before it forms a "
                "valid pair — add the current frequency of `target - x` to the running total, "
                "then record `x` itself (recording AFTER checking, so a value is never paired "
                "with itself when `target == 2 * x`).\n\n## Complexity\n\n- Time: O(n) — a "
                "single pass.\n- Space: O(n) — the frequency record, worst case one entry per "
                "distinct value."
            ),
        },
        "_default_concepts": [{"id": "arrays_hashing", "role": "primary", "weight": 1.0}],
    }


_TEMPLATES: dict[str, Any] = {
    "sliding_window": _sliding_window_core,
    "arrays_hashing": _arrays_hashing_core,
}


def _extract_request_dict(prompt: str) -> dict[str, Any]:
    match = _REQUEST_BLOCK_RE.search(prompt)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _primary_concept_id(request_dict: dict[str, Any]) -> str | None:
    concepts = request_dict.get("concepts")
    if isinstance(concepts, list) and concepts:
        first = concepts[0]
        if isinstance(first, dict) and isinstance(first.get("id"), str):
            return first["id"]
    return None


def _concepts_from_request(
    request_dict: dict[str, Any], default_concepts: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    raw = request_dict.get("concepts")
    if not isinstance(raw, list) or not raw:
        return default_concepts
    entries: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        weight = item.get("weight")
        resolved_weight = float(weight) if isinstance(weight, int | float) else 0.0
        entries.append({"id": item["id"], "weight": resolved_weight})
    if not entries:
        return default_concepts
    total = sum(e["weight"] for e in entries)
    if total <= 0:
        # No usable weights given — split evenly rather than divide by zero.
        even = 1.0 / len(entries)
        for e in entries:
            e["weight"] = even
        total = 1.0
    result = [
        {
            "id": e["id"],
            "role": "primary" if i == 0 else "secondary",
            "weight": e["weight"] / total,
        }
        for i, e in enumerate(entries)
    ]
    # Rounding can leave the sum a hair off 1.0 (ProblemVersion requires within +-0.01); correct
    # on the primary entry, which always exists.
    drift = 1.0 - sum(r["weight"] for r in result)
    result[0]["weight"] += drift
    return result


def _minutes_from_request(request_dict: dict[str, Any]) -> tuple[int, int]:
    raw = request_dict.get("expected_minutes")
    if isinstance(raw, list | tuple) and len(raw) == 2:
        try:
            low, high = int(raw[0]), int(raw[1])
        except (TypeError, ValueError):
            low, high = 0, 0
        if low > 0 and high >= low:
            return (low, high)
    return (8, 20)


def _rating_from_request(request_dict: dict[str, Any]) -> int:
    raw = request_dict.get("target_rating")
    try:
        rating = int(round(float(raw)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        rating = 1200
    return max(600, min(3000, rating))


class StubInvoker:
    """Deterministic, offline `Invoker` — **required** since CI and most local dev have no model
    access. Extracts the `GenerationRequest` JSON embedded in the prompt (see
    `algolift_content.generation.prompts.v1`'s module docstring for the delimiter contract, which
    `prompts.v2` reuses verbatim so this extraction is prompt-version-agnostic), picks a template
    from `_TEMPLATES` keyed by the request's primary concept id (falling back to
    `_DEFAULT_TEMPLATE_KEY` for any concept without a dedicated template), and returns a complete,
    genuinely-correct `ProblemVersion` encoded as ALGOLIFT envelope text (`render_envelope`) — NOT
    JSON. This is deliberate: a stub that returned JSON would bypass `parse_envelope` entirely and
    exercise nothing about the real wire format `generator.py` now depends on.

    "Deterministic" here means the CONTENT is fully determined by the request (same concept/
    rating/minutes in -> same problem shape out, no network, no model variance). `problem_id` is
    not part of the envelope at all (see `envelope`'s module docstring) — `parse_envelope` always
    synthesizes `"new"`, and `generator._persist_candidate` always overwrites it with a fresh
    ULID regardless of what any invoker returns, real or stub.
    """

    def __init__(self, *, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult:
        start = time.monotonic()
        request_dict = _extract_request_dict(prompt)
        concept_id = _primary_concept_id(request_dict)
        template_fn = _TEMPLATES.get(concept_id or "", _TEMPLATES[_DEFAULT_TEMPLATE_KEY])
        core = template_fn()

        problem = {
            "title": core["title"],
            "internal_name": core["internal_name"],
            "statement_md": core["statement_md"],
            "constraints_md": core["constraints_md"],
            "signature": core["signature"],
            "examples": core["examples"],
            "concepts": _concepts_from_request(request_dict, core["_default_concepts"]),
            "difficulty": {"rating": _rating_from_request(request_dict), "confidence": "generated"},
            "expected_active_minutes": list(_minutes_from_request(request_dict)),
            "target_complexity": core["target_complexity"],
            "reference_solution_py": core["reference_solution_py"],
            "brute_force_py": core["brute_force_py"],
            "input_generator_py": core["input_generator_py"],
            "comparator": core["comparator"],
            "checker_py": None,
            "mutants_py": core["mutants_py"],
            "hints": core["hints"],
            "provenance": {
                "mode": "template",
                "model": "stub-v1",
                "prompt_version": request_dict.get("prompt_version") or "v2",
                "generated_at": datetime.now(UTC).isoformat(),
            },
        }
        text = render_envelope(problem)
        duration_ms = max(1, int((time.monotonic() - start) * 1000))
        input_tokens = max(1, len(prompt) // 4)
        output_tokens = max(1, len(text) // 4)
        usage = {
            "input_tokens": input_tokens,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "output_tokens": output_tokens,
        }
        return InvokeResult(
            text=text,
            model="stub-v1",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=0.0,
            duration_ms=duration_ms,
            cache_creation_input_tokens=0,
            cache_read_input_tokens=0,
            usage=usage,
            model_usage={"stub-v1": {"outputTokens": output_tokens}},
            raw={"stub": True, "concept_id": concept_id, "template_used": template_fn.__name__},
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def get_invoker(settings: Settings | None = None) -> Invoker:
    """Selects an `Invoker` implementation by `GENERATOR_INVOKER` (CONTRACTS.md §2)."""
    s = settings or get_settings()
    if s.GENERATOR_INVOKER == "claude":
        return ClaudeInvoker(settings=s)
    if s.GENERATOR_INVOKER == "codex":
        return CodexInvoker(settings=s)
    if s.GENERATOR_INVOKER == "stub":
        return StubInvoker(settings=s)
    raise ValueError(f"unknown GENERATOR_INVOKER: {s.GENERATOR_INVOKER!r}")  # pragma: no cover
