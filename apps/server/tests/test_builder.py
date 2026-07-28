"""Pure unit tests for the builder's structural validation (PLAN_BACKEND.md §7.3). No DB, no
Docker, no LLM — content quality (is the reference actually correct) is verify.py's job."""

from __future__ import annotations

from leetmind.builder import BuilderOutput, _validate_structure
from tests.llm_fixtures import sum_problem_builder_output


def _output(**overrides: object) -> BuilderOutput:
    data = sum_problem_builder_output()
    data.update(overrides)
    return BuilderOutput.model_validate(data)


def test_valid_output_passes():
    assert _validate_structure(_output()) is None


def test_wrong_hint_count_rejected():
    output = _output(hints=["only one hint"])
    assert "hints" in (_validate_structure(output) or "")


def test_empty_hint_rejected():
    data = sum_problem_builder_output()
    data["hints"] = ["", "b", "c", "d"]
    output = BuilderOutput.model_validate(data)
    assert "empty" in (_validate_structure(output) or "")


def test_too_few_public_tests_rejected():
    data = sum_problem_builder_output()
    data["public_tests"] = data["public_tests"][:1]
    output = BuilderOutput.model_validate(data)
    assert "public_tests" in (_validate_structure(output) or "")


def test_too_few_private_tests_rejected():
    data = sum_problem_builder_output()
    data["private_tests"] = data["private_tests"][:2]
    output = BuilderOutput.model_validate(data)
    assert "private_tests" in (_validate_structure(output) or "")


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
    output = _output(par_minutes=0)
    assert "par_minutes" in (_validate_structure(output) or "")


def test_empty_title_rejected():
    output = _output(title="   ")
    assert "title" in (_validate_structure(output) or "")
