"""The learner model's rating math (PLAN_BACKEND.md §6.1, §13). Pure functions only — no DB, no
I/O — so the update properties (upset asymmetry, penalty caps, K decay) are cheap to unit test
and the resolution transaction (Phase 4) just calls `rating_update` and persists the result."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

DEFAULT_RATING = 1200
S_FLOOR = 0.30

K_BY_ATTEMPTS: tuple[tuple[int, float], ...] = ((5, 40.0), (15, 24.0))
K_FLOOR = 16.0

HINT_PENALTIES: tuple[float, ...] = (0.05, 0.10, 0.15, 0.25)
HINT_PENALTY_CAP = 0.40
SUBMIT_PENALTY_PER = 0.05
SUBMIT_PENALTY_CAP = 0.15
RUN_FREE_COUNT = 6
RUN_PENALTY_PER = 0.01
RUN_PENALTY_CAP = 0.05
TIME_PENALTY_MAX = 0.15
TIME_OVER_PAR_SPAN = 2.0  # penalty saturates at minutes = par * (1 + TIME_OVER_PAR_SPAN)
TIME_CAP_MULTIPLE = 4.0  # abandoned-tab guard: minutes are capped at this multiple of par


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


@dataclass(frozen=True)
class Metrics:
    """Resolution metrics for one problem (PLAN_BACKEND.md §6.1). `minutes` is server wall-clock
    (`resolved_at - served_at`); callers should pass it through `cap_minutes` first."""

    runs: int = 0
    failed_submissions: int = 0
    hints_revealed: int = 0  # highest rung revealed, 0-4
    minutes: float = 0.0
    gave_up: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "runs": self.runs,
            "failed_submissions": self.failed_submissions,
            "hints_revealed": self.hints_revealed,
            "minutes": self.minutes,
            "gave_up": self.gave_up,
        }


@dataclass(frozen=True)
class RatingUpdate:
    """Everything the resolution response needs to explain the change (PLAN_BACKEND.md §9, #22)."""

    rating_before: float
    rating_after: float
    delta: float
    problem_rating: int
    expected_score: float
    performance_score: float
    k_factor: float
    attempts_after: int
    metrics: dict[str, Any] = field(default_factory=dict)


def cap_minutes(minutes: float, par_minutes: float) -> float:
    """Abandoned-tab guard (§6.1): wall-clock time is capped at 4x par before it can affect S."""
    return min(max(minutes, 0.0), par_minutes * TIME_CAP_MULTIPLE)


def expected_score(rating: float, problem_rating: float) -> float:
    """`E = 1 / (1 + 10^((problem_rating - rating) / 400))`."""
    exponent = (problem_rating - rating) / 400.0
    return 1.0 / (1.0 + math.pow(10.0, exponent))


def hint_penalty(hints_revealed: int) -> float:
    return min(sum(HINT_PENALTIES[:hints_revealed]), HINT_PENALTY_CAP)


def submit_penalty(failed_submissions: int) -> float:
    beyond_first = max(0, failed_submissions - 1)
    return min(beyond_first * SUBMIT_PENALTY_PER, SUBMIT_PENALTY_CAP)


def run_penalty(runs: int) -> float:
    beyond_free = max(0, runs - RUN_FREE_COUNT)
    return min(beyond_free * RUN_PENALTY_PER, RUN_PENALTY_CAP)


def time_penalty(minutes: float, par_minutes: float) -> float:
    if par_minutes <= 0:
        return 0.0
    over = (minutes - par_minutes) / (par_minutes * TIME_OVER_PAR_SPAN)
    return TIME_PENALTY_MAX * clamp(over, 0.0, 1.0)


def performance_score(metrics: Metrics, par_minutes: float) -> float:
    """`S` (§6.1): 0 on give-up; otherwise 1 minus the penalty table, floored at `S_FLOOR`."""
    if metrics.gave_up:
        return 0.0
    penalty = (
        hint_penalty(metrics.hints_revealed)
        + submit_penalty(metrics.failed_submissions)
        + run_penalty(metrics.runs)
        + time_penalty(metrics.minutes, par_minutes)
    )
    return clamp(1.0 - penalty, S_FLOOR, 1.0)


def k_factor(attempts_before: int) -> float:
    """K decays with per-type evidence (§6.1, #8): 40 → 24 → 16 as attempts accumulate."""
    for threshold, k in K_BY_ATTEMPTS:
        if attempts_before < threshold:
            return k
    return K_FLOOR


def rating_update(
    *,
    rating_before: float,
    attempts_before: int,
    problem_rating: int,
    par_minutes: float,
    metrics: Metrics,
) -> RatingUpdate:
    """The full update for one resolution (§6.1). Support types never call this — only the
    primary type gets an Elo update."""
    e = expected_score(rating_before, problem_rating)
    s = performance_score(metrics, par_minutes)
    k = k_factor(attempts_before)
    delta = k * (s - e)
    return RatingUpdate(
        rating_before=rating_before,
        rating_after=rating_before + delta,
        delta=delta,
        problem_rating=problem_rating,
        expected_score=e,
        performance_score=s,
        k_factor=k,
        attempts_after=attempts_before + 1,
        metrics=metrics.as_dict(),
    )
