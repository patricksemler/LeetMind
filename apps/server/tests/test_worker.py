"""Worker/pipeline tests (PLAN_BACKEND.md §7.1, §12).

Claiming, per-user serialization, fencing, lease reclaim, resume-from-`plan_json`, and queue-
invariant maintenance are pure-DB and fast (stubbed LLM, no Docker). The one full-lifecycle test
exercises real Docker via the `judge_image`/`judge_client` fixtures with a stubbed LLM, covering
the repair loop end to end. Planner-violation fallback is covered in test_planner.py; the
differential-verify-catches-a-bad-fixture scenario is covered in test_verify.py.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from leetmind.builder import BuilderOutput, BuiltProblem
from leetmind.config import Settings
from leetmind.judge import JudgeClient
from leetmind.planner import Plan
from leetmind.worker import GenerationWorker
from tests.llm_fixtures import (
    BUILDER_MARKER,
    BUILDER_REPAIR_MARKER,
    ORACLE_MARKER,
    PLANNER_MARKER,
    QUALITY_REVIEW_MARKER,
    FakeLLM,
    aligned_quality_review_output,
    fresh_user_plan_output,
    sum_problem_builder_output,
    sum_problem_oracle_output,
)


def _fast_settings(**overrides: Any) -> Settings:
    defaults = {
        "worker_poll_interval_s": 0.05,
        "worker_heartbeat_interval_s": 0.1,
        "worker_lease_stale_s": 0.3,
    }
    defaults.update(overrides)
    return Settings(_env_file=None, **defaults)


async def _insert_job(pool: Any, user_id: uuid.UUID, **cols: Any) -> uuid.UUID:
    columns = {"user_id": user_id, **cols}
    keys = list(columns)
    placeholders = ", ".join(f"${i + 1}" for i in range(len(keys)))
    return await pool.fetchval(
        f"INSERT INTO generation_jobs ({', '.join(keys)}) VALUES ({placeholders}) RETURNING id",
        *[columns[k] for k in keys],
    )


async def _job_row(pool: Any, job_id: uuid.UUID) -> Any:
    return await pool.fetchrow("SELECT * FROM generation_jobs WHERE id = $1", job_id)


# -- claiming & per-user serialization (amendment 31) -------------------------------------------


async def test_claim_skips_a_user_with_another_live_leased_job(pool):
    worker = GenerationWorker(pool, settings=_fast_settings())
    user_id = uuid.uuid4()
    job1 = await _insert_job(pool, user_id)
    job2 = await _insert_job(pool, user_id)

    claimed1 = await worker._claim_job()
    assert claimed1 is not None
    assert claimed1.id in (job1, job2)

    # The other job belongs to the same (now live-leased) user — per-user serialization means it
    # cannot be claimed even though it's independently claimable in isolation.
    claimed2 = await worker._claim_job()
    assert claimed2 is None


async def test_claim_reclaims_a_stale_lease(pool):
    worker = GenerationWorker(pool, settings=_fast_settings(worker_lease_stale_s=0.2))
    user_id = uuid.uuid4()
    job_id = await _insert_job(pool, user_id)

    first = await worker._claim_job()
    assert first is not None and first.id == job_id
    assert await worker._claim_job() is None  # not yet stale

    await asyncio.sleep(0.25)

    second = await worker._claim_job()
    assert second is not None
    assert second.id == job_id
    assert second.lease_token != first.lease_token


# -- fencing --------------------------------------------------------------------------------


async def test_fenced_write_rejected_after_lease_reclaimed(pool):
    worker = GenerationWorker(pool, settings=_fast_settings())
    user_id = uuid.uuid4()
    job_id = await _insert_job(pool, user_id)

    claimed = await worker._claim_job()
    assert claimed is not None

    # Simulate another worker reclaiming the job after this one's lease went stale.
    new_token = uuid.uuid4()
    await pool.execute(
        "UPDATE generation_jobs SET lease_token = $1 WHERE id = $2", new_token, job_id
    )

    ok = await worker._advance_status(job_id, claimed.lease_token, "planning")
    assert ok is False

    row = await _job_row(pool, job_id)
    assert row["status"] == "queued"  # the stale-token writer's update never landed


async def test_insert_problem_rejected_after_lease_reclaimed(pool):
    worker = GenerationWorker(pool, settings=_fast_settings())
    user_id = uuid.uuid4()
    job_id = await _insert_job(pool, user_id)
    claimed = await worker._claim_job()
    assert claimed is not None

    await pool.execute(
        "UPDATE generation_jobs SET lease_token = $1 WHERE id = $2", uuid.uuid4(), job_id
    )

    plan = Plan(
        primary_type="arrays_hashing",
        support_types=[],
        shape="optimize_subarray",
        problem_rating=1000,
        premise="p",
        is_probe=True,
    )
    built = BuiltProblem(
        output=BuilderOutput.model_validate(sum_problem_builder_output()),
        brute_solution=sum_problem_oracle_output()["brute_solution"],
    )
    problem_id = await worker._insert_problem(job_id, claimed.lease_token, user_id, plan, built)
    assert problem_id is None
    assert await pool.fetchval("SELECT COUNT(*) FROM problems WHERE user_id = $1", user_id) == 0


# -- resume from plan_json (never re-plans) ------------------------------------------------------


async def test_resolve_plan_resumes_without_replanning(pool):
    worker = GenerationWorker(pool, settings=_fast_settings())
    user_id = uuid.uuid4()
    plan = Plan(
        primary_type="arrays_hashing",
        support_types=[],
        shape="optimize_subarray",
        problem_rating=1000,
        premise="already planned",
        is_probe=True,
    )
    job_id = await _insert_job(
        pool, user_id, status="building", plan_json=json.dumps(plan.to_json())
    )
    claimed = await worker._claim_job()
    assert claimed is not None and claimed.id == job_id
    assert claimed.plan_json is not None

    class ExplodingLLM:
        async def complete(self, prompt: str, schema: Any) -> Any:
            raise AssertionError("the planner must not be called when plan_json already exists")

    resuming_worker = GenerationWorker(pool, llm=ExplodingLLM(), settings=_fast_settings())
    resolved = await resuming_worker._resolve_plan(claimed)
    assert resolved == plan


# -- queue invariant maintenance (§7.1, §9) ------------------------------------------------------


async def test_replenish_bootstraps_two_jobs_for_a_new_user_and_is_idempotent(pool):
    worker = GenerationWorker(pool, settings=_fast_settings())
    user_id = uuid.uuid4()

    created = await worker.replenish(user_id)
    assert len(created) == 2

    assert await worker.replenish(user_id) == []


async def test_replenish_tops_up_an_established_user_missing_a_ready_slot(pool):
    worker = GenerationWorker(pool, settings=_fast_settings())
    user_id = uuid.uuid4()

    # A user who has practiced before (a resolved problem exists), with no ready problem and no
    # live job — replenish should create exactly one.
    await pool.execute(
        """
        INSERT INTO problems (
          user_id, status, primary_type, shape, problem_rating, title, statement_md, signature,
          starter_code, public_tests, private_tests, hints, reference_solution, complexity,
          par_minutes, resolved_at
        ) VALUES ($1, 'solved', 'arrays_hashing', 'optimize_subarray', 1200, 't', 's', '{}',
                  'c', '[]', '[]', '[]', 'r', '{}', 5, now())
        """,
        user_id,
    )

    created = await worker.replenish(user_id)
    assert len(created) == 1
    assert await worker.replenish(user_id) == []


# -- amendment 42 regression: cleanup on a mid-repair crash --------------------------------------


async def test_problem_row_marked_failed_when_builder_crashes_mid_repair(pool, monkeypatch):
    """A build/oracle failure on a REPAIR attempt (i.e. after the first attempt's problems row
    already exists) must still mark that row 'failed' (amendment 42) — not leave a dangling
    'building' row that reserves its type/shape forever. Regression test for a bug where the
    failure handler used the stale problem_id captured at claim time instead of the live one."""
    from leetmind import worker as worker_module
    from leetmind.verify import Disagreement, VerifyResult

    user_id = uuid.uuid4()
    llm = FakeLLM(
        [
            (BUILDER_REPAIR_MARKER, {"title": "incomplete, missing required fields"}),
            (BUILDER_MARKER, sum_problem_builder_output()),
            (QUALITY_REVIEW_MARKER, aligned_quality_review_output()),
            (ORACLE_MARKER, sum_problem_oracle_output()),
            (PLANNER_MARKER, fresh_user_plan_output()),
        ]
    )

    async def _always_fails(judge: Any, built: Any, *, settings: Any = None) -> VerifyResult:
        return VerifyResult(ok=False, disagreements=[Disagreement("x", "seeded failure")])

    monkeypatch.setattr(worker_module, "verify_problem", _always_fails)

    worker = GenerationWorker(pool, llm=llm, settings=_fast_settings())
    job_id = await _insert_job(pool, user_id)

    assert await worker.run_once() is True

    job = await _job_row(pool, job_id)
    assert job["status"] == "failed"
    assert job["problem_id"] is not None

    problem = await pool.fetchrow("SELECT status FROM problems WHERE id = $1", job["problem_id"])
    assert problem["status"] == "failed"


# -- full lifecycle, with a repair (real Docker) -------------------------------------------------


async def test_full_lifecycle_with_repair_produces_an_active_verified_problem(pool, judge_image):
    """queued -> planning -> building -> verifying(fails, buggy reference) -> building(repaired)
    -> verifying(passes) -> ready, promoted to `active` (first-ever problem for this user), and
    the queue invariant's missing ready slot is replenished."""
    user_id = uuid.uuid4()
    llm = FakeLLM(
        [
            (BUILDER_REPAIR_MARKER, sum_problem_builder_output(buggy=False)),
            (BUILDER_MARKER, sum_problem_builder_output(buggy=True)),
            (QUALITY_REVIEW_MARKER, aligned_quality_review_output()),
            (ORACLE_MARKER, sum_problem_oracle_output()),
            (PLANNER_MARKER, fresh_user_plan_output()),
        ]
    )
    judge_settings = Settings(
        _env_file=None,
        judge_image=judge_image,
        judge_verify_wall_s=30.0,
        judge_per_test_limit_s=2.0,
        judge_oracle_limit_s=5.0,
    )
    judge = JudgeClient(judge_settings)
    worker = GenerationWorker(pool, llm=llm, judge=judge, settings=_fast_settings())

    job_id = await _insert_job(pool, user_id)

    assert await worker.run_once() is True

    job = await _job_row(pool, job_id)
    assert job["status"] == "ready"
    assert job["repair_count"] == 1
    assert job["problem_id"] is not None

    problem = await pool.fetchrow("SELECT * FROM problems WHERE id = $1", job["problem_id"])
    assert problem["status"] == "active"  # no other active problem existed yet
    assert problem["primary_type"] == "arrays_hashing"
    assert json.loads(problem["constraints"]) == [
        "0 <= nums.length <= 100",
        "-100 <= nums[i] <= 100",
    ]
    assert "sum(nums) + 1" not in problem["reference_solution"]  # the repaired version survived

    # Worker job completion replenishes the queue invariant's missing ready slot (§7.1).
    live_jobs = await pool.fetchval(
        "SELECT COUNT(*) FROM generation_jobs "
        "WHERE user_id = $1 AND status NOT IN ('ready', 'failed')",
        user_id,
    )
    assert live_jobs == 1
