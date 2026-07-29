"""Step 2 of the generation pipeline (PLAN_BACKEND.md §7.3) plus the independent oracle call
(amendment 32).

Unlike the planner, the builder has no deterministic fallback — a full problem can't be
synthesized without a model — so a call that can't be coaxed into a structurally valid shape
after one re-ask raises `BuilderError` and the worker's repair loop (§7.1) takes over: either a
targeted repair prompt (verification found a disagreement) or, eventually, giving up on the job.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from leetmind.llm import LLMClient, LLMError
from leetmind.planner import DIFFICULTY_RUBRIC, Plan
from leetmind.schemas import Complexity, Signature, ValueType

STATEMENT_MAX_CHARS = 650
STATEMENT_PREFERRED_RANGE = (350, 550)
CONSTRAINT_MAX_CHARS = 160

# `statement_md` is intentionally only the problem description. Public examples and constraints
# have first-class fields and dedicated UI sections; accepting those headings here recreates the
# duplicate, overly long statement this split is meant to prevent.
_ROUTED_IO_HEADING_RE = re.compile(r"(?im)^\s{0,3}(?:#{1,6}\s*)?(?:input|output)\s*:")
_EXAMPLE_TERM_RE = re.compile(r"(?i)\bexamples?\b")
_CONSTRAINT_TERM_RE = re.compile(r"(?i)\bconstraints?\b")
ConstraintText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=CONSTRAINT_MAX_CHARS),
]

HINT_RUNG_GUIDE = """\
1. orientation — restate the goal, no technique hint.
2. conceptual — name the general technique/pattern to use.
3. structural — describe the concrete data structure, invariant, or recurrence to use.
4. outline — a near-complete step-by-step approach, short of literal code."""

VALUE_GRAMMAR = """\
T ::= int | float | bool | str | T? | T[]  (nullable marker ?, list nesting [])
No dicts, tuples, or custom classes. Linked lists = value lists (int[]); binary trees =
level-order lists with nulls (int?[]); graphs = adjacency lists (int[][]) or edge lists.
Comparison is type-strict: bool never equals int, "1" never equals 1, floats compare with a
small tolerance. Declare order_insensitive=true on the signature only if the return is a
collection whose order doesn't matter (compared as a multiset)."""

SIGNATURE_JSON_EXAMPLE = """\
Every `type` above is a JSON OBJECT, never a shorthand string like "int[]" — for example, the
grammar type `int[]` (a plain list of ints) is written {"kind": "int", "list_depth": 1}, and
`int?[]` (a list of nullable ints) is {"kind": "int", "nullable": true, "list_depth": 1}. A full
signature for `def solve(nums: int[], target: int) -> int:` looks exactly like this:
{
  "func_name": "solve",
  "params": [
    {"name": "nums", "type": {"kind": "int", "nullable": false, "list_depth": 1}},
    {"name": "target", "type": {"kind": "int", "nullable": false, "list_depth": 0}}
  ],
  "returns": {"kind": "int", "nullable": false, "list_depth": 0},
  "order_insensitive": false
}"""


class BuilderError(RuntimeError):
    """The builder (or oracle) CLI couldn't be coaxed into a structurally valid response."""


class BuilderTest(BaseModel):
    __test__ = False  # not a pytest test despite the name
    model_config = ConfigDict(extra="forbid")

    args: list[Any]
    expected: Any


