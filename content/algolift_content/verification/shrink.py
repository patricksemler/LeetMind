"""Counterexample shrinking for stage_differential (CONTRACTS.md §10 stage 3).

Real shrinking, not just "report the first failing case": given a set of positional arguments on
which the reference and brute-force solutions disagree, repeatedly try smaller variants (halved /
element-dropped lists, ints pulled toward zero, truncated strings) and keep shrinking as long as
disagreement persists. Bounded to `max_attempts` total candidate evaluations.

Each round batches every candidate for that round into exactly two sandbox calls (one brute-force
run, one reference-vs-brute-output comparison) — never one container per candidate — matching the
same batching discipline as the main differential pass.
"""

from __future__ import annotations

from typing import Any

from algolift_content.sandbox import SandboxLimits
from algolift_content.verification.execution import actual_outputs, compare_against

DEFAULT_MAX_ATTEMPTS = 100


def _size(value: Any) -> int:
    if isinstance(value, list):
        return 1 + sum(_size(v) for v in value)
    if isinstance(value, bool):
        return 1
    if isinstance(value, int | float):
        return 1 + min(int(abs(value)), 1000)
    if isinstance(value, str):
        return 1 + len(value)
    return 1


def size_metric(args: list[Any]) -> int:
    """Total "size" of an argument list — smaller is simpler. Used both to decide whether a
    shrink candidate is an improvement and to report the before/after reduction."""
    return sum(_size(a) for a in args)


def _value_candidates(value: Any, depth: int = 0) -> list[Any]:
    if depth > 6:
        return []
    if isinstance(value, list) and value:
        n = len(value)
        out: list[Any] = []
        if n > 1:
            out.append(value[: n // 2])
            out.append(value[n // 2 :])
            out.append(value[:-1])
            out.append(value[1:])
        else:
            out.append([])
        # Shrink individual elements too (bounded to the first few so one round doesn't
        # explode combinatorially on long lists).
        for idx in range(min(n, 6)):
            for shrunk_elem in _value_candidates(value[idx], depth + 1):
                nv = list(value)
                nv[idx] = shrunk_elem
                out.append(nv)
        return out
    if isinstance(value, bool):
        return []
    if isinstance(value, int):
        out = []
        if value != 0:
            out.append(0)
            half = value // 2
            if half != value:
                out.append(half)
        if value > 0:
            out.append(value - 1)
        elif value < 0:
            out.append(value + 1)
        return out
    if isinstance(value, float):
        out = []
        if value != 0.0:
            out.append(0.0)
            out.append(value / 2)
        return out
    if isinstance(value, str) and value:
        return [value[: len(value) // 2], ""]
    return []


def shrink_candidates(args: list[Any]) -> list[list[Any]]:
    """One round of candidates: for each positional argument, every "simpler" variant of just
    that argument, with all other arguments held fixed."""
    candidates: list[list[Any]] = []
    for i, v in enumerate(args):
        for nv in _value_candidates(v):
            if nv == v:
                continue
            candidate = list(args)
            candidate[i] = nv
            candidates.append(candidate)
    return candidates


def shrink_counterexample(
    args: list[Any],
    *,
    brute_source: str,
    reference_source: str,
    signature: Any,
    comparator_spec: dict[str, Any],
    limits: SandboxLimits,
    checker_source: str | None = None,
    image: str | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> tuple[list[Any], int]:
    """Repeatedly tries to replace `args` with a smaller argument list that still makes the
    reference and brute-force solutions disagree. Returns `(smallest_known_counterexample,
    attempts_used)`. Always returns at least `args` itself (attempts_used may be 0 if the very
    first round finds nothing smaller, or if `args` has no candidates at all, e.g. all scalars
    already at/near zero)."""
    current = args
    attempts_used = 0

    while attempts_used < max_attempts:
        candidates = shrink_candidates(current)
        if not candidates:
            break
        remaining = max_attempts - attempts_used
        candidates = candidates[:remaining]
        attempts_used += len(candidates)

        brute_results, _brute_raw = actual_outputs(
            brute_source, candidates, signature, limits, image=image
        )
        expected_pairs = [
            (candidates[i], brute_results[i].output if brute_results[i].ok else None)
            for i in range(len(candidates))
        ]
        result, _ref_outputs = compare_against(
            reference_source,
            expected_pairs,
            signature,
            comparator_spec,
            limits,
            checker_source=checker_source,
            image=image,
        )

        current_size = size_metric(current)
        best: list[Any] | None = None
        best_size = current_size
        for i, pt in enumerate(result.per_test):
            if pt.passed:
                continue
            # A candidate where BOTH sides errored (e.g. it shrank into an out-of-constraint
            # input both solutions correctly reject) is not a genuine disagreement — skip it,
            # mirroring stage_boundary's "both error -> not a real failure" rule, so shrinking
            # never wanders into degenerate/invalid inputs just because they're small.
            if not brute_results[i].ok and pt.status == "error":
                continue
            cand_size = size_metric(candidates[i])
            if cand_size < best_size:
                best = candidates[i]
                best_size = cand_size

        if best is None:
            break
        current = best

    return current, attempts_used
