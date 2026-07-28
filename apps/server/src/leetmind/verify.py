"""Independent-oracle differential verification (PLAN_BACKEND.md §7.4, amendments 24, 32, 33).

Runs in the same judge image users get, but under its own wall clock (`VERIFY_WALL`) — fifty
random cases times two solutions with a ten-second oracle cap cannot fit an interactive timeout,
and nobody is waiting synchronously on verification. Three mandatory gates:

1. Reference solution vs authored (public + private) tests — must pass 100%.
2. Independent brute-force oracle vs the same authored tests — must pass 100%.
3. Reference vs oracle agreement on `RANDOM_CASES` seeded inputs from the builder's own
   `input_generator`.

Gates 1 and 2 together already establish the three-way agreement on every authored input
(builder-expected = reference = oracle); gate 3 is the genuinely new check, since nothing
authored those random inputs' expected values — only reference/oracle agreement can validate
them. A problem that never verifies is never seen by a user.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from leetmind.builder import BuiltProblem
from leetmind.config import Settings, get_settings
from leetmind.judge import JudgeClient
from leetmind.schemas import Signature, TestCase, Verdict, ValueType, values_equal

RANDOM_CASES = 50
GENERATOR_LIMIT_S = 2.0
# The generator's own outcome value is read directly (`.value`), never verdict-compared, so this
# placeholder value_type is inert — TestCase just requires one to construct.
_PLACEHOLDER_TYPE = ValueType(kind="int")


@dataclass(frozen=True)
class Disagreement:
    kind: str
    detail: str


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    disagreements: list[Disagreement] = field(default_factory=list)

    def report(self) -> str:
        return "\n".join(f"- {d.kind}: {d.detail}" for d in self.disagreements)


def _to_test_cases(tests: Sequence[Any], signature: Signature) -> list[TestCase]:
    return [
        TestCase(
            args=t.args,
            expected=t.expected,
            value_type=signature.returns,
            order_insensitive=signature.order_insensitive,
        )
        for t in tests
    ]


async def verify_problem(
    judge: JudgeClient, built: BuiltProblem, *, settings: Settings | None = None
) -> VerifyResult:
    s = settings or get_settings()
    output = built.output
    signature = output.signature
    wall_s = s.judge_verify_wall_s

    authored_tests = _to_test_cases(output.public_tests + output.private_tests, signature)
    disagreements: list[Disagreement] = []

    exec_prefix = uuid.uuid4().hex[:10]
    async with (
        judge.session(
            f"verify-ref-{exec_prefix}",
            output.reference_solution,
            signature.func_name,
            wall_s=wall_s,
            per_test_limit_s=s.judge_per_test_limit_s,
        ) as ref_session,
        judge.session(
            f"verify-oracle-{exec_prefix}",
            built.brute_solution,
            signature.func_name,
            wall_s=wall_s,
            per_test_limit_s=s.judge_oracle_limit_s,
        ) as oracle_session,
        judge.session(
            f"verify-gen-{exec_prefix}",
            output.input_generator,
            "generate",
            wall_s=wall_s,
            per_test_limit_s=GENERATOR_LIMIT_S,
        ) as gen_session,
    ):
        # Gate 1: reference vs authored tests.
        ref_outcomes = [o async for o in ref_session.run(authored_tests)]
        for tc, outcome in zip(authored_tests, ref_outcomes, strict=False):
            if outcome.verdict != Verdict.PASS:
                disagreements.append(
                    Disagreement(
                        "reference_failed_authored",
                        f"args={tc.args} expected={tc.expected!r} "
                        f"verdict={outcome.verdict} value={outcome.value!r} error={outcome.error}",
                    )
                )

        # Gate 2: independent oracle vs the same authored tests.
        oracle_outcomes = [o async for o in oracle_session.run(authored_tests)]
        for tc, outcome in zip(authored_tests, oracle_outcomes, strict=False):
            if outcome.verdict != Verdict.PASS:
                disagreements.append(
                    Disagreement(
                        "oracle_failed_authored",
                        f"args={tc.args} expected={tc.expected!r} "
                        f"verdict={outcome.verdict} value={outcome.value!r} error={outcome.error}",
                    )
                )

        # Gate 3: reference vs oracle on RANDOM_CASES seeded inputs — nothing authored these, so
        # only mutual agreement (not a fixed `expected`) can validate them.
        seed_tests = [
            TestCase(args=[seed], expected=None, value_type=_PLACEHOLDER_TYPE)
            for seed in range(RANDOM_CASES)
        ]
        gen_outcomes = [o async for o in gen_session.run(seed_tests)]

        random_arg_lists: list[list[Any]] = []
        for seed, outcome in enumerate(gen_outcomes):
            if outcome.verdict in (Verdict.ERROR, Verdict.TIMEOUT) or not isinstance(
                outcome.value, list
            ):
                disagreements.append(
                    Disagreement(
                        "generator_failed",
                        f"seed={seed} verdict={outcome.verdict} error={outcome.error}",
                    )
                )
                continue
            random_arg_lists.append(outcome.value)

        if random_arg_lists:
            probe_tests = [
                TestCase(
                    args=args,
                    expected=None,
                    value_type=signature.returns,
                    order_insensitive=signature.order_insensitive,
                )
                for args in random_arg_lists
            ]
            ref_random = [o async for o in ref_session.run(probe_tests)]
            oracle_random = [o async for o in oracle_session.run(probe_tests)]
            for args, ref_o, oracle_o in zip(
                random_arg_lists, ref_random, oracle_random, strict=False
            ):
                if ref_o.verdict in (Verdict.ERROR, Verdict.TIMEOUT):
                    disagreements.append(
                        Disagreement(
                            "reference_oracle_mismatch",
                            f"args={args} reference crashed: {ref_o.error}",
                        )
                    )
                    continue
                if oracle_o.verdict in (Verdict.ERROR, Verdict.TIMEOUT):
                    disagreements.append(
                        Disagreement(
                            "reference_oracle_mismatch",
                            f"args={args} oracle crashed: {oracle_o.error}",
                        )
                    )
                    continue
                agree = values_equal(
                    ref_o.value,
                    oracle_o.value,
                    signature.returns,
                    order_insensitive=signature.order_insensitive,
                )
                if not agree:
                    disagreements.append(
                        Disagreement(
                            "reference_oracle_mismatch",
                            f"args={args} reference={ref_o.value!r} oracle={oracle_o.value!r}",
                        )
                    )

    return VerifyResult(ok=not disagreements, disagreements=disagreements)
