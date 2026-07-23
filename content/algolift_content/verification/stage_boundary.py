"""Stage 4 — boundary (CONTRACTS.md §10).

Derives boundary cases from `constraints_md` (`algolift_content.verification.constraints`) and
the signature: empty containers, min/max sizes, single elements, all-duplicates, extreme values,
negatives. Falls back to type-driven defaults (and records the fallback in `details`) whenever a
parameter's bound can't be parsed — derivation must be defensive, never itself a reason to crash.

**On "both solutions reject the same scenario" (a heuristically-derived case turns out to violate
a cross-parameter relationship this module doesn't reason about, e.g. `k <= len(nums)`):** if
BOTH the reference and brute-force solutions come back `error` for a scenario, that scenario is
treated as structurally invalid for this problem and skipped (recorded, not failed) rather than
reported as a disagreement — the two solutions responding identically to an out-of-domain input
isn't the correctness question this stage exists to answer. A scenario is only a real failure when
exactly one side errors/times out while the other doesn't, or both run but disagree on the
output. This is a deliberate, documented relaxation of "auto-derived from constraints" — see this
project's final report for the tradeoff.

Both solutions must AGREE (real failures above) AND COMPLETE WITHIN LIMITS — a timeout on either
side is always a failure, never treated as an "agreed rejection".
"""

from __future__ import annotations

import time
from typing import Any

from algolift_content.codegen import GeneratorContractError, seeded_inputs
from algolift_content.models import (
    ParamTypeAst,
    ProblemVersion,
    Signature,
    StageResult,
    TestCase,
    parse_param_type,
)
from algolift_content.sandbox import SandboxLimits
from algolift_content.verification.constraints import Bound, coupled_scalars, parse_bounds
from algolift_content.verification.execution import actual_outputs, compare_against

STAGE = "boundary"

#: Reserved seed range for the template random cases this stage draws on to fill in
#: "other parameter" values — kept well clear of stage_differential's SEED_START..+count range.
TEMPLATE_SEED_START = 9_000_000
TEMPLATE_CASE_COUNT = 3

#: Type-driven fallback bounds, used whenever `constraints_md` doesn't parse for a given param.
_FALLBACK_SCALAR_MIN, _FALLBACK_SCALAR_MAX = -1000, 1000
_FALLBACK_LEN_MIN, _FALLBACK_LEN_MAX = 0, 20
_FALLBACK_ELEM_MIN, _FALLBACK_ELEM_MAX = -1000, 1000

#: Cap on how large a derived list can be, independent of what constraints_md allows, so a
#: constraint like `<= 100000` doesn't make this stage itself unreasonably slow.
MAX_DERIVED_LIST_LEN = 500


def _scalar_bound(bounds: dict[str, Bound], name: str, details: dict[str, Any]) -> tuple[int, int]:
    b = bounds.get(f"scalar:{name}")
    if b is None or (b.min is None and b.max is None):
        details.setdefault("fallback_bounds", []).append(f"scalar:{name}")
        return _FALLBACK_SCALAR_MIN, _FALLBACK_SCALAR_MAX
    lo = b.min if b.min is not None else _FALLBACK_SCALAR_MIN
    hi = b.max if b.max is not None else _FALLBACK_SCALAR_MAX
    return lo, hi


def _len_bound(bounds: dict[str, Bound], name: str, details: dict[str, Any]) -> tuple[int, int]:
    b = bounds.get(f"len:{name}")
    if b is None or (b.min is None and b.max is None):
        details.setdefault("fallback_bounds", []).append(f"len:{name}")
        return _FALLBACK_LEN_MIN, _FALLBACK_LEN_MAX
    lo = b.min if b.min is not None else _FALLBACK_LEN_MIN
    hi = b.max if b.max is not None else _FALLBACK_LEN_MAX
    return lo, min(hi, MAX_DERIVED_LIST_LEN)


