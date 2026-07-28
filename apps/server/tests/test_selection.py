"""Pure unit tests for selection scoring (PLAN_BACKEND.md §6.2, §12): the four inherited
invariants I1-I4 as explicit cases, plus probe-phase and scoring behavior. No DB, no Docker."""

from __future__ import annotations

from leetmind.selection import (
    TypeSignal,
    is_probe_generation,
    lru_shape,
    score_type,
    shortlist,
    staleness,
    support_candidates,
    target_band,
    weakness,
)
from leetmind.taxonomy import SHAPES


def _signal(
    slug: str,
    *,
    rating: float = 1200,
    attempts: int = 0,
    days_since_resolved: float | None = None,
    repetition_count: int = 0,
) -> TypeSignal:
    return TypeSignal(
        slug=slug,
        rating=rating,
        attempts=attempts,
        days_since_resolved=days_since_resolved,
        repetition_count=repetition_count,
    )


def test_i1_unevidenced_types_stay_reachable_via_probe_generation():
    strong = _signal("strong", rating=2000, attempts=50, days_since_resolved=0)
    new = _signal("new", rating=1200, attempts=0)
    assert is_probe_generation(0, [strong, new]) is True
    sl = shortlist([strong, new], probe_only=True)
    assert {sc.slug for sc in sl} == {"new"}


def test_i2_weakness_is_gated_on_evidence():
    unevidenced_low_rating = _signal("x", rating=800, attempts=0)
    assert weakness(unevidenced_low_rating) == 0.0

    evidenced_low_rating = _signal("x", rating=800, attempts=5, days_since_resolved=1)
    assert weakness(evidenced_low_rating) > 0.0


def test_i3_repetition_penalty_demotes_an_overused_type():
    overused = _signal(
        "overused", rating=1000, attempts=10, days_since_resolved=0, repetition_count=8
    )
    fresh = _signal("fresh", rating=1000, attempts=10, days_since_resolved=0, repetition_count=0)
    assert score_type(overused).score < score_type(fresh).score

    sl = shortlist([overused, fresh], probe_only=False, size=1)
    assert sl[0].slug == "fresh"


def test_i4_lru_shape_prefers_any_never_used_shape():
    used = {"kth_element": 3.0}
    picked = lru_shape(used)
    assert picked != "kth_element"
    assert picked in SHAPES


def test_i4_lru_shape_rotates_to_the_least_recently_used_once_all_used():
    all_used = {shape: float(i) for i, shape in enumerate(SHAPES)}  # bigger index = longer ago
    assert lru_shape(all_used) == SHAPES[-1]


def test_probe_phase_alternates_generations_while_coverage_incomplete():
    signals = [_signal("new", attempts=0)]
    assert is_probe_generation(0, signals) is True
    assert is_probe_generation(1, signals) is False
    assert is_probe_generation(2, signals) is True


def test_probe_phase_ends_once_every_type_is_evidenced():
    signals = [_signal("a", attempts=1, days_since_resolved=1)]
    assert is_probe_generation(0, signals) is False


def test_staleness_treats_never_resolved_as_maximally_stale():
    assert staleness(_signal("never", days_since_resolved=None)) == 1.0
    assert staleness(_signal("recent", days_since_resolved=0)) == 0.0
    assert staleness(_signal("very_old", days_since_resolved=1000)) == 1.0


def test_shortlist_probe_only_falls_back_when_nothing_is_unevidenced():
    a = _signal("a", attempts=5, days_since_resolved=1)
    b = _signal("b", attempts=5, days_since_resolved=1)
    sl = shortlist([a, b], probe_only=True)
    assert {sc.slug for sc in sl} == {"a", "b"}


def test_support_candidates_require_margin_evidence_and_not_the_primary():
    primary = _signal("primary", rating=1200, attempts=5, days_since_resolved=1)
    strong_enough = _signal("strong", rating=1350, attempts=5, days_since_resolved=1)
    too_close = _signal("too_close", rating=1250, attempts=5, days_since_resolved=1)
    unevidenced_strong = _signal("unevidenced_strong", rating=2000, attempts=0)

    candidates = support_candidates(
        [primary, strong_enough, too_close, unevidenced_strong],
        primary_slug="primary",
        primary_rating=1200,
    )
    assert candidates == ["strong"]


def test_support_threshold_has_a_floor_below_which_low_primary_ratings_dont_lower_it():
    weak_primary_strong = _signal("strong", rating=1300, attempts=5, days_since_resolved=1)
    candidates = support_candidates(
        [weak_primary_strong], primary_slug="primary", primary_rating=900
    )
    # max(900+100, 1300) == 1300, so exactly-1300 qualifies.
    assert candidates == ["strong"]


def test_target_band_matches_the_tunable():
    assert target_band(1200) == (1150, 1350)
