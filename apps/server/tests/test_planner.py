"""Deterministic planner tests: persisted compatibility, reservations, and selection context."""

from __future__ import annotations

import json
import uuid

from leetmind.planner import (
    Plan,
    _lru_shape_for_type,
    _reservations,
    plan_generation,
)
from leetmind.selection import TypeSignal
from leetmind.taxonomy import PROBLEM_TYPES, SHAPES, TYPE_SHAPES


async def test_plan_generation_fresh_user_is_deterministic(pool):
    user_id = uuid.uuid4()

    async with pool.acquire() as conn:
        job_id = await conn.fetchval(
            "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
        )
        plan = await plan_generation(conn, user_id=user_id, job_id=job_id)

    assert plan.primary_type == PROBLEM_TYPES[0]
    assert plan.shape == TYPE_SHAPES[PROBLEM_TYPES[0]][0]
    assert plan.is_probe is True
    assert plan.problem_rating == 1000
    assert plan.support_types == []


async def test_reservations_prevent_a_second_job_from_repeating_shape(pool):
    user_id = uuid.uuid4()

    async with pool.acquire() as conn:
        first_job = await conn.fetchval(
            "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
        )
        plan = await plan_generation(conn, user_id=user_id, job_id=first_job)
        await conn.execute(
            "UPDATE generation_jobs SET plan_json = $2, status = 'building' WHERE id = $1",
            first_job,
            json.dumps(plan.to_json()),
        )

        await conn.fetchval(
            "INSERT INTO generation_jobs (user_id) VALUES ($1) RETURNING id", user_id
        )
        reserved_types, reserved_shapes = await _reservations(conn, user_id)
        assert plan.primary_type in reserved_types
        next_shape = await _lru_shape_for_type(conn, user_id, plan.primary_type, reserved_shapes)
        assert next_shape != plan.shape


def test_every_problem_type_has_three_compatible_shapes():
    assert set(TYPE_SHAPES) == set(PROBLEM_TYPES)
    for type_slug, shapes in TYPE_SHAPES.items():
        assert len(shapes) == 3, type_slug
        assert len(set(shapes)) == 3, type_slug
        assert set(shapes) <= set(SHAPES), type_slug


def test_plan_json_v2_and_legacy_v1_are_both_recoverable():
    current = Plan(
        primary_type="trees",
        support_types=["arrays_hashing"],
        shape="path_search",
        problem_rating=1300,
        premise="",
        is_probe=False,
        recent_problems=[{"title": "Old", "premise": "Avoid this."}],
    )
    assert Plan.from_json(current.to_json()) == current

    legacy = {
        "primary_type": "arrays_hashing",
        "support_types": ["two_pointers"],
        "shape": "count_structures",
        "problem_rating": 1100,
        "premise": "A persisted legacy scenario.",
        "is_probe": False,
    }
    recovered = Plan.from_json(legacy)
    assert recovered.premise == legacy["premise"]
    assert recovered.support_types == legacy["support_types"]


async def test_plan_generation_uses_shortlist_midpoint_supports_and_recent_context(
    monkeypatch,
):
    from leetmind import planner as planner_module

    ratings = dict.fromkeys(PROBLEM_TYPES, 1450.0)
    ratings.update(
        {
            "arrays_hashing": 1200.0,
            "binary_search": 1600.0,
            "trees": 1550.0,
        }
    )
    signals = [
        TypeSignal(
            slug=slug,
            rating=ratings[slug],
            attempts=5,
            days_since_resolved=None,
            repetition_count=0,
        )
        for slug in PROBLEM_TYPES
    ]
    recent = [{"title": f"Recent {index}", "premise": f"Scenario {index}"} for index in range(8)]

    async def generation_index(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        return 1

    async def gathered(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        return signals

    async def reservations(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        return [], {}

    async def shape(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        return "count_structures"

    async def recent_context(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        return recent

    monkeypatch.setattr(planner_module, "_generation_index", generation_index)
    monkeypatch.setattr(planner_module, "gather_signals", gathered)
    monkeypatch.setattr(planner_module, "_reservations", reservations)
    monkeypatch.setattr(planner_module, "_lru_shape_for_type", shape)
    monkeypatch.setattr(planner_module, "_recent_titles_and_premises", recent_context)

    plan = await plan_generation(
        object(),  # type: ignore[arg-type]
        user_id=uuid.uuid4(),
        job_id=uuid.uuid4(),
    )

    assert plan.primary_type == "arrays_hashing"
    assert plan.problem_rating == 1250
    assert plan.support_types == ["binary_search", "trees"]
    assert plan.recent_problems == recent
