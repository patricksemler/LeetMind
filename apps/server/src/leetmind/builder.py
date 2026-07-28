"""Step 2 of the generation pipeline (PLAN_BACKEND.md §7.3) plus the independent oracle call
(amendment 32).

Unlike the planner, the builder has no deterministic fallback — a full problem can't be
synthesized without a model — so a call that can't be coaxed into a structurally valid shape
after one re-ask raises `BuilderError` and the worker's repair loop (§7.1) takes over: either a
targeted repair prompt (verification found a disagreement) or, eventually, giving up on the job.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from leetmind.llm import LLMClient, LLMError
from leetmind.planner import DIFFICULTY_RUBRIC, Plan
from leetmind.schemas import Complexity, Signature, ValueType

logger = logging.getLogger("leetmind.builder")

PUBLIC_TEST_RANGE = (3, 4)
PRIVATE_TEST_RANGE = (8, 12)
CONSTRAINT_RANGE = (2, 6)
HINT_RUNGS = 4
STATEMENT_MAX_CHARS = 650
STATEMENT_PREFERRED_RANGE = (350, 550)
CONSTRAINT_MAX_CHARS = 160

# `statement_md` is intentionally only the problem description. Public examples and constraints
# have first-class fields and dedicated UI sections; accepting those headings here recreates the
# duplicate, overly long statement this split is meant to prevent.
_ROUTED_IO_HEADING_RE = re.compile(
    r"(?im)^\s{0,3}(?:#{1,6}\s*)?(?:input|output)\s*:"
)
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
    signature: Signature
    starter_code: str = Field(min_length=1)
    public_tests: list[BuilderTest] = Field(min_length=3, max_length=4)
    private_tests: list[BuilderTest] = Field(min_length=8, max_length=12)
    hints: list[str] = Field(min_length=4, max_length=4)
    reference_solution: str = Field(min_length=1)
    input_generator: str = Field(min_length=1)
    complexity: Complexity
    par_minutes: int = Field(gt=0, le=180)


class OracleOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    brute_solution: str


class QualityReviewOutput(BaseModel):
    """An independent semantic check that the generated content matches the activity-selected
    plan. Executable verification cannot catch a correct problem filed under the wrong concept."""

    model_config = ConfigDict(extra="forbid")

    aligned_with_plan: bool
    issues: list[str]


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


def _type_str(t: ValueType) -> str:
    leaf = f"{t.kind}?" if t.nullable else t.kind
    return "[" * t.list_depth + leaf + "]" * t.list_depth


def _validate_structure(output: BuilderOutput) -> str | None:
    """First violation found, or `None` if the output is structurally sound. Content quality
    (is the statement good, is the reference solution actually correct) is verify.py's job —
    this only catches shapes that would break the judge or the value contract."""
    if not output.title.strip():
        return "title must not be empty"
    if not output.statement_md.strip():
        return "statement_md must not be empty"
    if len(output.statement_md) > STATEMENT_MAX_CHARS:
        return f"statement_md must be at most {STATEMENT_MAX_CHARS} characters"
    if (
        _ROUTED_IO_HEADING_RE.search(output.statement_md)
        or _EXAMPLE_TERM_RE.search(output.statement_md)
        or _CONSTRAINT_TERM_RE.search(output.statement_md)
    ):
        return (
            "statement_md must not contain examples, constraints, or input/output sections; "
            "route them to public_tests and constraints"
        )

    lo, hi = CONSTRAINT_RANGE
    if not (lo <= len(output.constraints) <= hi):
        return f"constraints must have {lo}-{hi} entries"
    if any(not constraint.strip() for constraint in output.constraints):
        return "constraints must not contain empty strings"
    if any(len(constraint) > CONSTRAINT_MAX_CHARS for constraint in output.constraints):
        return f"each constraint must be at most {CONSTRAINT_MAX_CHARS} characters"

    if len(output.hints) != HINT_RUNGS:
        return f"hints must have exactly {HINT_RUNGS} entries, one per rung"
    if any(not h.strip() for h in output.hints):
        return "hints must not contain empty strings"

    lo, hi = PUBLIC_TEST_RANGE
    if not (lo <= len(output.public_tests) <= hi):
        return f"public_tests must have {lo}-{hi} cases"
    lo, hi = PRIVATE_TEST_RANGE
    if not (lo <= len(output.private_tests) <= hi):
        return f"private_tests must have {lo}-{hi} cases"

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
    if output.par_minutes <= 0:
        return "par_minutes must be positive"
    return None


def _render_builder_prompt(plan: Plan, *, repair: RepairContext | None = None) -> str:
    base = f"""\