def _elem_bound(bounds: dict[str, Bound], name: str, details: dict[str, Any]) -> tuple[int, int]:
    b = bounds.get(f"elem:{name}")
    if b is None or (b.min is None and b.max is None):
        details.setdefault("fallback_bounds", []).append(f"elem:{name}")
        return _FALLBACK_ELEM_MIN, _FALLBACK_ELEM_MAX
    lo = b.min if b.min is not None else _FALLBACK_ELEM_MIN
    hi = b.max if b.max is not None else _FALLBACK_ELEM_MAX
    return lo, hi


def _fill_list(length: int, kind: str, lo: int, hi: int) -> list[int]:
    if length <= 0:
        return []
    if kind == "min":
        return [lo] * length
    if kind == "max":
        return [hi] * length
    if kind == "dup":
        return [lo if lo != 0 else hi] * length
    if kind == "extremes":
        return [lo if i % 2 == 0 else hi for i in range(length)]
    if kind == "negatives":
        neg = min(lo, -1) if lo < 0 else lo
        return [neg] * length
    return [lo] * length


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


class _ScenarioBuilder:
    """Builds full argument lists for a scenario, starting from a "template" base (a valid
    generator-produced case) and varying exactly one parameter, clamping any scalar parameter
    known to be coupled to a varied list's length (per `coupled_scalars`)."""

    def __init__(
        self,
        signature: Signature,
        bounds: dict[str, Bound],
        templates: list[list[Any]],
        details: dict[str, Any],
    ) -> None:
        self.signature = signature
        self.bounds = bounds
        self.templates = templates
        self.details = details
        self._template_i = 0

    def _next_template(self) -> list[Any]:
        t = self.templates[self._template_i % len(self.templates)]
        self._template_i += 1
        return list(t)

    def scalar_variants(self, param_index: int, name: str) -> list[list[Any]]:
        lo, hi = _scalar_bound(self.bounds, name, self.details)
        values = {lo, hi}
        if lo <= 0 <= hi:
            values.add(0)
        out = []
        for v in values:
            args = self._next_template()
            args[param_index] = v
            out.append(args)
        return out

    def list_variants(self, param_index: int, name: str, elem_ast: ParamTypeAst) -> list[list[Any]]:
        len_lo, len_hi = _len_bound(self.bounds, name, self.details)
        elem_lo, elem_hi = (0, 0)
        is_int_list = elem_ast.get("kind") == "scalar" and elem_ast.get("name") in ("int", "float")
        if is_int_list:
            elem_lo, elem_hi = _elem_bound(self.bounds, name, self.details)

        scenarios: list[tuple[str, int]] = []
        if len_lo <= 0 <= len_hi:
            scenarios.append(("min", 0))
        if len_lo <= 1 <= len_hi:
            scenarios.append(("single", 1))
        scenarios.append(("max", len_hi))
        dup_len = min(max(len_lo, 2), len_hi) if len_hi >= 2 else len_hi
        scenarios.append(("dup", dup_len))
        extreme_len = min(max(len_lo, 2), len_hi) if len_hi >= 2 else len_hi
        scenarios.append(("extremes", extreme_len))
        if is_int_list and elem_lo < 0:
            neg_len = min(max(len_lo, 1), len_hi) if len_hi >= 1 else len_hi
            scenarios.append(("negatives", neg_len))

        related = coupled_scalars(self.bounds, name)
        related_indices = [
            (i, p.name) for i, p in enumerate(self.signature.params) if p.name in related
        ]

        out = []
        for kind, length in scenarios:
            length = max(0, length)
            args = self._next_template()
            values: list[Any]
            if kind == "min":
                values = []
            elif kind == "single":
                values = [elem_lo if is_int_list else 0]
            else:
                values = _fill_list(length, kind, elem_lo, elem_hi) if is_int_list else [0] * length
            args[param_index] = values
            for ci, cname in related_indices:
                lo, hi = _scalar_bound(self.bounds, cname, self.details)
                current = args[ci] if isinstance(args[ci], int) else lo
                args[ci] = _clamp(current, lo, min(hi, max(len(values), lo)))
            out.append(args)
        return out


