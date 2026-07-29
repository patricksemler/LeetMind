"""The §8.4 value contract: the single type system shared by the builder, the judge, and (once
generated) the frontend. `ValueType` describes a signature's parameter/return type; `values_equal`
is the comparator's law — the only place "is this answer right" gets decided."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field

ScalarKind = Literal["int", "float", "bool", "str"]

FLOAT_ABS_TOL = 1e-6
FLOAT_REL_TOL = 1e-6


class ValueType(BaseModel):
    """`T ::= int | float | bool | str | T? | T[]`.

    `list_depth` counts the `[]` nesting (0 = scalar); `nullable` marks the *leaf* scalar as
    `T?` — e.g. a level-order binary tree is `ValueType(kind="int", nullable=True, list_depth=1)`.
    """

    kind: ScalarKind
    nullable: bool = False
    list_depth: int = 0


class SignatureParam(BaseModel):
    name: str
    type: ValueType


class Signature(BaseModel):
    """A generated problem's callable shape: what the judge calls and what the frontend renders
    as starter code (§8.4). `order_insensitive` applies to the *return* value only — a list
    return compared as a multiset (e.g. "any valid ordering")."""

    func_name: str
    params: list[SignatureParam]
    returns: ValueType
    order_insensitive: bool = False


class Complexity(BaseModel):
    time: str
    space: str


class Verdict(StrEnum):
    PASS = "pass"
    WRONG_ANSWER = "wrong_answer"
    ERROR = "error"
    TIMEOUT = "timeout"


class TestCase(BaseModel):
    """One test to run: the args passed positionally to the submitted function, the agreed
    expected value (§7.4), and the return type used to compare them."""

    __test__ = False  # not a pytest test despite the name

    args: list[Any]
    expected: Any
    value_type: ValueType
    order_insensitive: bool = False


class TestOutcome(BaseModel):
    __test__ = False  # not a pytest test despite the name

    index: int
    verdict: Verdict
    value: Any = None
    error: str | None = None
    printed: str = ""
    duration_ms: int = 0


def _scalar_equal(expected: object, actual: object, kind: ScalarKind) -> bool:
    if kind == "bool":
        return isinstance(expected, bool) and isinstance(actual, bool) and expected == actual
    if kind == "int":
        return (
            isinstance(expected, int)
            and not isinstance(expected, bool)
            and isinstance(actual, int)
            and not isinstance(actual, bool)
            and expected == actual
        )
    if kind == "float":
        # Type-strict: declared float, but an int return (2 instead of 2.0) is still a plain
        # number and numerically equal, so it's accepted; a bool never is (§8.4).
        if not (isinstance(expected, (int, float)) and not isinstance(expected, bool)):
            return False
        if not (isinstance(actual, (int, float)) and not isinstance(actual, bool)):
            return False
        e, a = float(expected), float(actual)
        return abs(e - a) <= max(FLOAT_ABS_TOL, FLOAT_REL_TOL * max(abs(e), abs(a)))
    if kind == "str":
        return isinstance(expected, str) and isinstance(actual, str) and expected == actual
    raise ValueError(f"unknown scalar kind {kind!r}")


def _compare(
    expected: object,
    actual: object,
    kind: ScalarKind,
    nullable: bool,
    depth: int,
    order_insensitive: bool,
) -> bool:
    if depth > 0:
        if not isinstance(expected, list) or not isinstance(actual, list):
            return False
        if len(expected) != len(actual):
            return False
        if order_insensitive:
            return _multiset_equal(expected, actual, kind, nullable, depth - 1, order_insensitive)
        return all(
            _compare(e, a, kind, nullable, depth - 1, order_insensitive)
            for e, a in zip(expected, actual, strict=True)
        )

    if expected is None or actual is None:
        return nullable and expected is None and actual is None
    return _scalar_equal(expected, actual, kind)


def _multiset_equal(
    expected: list[object],
    actual: list[object],
    kind: ScalarKind,
    nullable: bool,
    sub_depth: int,
    order_insensitive: bool,
) -> bool:
    remaining = list(actual)
    for e in expected:
        for i, a in enumerate(remaining):
            if _compare(e, a, kind, nullable, sub_depth, order_insensitive):
                del remaining[i]
                break
        else:
            return False
    return not remaining


def values_equal(
    expected: object, actual: object, value_type: ValueType, *, order_insensitive: bool = False
) -> bool:
    """The comparator's law (§8.4): type-strict deep equality, `bool` never equals `int`,
    lists ordered unless `order_insensitive`, floats compared with tolerance."""
    return _compare(
        expected,
        actual,
        value_type.kind,
        value_type.nullable,
        value_type.list_depth,
        order_insensitive,
    )


class GenerationJobStatus(StrEnum):
    """Mirrors the DB `job_status` enum (migration 0001, PLAN_BACKEND.md §4)."""

    QUEUED = "queued"
    PLANNING = "planning"
    BUILDING = "building"
    VERIFYING = "verifying"
    READY = "ready"
    FAILED = "failed"


class GenerationPhase(StrEnum):
    WAITING = "waiting"
    SELECTING = "selecting"
    DRAFTING = "drafting"
    INDEPENDENT_REVIEW = "independent_review"
    CHECKING_EXAMPLES = "checking_examples"
    STRESS_TESTING = "stress_testing"
    REPAIRING = "repairing"
    FINALIZING = "finalizing"
    READY = "ready"
    FAILED = "failed"


class GenerationRecoveryReason(StrEnum):
    FORMAT = "format"
    ACTIVITY_FIT = "activity_fit"
    TEST_DISAGREEMENT = "test_disagreement"
    PROVIDER = "provider"
    VERIFICATION_INFRASTRUCTURE = "verification_infrastructure"


class GenerationFailureCode(StrEnum):
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    GENERATION_INVALID = "generation_invalid"
    QUALITY_MISMATCH = "quality_mismatch"
    VERIFICATION_FAILED = "verification_failed"
    VERIFICATION_UNAVAILABLE = "verification_unavailable"
    DEADLINE_EXCEEDED = "deadline_exceeded"


class GenerationEvent(BaseModel):
    """One `GET /api/events` SSE payload (§9): a generation job's stage transition."""

    job_id: str
    status: GenerationJobStatus
    phase: GenerationPhase
    repair_count: int = 0
    attempt: int = 1
    max_attempts: int = 2
    started_at: datetime
    phase_started_at: datetime
    recovery_reason: GenerationRecoveryReason | None = None
    failure_code: GenerationFailureCode | None = None
    problem_id: str | None = None