Generate one algorithm practice problem as JSON.

Plan (already decided, do not change):
- primary_type: {plan.primary_type}
- support_types: {plan.support_types}
- shape: {plan.shape}
- target problem_rating: {plan.problem_rating}
- premise: {plan.premise}

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
- signature: func_name, params (name + type), returns (type), order_insensitive if applicable —
  each `type` field is an OBJECT per the example above, never a bare string.
- starter_code: a Python stub defining `def <func_name>(...): ...` with a stub body, matching
  the signature exactly.
- public_tests: 3-4 self-contained example cases, each
  {{"args": [...], "expected": v}}. These are the ONLY worked examples and are rendered by the
  app's Examples section, so do not duplicate them in statement_md.
- private_tests: 8-12 cases including edge cases, same shape as public_tests, never shown to the
  user. Re-check every authored expected value against reference_solution before responding.
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
signature, starter_code, public_tests, private_tests, hints, reference_solution,
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


def _render_oracle_prompt(
    statement_md: str, constraints: list[str], signature: Signature
) -> str:
    params = ", ".join(f"{p.name}: {_type_str(p.type)}" for p in signature.params)
    constraint_lines = "\n".join(f"- {constraint}" for constraint in constraints)
    return f"""\
You are an independent verifier. You have NOT seen any proposed solution, test cases, or prior
conversation about this problem — only the statement below. Write a deliberately NAIVE but
obviously-correct Python solution (favor correctness over performance; brute force is fine, as
inputs are kept small).

Problem statement:
{statement_md}

Constraints:
{constraint_lines}

Required function signature: def {signature.func_name}({params}) -> {_type_str(signature.returns)}

Value contract:
{VALUE_GRAMMAR}

Respond with ONLY a JSON object with exactly one key, "brute_solution", whose value is the
complete Python source (as a single string) defining `def {signature.func_name}(...):`. No
markdown fences, no prose outside the JSON.
"""


def _render_quality_review_prompt(plan: Plan, output: BuilderOutput) -> str:
    return f"""\
You are an independent curriculum reviewer for an algorithm-practice app. Decide whether the
generated problem genuinely matches the learner-activity plan below. A problem is NOT aligned
merely because its story or metadata names the target technique.

Plan:
- primary_type: {plan.primary_type}
- support_types: {plan.support_types}
- shape: {plan.shape}
- problem_rating: {plan.problem_rating}
- premise: {plan.premise}

Difficulty rubric:
{DIFFICULTY_RUBRIC}

Generated problem:
- title: {output.title}
- statement_md: {output.statement_md}
- constraints: {output.constraints}
- signature: {output.signature.model_dump_json()}
- target complexity: {output.complexity.model_dump_json()}
- reference solution:
{output.reference_solution}

Set aligned_with_plan=false if ANY of these are true:
1. The efficient reference solution does not centrally exercise `primary_type`, or the problem's
   input properties invalidate that technique and force a materially different one.
2. The requested `shape` does not describe the actual computational task.
3. The target complexity or structural difficulty is implausible for the requested rating band.
4. The statement, constraints, and reference solution disagree about what problem is being solved.

Support types may appear, but they must not replace the primary type. When false, provide 1-3
short, concrete issues that tell the builder exactly what to change.

Respond with ONLY a JSON object with exactly these keys:
{{"aligned_with_plan": true_or_false, "issues": ["..."]}}
No markdown fences and no prose outside the JSON.
"""


