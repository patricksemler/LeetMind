"""Real-Docker differential verification tests (PLAN_BACKEND.md §7.4, §12): a correct problem
passes all three gates; a wrong reference solution and a seeded wrong `expected` value are both
caught."""

from __future__ import annotations

import asyncio

from leetmind.builder import BuilderOutput, BuiltProblem
from leetmind.config import Settings
from leetmind.judge import JudgeClient
from leetmind.schemas import TestOutcome, Verdict
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
    buggy = bool(builder_overrides.pop("buggy", False))
    title = str(builder_overrides.pop("title", "Sum It Up"))
    data = sum_problem_builder_output(buggy=buggy, title=title)
    data.update(builder_overrides)
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

    phases: list[str] = []

    async def on_phase(phase: str) -> None:
        phases.append(phase)

    result = await verify_problem(judge, built, settings=settings, on_phase=on_phase)

    assert not result.ok
    kinds = {d.kind for d in result.disagreements}
    assert "reference_failed_authored" in kinds
    assert "oracle_failed_authored" in kinds
    assert phases == ["checking_examples"]  # randomized solution probes never start


async def test_verify_rejects_an_impure_batched_generator(judge_image: str):
    judge, settings = _verify_client(judge_image)
    impure_generator = (
        "calls = 0\n"
        "def generate(seed):\n"
        "    global calls\n"
        "    calls += 1\n"
        "    return [[seed, calls]]\n"
    )

    result = await verify_problem(
        judge,
        _built(input_generator=impure_generator),
        settings=settings,
    )

    assert not result.ok
    assert [d.kind for d in result.disagreements] == ["generator_failed"]


async def test_verify_catches_a_randomized_only_disagreement(judge_image: str):
    judge, settings = _verify_client(judge_image)
    random_only_bug = (
        "def solve(nums):\n"
        "    total = sum(nums)\n"
        "    return total + 1 if nums == [3, -9, -2] else total\n"
    )

    result = await verify_problem(
        judge,
        _built(reference_solution=random_only_bug),
        settings=settings,
    )

    assert not result.ok
    assert {d.kind for d in result.disagreements} == {"reference_oracle_mismatch"}


async def test_reference_and_oracle_gates_run_concurrently():
    built = _built()

    class ConcurrentJudge:
        def __init__(self) -> None:
            self.active = 0
            self.max_active = 0

        def session(self, execution_id, code, func_name, **kwargs):  # noqa: ANN001, ANN201
            judge = self

            class Session:
                async def __aenter__(self):  # noqa: ANN204
                    return self

                async def __aexit__(self, exc_type, exc, tb):  # noqa: ANN001, ANN201
                    return None

                async def run(self, tests):  # noqa: ANN001, ANN202
                    if "verify-gen-" in execution_id:
                        yield TestOutcome(
                            index=0,
                            verdict=Verdict.PASS,
                            value=[[[seed]] for seed in range(50)],
                        )
                        return
                    judge.active += 1
                    judge.max_active = max(judge.max_active, judge.active)
                    try:
                        await asyncio.sleep(0.01)
                        for index, test in enumerate(tests):
                            value = test.expected if test.expected is not None else 0
                            yield TestOutcome(index=index, verdict=Verdict.PASS, value=value)
                    finally:
                        judge.active -= 1

            return Session()

    judge = ConcurrentJudge()
    result = await verify_problem(judge, built)  # type: ignore[arg-type]

    assert result.ok
    assert judge.max_active == 2
