"""Planner tests (PLAN_BACKEND.md §7.2, §12): pure validation/fallback unit tests, plus real-
Postgres integration tests for the context-gathering queries (reservations, shape LRU, anti-
repetition window) and the full `plan_generation` flow with a stubbed LLM."""

from __future__ import annotations

import json
import uuid

from leetmind.planner import (
    PlanOutput,
    _call_planner,
    _deterministic_plan,
    _lru_shape_for_type,
    _reservations,
    _validate,
    plan_generation,
)
from leetmind.selection import TypeSignal, target_band
from leetmind.taxonomy import PROBLEM_TYPES, SHAPES
from tests.llm_fixtures import PLANNER_MARKER, FakeLLM, fresh_user_plan_output


def _signal(slug: str, *, rating: float = 1200, attempts: int = 0) -> TypeSignal:
    return TypeSignal(
        slug=slug, rating=rating, attempts=attempts, days_since_resolved=None, repetition_count=0
    )


SHORTLIST = ["arrays_hashing", "two_pointers", "sliding_window"]
SIGNAL_BY_SLUG = {
    "arrays_hashing": _signal("arrays_hashing", attempts=10, rating=1200),
    "two_pointers": _signal("two_pointers", attempts=0),
    "sliding_window": _signal("sliding_window", attempts=0),
}
SHAPE_FOR = dict.fromkeys(SHORTLIST, SHAPES[0])
SUPPORT_POOL = {"arrays_hashing": ["dp_1d"], "two_pointers": [], "sliding_window": []}


def _valid_output(**overrides: object) -> PlanOutput:
    lo, hi = target_band(SIGNAL_BY_SLUG["arrays_hashing"].rating)
    data = {
        "primary_type": "arrays_hashing",
        "support_types": [],
        "shape": SHAPE_FOR["arrays_hashing"],
        "problem_rating": round((lo + hi) / 2),
        "premise": "A short original scenario.",
        "rationale": "because",
    }
    data.update(overrides)
    return PlanOutput.model_validate(data)


class TestValidate:
    def _check(self, **overrides: object) -> str | None:
        return _validate(
            _valid_output(**overrides),
            shortlist_slugs=set(SHORTLIST),
            shape_for=SHAPE_FOR,
            signal_by_slug=SIGNAL_BY_SLUG,
            support_pool=SUPPORT_POOL,
        )

    def test_valid_plan_passes(self):
        assert self._check() is None

    def test_primary_not_in_shortlist_rejected(self):
        assert "shortlisted" in (self._check(primary_type="graphs_bfs_dfs") or "")

    def test_wrong_shape_rejected(self):
        assert "shape" in (self._check(shape=SHAPES[1]) or "")

    def test_too_many_support_types_rejected(self):
        assert "at most 2" in (self._check(support_types=["a", "b", "c"]) or "")

    def test_primary_in_support_types_rejected(self):
        assert (
            "must not include primary_type"
            in (self._check(support_types=["arrays_hashing"]) or "")
        )

    def test_support_type_outside_pool_rejected(self):
        assert "drawn from" in (self._check(support_types=["dp_2d"]) or "")

    def test_support_type_from_pool_accepted(self):
        assert self._check(support_types=["dp_1d"]) is None

    def test_rating_outside_band_rejected_when_evidenced(self):
        assert "problem_rating" in (self._check(problem_rating=1) or "")

    def test_rating_unconstrained_when_unevidenced(self):
        # two_pointers has attempts=0 in SIGNAL_BY_SLUG — no band check applies.
        output = _valid_output(
            primary_type="two_pointers", shape=SHAPE_FOR["two_pointers"], problem_rating=1
        )
        result = _validate(
            output,
            shortlist_slugs=set(SHORTLIST),
            shape_for=SHAPE_FOR,
            signal_by_slug=SIGNAL_BY_SLUG,
            support_pool=SUPPORT_POOL,
        )
        assert result is None

    def test_empty_premise_rejected(self):
        assert "premise" in (self._check(premise="   ") or "")

    def test_oversized_premise_rejected(self):
        assert "premise" in (self._check(premise="x" * 3000) or "")


class TestDeterministicPlan:
    def test_uses_band_midpoint_when_evidenced(self):
        plan = _deterministic_plan(
            fallback_primary="arrays_hashing", shape_for=SHAPE_FOR, signal_by_slug=SIGNAL_BY_SLUG
        )
        lo, hi = target_band(SIGNAL_BY_SLUG["arrays_hashing"].rating)
        assert plan.primary_type == "arrays_hashing"
        assert plan.shape == SHAPE_FOR["arrays_hashing"]
        assert lo <= plan.problem_rating <= hi
        assert plan.support_types == []

    def test_uses_probe_rating_when_unevidenced(self):
        plan = _deterministic_plan(
            fallback_primary="two_pointers", shape_for=SHAPE_FOR, signal_by_slug=SIGNAL_BY_SLUG
        )
        assert plan.problem_rating == 1000