async def _call_builder(llm: LLMClient, prompt: str) -> BuilderOutput:
    current_prompt = prompt
    last_error: str | None = None
    for attempt in range(2):  # one original call + one re-ask on violation (decision 10)
        try:
            output = await llm.complete(current_prompt, BuilderOutput)
        except (LLMError, ValidationError) as exc:
            last_error = str(exc)
            logger.warning("builder CLI call failed (attempt %d): %s", attempt, exc)
            current_prompt = (
                f"{prompt}\n\nYour previous response failed: {exc}\nRespond again with "
                "corrected JSON."
            )
            continue
        error = _validate_structure(output)
        if error is None:
            return output
        last_error = error
        logger.warning("builder output violated constraints (attempt %d): %s", attempt, error)
        current_prompt = f"{prompt}\n\nYour previous answer was invalid: {error}\nRespond again."
    raise BuilderError(f"builder CLI could not produce a valid problem: {last_error}")


async def _call_oracle(llm: LLMClient, output: BuilderOutput) -> str:
    prompt = _render_oracle_prompt(output.statement_md, output.constraints, output.signature)
    current_prompt = prompt
    last_error: str | None = None
    for attempt in range(2):
        try:
            oracle = await llm.complete(current_prompt, OracleOutput)
        except (LLMError, ValidationError) as exc:
            last_error = str(exc)
            logger.warning("oracle CLI call failed (attempt %d): %s", attempt, exc)
            current_prompt = f"{prompt}\n\nYour previous response failed: {exc}\nRespond again."
            continue
        if f"def {output.signature.func_name}" not in oracle.brute_solution:
            last_error = f"brute_solution must define def {output.signature.func_name}(...)"
            logger.warning(
                "oracle output violated constraints (attempt %d): %s", attempt, last_error
            )
            current_prompt = f"{prompt}\n\n{last_error}\nRespond again."
            continue
        return oracle.brute_solution
    raise BuilderError(f"oracle CLI could not produce a valid brute-force solution: {last_error}")


async def _call_quality_reviewer(
    llm: LLMClient, plan: Plan, output: BuilderOutput
) -> QualityReviewOutput:
    prompt = _render_quality_review_prompt(plan, output)
    current_prompt = prompt
    last_error: str | None = None
    for attempt in range(2):
        try:
            review = await llm.complete(current_prompt, QualityReviewOutput)
        except (LLMError, ValidationError) as exc:
            last_error = str(exc)
            logger.warning("quality reviewer CLI call failed (attempt %d): %s", attempt, exc)
            current_prompt = f"{prompt}\n\nYour previous response failed: {exc}\nRespond again."
            continue
        if review.aligned_with_plan or review.issues:
            return review
        last_error = "issues must explain why aligned_with_plan is false"
        current_prompt = f"{prompt}\n\n{last_error}\nRespond again."
    raise BuilderError(f"quality reviewer could not produce a valid review: {last_error}")


async def build_problem(
    llm: LLMClient, plan: Plan, *, repair: RepairContext | None = None
) -> BuiltProblem:
    """The full step-2 pipeline: build, independently review alignment with the activity-selected
    plan (one rebuild on mismatch), then ask a separate oracle for a brute solution. The oracle
    still sees no authored solution or tests, preserving amendment 32's independence."""
    quality_repair = repair
    last_issues: list[str] = []
    for attempt in range(2):
        prompt = _render_builder_prompt(plan, repair=quality_repair)
        output = await _call_builder(llm, prompt)
        review = await _call_quality_reviewer(llm, plan, output)
        if review.aligned_with_plan:
            brute_solution = await _call_oracle(llm, output)
            return BuiltProblem(output=output, brute_solution=brute_solution)

        last_issues = review.issues
        logger.warning(
            "builder output failed activity alignment (attempt %d): %s", attempt, last_issues
        )
        quality_repair = RepairContext(
            previous_output=output.model_dump(mode="json"),
            failure_report=(
                "Independent curriculum review found that the generated problem does not match "
                f"the activity-selected plan: {'; '.join(last_issues)}"
            ),
        )

    raise BuilderError(
        "builder could not align the problem with the activity-selected plan: "
        + "; ".join(last_issues)
    )
