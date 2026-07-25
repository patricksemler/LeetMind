"""Pydantic v2 models mirroring `packages/shared`'s zod schemas field-for-field
(docs/CONTRACTS.md §4). Field names are snake_case exactly as written in CONTRACTS.md — this is
the Python side of the shared type surface; TypeScript is authoritative for HTTP/DB row shapes,
this module must stay in lockstep with it.

Server-only fields (never sent to a client) are listed in `SERVER_ONLY_FIELDS` and stripped by
`ProblemVersion.public_dict()`.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, TypedDict

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator
from ulid import ULID

# ---------------------------------------------------------------------------
# 4.1 Signature / type system
# ---------------------------------------------------------------------------
# Grammar (CONTRACTS.md §4.1), mirrored from packages/shared/src/types/signature.ts:
#   int | float | bool | str
#   | TreeNode | ListNode        (M3, non-nullable root)
#   | TreeNode? | ListNode?      (M3, nullable root)
#   | list[<ParamType>]          (arbitrarily nested, e.g. "list[list[int]]")

ScalarName = Literal["int", "float", "bool", "str"]

_SCALAR_RE = re.compile(r"^(int|float|bool|str)$")
_TREE_NODE_RE = re.compile(r"^TreeNode(\?)?$")
_LINKED_LIST_NODE_RE = re.compile(r"^ListNode(\?)?$")
_LIST_WRAPPER_RE = re.compile(r"^list\[(.*)\]$", re.DOTALL)


class ScalarAst(TypedDict):
    kind: Literal["scalar"]
    name: ScalarName


class ListAst(TypedDict):
    kind: Literal["list"]
    of: ParamTypeAst


class TreeAst(TypedDict):
    kind: Literal["tree"]
    nullable: bool


class LinkedListAst(TypedDict):
    kind: Literal["linkedlist"]
    nullable: bool


ParamTypeAst = ScalarAst | ListAst | TreeAst | LinkedListAst


def parse_param_type(raw: str) -> ParamTypeAst:
    """Parses a ParamType string into its discriminated AST. Raises ValueError with a
    descriptive message on invalid input. Mirrors `parseParamType` in
    `packages/shared/src/types/signature.ts` field-for-field (`kind`, `name`, `of`, `nullable`)
    so the two ASTs are structurally identical once serialized to JSON."""
    trimmed = raw.strip() if isinstance(raw, str) else ""

    if _SCALAR_RE.match(trimmed):
        scalar: ScalarAst = {"kind": "scalar", "name": trimmed}  # type: ignore[typeddict-item]
        return scalar

    tree_match = _TREE_NODE_RE.match(trimmed)
    if tree_match:
        tree: TreeAst = {"kind": "tree", "nullable": tree_match.group(1) == "?"}
        return tree

    ll_match = _LINKED_LIST_NODE_RE.match(trimmed)
    if ll_match:
        ll: LinkedListAst = {"kind": "linkedlist", "nullable": ll_match.group(1) == "?"}
        return ll

    list_match = _LIST_WRAPPER_RE.match(trimmed)
    if list_match:
        inner = list_match.group(1) or ""
        lst: ListAst = {"kind": "list", "of": parse_param_type(inner)}
        return lst

    raise ValueError(f'Invalid ParamType: "{raw}"')


def is_valid_param_type(value: object) -> bool:
    """True iff `value` parses as a valid ParamType string. Never raises."""
    if not isinstance(value, str):
        return False
    try:
        parse_param_type(value)
        return True
    except ValueError:
        return False


def _check_param_type(value: str) -> str:
    if not is_valid_param_type(value):
        raise ValueError(
            "Invalid ParamType (expected int|float|bool|str|TreeNode[?]|ListNode[?]|"
            f'list[<ParamType>]): "{value}"'
        )
    return value


ParamType = Annotated[str, AfterValidator(_check_param_type)]


class Param(BaseModel):
    name: str = Field(min_length=1)
    type: ParamType


class Signature(BaseModel):
    name: str = Field(min_length=1)
    params: list[Param] = Field(default_factory=list)
    returns: ParamType


# ---------------------------------------------------------------------------
# Shared small shapes
# ---------------------------------------------------------------------------


class Example(BaseModel):
    args: list[Any]
    expected: Any
    explanation: str


class ConceptRef(BaseModel):
    """A concept attached to a ProblemVersion (CONTRACTS.md §4.2 `concepts` array element)."""

    id: str
    role: Literal["primary", "secondary"]
    weight: float = Field(ge=0.0, le=1.0)


class Difficulty(BaseModel):
    rating: int = Field(ge=600, le=3000)
    confidence: Literal["generated", "verified", "calibrated"]


class TargetComplexity(BaseModel):
    time: str
    space: str


class Provenance(BaseModel):
    mode: Literal["novel", "template", "composed"]
    model: str
    prompt_version: str
    generated_at: str


class TestCase(BaseModel):
    args: list[Any]
    expected: Any
    origin: Literal["example", "random", "boundary", "adversarial"]
    seed: int | None = None

    #: Not a pytest test class — this name just matches CONTRACTS.md §4.2's `TestCaseSchema`
    #: verbatim. Silences pytest's "cannot collect ... has an __init__ constructor" warning.
    __test__ = False


class HintLadder(BaseModel):
    l1_orientation: str
    l2_conceptual: str
    l3_structural: str
    outline: str
    editorial_md: str


# ---------------------------------------------------------------------------
# 4.2 ProblemVersion
# ---------------------------------------------------------------------------

#: Fields that must never be serialized to a client. `checker_py` is included even though it's
#: optional/absent for most comparators, since when present it can leak checker logic that
#: doubles as a partial solution.
SERVER_ONLY_FIELDS: tuple[str, ...] = (
    "hidden_tests",
    "mutants_py",
    "reference_solution_py",
    "brute_force_py",
    "input_generator_py",
    "checker_py",
)


class ProblemVersion(BaseModel):
    problem_id: str
    version: int = Field(gt=0)
    title: str
    internal_name: str
    statement_md: str
    constraints_md: str
    signature: Signature
    examples: list[Example] = Field(min_length=1)
    concepts: list[ConceptRef] = Field(min_length=1)
    difficulty: Difficulty
    expected_active_minutes: tuple[int, int]
    target_complexity: TargetComplexity
    reference_solution_py: str
    brute_force_py: str
    input_generator_py: str
    comparator: Literal["exact", "float_tol", "unordered", "checker_py"]
    checker_py: str | None = None
    hidden_tests: list[TestCase] = Field(default_factory=list)  # SERVER ONLY
    mutants_py: list[str] = Field(default_factory=list)  # SERVER ONLY
    hints: HintLadder
    provenance: Provenance
    state: Literal["candidate", "verifying", "approved", "rejected", "retired"]

    @field_validator("expected_active_minutes")
    @classmethod
    def _minutes_ascending(cls, v: tuple[int, int]) -> tuple[int, int]:
        low, high = v
        if low <= 0 or high <= 0:
            raise ValueError("expected_active_minutes must both be positive")
        if low > high:
            raise ValueError("expected_active_minutes must be ascending (low <= high)")
        return v

    @model_validator(mode="after")
    def _concept_weights_sum_to_one(self) -> ProblemVersion:
        total = sum(c.weight for c in self.concepts)
        if abs(total - 1.0) > 0.01:
            raise ValueError(f"concept weights must sum to ~1.0 (±0.01); got {total!r}")
        return self

    @model_validator(mode="after")
    def _exactly_one_primary_concept(self) -> ProblemVersion:
        primaries = [c for c in self.concepts if c.role == "primary"]
        if len(primaries) != 1:
            raise ValueError(f"exactly one concept must have role='primary'; got {len(primaries)}")
        return self

    def public_dict(self, taken_hint_levels: tuple[str, ...] = ()) -> dict[str, Any]:
        """Returns this ProblemVersion as a plain dict with every server-only field stripped
        (`SERVER_ONLY_FIELDS`) and every hint whose level is not in `taken_hint_levels` removed
        (default: none taken, so `hints` comes back empty). This is NOT `toPublicProblem` —
        that TS function in `@leetmind/shared` is the only thing allowed to build the
        API-facing `PublicProblem` shape (CONTRACTS.md §4.2) — this exists as an equivalent
        safety net for anywhere the Python side might otherwise be tempted to hand out a full
        ProblemVersion (logs, debug tooling, tests)."""
        taken = set(taken_hint_levels)
        data = self.model_dump(mode="json")
        for field_name in SERVER_ONLY_FIELDS:
            data.pop(field_name, None)
        hints = data.get("hints")
        if isinstance(hints, dict):
            data["hints"] = {k: v for k, v in hints.items() if k in taken}
        return data


# ---------------------------------------------------------------------------
# 4.4 Job kinds, payloads, priorities
# ---------------------------------------------------------------------------

JobKind = Literal["judge", "verify", "generate"]

#: lower = sooner (CONTRACTS.md §4.4)
JOB_PRIORITY: dict[JobKind, int] = {"judge": 10, "verify": 50, "generate": 100}


class GenerationConceptWeight(BaseModel):
    id: str
    weight: float = Field(ge=0.0, le=1.0)


class GenerationRequest(BaseModel):
    concepts: list[GenerationConceptWeight]
    target_rating: float
    rating_tolerance: float
    expected_minutes: tuple[int, int]
    target_complexity: TargetComplexity | None = None
    required_patterns: list[str] = Field(default_factory=list)
    forbidden_patterns: list[str] = Field(default_factory=list)
    similarity_exclusions: list[str] = Field(default_factory=list)
    comparator_hint: str | None = None
    allow_types: list[str] = Field(default_factory=list)
    prompt_version: str


class JudgeJobPayload(BaseModel):
    submission_id: str
    mode: Literal["run", "submit"]
    language: Literal["python", "cpp"]
    problem_version_id: str
    user_id: str


class VerifyJobPayload(BaseModel):
    problem_version_id: str
    correlation_id: str | None = None


class GenerateJobPayload(BaseModel):
    request: GenerationRequest
    correlation_id: str | None = None


# ---------------------------------------------------------------------------
# Verification gate (CONTRACTS.md §10)
# ---------------------------------------------------------------------------


class StageResult(BaseModel):
    stage: str
    status: Literal["passed", "failed", "skipped"]
    duration_ms: int
    details: dict[str, Any] = Field(default_factory=dict)


class VerificationReport(BaseModel):
    """Mirrors the `verification_reports` table (CONTRACTS.md §3)."""

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(default_factory=lambda: str(ULID()))
    problem_version_id: str
    passed: bool
    failed_stage: str | None = None
    stages: list[StageResult]
    seeds: list[int] = Field(default_factory=list)
    counterexample: dict[str, Any] | None = None
    solution_hashes: dict[str, str] = Field(default_factory=dict)
    duration_ms: int | None = None
    correlation_id: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


# ---------------------------------------------------------------------------
# model_runs (CONTRACTS.md §3, §11)
# ---------------------------------------------------------------------------


class ModelRun(BaseModel):
    """Mirrors the `model_runs` table (CONTRACTS.md §3)."""

    id: str = Field(default_factory=lambda: str(ULID()))
    kind: Literal["generate", "repair"]
    invoker: str
    model: str | None = None
    prompt_version: str
    request: dict[str, Any]
    duration_ms: int | None = None
    output_hash: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    problem_version_id: str | None = None
    status: Literal["ok", "schema_error", "invoke_error"]
    error: str | None = None
    correlation_id: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
