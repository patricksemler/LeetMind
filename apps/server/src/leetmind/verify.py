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

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Sequence
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
    retryable_infrastructure: bool = False

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


async def _emit_phase(callback: Callable[[str], Awaitable[None]] | None, phase: str) -> None:
    if callback is not None:
        await callback(phase)


async def _collect(session: Any, tests: Sequence[TestCase]) -> list[Any]:
    return [outcome async for outcome in session.run(tests)]


def _infrastructure_failure(outcome: Any) -> bool:
    return outcome.error in {
        "judge container exited unexpectedly",
        "malformed judge protocol response",
        "judge wall-clock exceeded",
    }


async def verify_problem(
    judge: JudgeClient,
    built: BuiltProblem,
    *,
    settings: Settings | None = None,
    on_phase: Callable[[str], Awaitable[None]] | None = None,
) -> VerifyResult:
    s = settings or get_settings()
    output = built.output
    signature = output.signature
    wall_s = s.judge_verify_wall_s

    authored_tests = _to_test_cases(output.public_tests + output.private_tests, signature)
    disagreements: list[Disagreement] = []

    exec_prefix = uuid.uuid4().hex[:10]
    # Generate all seeds in one sandboxed child process. Running the batch twice in the wrapper
    # validates the builder contract that `generate(seed)` is pure while avoiding fifty Python
    # interpreter startups just to obtain argument lists.
    generator_code = (
        f"{output.input_generator.rstrip()}\n\n"
        "def __leetmind_generate_batch(seeds):\n"
        "    first = [generate(seed) for seed in seeds]\n"
        "    second = [generate(seed) for seed in seeds]\n"
        "    if first != second:\n"
        "        raise ValueError('input generator is not pure')\n"
        "    return first\n"
    )
    seed_list = list(range(RANDOM_CASES))
    seed_batch = [TestCase(args=[seed_list], expected=None, value_type=_PLACEHOLDER_TYPE)]

    await _emit_phase(on_phase, "checking_examples")
    # Materialize randomized inputs with one short-lived process before occupying the two
    # long-lived solution sessions. This avoids a semaphore deadlock when two generation workers
    # verify concurrently under the default four-container judge limit.
    async with judge.session(
        f"verify-gen-{exec_prefix}",
        generator_code,
        "__leetmind_generate_batch",
        wall_s=wall_s,
        per_test_limit_s=GENERATOR_LIMIT_S,
    ) as gen_session:
        generator_outcomes = await _collect(gen_session, seed_batch)

    generator_outcome = generator_outcomes[0]
    if generator_outcome.verdict in (Verdict.ERROR, Verdict.TIMEOUT) or not isinstance(
        generator_outcome.value, list
    ):
        disagreement = Disagreement(
            "generator_failed",
            f"verdict={generator_outcome.verdict} error={generator_outcome.error}",
        )
        return VerifyResult(
            ok=False,
            disagreements=[disagreement],
            retryable_infrastructure=_infrastructure_failure(generator_outcome),
        )
    random_arg_lists = generator_outcome.value
    if len(random_arg_lists) != RANDOM_CASES or not all(
        isinstance(args, list) for args in random_arg_lists
    ):
        return VerifyResult(
            ok=False,
            disagreements=[
                Disagreement(
                    "generator_failed",
                    f"batch must return {RANDOM_CASES} positional-argument lists",
                )
            ],
        )

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
    ):
        # Gates 1 and 2 are independent processes and can execute authored tests concurrently.
        ref_outcomes, oracle_outcomes = await asyncio.gather(
            _collect(ref_session, authored_tests),
            _collect(oracle_session, authored_tests),
        )
        for tc, outcome in zip(authored_tests, ref_outcomes, strict=False):
            if outcome.verdict != Verdict.PASS:
                disagreements.append(
                    Disagreement(
                        "reference_failed_authored",
                        f"args={tc.args} expected={tc.expected!r} "
                        f"verdict={outcome.verdict} value={outcome.value!r} error={outcome.error}",
                    )
                )

        for tc, outcome in zip(authored_tests, oracle_outcomes, strict=False):
            if outcome.verdict != Verdict.PASS:
                disagreements.append(
                    Disagreement(
                        "oracle_failed_authored",
                        f"args={tc.args} expected={tc.expected!r} "
                        f"verdict={outcome.verdict} value={outcome.value!r} error={outcome.error}",
                    )
                )

        if disagreements:
            infrastructure = any(
                _infrastructure_failure(outcome) for outcome in [*ref_outcomes, *oracle_outcomes]
            )
            return VerifyResult(
                ok=False,
                disagreements=disagreements,
                retryable_infrastructure=infrastructure,
            )

        # Authored gates passed, so it is now worth paying for randomized solution probes.
        await _emit_phase(on_phase, "stress_testing")
        # Gate 3: reference and oracle see identical generated inputs concurrently.
        probe_tests = [
            TestCase(
                args=args,
                expected=None,
                value_type=signature.returns,
                order_insensitive=signature.order_insensitive,
            )
            for args in random_arg_lists
        ]
        ref_random, oracle_random = await asyncio.gather(
            _collect(ref_session, probe_tests),
            _collect(oracle_session, probe_tests),
        )
        infrastructure = False
        for args, ref_o, oracle_o in zip(
            random_arg_lists, ref_random, oracle_random, strict=False
        ):
            if ref_o.verdict in (Verdict.ERROR, Verdict.TIMEOUT):
                infrastructure = infrastructure or _infrastructure_failure(ref_o)
                disagreements.append(
                    Disagreement(
                        "reference_oracle_mismatch",
                        f"args={args} reference crashed: {ref_o.error}",
                    )
                )
                continue
            if oracle_o.verdict in (Verdict.ERROR, Verdict.TIMEOUT):
                infrastructure = infrastructure or _infrastructure_failure(oracle_o)
                disagreements.append(
                    Disagreement(
                        "reference_oracle_mismatch",
                        f"args={args} oracle crashed: {oracle_o.error}",
                    )
                )
                continue
            if not values_equal(
                ref_o.value,
                oracle_o.value,
                signature.returns,
                order_insensitive=signature.order_insensitive,
            ):
                disagreements.append(
                    Disagreement(
                        "reference_oracle_mismatch",
                        f"args={args} reference={ref_o.value!r} oracle={oracle_o.value!r}",
                    )
                )

    return VerifyResult(
        ok=not disagreements,
        disagreements=disagreements,
        retryable_infrastructure=infrastructure if disagreements else False,
    )
