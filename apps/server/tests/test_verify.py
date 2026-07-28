"""Real-Docker differential verification tests (PLAN_BACKEND.md §7.4, §12): a correct problem
passes all three gates; a wrong reference solution and a seeded wrong `expected` value are both
caught."""

from __future__ import annotations

from leetmind.builder import BuilderOutput, BuiltProblem
from leetmind.config import Settings
from leetmind.judge import JudgeClient
from leetmind.verify import verify_problem
from tests.llm_fixtures import sum_problem_builder_output, sum_problem_oracle_output


def _verify_client(judge_image: str) -> tuple[JudgeClient, Settings]:
    settings = Settings(
        _env_file=None,
        judge_image=judge_image,
        judge_verify_wall_s=30.0,
        judge_per_test_limit_s=2.0,
        judge_oracle_limit_s=5.0,
    )
    return JudgeClient(settings), settings


def _built(**builder_overrides: object) -> BuiltProblem:
    data = sum_problem_builder_output(**builder_overrides)  # type: ignore[arg-type]
    output = BuilderOutput.model_validate(data)
    return BuiltProblem(output=output, brute_solution=sum_problem_oracle_output()["brute_solution"])


async def test_verify_passes_for_a_correct_problem(judge_image: str):
    judge, settings = _verify_client(judge_image)

    result = await verify_problem(judge, _built(), settings=settings)

    assert result.ok, result.report()


async def test_verify_catches_a_wrong_reference_solution(judge_image: str):
    judge, settings = _verify_client(judge_image)

    result = await verify_problem(judge, _built(buggy=True), settings=settings)

    assert not result.ok
    assert any(d.kind == "reference_failed_authored" for d in result.disagreements)


async def test_verify_catches_a_seeded_wrong_expected_output(judge_image: str):
    """§12's literal scenario: a wrong claimed `expected` on an authored test, with both the
    reference solution and the independent oracle actually correct."""
    judge, settings = _verify_client(judge_image)
    data = sum_problem_builder_output()
    data["public_tests"][0]["expected"] = 999  # sum([1, 2, 3]) is 6, not 999
    output = BuilderOutput.model_validate(data)
    built = BuiltProblem(
        output=output, brute_solution=sum_problem_oracle_output()["brute_solution"]
    )

    result = await verify_problem(judge, built, settings=settings)

    assert not result.ok
    kinds = {d.kind for d in result.disagreements}
    assert "reference_failed_authored" in kinds
    assert "oracle_failed_authored" in kinds
