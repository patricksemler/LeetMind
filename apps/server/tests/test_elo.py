"""Pure unit tests for the rating math (PLAN_BACKEND.md §6.1, §12): update properties (upset
asymmetry, penalty caps, K decay). No DB, no Docker."""

from __future__ import annotations

from leetmind.elo import (
    Metrics,
    cap_minutes,
    expected_score,
    hint_penalty,
    k_factor,
    performance_score,
    rating_update,
    run_penalty,
    submit_penalty,
    time_penalty,
)


def test_expected_score_is_half_at_equal_rating():
    assert expected_score(1200, 1200) == 0.5


def test_expected_score_favors_higher_rating():
    assert expected_score(1400, 1000) > 0.5
    assert expected_score(1000, 1400) < 0.5


def test_low_rated_solving_far_above_rating_gains_big():
    e = expected_score(1000, 1400)
    assert e < 0.15
    update = rating_update(
        rating_before=1000,
        attempts_before=10,
        problem_rating=1400,
        par_minutes=30,
        metrics=Metrics(),
    )
    assert update.performance_score == 1.0
    assert update.delta > 0.85 * update.k_factor  # E ~= 0.1 -> +0.9*K


def test_low_rated_failing_far_above_rating_costs_almost_nothing():
    update = rating_update(
        rating_before=1000,
        attempts_before=10,
        problem_rating=1400,
        par_minutes=30,
        metrics=Metrics(gave_up=True),
    )
    assert update.performance_score == 0.0
    assert abs(update.delta) < 0.15 * update.k_factor


def test_sloppy_solve_below_rating_can_lose_points():
    # High-rated user, easy problem, but a hint-heavy, submission-heavy, slow solve: S < E.
    update = rating_update(
        rating_before=1600,
        attempts_before=10,
        problem_rating=1000,
        par_minutes=20,
        metrics=Metrics(runs=50, failed_submissions=10, hints_revealed=4, minutes=200.0),
    )
    assert update.performance_score == 0.30  # floors at S_FLOOR
    assert update.expected_score > update.performance_score
    assert update.delta < 0


def test_hint_penalty_cumulative_and_capped():
    assert hint_penalty(0) == 0.0
    assert hint_penalty(1) == 0.05
    assert hint_penalty(3) == 0.30
    assert hint_penalty(4) == 0.40  # 0.55 raw, capped at 0.40


def test_submit_penalty_first_failure_free_then_capped():
    assert submit_penalty(0) == 0.0
    assert submit_penalty(1) == 0.0
    assert submit_penalty(2) == 0.05
    assert submit_penalty(100) == 0.15


def test_run_penalty_free_allowance_then_capped():
    assert run_penalty(6) == 0.0
    assert run_penalty(7) == 0.01
    assert run_penalty(1000) == 0.05


def test_time_penalty_zero_at_par_and_capped_beyond_double_par():
    assert time_penalty(20, par_minutes=20) == 0.0
    assert time_penalty(60, par_minutes=20) == 0.15  # minutes = par * 3 -> ratio saturates at 1
    assert time_penalty(1000, par_minutes=20) == 0.15


def test_cap_minutes_bounds_abandoned_tab():
    assert cap_minutes(1000, par_minutes=10) == 40.0
    assert cap_minutes(5, par_minutes=10) == 5.0
    assert cap_minutes(-5, par_minutes=10) == 0.0


def test_performance_score_floors_even_under_extreme_penalties():
    metrics = Metrics(runs=1000, failed_submissions=1000, hints_revealed=4, minutes=10000.0)
    assert performance_score(metrics, par_minutes=10) == 0.30


def test_give_up_is_always_zero_regardless_of_other_metrics():
    metrics = Metrics(runs=0, failed_submissions=0, hints_revealed=0, minutes=1.0, gave_up=True)
    assert performance_score(metrics, par_minutes=30) == 0.0


def test_k_factor_decays_with_attempts():
    assert k_factor(0) == 40.0
    assert k_factor(4) == 40.0
    assert k_factor(5) == 24.0
    assert k_factor(14) == 24.0
    assert k_factor(15) == 16.0
    assert k_factor(1000) == 16.0