def run(
    problem: ProblemVersion,
    *,
    limits: SandboxLimits,
    comparator_spec: dict[str, Any],
) -> tuple[StageResult, dict[str, Any]]:
    started = time.monotonic()
    details: dict[str, Any] = {}

    try:
        templates_raw = seeded_inputs(
            problem.input_generator_py,
            problem.signature,
            TEMPLATE_CASE_COUNT,
            TEMPLATE_SEED_START,
            limits=limits,
        )
        templates = [c["args"] for c in templates_raw]
    except GeneratorContractError as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        return (
            StageResult(
                stage=STAGE,
                status="failed",
                duration_ms=duration_ms,
                details={"reason": "generator_contract_error", "message": str(exc)},
            ),
            {},
        )

    if not templates:
        duration_ms = int((time.monotonic() - started) * 1000)
        return (
            StageResult(
                stage=STAGE, status="passed", duration_ms=duration_ms, details={"scenarios": 0}
            ),
            {"verified_cases": []},
        )

    bounds = parse_bounds(problem.constraints_md)
    builder = _ScenarioBuilder(problem.signature, bounds, templates, details)

    scenario_args: list[list[Any]] = []
    scenario_labels: list[str] = []
    for i, param in enumerate(problem.signature.params):
        ast = parse_param_type(param.type)
        if ast["kind"] == "scalar" and ast["name"] in ("int", "float"):
            variants = builder.scalar_variants(i, param.name)
            scenario_args.extend(variants)
            scenario_labels.extend([f"{param.name}=scalar_bound"] * len(variants))
        elif ast["kind"] == "list":
            variants = builder.list_variants(i, param.name, ast["of"])
            scenario_args.extend(variants)
            scenario_labels.extend([f"{param.name}=list_shape"] * len(variants))
        else:
            details.setdefault("unsupported_param_types", []).append(param.type)

    if not scenario_args:
        duration_ms = int((time.monotonic() - started) * 1000)
        details["scenarios"] = 0
        return (
            StageResult(stage=STAGE, status="passed", duration_ms=duration_ms, details=details),
            {"verified_cases": []},
        )

    brute_results, _brute_raw = actual_outputs(
        problem.brute_force_py, scenario_args, problem.signature, limits
    )
    expected_pairs = [
        (scenario_args[i], brute_results[i].output if brute_results[i].ok else None)
        for i in range(len(scenario_args))
    ]
    result, reference_outputs = compare_against(
        problem.reference_solution_py,
        expected_pairs,
        problem.signature,
        comparator_spec,
        limits,
        checker_source=problem.checker_py,
    )

    skipped = 0
    real_failures: list[dict[str, Any]] = []
    verified_cases: list[TestCase] = []

    for i, pt in enumerate(result.per_test):
        brute_ok = brute_results[i].ok
        ref_status = pt.status
        if not brute_ok and ref_status == "error":
            skipped += 1
            continue
        is_timeout = ref_status == "timeout" or brute_results[i].status == "timeout"
        if is_timeout or not pt.passed:
            real_failures.append(
                {
                    "label": scenario_labels[i],
                    "args": scenario_args[i],
                    "brute_status": brute_results[i].status,
                    "reference_status": ref_status,
                }
            )
            continue
        verified_cases.append(
            TestCase(args=scenario_args[i], expected=reference_outputs[i], origin="boundary")
        )

    details["scenarios"] = len(scenario_args)
    details["skipped_invalid"] = skipped
    details["verified"] = len(verified_cases)

    duration_ms = int((time.monotonic() - started) * 1000)

    if real_failures:
        details["failures"] = real_failures[:10]
        return (
            StageResult(stage=STAGE, status="failed", duration_ms=duration_ms, details=details),
            {"counterexample": real_failures[0]},
        )

    return (
        StageResult(stage=STAGE, status="passed", duration_ms=duration_ms, details=details),
        {"verified_cases": verified_cases},
    )
