"""Pure unit tests for the builder's structural validation (PLAN_BACKEND.md §7.3). No DB, no
Docker, no LLM — content quality (is the reference actually correct) is verify.py's job."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from leetmind.builder import (
    STATEMENT_MAX_CHARS,
    BuilderOutput,
    OracleOutput,
    QualityReviewOutput,
    _render_builder_prompt,
    _validate_structure,
    build_problem,
)
from leetmind.planner import Plan
from tests.llm_fixtures import sum_problem_builder_output, sum_problem_oracle_output


def _output(**overrides: object) -> BuilderOutput:
    data = sum_problem_builder_output()
    data.update(overrides)
    return BuilderOutput.model_validate(data)


def test_valid_output_passes():
    assert _validate_structure(_output()) is None


def test_wrong_hint_count_rejected():
    with pytest.raises(ValidationError, match="hints"):
        _output(hints=["only one hint"])


def test_empty_hint_rejected():
    data = sum_problem_builder_output()
    data["hints"] = ["", "b", "c", "d"]
    output = BuilderOutput.model_validate(data)
    assert "empty" in (_validate_structure(output) or "")


def test_too_few_public_tests_rejected():
    data = sum_problem_builder_output()
    data["public_tests"] = data["public_tests"][:1]
    with pytest.raises(ValidationError, match="public_tests"):
        BuilderOutput.model_validate(data)


def test_too_few_private_tests_rejected():
    data = sum_problem_builder_output()
    data["private_tests"] = data["private_tests"][:2]
    with pytest.raises(ValidationError, match="private_tests"):
        BuilderOutput.model_validate(data)


def test_duplicate_param_names_rejected():
    data = sum_problem_builder_output()
    data["signature"]["params"] = [
        {"name": "x", "type": {"kind": "int"}},
        {"name": "x", "type": {"kind": "int"}},
    ]
    output = BuilderOutput.model_validate(data)
    assert "unique" in (_validate_structure(output) or "")


def test_test_args_arity_mismatch_rejected():
    data = sum_problem_builder_output()
    data["public_tests"][0]["args"] = [[1, 2], 99]  # solve(nums) takes exactly one arg
    output = BuilderOutput.model_validate(data)
    assert "args" in (_validate_structure(output) or "")


def test_starter_code_missing_func_name_rejected():
    output = _output(starter_code="def other():\n    pass\n")
    assert "starter_code" in (_validate_structure(output) or "")


def test_reference_solution_missing_func_name_rejected():
    output = _output(reference_solution="def other():\n    return 0\n")
    assert "reference_solution" in (_validate_structure(output) or "")


def test_input_generator_missing_generate_rejected():
    output = _output(input_generator="def make_input(seed):\n    return [[1]]\n")
    assert "input_generator" in (_validate_structure(output) or "")


def test_zero_par_minutes_rejected():
    with pytest.raises(ValidationError, match="par_minutes"):
        _output(par_minutes=0)


def test_empty_title_rejected():
    output = _output(title="   ")
    assert "title" in (_validate_structure(output) or "")


def test_oversized_statement_rejected():
    with pytest.raises(ValidationError, match="statement_md"):
        _output(statement_md="x" * (STATEMENT_MAX_CHARS + 1))


def test_examples_are_rejected_from_statement():
    output = _output(statement_md="Return the sum.\n\nExample 1:\nnums = [1, 2]")
    assert "public_tests" in (_validate_structure(output) or "")


def test_inline_example_is_rejected_from_statement():
    output = _output(statement_md="Return the sum. For example, two values may be equal.")
    assert "public_tests" in (_validate_structure(output) or "")


def test_constraints_are_rejected_from_statement():
    output = _output(statement_md="Return the sum.\n\n## Constraints\n`1 <= n <= 100`")
    assert "constraints" in (_validate_structure(output) or "")


def test_ordinary_input_sentence_is_allowed():
    output = _output(statement_md="Inputs are integers. Return their sum.")
    assert _validate_structure(output) is None


def test_wrong_constraint_count_rejected():
    with pytest.raises(ValidationError, match="constraints"):
        _output(constraints=[])


def test_empty_constraint_rejected():
    with pytest.raises(ValidationError, match="constraints"):
        _output(constraints=["1 <= n <= 100", "  "])


def test_long_constraint_rejected():
    with pytest.raises(ValidationError, match="constraints"):
        _output(constraints=["1 <= n <= 100", "x" * 161])


def test_builder_schema_enforces_compact_generation_limits():
    properties = BuilderOutput.model_json_schema()["properties"]

    assert properties["statement_md"]["maxLength"] == STATEMENT_MAX_CHARS
    assert properties["constraints"]["minItems"] == 2
    assert properties["constraints"]["maxItems"] == 6
    assert properties["public_tests"]["minItems"] == 3
    assert properties["public_tests"]["maxItems"] == 4
    assert properties["private_tests"]["minItems"] == 8
    assert properties["private_tests"]["maxItems"] == 12
    assert properties["hints"]["minItems"] == 4
    assert properties["hints"]["maxItems"] == 4


def test_builder_prompt_routes_display_sections_to_dedicated_fields():
    prompt = _render_builder_prompt(_plan())
    assert "Do NOT include worked examples" in prompt
    assert "the ONLY worked examples" in prompt
    assert "- constraints: 2-6 short strings" in prompt
    assert "aim for 350-550 characters" in prompt
    assert "mentally execute the final reference_solution" in prompt


def _plan() -> Plan:
    return Plan(
        primary_type="arrays_hashing",
        support_types=[],
        shape="optimize_subarray",
        problem_rating=1000,
        premise="Sum a batch of package weights.",
        is_probe=True,
    )


async def test_semantic_mismatch_is_rebuilt_before_oracle():
    bad = sum_problem_builder_output(title="Wrong technique")
    good = sum_problem_builder_output(title="Aligned technique")

    class ReviewThenAcceptLLM:
        def __init__(self):
            self.builder_calls = 0
            self.review_calls = 0
            self.oracle_calls = 0
            self.prompts: list[str] = []

        async def complete(self, prompt, schema):  # noqa: ANN001, ANN201
            self.prompts.append(prompt)
            if schema is BuilderOutput:
                self.builder_calls += 1
                return schema.model_validate(bad if self.builder_calls == 1 else good)
            if schema is QualityReviewOutput:
                self.review_calls += 1
                return schema.model_validate(
                    {
                        "aligned_with_plan": self.review_calls > 1,
                        "issues": (
                            []
                            if self.review_calls > 1
                            else ["The solution uses binary search, not arrays and hashing."]
                        ),
                    }
                )
            if schema is OracleOutput:
                self.oracle_calls += 1
                return schema.model_validate(sum_problem_oracle_output())
            raise AssertionError(f"unexpected schema: {schema}")

    llm = ReviewThenAcceptLLM()
    built = await build_problem(llm, _plan())

    assert built.output.title == "Aligned technique"
    assert llm.builder_calls == 2
    assert llm.review_calls == 2
    assert llm.oracle_calls == 1
    assert "does not match the activity-selected plan" in llm.prompts[2]
