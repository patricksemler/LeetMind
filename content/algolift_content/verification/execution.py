"""Sandbox execution helpers shared by every verification stage.

Everything here goes through `algolift_content.sandbox.run_python` (the single sandbox CLI
bridge, CONTRACTS.md §6.1) and batches many test cases into one sandbox invocation, per the
task brief's "one container per case would be unusably slow" instruction.

Two request shapes cover every stage's needs:

- `actual_outputs`: runs a solution against a batch of *raw arguments* with no real `expected`
  (comparator is irrelevant — we only want the solution's own output value back). Used to
  discover what the brute-force/reference solution actually computes for a given input.
- `compare_against`: runs a *candidate* solution against a batch of `(args, expected)` pairs
  using the problem's REAL comparator (exact/float_tol/unordered/checker_py). This reuses the
  harness's own comparator/checker implementation (packages/sandbox/runners/python/runner.py)
  instead of re-implementing float-tolerance/unordered/checker comparison a second time in
  Python — the single-implementation rule from CONTRACTS.md §6.1 applied one level up.

Both helpers read the actual per-test output values out of `ExecuteResult.raw["harness"]["tests"]`
because the *normalized* `ExecuteResult.per_test` (CONTRACTS.md §6 "Harness result protocol")
deliberately does not carry `output` — that field only exists in the raw in-container per-test
object (`packages/sandbox/runners/python/runner.py`'s `public["output"]`, mirrored losslessly
into `raw.harness.tests[i].output` by `packages/sandbox/src/execute.ts#buildExecutionResult`).
Reading `output` out of `raw` is exactly what CONTRACTS.md §4 has in mind when it says hidden
test expected values must come from "the reference solution's actual output, never from LLM
assertion" — there is no other way to observe that actual output.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from algolift_content.models import Signature
from algolift_content.sandbox import ExecuteResult, SandboxLimits, run_python

#: Harness per-test statuses that mean "we got a real output value" (CONTRACTS.md §6 / §7's
#: `runner.py`: `output` is only ever populated when status is 'passed' or 'failed' — 'error'
#: and 'timeout' never carry an output).
_OUTPUT_STATUSES = ("passed", "failed")


@dataclass
class ActualOutput:
    """One case's outcome from `actual_outputs()`."""

    ok: bool  # True iff the solution produced a real value (no crash/timeout)
    output: Any
    status: str
    error: str | None


def _harness_tests_by_index(result: ExecuteResult) -> dict[int, dict[str, Any]]:
    harness = result.raw.get("harness") or {}
    tests = harness.get("tests") or []
    return {int(t["index"]): t for t in tests if isinstance(t, dict) and "index" in t}


def actual_outputs(
    source: str,
    args_list: list[list[Any]],
    signature: Signature | dict[str, Any],
    limits: SandboxLimits,
    *,
    image: str | None = None,
) -> tuple[list[ActualOutput], ExecuteResult]:
    """Runs `source` against every entry of `args_list` in ONE batched sandbox call, using a
    dummy `expected=None` for every test (the comparator outcome is discarded — only the
    solution's own computed output matters here). Returns `(per_case_results, raw_result)`
    aligned by input order; `raw_result` lets a caller inspect a top-level failure (e.g. the
    solution failed to import at all, in which case every entry comes back not-ok)."""
    if not args_list:
        empty_result = run_python(signature, [], {"kind": "exact"}, source, limits, image=image)
        return [], empty_result

    tests = [{"args": args, "expected": None} for args in args_list]
    result = run_python(signature, tests, {"kind": "exact"}, source, limits, image=image)
    by_index = _harness_tests_by_index(result)

    outputs: list[ActualOutput] = []
    for i in range(len(args_list)):
        t = by_index.get(i)
        if t is None:
            outputs.append(ActualOutput(ok=False, output=None, status="missing", error=None))
            continue
        status = t.get("status", "error")
        outputs.append(
            ActualOutput(
                ok=status in _OUTPUT_STATUSES,
                output=t.get("output") if status in _OUTPUT_STATUSES else None,
                status=status,
                error=t.get("error"),
            )
        )
    return outputs, result


def compare_against(
    source: str,
    cases: list[tuple[list[Any], Any]],
    signature: Signature | dict[str, Any],
    comparator_spec: dict[str, Any],
    limits: SandboxLimits,
    *,
    checker_source: str | None = None,
    image: str | None = None,
    reveal_inputs: bool = False,
) -> tuple[ExecuteResult, list[Any]]:
    """Runs `source` against `cases` (`[(args, expected), ...]`) in ONE batched sandbox call
    using the REAL comparator, so the pass/fail verdict per test is authoritative (computed by
    the same harness code that judges real submissions). Returns `(execute_result,
    candidate_actual_outputs)` — the second element is `source`'s own actual output for each
    case (from `raw.harness`), aligned by input order, regardless of whether it matched
    `expected`."""
    if not cases:
        empty_result = run_python(
            signature,
            [],
            comparator_spec,
            source,
            limits,
            image=image,
            checker_source=checker_source,
        )
        return empty_result, []

    tests = [{"args": args, "expected": expected} for args, expected in cases]
    result = run_python(
        signature,
        tests,
        comparator_spec,
        source,
        limits,
        image=image,
        checker_source=checker_source,
        reveal_inputs=reveal_inputs,
    )
    by_index = _harness_tests_by_index(result)

    outputs: list[Any] = []
    for i in range(len(cases)):
        t = by_index.get(i)
        status = t.get("status") if t else None
        outputs.append(t.get("output") if t is not None and status in _OUTPUT_STATUSES else None)
    return result, outputs