class BuilderOutput(BaseModel):
    """The builder CLI call's JSON-schema-validated output (§7.3)."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=80)
    statement_md: str = Field(min_length=1, max_length=STATEMENT_MAX_CHARS)
    constraints: list[ConstraintText] = Field(min_length=2, max_length=6)
    support_types: list[str] = Field(default_factory=list, max_length=2)
    signature: Signature
    starter_code: str = Field(min_length=1)
    public_tests: list[BuilderTest] = Field(min_length=3, max_length=3)
    private_tests: list[BuilderTest] = Field(min_length=8, max_length=8)
    hints: list[str] = Field(min_length=4, max_length=4)
    reference_solution: str = Field(min_length=1)
    input_generator: str = Field(min_length=1)
    complexity: Complexity
    par_minutes: int = Field(gt=0, le=180)


class IndependentReviewOutput(BaseModel):
    """One independent call owns both activity review and brute-force oracle generation.

    It never receives authored tests or the reference solution. A rejected candidate carries
    actionable issues; an accepted one must carry the independent solution used by differential
    verification.
    """

    model_config = ConfigDict(extra="forbid")

    aligned_with_plan: bool
    issues: list[str]
    brute_solution: str | None = None

    @model_validator(mode="after")
    def validate_decision(self) -> IndependentReviewOutput:
        if self.aligned_with_plan:
            if self.issues:
                raise ValueError("issues must be empty when aligned_with_plan is true")
            if not self.brute_solution or "def " not in self.brute_solution:
                raise ValueError("an aligned review must include a Python brute_solution")
        elif not self.issues:
            raise ValueError("a rejected review must include at least one repair issue")
        return self


@dataclass(frozen=True)
class BuiltProblem:
    output: BuilderOutput
    brute_solution: str


@dataclass(frozen=True)
class RepairContext:
    """Fed back into a repair build (§7.1): the prior attempt plus why it failed — either
    verify.py's disagreement report or a structural-validation message."""

    previous_output: dict[str, Any]
    failure_report: str


class ReviewRejected(BuilderError):
    def __init__(
        self,
        output: BuilderOutput,
        issues: list[str],
        *,
        reason: Literal["format", "activity_fit"],
    ) -> None:
        super().__init__("independent review rejected the candidate: " + "; ".join(issues))
        self.output = output
        self.issues = issues
        self.reason = reason


def _type_str(t: ValueType) -> str:
    leaf = f"{t.kind}?" if t.nullable else t.kind
    return "[" * t.list_depth + leaf + "]" * t.list_depth


def _validate_structure(output: BuilderOutput, plan: Plan | None = None) -> str | None:
    """First violation found, or `None` if the output is structurally sound. Content quality
    (is the statement good, is the reference solution actually correct) is verify.py's job —
    this only catches shapes that would break the judge or the value contract."""
    if not output.title.strip():
        return "title must not be empty"
    if not output.statement_md.strip():
        return "statement_md must not be empty"
    if (
        _ROUTED_IO_HEADING_RE.search(output.statement_md)
        or _EXAMPLE_TERM_RE.search(output.statement_md)
        or _CONSTRAINT_TERM_RE.search(output.statement_md)
    ):
        return (
            "statement_md must not contain examples, constraints, or input/output sections; "
            "route them to public_tests and constraints"
        )

    if plan is not None:
        if plan.primary_type in output.support_types:
            return "support_types must not include primary_type"
        if not set(output.support_types) <= set(plan.support_types):
            return f"support_types must be drawn from {sorted(plan.support_types)}"

    if any(not h.strip() for h in output.hints):
        return "hints must not contain empty strings"

    sig = output.signature
    if not sig.func_name.isidentifier():
        return "signature.func_name must be a valid Python identifier"
    names = [p.name for p in sig.params]
    if len(names) != len(set(names)):
        return "signature.params must have unique names"

    for label, tests in (
        ("public_tests", output.public_tests),
        ("private_tests", output.private_tests),
    ):
        for i, t in enumerate(tests):
            if len(t.args) != len(sig.params):
                return f"{label}[{i}].args must have {len(sig.params)} values (one per parameter)"

    if f"def {sig.func_name}" not in output.starter_code:
        return f"starter_code must define def {sig.func_name}(...)"
    if f"def {sig.func_name}" not in output.reference_solution:
        return f"reference_solution must define def {sig.func_name}(...)"
    if "def generate" not in output.input_generator:
        return "input_generator must define def generate(seed)"
    return None