async def test_call_planner_falls_back_after_two_bad_attempts():
    llm = FakeLLM(
        [(PLANNER_MARKER, {**_valid_output().model_dump(), "primary_type": "not_in_shortlist"})]
    )
    output = await _call_planner(
        llm,
        f"{PLANNER_MARKER} ...",
        shortlist_slugs=set(SHORTLIST),
        shape_for=SHAPE_FOR,
        signal_by_slug=SIGNAL_BY_SLUG,
        support_pool=SUPPORT_POOL,
        fallback_primary="arrays_hashing",
    )
    assert output.primary_type == "arrays_hashing"
    assert "fallback" in output.rationale
    # one original call + one re-ask, both violating, then the deterministic path — no third call
    assert len(llm.calls) == 2


async def test_call_planner_recovers_on_reask():
    good = _valid_output().model_dump()
    bad = {**good, "primary_type": "not_in_shortlist"}
    calls = {"n": 0}

    class OnceBadLLM:
        async def complete(self, prompt, schema):  # noqa: ANN001, ANN201, D102
            calls["n"] += 1
            return schema.model_validate(bad if calls["n"] == 1 else good)

    output = await _call_planner(
        OnceBadLLM(),
        f"{PLANNER_MARKER} ...",
        shortlist_slugs=set(SHORTLIST),
        shape_for=SHAPE_FOR,
        signal_by_slug=SIGNAL_BY_SLUG,
        support_pool=SUPPORT_POOL,
        fallback_primary="arrays_hashing",
    )
    assert output.primary_type == "arrays_hashing"
    assert calls["n"] == 2


async def test_plan_generation_fresh_user_is_deterministically_shortlisted(pool):
    user_id = uuid.uuid4()
    llm = FakeLLM([(PLANNER_MARKER, fresh_user_plan_output())])

    async with pool.acquire() as conn:
        job_id = await conn.fetchval(
            "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
        )
        plan = await plan_generation(conn, llm, user_id=user_id, job_id=job_id)

    # No history ties every type's score, so the shortlist is PROBLEM_TYPES[:3] and the LRU
    # shape is SHAPES[0] — exactly what the fixture's canned plan output already matches.
    assert plan.primary_type == PROBLEM_TYPES[0]
    assert plan.shape == SHAPES[0]
    assert plan.is_probe is True
    assert plan.problem_rating == 1000  # probe forces this regardless of the LLM's suggestion
    assert plan.support_types == []  # probe forces this too


async def test_plan_generation_falls_back_when_llm_violates_shortlist(pool):
    user_id = uuid.uuid4()
    bad_plan = fresh_user_plan_output(primary_type="dp_2d", shape="transform_encode")
    llm = FakeLLM([(PLANNER_MARKER, bad_plan)])

    async with pool.acquire() as conn:
        job_id = await conn.fetchval(
            "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
        )
        plan = await plan_generation(conn, llm, user_id=user_id, job_id=job_id)

    assert plan.primary_type == PROBLEM_TYPES[0]  # fell back to the shortlist head
    assert plan.shape == SHAPES[0]


async def test_reservations_prevent_a_second_job_from_repeating_type_and_shape(pool):
    """Amendment 30: a pending job's plan_json reserves its type/shape so a second concurrently-
    planned job for the same user is steered elsewhere."""
    user_id = uuid.uuid4()

    async with pool.acquire() as conn:
        first_job = await conn.fetchval(
            "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
        )
        llm1 = FakeLLM([(PLANNER_MARKER, fresh_user_plan_output())])
        plan1 = await plan_generation(conn, llm1, user_id=user_id, job_id=first_job)
        await conn.execute(
            "UPDATE generation_jobs SET plan_json = $2, status = 'building' WHERE id = $1",
            first_job,
            json.dumps(plan1.to_json()),
        )

        # A second job's planning pass sees plan1's reservation: arrays_hashing/optimize_subarray
        # is now "just used", so its LRU shape should differ.
        await conn.fetchval(
            "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
        )
        reserved_types, reserved_shapes = await _reservations(conn, user_id)
        assert plan1.primary_type in reserved_types
        next_shape = await _lru_shape_for_type(conn, user_id, plan1.primary_type, reserved_shapes)
        assert next_shape != plan1.shape
