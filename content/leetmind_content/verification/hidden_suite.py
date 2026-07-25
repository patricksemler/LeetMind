"""Hidden suite construction (CONTRACTS.md §10 / this project's task brief).

From the differential-verified seeded inputs (stage 3) plus boundary cases (stage 4) plus the
public examples, with expected outputs already taken from the reference solution's actual output
(never from LLM assertion — CONTRACTS.md §4) by the stages that produced them. Capped at a
sensible size: all boundary cases + all examples + a deterministic, evenly-spread sample of the
random (differential) cases.

**Deviation from the literal CONTRACTS.md §10 table** ("built in stages 3–4"): the task brief for
this module explicitly says the capped suite is "all boundary + examples + a sampled spread of
random ones", so examples are folded in here too. Doing so is harmless and arguably required —
without it, an approved problem's hidden suite would never include the exact cases the reference
is already known (stage 5) to satisfy, which is a strictly worse hidden suite. Noted in the final
report as a deliberate, documented extension of the letter of the table.
"""

from __future__ import annotations

from leetmind_content.models import ProblemVersion, TestCase

MAX_HIDDEN_SUITE_SIZE = 60


def _example_cases(problem: ProblemVersion) -> list[TestCase]:
    return [
        TestCase(args=ex.args, expected=ex.expected, origin="example")
        for ex in problem.examples
    ]


def _sample_spread(cases: list[TestCase], count: int) -> list[TestCase]:
    """Deterministic, evenly-spaced sample of `cases` (not a random subset — a fixed stride
    keeps the suite reproducible across identical inputs)."""
    n = len(cases)
    if count <= 0 or n == 0:
        return []
    if count >= n:
        return list(cases)
    step = n / count
    indices = sorted({int(i * step) for i in range(count)})
    # De-duplication via the set above can leave us one short; top up from the end.
    i = n - 1
    while len(indices) < count and i >= 0:
        if i not in indices:
            indices.append(i)
        i -= 1
    return [cases[i] for i in sorted(set(indices))[:count]]


def build_hidden_suite(
    problem: ProblemVersion,
    random_cases: list[TestCase],
    boundary_cases: list[TestCase],
    *,
    max_size: int = MAX_HIDDEN_SUITE_SIZE,
) -> list[TestCase]:
    examples = _example_cases(problem)

    suite = list(examples) + list(boundary_cases)
    if len(suite) > max_size:
        # Examples always win a slot; trim boundary cases first if even those overflow the cap.
        keep_boundary = max(0, max_size - len(examples))
        suite = list(examples) + list(boundary_cases[:keep_boundary])
        return suite

    remaining = max_size - len(suite)
    suite.extend(_sample_spread(random_cases, remaining))
    return suite