class TypeProfileView(BaseModel):
    """One row of `GET /api/me` (§9): a type's learner-model state."""

    slug: str
    name: str
    rating: float
    attempts: int
    evidenced: bool


class MeResponse(BaseModel):
    types: list[TypeProfileView]


# -- Phase 4: practice API (PLAN_BACKEND.md §9) --------------------------------------------------


class JobStub(BaseModel):
    job_id: str
    status: GenerationJobStatus
    phase: GenerationPhase
    repair_count: int = 0
    attempt: int = 1
    max_attempts: int = 2
    started_at: datetime
    phase_started_at: datetime
    recovery_reason: GenerationRecoveryReason | None = None
    failure_code: GenerationFailureCode | None = None


class PracticeNextResponse(BaseModel):
    """`GET /api/practice/next` (amendments 36, 41): a pure-read stub, never the statement."""

    state: Literal["active", "generating", "generation_failed", "stalled"]
    problem_id: str | None = None
    opened: bool = False
    job: JobStub | None = None


class ReplenishResponse(BaseModel):
    created: list[str]


class TestCaseView(BaseModel):
    """A test case as shown to the client: args + the agreed expected value, no `value_type`
    (the client doesn't need the comparator's internals)."""

    args: list[Any]
    expected: Any


class ProblemViewBase(BaseModel):
    id: str
    status: str
    primary_type: str
    support_types: list[str]
    shape: str
    problem_rating: int
    is_probe: bool
    title: str
    statement_md: str
    constraints: list[str]
    signature: Signature
    starter_code: str
    public_tests: list[TestCaseView]
    complexity: Complexity
    par_minutes: int
    created_at: datetime
    served_at: datetime | None


class ProblemView(ProblemViewBase):
    """Unresolved view (§9): private tests, unrevealed hints, and both solutions are not fields
    of this model, so they cannot leak by construction — not because a route remembers to
    scrub them. Siblings with `ResolvedProblemView`, not a superclass, so the two can never be
    confused by response-model coercion."""

    revealed_hints: list[str]


class ResolvedProblemView(ProblemViewBase):
    """Produced only once status is `solved`/`given_up` (§9): adds the reference solution, the
    full hint ladder, and the private tests for post-mortem study."""

    hints: list[str]
    private_tests: list[TestCaseView]
    reference_solution: str
    resolved_at: datetime | None


class CodeRequest(BaseModel):
    code: str = Field(max_length=65536)  # §9: code fields capped at 64 KB


class RunResponse(BaseModel):
    results: list[TestOutcome]
    passed: bool


class FailingCaseView(BaseModel):
    """§8.3/§9: the first failing private case's input, expected output, and the user's output."""

    input: list[Any]
    expected: Any
    actual: Any


class RatingUpdateView(BaseModel):
    """§9, #22: every resolution response carries a full rating-update breakdown."""

    type_slug: str
    rating_before: float
    rating_after: float
    delta: float
    problem_rating: int
    expected_score: float
    performance_score: float
    k_factor: float
    metrics: dict[str, Any]


class SubmitResponse(BaseModel):
    """§8.3: a public failure demotes `kind` to `'run'`; an all-private-pass submit sets
    `solved=True` and carries `rating_update`."""

    kind: Literal["run", "submit"]
    passed: bool
    solved: bool = False
    results: list[TestOutcome]
    failing_case: FailingCaseView | None = None
    rating_update: RatingUpdateView | None = None


class HintResponse(BaseModel):
    rung: int
    text: str


class GiveUpResponse(BaseModel):
    reference_solution: str
    rating_update: RatingUpdateView