def _render_builder_prompt(plan: Plan, *, repair: RepairContext | None = None) -> str:
    recent = plan.recent_problems or []
    recent_lines = (
        "\n".join(
            f'- "{item.get("title", "")}": {item.get("premise", "")[:500]}' for item in recent
        )
        or "- (none yet)"
    )
    legacy_hint = (
        f"\nA legacy plan suggested this scenario, but it is optional and must be changed if it "
        f"conflicts with the activity: {plan.premise}\n"
        if plan.premise
        else ""
    )
    base = f"""\
Generate one algorithm practice problem as JSON.

Activity plan (already decided):
- primary_type: {plan.primary_type}
- allowed_support_types: {plan.support_types}
- shape: {plan.shape}
- target problem_rating: {plan.problem_rating}
{legacy_hint}

Create the premise yourself. It must naturally require the primary type and requested shape; never
force a technique that a simpler or asymptotically better method makes unnecessary. You may use
zero to two allowed support types, but they must only scaffold the primary activity.

Avoid repeating these recent titles or scenarios:
{recent_lines}

Difficulty rubric — the problem's structure must match its target rating:
{DIFFICULTY_RUBRIC}

Value contract (the ONLY type system allowed for the signature and all test values):
{VALUE_GRAMMAR}

{SIGNATURE_JSON_EXAMPLE}

Before writing the JSON, silently check all of the following:
1. Technique fit: the efficient solution centrally uses `{plan.primary_type}` and the requested
   `{plan.shape}`. Do not add input properties that invalidate the target technique.
2. Difficulty fit: the structure matches rating {plan.problem_rating}. For ratings <=1000, use
   only the canonical basic pattern — no disguised hard variant or non-obvious invariant.
3. Test correctness: mentally execute the final reference_solution on EVERY public and private
   test and fix each expected value before responding.
4. Internal consistency: the statement, constraints, signature, tests, input generator,
   reference solution, and complexity all describe exactly the same problem.

Produce:
- title: short, original (not a known LeetCode title).
- statement_md: a CONCISE problem description in markdown, at most {STATEMENT_MAX_CHARS}
  characters; aim for {STATEMENT_PREFERRED_RANGE[0]}-{STATEMENT_PREFERRED_RANGE[1]} characters.
  Use 2-3 short paragraphs covering only the scenario, inputs, required result, and one essential
  edge-case rule if needed. Avoid repetition, motivation after the setup, technique discussion,
  and restating the same goal. Do NOT include worked examples, example/input/output headings,
  constraints, target complexity, solution analysis, or hints here; those have dedicated fields.
- constraints: 2-6 short strings (at most {CONSTRAINT_MAX_CHARS} characters each) containing only
  input bounds and guarantees, such as `1 <= nums.length <= 10^5`. They must match the signature,
  tests, and input generator. Do not repeat them in statement_md.
- support_types: 0-2 values drawn only from {plan.support_types}; use an empty list unless a
  support concept genuinely scaffolds the primary activity.
- signature: func_name, params (name + type), returns (type), order_insensitive if applicable —
  each `type` field is an OBJECT per the example above, never a bare string.
- starter_code: a Python stub defining `def <func_name>(...): ...` with a stub body, matching
  the signature exactly.
- public_tests: exactly 3 self-contained example cases, each
  {{"args": [...], "expected": v}}. These are the ONLY worked examples and are rendered by the
  app's Examples section, so do not duplicate them in statement_md.
- private_tests: exactly 8 cases including edge cases, same shape as public_tests, never shown
  to the user. Re-check every authored expected value against reference_solution before responding.
- hints: exactly 4 strings, one per rung, increasingly specific:
{HINT_RUNG_GUIDE}
- reference_solution: a correct, reasonably efficient Python solution defining the same function.
- input_generator: Python source defining `def generate(seed):` — a PURE function of an int seed
  that returns a list of positional arguments (matching signature.params, in order) for one
  random but small, valid input. Small enough that a naive/brute-force solution finishes quickly.
  It must never bias or compute an expected output — inputs only.
- complexity: {{"time": ..., "space": ...}} big-O strings for the reference solution.
- par_minutes: a reasonable target solve time in minutes for a learner at the target rating.

Respond with ONLY a JSON object with exactly these keys: title, statement_md, constraints,
support_types, signature, starter_code, public_tests, private_tests, hints, reference_solution,
input_generator, complexity, par_minutes. No markdown fences, no prose outside the JSON.
"""
    if repair is None:
        return base
    return f"""\
{base}

Your previous attempt failed verification. Previous JSON:
{json.dumps(repair.previous_output)}

Failure report:
{repair.failure_report}

Fix the problem so the reference solution, an independent brute-force oracle, and every test
agree. You may adjust the statement, tests, or either solution as needed — respond with the FULL
corrected JSON object (not a diff), matching the exact schema above.
"""


