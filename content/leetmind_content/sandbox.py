"""The sandbox CLI bridge (docs/CONTRACTS.md §6.1).

The content plane must execute reference/brute-force/mutant/generator code under **exactly** the
same sandbox as user submissions. To guarantee that without a second implementation of the
`docker run` flag list, `@leetmind/sandbox` ships a CLI and this module shells out to it:

    node --import tsx packages/sandbox/src/cli.ts exec
        reads  SandboxRequest JSON on stdin
        writes SandboxResult JSON on stdout

    node --import tsx packages/sandbox/src/cli.ts exec-python
        reads  {signature, tests, comparator, source, limits, image} on stdin
        writes the normalized execute result

JSON in / JSON out on stdin/stdout only; all logs go to stderr; exit 0 on a successful
*execution attempt* (even a `wrong_answer` verdict), non-zero only on infrastructure failure.

**Python must never build `docker run` arguments itself** — that is `@leetmind/sandbox`'s job
alone (single-implementation rule, CONTRACTS.md §6.1).

The `SandboxRequest`/`SandboxLimits`/`SandboxResult`/`ExecutionResult` shapes below were checked
against the real `packages/sandbox/src/{cli,execute,types}.ts` (built concurrently by another
agent) and mirror them field-for-field. One deviation from CONTRACTS.md §6.1 was found in that
package at the time of writing: `@leetmind/shared`'s `createLogger` writes pino JSON log lines to
**stdout** rather than stderr, so `cli.ts` stdout is not always a single clean JSON document —
`_parse_last_json_object` below works around this defensively (see its docstring); this is purely
a robustness measure and does not change any request/response shape.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from leetmind_content.config import Settings, get_settings
from leetmind_content.logging import get_logger
from leetmind_content.models import Signature, TestCase

log = get_logger("content-sandbox")

#: Emitted by all three entry points that need the repo root to locate `packages/sandbox/src/cli.ts`
#: — `_find_repo_root` returning `None` means the same thing and warrants the same remedy at each.
_NO_REPO_ROOT = (
    "could not locate repo root (set LEETMIND_REPO_ROOT, or run inside the LeetMind workspace)"
)


class SandboxUnavailable(RuntimeError):
    """Raised when the sandbox CLI bridge cannot be reached or produced garbage: `node`/`tsx`
    missing, `docker` missing, the docker daemon unreachable, the repo root not locatable, or a
    non-JSON / non-zero-exit response from the bridge. This is an *infrastructure* failure —
    distinct from a normal execution outcome (wrong_answer, timeout, ...), which comes back as a
    value in the returned result, never as an exception."""


# ---------------------------------------------------------------------------
# Request/response shapes (CONTRACTS.md §6)
# ---------------------------------------------------------------------------


@dataclass
class SandboxLimits:
    """Mirrors the TS `SandboxLimits` interface field-for-field; serialized to the camelCase
    JSON the TS-side CLI expects."""

    memory_mb: int
    cpus: float
    pids_limit: int
    wall_timeout_ms: int
    output_limit_bytes: int

    def to_json(self) -> dict[str, Any]:
        return {
            "memoryMb": self.memory_mb,
            "cpus": self.cpus,
            "pidsLimit": self.pids_limit,
            "wallTimeoutMs": self.wall_timeout_ms,
            "outputLimitBytes": self.output_limit_bytes,
        }

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> SandboxLimits:
        s = settings or get_settings()
        return cls(
            memory_mb=s.SANDBOX_MEMORY_MB,
            cpus=s.SANDBOX_CPUS,
            pids_limit=s.SANDBOX_PIDS_LIMIT,
            wall_timeout_ms=s.SANDBOX_WALL_TIMEOUT_MS,
            output_limit_bytes=s.SANDBOX_OUTPUT_LIMIT_BYTES,
        )


@dataclass
class SandboxRequest:
    """Mirrors the TS `SandboxRequest` interface (CONTRACTS.md §6)."""

    image: str
    files: dict[str, str]
    argv: list[str]
    limits: SandboxLimits
    correlation_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "image": self.image,
            "files": self.files,
            "argv": self.argv,
            "limits": self.limits.to_json(),
        }
        if self.correlation_id:
            payload["correlationId"] = self.correlation_id
        return payload


@dataclass
class SandboxResult:
    """Mirrors the TS `SandboxResult` interface (CONTRACTS.md §6), field names snake_cased."""

    exit_code: int | None
    timed_out: bool
    oom_killed: bool
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    duration_ms: int
    image_digest: str | None
    usage: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> SandboxResult:
        return cls(
            exit_code=data.get("exitCode"),
            timed_out=bool(data.get("timedOut", False)),
            oom_killed=bool(data.get("oomKilled", False)),
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
            stdout_truncated=bool(data.get("stdoutTruncated", False)),
            stderr_truncated=bool(data.get("stderrTruncated", False)),
            duration_ms=int(data.get("durationMs", 0) or 0),
            image_digest=data.get("imageDigest"),
            usage=data.get("usage") or {},
        )


#: `Verdict`, mirrored from CONTRACTS.md §4.3 / `packages/sandbox/src/types.ts`.
Verdict = Literal[
    "accepted",
    "wrong_answer",
    "compilation_error",
    "runtime_error",
    "time_limit",
    "memory_limit",
    "output_limit",
    "internal_error",
    "cancelled",
]


@dataclass
class ExecutionPerTestResult:
    """Mirrors TS `ExecutionPerTestResult` (`packages/sandbox/src/types.ts`) — one already-graded
    test outcome (as opposed to `HarnessTestResult`, the raw in-container per-test object)."""

    index: int
    status: Literal["passed", "failed", "error", "timeout"]
    time_ms: float
    memory_kb: float
    passed: bool

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ExecutionPerTestResult:
        return cls(
            index=int(data.get("index", 0)),
            status=data.get("status", "error"),
            time_ms=float(data.get("timeMs", 0) or 0),
            memory_kb=float(data.get("memoryKb", 0) or 0),
            passed=bool(data.get("passed", False)),
        )


@dataclass
class ExecutionFailure:
    """Mirrors TS `ExecutionFailure` — safe diagnostics only (CONTRACTS.md §4.5); `*_preview`
    fields are populated only when the caller passed `reveal_inputs=True`."""

    kind: str
    message: str
    first_failing_test_index: int | None = None
    stderr_tail: str | None = None
    input_preview: Any = None
    expected_preview: Any = None
    actual_preview: Any = None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ExecutionFailure:
        return cls(
            kind=data.get("kind", "internal_error"),
            message=data.get("message", ""),
            first_failing_test_index=data.get("first_failing_test_index"),
            stderr_tail=data.get("stderr_tail"),
            input_preview=data.get("input_preview"),
            expected_preview=data.get("expected_preview"),
            actual_preview=data.get("actual_preview"),
        )


@dataclass
class ExecuteResult:
    """The normalized `exec-python` response — mirrors TS `ExecutionResult`
    (`packages/sandbox/src/types.ts`, built by `execute.ts#buildExecutionResult`) field-for-field.
    `raw` retains the full `{sandbox, harness, parseError?}` envelope for anything not modeled
    explicitly above."""

    verdict: Verdict
    passed_tests: int
    total_tests: int
    runtime_ms: float
    memory_kb: float | None
    per_test: list[ExecutionPerTestResult]
    failure: ExecutionFailure | None
    raw: dict[str, Any]

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ExecuteResult:
        failure_data = data.get("failure")
        return cls(
            verdict=data.get("verdict", "internal_error"),
            passed_tests=int(data.get("passedTests", 0) or 0),
            total_tests=int(data.get("totalTests", 0) or 0),
            runtime_ms=float(data.get("runtimeMs", 0) or 0),
            memory_kb=data.get("memoryKb"),
            per_test=[ExecutionPerTestResult.from_json(t) for t in data.get("perTest", [])],
            failure=ExecutionFailure.from_json(failure_data) if failure_data else None,
            raw=data.get("raw", {}),
        )

    @property
    def ok(self) -> bool:
        """Convenience: True iff every test passed (`verdict == "accepted"`)."""
        return self.verdict == "accepted"


# ---------------------------------------------------------------------------
# Repo root resolution
# ---------------------------------------------------------------------------


def _find_repo_root(settings: Settings | None = None) -> Path | None:
    """Resolves the repo root from `LEETMIND_REPO_ROOT`, else by walking up from this file for
    `pnpm-workspace.yaml` (CONTRACTS.md §6.1)."""
    s = settings or get_settings()
    if s.LEETMIND_REPO_ROOT:
        return Path(s.LEETMIND_REPO_ROOT)
    here = Path(__file__).resolve()
    for parent in (here, *here.parents):
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    return None


# ---------------------------------------------------------------------------
# Availability probe
# ---------------------------------------------------------------------------


def sandbox_probe() -> tuple[bool, str]:
    """Returns `(available, reason)`. `reason` is empty when available, else a human-readable
    explanation of the first thing found missing."""
    settings = get_settings()

    if shutil.which("node") is None:
        return False, "`node` not found on PATH"

    repo_root = _find_repo_root(settings)
    if repo_root is None:
        return (
            False,
            _NO_REPO_ROOT,
        )

    cli_path = repo_root / "packages" / "sandbox" / "src" / "cli.ts"
    if not cli_path.exists():
        return (
            False,
            f"sandbox CLI bridge not found at {cli_path} (packages/sandbox not built yet?)",
        )

    docker_bin = settings.DOCKER_BIN
    if shutil.which(docker_bin) is None:
        return False, f"`{docker_bin}` not found on PATH"

    try:
        subprocess.run([docker_bin, "info"], capture_output=True, timeout=5, check=True)
    except Exception as exc:  # noqa: BLE001 - any failure here means "not available"
        return False, f"docker daemon not reachable via `{docker_bin} info`: {exc}"

    return True, ""


def SANDBOX_AVAILABLE() -> bool:  # noqa: N802 - deliberately shout-cased, see CONTRACTS.md §6.1 task brief
    """Probe used by tests (and callers generally) to decide whether to skip sandbox-dependent
    work. True iff `node`, the sandbox CLI file, `docker`, and a reachable docker daemon are all
    present."""
    available, _reason = sandbox_probe()
    return available


# ---------------------------------------------------------------------------
# Subprocess plumbing
# ---------------------------------------------------------------------------


def _subprocess_timeout_seconds(wall_timeout_ms: int) -> float:
    """The subprocess timeout must be generously larger than the sandbox's own wall timeout so
    the *inner* timeout always wins and reports a clean `timedOut: true`, rather than us killing
    the bridge process mid-flight."""
    return max(30.0, (wall_timeout_ms / 1000.0) * 3 + 30.0)


def _parse_last_json_object(stdout: str) -> dict[str, Any] | None:
    """Returns the last line of `stdout` that parses as a JSON object.

    `cli.ts`'s `writeResult()` is documented as "the ONLY function... allowed to write to
    stdout" and is always called exactly once, as the very last stdout write, on every code
    path (success or `failInfra`). In practice, at the time of writing, `@leetmind/shared`'s
    `createLogger` (used by the CLI's own logger) writes its pino JSON log lines to stdout
    rather than stderr — a CONTRACTS.md §6.1 violation ("all logs to stderr") in shared code
    outside this package's boundary. Rather than fail on that, we parse defensively: the real
    result is reliably the last line, and taking the last line is a no-op once that's fixed
    upstream. See this module's docstring note and the implementing agent's final report."""
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
        return None
    return None


def _run_cli(argv: list[str], cwd: Path, stdin_payload: str, timeout_s: float) -> dict[str, Any]:
    log.debug("invoking sandbox CLI bridge", argv=argv, cwd=str(cwd), timeout_s=timeout_s)
    try:
        proc = subprocess.run(
            argv,
            input=stdin_payload,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=str(cwd),
        )
    except FileNotFoundError as exc:
        raise SandboxUnavailable(
            f"failed to launch sandbox CLI bridge ({argv[0]!r} not found on PATH): {exc}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise SandboxUnavailable(
            f"sandbox CLI bridge did not return within {timeout_s:.0f}s — this should never "
            "happen since the subprocess timeout is set well above SANDBOX_WALL_TIMEOUT_MS; "
            "check that docker/the runner image are healthy"
        ) from exc

    if proc.stderr:
        log.debug("sandbox CLI bridge stderr", stderr=proc.stderr[-4000:])

    parsed = _parse_last_json_object(proc.stdout)

    if proc.returncode != 0:
        # cli.ts's failInfra() writes {"error": {"code", "message"}} to stdout before setting a
        # non-zero exit code; surface that structured reason when we got it.
        error = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(error, dict):
            raise SandboxUnavailable(
                f"sandbox CLI bridge infrastructure failure [{error.get('code', 'unknown')}]: "
                f"{error.get('message', '(no message)')}"
            )
        raise SandboxUnavailable(
            f"sandbox CLI bridge exited {proc.returncode} (infrastructure failure, not a "
            f"verdict). argv={argv} stdout_tail={proc.stdout[-2000:]!r} "
            f"stderr_tail={proc.stderr[-2000:]!r}"
        )

    if parsed is None:
        raise SandboxUnavailable(
            "sandbox CLI bridge produced no parseable JSON object on stdout: "
            f"stdout_tail={proc.stdout[-2000:]!r}"
        )
    return parsed


def _test_to_json(t: TestCase | dict[str, Any]) -> dict[str, Any]:
    if isinstance(t, TestCase):
        return {"args": t.args, "expected": t.expected}
    return {"args": t["args"], "expected": t["expected"]}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def run_raw(request: SandboxRequest, *, settings: Settings | None = None) -> SandboxResult:
    """Runs an arbitrary `SandboxRequest` via `cli.ts exec`. This is the low-level entry point —
    prefer `run_python` for the common Python-harness case."""
    s = settings or get_settings()
    repo_root = _find_repo_root(s)
    if repo_root is None:
        raise SandboxUnavailable(_NO_REPO_ROOT)
    argv = ["node", "--import", "tsx", "packages/sandbox/src/cli.ts", "exec"]
    timeout_s = _subprocess_timeout_seconds(request.limits.wall_timeout_ms)
    data = _run_cli(argv, repo_root, json.dumps(request.to_json()), timeout_s)
    return SandboxResult.from_json(data)


def run_python(
    signature: Signature | dict[str, Any],
    tests: Sequence[TestCase | dict[str, Any]],
    comparator: dict[str, Any],
    source: str,
    limits: SandboxLimits,
    *,
    image: str | None = None,
    checker_source: str | None = None,
    reveal_inputs: bool = False,
    settings: Settings | None = None,
) -> ExecuteResult:
    """Runs `source` (a Python module defining the function described by `signature`) against
    `tests` inside the sandbox, via `cli.ts exec-python`.

    Args:
        signature: the problem's `Signature` (or an already-JSON-shaped dict).
        tests: test cases to run; only `args`/`expected` are sent (origin/seed are a
            hidden-test-authoring concern, not an execution concern).
        comparator: `{"kind": "exact"|"float_tol"|"unordered"|"checker_py", "tol"?: number}`
            (CONTRACTS.md §7 `comparator.json` shape).
        source: the Python source under test (reference/brute-force/mutant/submission).
        limits: sandbox resource limits for this run.
        image: overrides `SANDBOX_PYTHON_IMAGE` when set.
        checker_source: required when `comparator.kind == "checker_py"`.
        reveal_inputs: when True, asks the bridge to include full (not truncated/hidden) input
            previews in the response — only ever appropriate for `run`-mode / example-derived
            tests, per CONTRACTS.md §4.5's `failure.*_preview` rule. Defaults to False so hidden
            tests never leak inputs by accident.

    Raises:
        SandboxUnavailable: on any infrastructure failure (not on a normal wrong_answer/timeout
            verdict, which comes back inside the returned `ExecuteResult`).
    """
    s = settings or get_settings()
    repo_root = _find_repo_root(s)
    if repo_root is None:
        raise SandboxUnavailable(_NO_REPO_ROOT)

    resolved_image = image or s.SANDBOX_PYTHON_IMAGE
    signature_json = (
        signature.model_dump(mode="json") if isinstance(signature, BaseModel) else signature
    )

    payload: dict[str, Any] = {
        "signature": signature_json,
        "tests": [_test_to_json(t) for t in tests],
        "comparator": comparator,
        "source": source,
        "limits": limits.to_json(),
        "image": resolved_image,
    }
    if checker_source is not None:
        payload["checkerSource"] = checker_source
    if reveal_inputs:
        payload["revealInputs"] = True

    argv = ["node", "--import", "tsx", "packages/sandbox/src/cli.ts", "exec-python"]
    timeout_s = _subprocess_timeout_seconds(limits.wall_timeout_ms)
    data = _run_cli(argv, repo_root, json.dumps(payload), timeout_s)
    return ExecuteResult.from_json(data)
