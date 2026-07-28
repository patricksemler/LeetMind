"""Deterministic selection scoring (PLAN_BACKEND.md §6.2, §13). Pure functions only: the caller
(worker/replenish, Phase 3) gathers the Elo profile plus reservations (pending `active`/`ready`
/`building` problems and non-terminal jobs' `plan_json`, per the amendment-30 reservation rule)
and this module turns that into a shortlist, a probe decision, support candidates, a target
band, and a shape pick — all deterministic, so the four inherited invariants (I1-I4) hold by
construction rather than by hoping the LLM cooperates."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from leetmind.taxonomy import SHAPES

REPETITION_WINDOW = 8
STALENESS_DAYS = 14.0
SHORTLIST_SIZE = 3
PROBE_RATING = 1000
TARGET_BAND = (-50, 150)
SUPPORT_MARGIN = 100
SUPPORT_MIN_RATING = 1300

WEIGHT_WEAKNESS = 1.0
WEIGHT_PROBE_NEED = 1.5
WEIGHT_STALENESS = 0.4
WEIGHT_REPETITION = 1.2

WEAKNESS_ANCHOR = 1400.0
WEAKNESS_SPAN = 400.0


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


@dataclass(frozen=True)
class TypeSignal:
    """One type's inputs to the scorer. `days_since_resolved=None` means never resolved (treated
    as maximally stale). `repetition_count` and `attempts` must already include reservations
    (amendment 30) — this module doesn't know about the DB, only the numbers."""

    slug: str
    rating: float
    attempts: int
    days_since_resolved: float | None
    repetition_count: int

    @property
    def evidenced(self) -> bool:
        return self.attempts > 0  # I2: a seeded rating with attempts=0 is not a measurement


@dataclass(frozen=True)
class TypeScore:
    slug: str
    score: float
    evidenced: bool


def weakness(signal: TypeSignal) -> float:
    # I2: gated on evidence — an unevidenced type contributes nothing here no matter its
    # (default-seeded) rating.
    if not signal.evidenced:
        return 0.0
    return max(0.0, (WEAKNESS_ANCHOR - signal.rating) / WEAKNESS_SPAN)


def probe_need(signal: TypeSignal) -> float:
    return 0.0 if signal.evidenced else 1.0  # I1: unevidenced dominates


def staleness(signal: TypeSignal) -> float:
    # Never-resolved reads as maximally stale, on top of probe_need already dominating.
    days = STALENESS_DAYS if signal.days_since_resolved is None else signal.days_since_resolved
    return clamp01(days / STALENESS_DAYS)


def repetition(signal: TypeSignal) -> float:
    return clamp01(signal.repetition_count / REPETITION_WINDOW)  # I3


def score_type(signal: TypeSignal) -> TypeScore:
    total = (
        WEIGHT_WEAKNESS * weakness(signal)
        + WEIGHT_PROBE_NEED * probe_need(signal)
        + WEIGHT_STALENESS * staleness(signal)
        - WEIGHT_REPETITION * repetition(signal)
    )
    return TypeScore(slug=signal.slug, score=total, evidenced=signal.evidenced)


def is_probe_generation(generation_index: int, signals: Sequence[TypeSignal]) -> bool:
    """Coverage-first policy: while any type lacks evidence, at least every second generation
    (0-indexed, so index 0 counts) is constrained to the unevidenced pool."""
    if not any(not s.evidenced for s in signals):
        return False
    return generation_index % 2 == 0


def shortlist(
    signals: Sequence[TypeSignal],
    *,
    probe_only: bool,
    size: int = SHORTLIST_SIZE,
) -> list[TypeScore]:
    """Top-`size` types by score. `probe_only` restricts the pool to unevidenced types (and is a
    no-op if none exist, so a caller can pass it unconditionally alongside
    `is_probe_generation`)."""
    scores = [score_type(s) for s in signals]
    pool = [sc for sc in scores if not sc.evidenced] if probe_only else scores
    if not pool:
        pool = scores
    return sorted(pool, key=lambda sc: sc.score, reverse=True)[:size]


def support_candidates(
    signals: Sequence[TypeSignal],
    *,
    primary_slug: str,
    primary_rating: float,
) -> list[str]:
    """Evidenced types strong enough to scaffold the primary without taking its Elo update."""
    threshold = max(primary_rating + SUPPORT_MARGIN, SUPPORT_MIN_RATING)
    return [
        s.slug for s in signals if s.slug != primary_slug and s.evidenced and s.rating >= threshold
    ]


def target_band(rating: float) -> tuple[float, float]:
    lo, hi = TARGET_BAND
    return (rating + lo, rating + hi)


def lru_shape(shape_last_used: Mapping[str, float | None], shapes: Sequence[str] = SHAPES) -> str:
    """I4: rotate a type's premise shape by least-recently-used. `shape_last_used` maps shape ->
    a "how long ago" measure (bigger = longer ago / more stale); a shape absent from the mapping
    or mapped to None has never been used and sorts before any used shape."""

    def key(shape: str) -> tuple[int, float]:
        recency = shape_last_used.get(shape)
        return (0, 0.0) if recency is None else (1, -recency)

    return min(shapes, key=key)