def _render_independent_review_prompt(plan: Plan, output: BuilderOutput) -> str:
    params = ", ".join(f"{p.name}: {_type_str(p.type)}" for p in output.signature.params)
    constraint_lines = "\n".join(f"- {constraint}" for constraint in output.constraints)
    return f"""\
You are the independent reviewer and brute-force oracle author for an algorithm-practice app.
You have NOT seen the authored tests or proposed reference solution.

Activity plan:
- primary_type: {plan.primary_type}
- selected_support_types: {output.support_types}
- shape: {plan.shape}
- problem_rating: {plan.problem_rating}

Public problem contract:
- title: {output.title}
- statement:
{output.statement_md}
- constraints:
{constraint_lines}
- signature: def {output.signature.func_name}({params}) -> {_type_str(output.signature.returns)}
- claimed complexity: {output.complexity.model_dump_json()}

Set aligned_with_plan=false when the natural efficient solution does not centrally exercise the
primary type, the task does not match the selected shape, a simpler/asymptotically better technique
invalidates the activity, the difficulty is implausible for the target rating, or the public
contract is internally inconsistent. Return 1-3 concise repair issues in that case and set
brute_solution=null.

When aligned_with_plan=true, issues must be empty and brute_solution must contain a deliberately
naive but obviously-correct Python implementation of the required function. Favor correctness over
performance; randomized verification inputs are intentionally small. The brute solution must be
derived only from this public contract.

Value contract:
{VALUE_GRAMMAR}

Respond with ONLY a JSON object with exactly these keys:
{{"aligned_with_plan": true_or_false, "issues": ["..."], "brute_solution": "..."_or_null}}
No markdown fences and no prose outside the JSON.
"""


async def _call_builder(llm: LLMClient, prompt: str) -> BuilderOutput:
    try:
        return await llm.complete(prompt, BuilderOutput)
    except (LLMError, ValidationError) as exc:
        raise BuilderError(f"builder CLI could not produce a valid problem: {exc}") from exc


async def _call_independent_reviewer(
    llm: LLMClient, plan: Plan, output: BuilderOutput
) -> IndependentReviewOutput:
    try:
        review = await llm.complete(
            _render_independent_review_prompt(plan, output), IndependentReviewOutput
        )
    except (LLMError, ValidationError) as exc:
        raise BuilderError(f"independent review failed: {exc}") from exc

    if review.aligned_with_plan:
        if f"def {output.signature.func_name}" not in (review.brute_solution or ""):
            raise BuilderError(
                f"independent review must define def {output.signature.func_name}(...)"
            )
    return review


async def build_problem(
    llm: LLMClient,
    plan: Plan,
    *,
    repair: RepairContext | None = None,
    on_review: Callable[[], Awaitable[None]] | None = None,
) -> BuiltProblem:
    """Two-call happy path: one creative draft, one independent review + oracle."""
    output = await _call_builder(llm, _render_builder_prompt(plan, repair=repair))
    structure_error = _validate_structure(output, plan)
    if structure_error is not None:
        raise ReviewRejected(output, [structure_error], reason="format")

    if on_review is not None:
        await on_review()
    review = await _call_independent_reviewer(llm, plan, output)
    if not review.aligned_with_plan:
        raise ReviewRejected(output, review.issues, reason="activity_fit")
    assert review.brute_solution is not None
    return BuiltProblem(output=output, brute_solution=review.brute_solution)
