"""Tests for leetmind_content.workers.replenish — compute_demand's prediction rule, replenish_once's
watermark top-up + idempotency + per-pass cap, and buffer_report. Requires Postgres (skips the
whole module otherwise) with migrations + taxonomy seed applied.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from conftest import postgres_reachable
from ulid import ULID

from leetmind_content.config import get_settings
from leetmind_content.db import assert_test_database, get_pool, query
from leetmind_content.workers.replenish import buffer_report, compute_demand, replenish_once

pytestmark = pytest.mark.skipif(
    not postgres_reachable(), reason="Postgres not reachable on TEST_DATABASE_URL"
)

TEST_USER_ID = "01JTESTREPLENISHUSER000000"
TEST_USER_HANDLE = "test-replenish-user"


def _reset_state() -> None:
    # docs/CONTRACTS.md §13: assert (again, defense in depth) right before this destructive
    # fixture truncates — conftest.py already redirected+guarded DATABASE_URL at import time, but
    # this is the actual truncate call, so it re-checks its own target immediately beforehand.
    assert_test_database(get_settings().DATABASE_URL)
    pool = get_pool()
    with pool.connection() as conn:
        conn.execute("delete from submissions where user_id = %s;", (TEST_USER_ID,))
        conn.execute("delete from user_concept_state where user_id = %s;", (TEST_USER_ID,))
        conn.execute(
            "truncate table jobs, model_runs, verification_reports, problem_concepts, "
            "problem_versions, problems cascade;"
        )
        conn.execute("delete from users where id = %s;", (TEST_USER_ID,))


@pytest.fixture(autouse=True)
def _clean_state() -> Iterator[None]:
    _reset_state()
    query(
        "insert into users (id, handle) values (%s, %s) on conflict (id) do nothing;",
        (TEST_USER_ID, TEST_USER_HANDLE),
    )
    yield
    _reset_state()


def _seed_concept_state(
    concept_id: str,
    rating: float,
    *,
    uncertainty: float = 350.0,
    next_review_at: datetime | None = None,
) -> None:
    query(
        """
        insert into user_concept_state (user_id, concept_id, rating, uncertainty, next_review_at)
        values (%s, %s, %s, %s, %s)
        on conflict (user_id, concept_id) do update set
          rating = excluded.rating, uncertainty = excluded.uncertainty,
          next_review_at = excluded.next_review_at;
        """,
        (TEST_USER_ID, concept_id, rating, uncertainty, next_review_at),
    )


def _seed_approved_problem(concept_id: str, rating: int, *, attempted: bool = False) -> str:
    """Inserts one minimal `approved` problem_version primarily tagged `concept_id` at
    `rating`. If `attempted`, also inserts a completed submission by `TEST_USER_ID` against it
    (so it should NOT count toward that user's buffer depth)."""
    problem_id = str(ULID())
    pv_id = str(ULID())
    query("insert into problems (id, internal_name) values (%s, %s);", (problem_id, f"seed-{pv_id}"))
    query(
        """
        insert into problem_versions
          (id, problem_id, version, state, content, title, difficulty_rating, comparator)
        values (%s, %s, 1, 'approved', '{}'::jsonb, %s, %s, 'exact');
        """,
        (pv_id, problem_id, f"Seed Problem {pv_id}", rating),
    )
    query(
        "insert into problem_concepts (problem_version_id, concept_id, role, weight) "
        "values (%s, %s, 'primary', 1.0);",
        (pv_id, concept_id),
    )
    if attempted:
        query(
            """
            insert into submissions
              (id, user_id, problem_version_id, mode, language, source, source_hash, status)
            values (%s, %s, %s, 'submit', 'python', 'x', 'hash', 'completed');
            """,
            (str(ULID()), TEST_USER_ID, pv_id),
        )
    return pv_id


# ---------------------------------------------------------------------------
# compute_demand
# ---------------------------------------------------------------------------


def test_compute_demand_includes_weak_due_review_and_overload_cells() -> None:
    _seed_concept_state(
        "arrays_hashing", rating=1050, next_review_at=datetime.now(UTC) - timedelta(days=1)
    )
    _seed_concept_state("two_pointers", rating=1620)  # no review due

    cells = compute_demand(TEST_USER_ID)
    by_key = {(c.concept_id, c.band): c for c in cells}

    ah = by_key[("arrays_hashing", 1000)]
    assert set(ah.reasons) == {"weak", "due_review"}
    assert ("arrays_hashing", 1200) in by_key
    assert by_key[("arrays_hashing", 1200)].reasons == ("overload",)

    tp = by_key[("two_pointers", 1600)]
    assert tp.reasons == ("weak",)
    assert ("two_pointers", 1800) in by_key

    # An untouched concept (no user_concept_state row at all) still gets a default-rating cell.
    assert ("sorting", 1200) in by_key
    assert by_key[("sorting", 1200)].rating == 1200.0


def test_compute_demand_orders_due_review_and_weak_before_pure_overload() -> None:
    _seed_concept_state(
        "arrays_hashing", rating=900, next_review_at=datetime.now(UTC) - timedelta(hours=1)
    )
    cells = compute_demand(TEST_USER_ID)

    assert "due_review" in cells[0].reasons

    idx_due = next(i for i, c in enumerate(cells) if "due_review" in c.reasons)
    idx_pure_overload = next(i for i, c in enumerate(cells) if c.reasons == ("overload",))
    assert idx_due < idx_pure_overload


def test_compute_demand_overload_band_capped_at_max_band() -> None:
    _seed_concept_state("arrays_hashing", rating=2390)  # band 2200, overload would be 2400 (== MAX_BAND)
    cells = compute_demand(TEST_USER_ID)
    bands = {(c.concept_id, c.band) for c in cells if c.concept_id == "arrays_hashing"}
    assert ("arrays_hashing", 2200) in bands
    assert ("arrays_hashing", 2400) in bands
    assert not any(band > 2400 for (_, band) in bands)


# ---------------------------------------------------------------------------
# replenish_once — watermark top-up, idempotency keys, capping
# ---------------------------------------------------------------------------


def test_replenish_once_enqueues_missing_slots_with_correct_idempotency_keys() -> None:
    _seed_concept_state("arrays_hashing", rating=1250)  # band 1200
    _seed_approved_problem("arrays_hashing", rating=1230)  # 1 unit of inventory, unattempted

    settings = get_settings()
    assert settings.BUFFER_LOW_WATERMARK == 3

    result = replenish_once(TEST_USER_ID, settings=settings, max_enqueue_per_pass=200)

    assert "generate:arrays_hashing:1200:0" in result.jobs_enqueued
    assert "generate:arrays_hashing:1200:1" in result.jobs_enqueued
    # covered=1, watermark=3 -> deficit=2 -> only slots 0 and 1, never slot 2.
    assert "generate:arrays_hashing:1200:2" not in result.jobs_enqueued

    rows = query(
        "select idempotency_key from jobs where kind = 'generate' "
        "and idempotency_key like 'generate:arrays_hashing:1200:%' order by idempotency_key;"
    )
    assert [r["idempotency_key"] for r in rows] == [
        "generate:arrays_hashing:1200:0",
        "generate:arrays_hashing:1200:1",
    ]


def test_replenish_once_enqueues_at_lowest_generate_priority() -> None:
    _seed_concept_state("arrays_hashing", rating=1250)
    replenish_once(TEST_USER_ID, max_enqueue_per_pass=3)
    rows = query("select priority from jobs where kind = 'generate' limit 1;")
    assert rows and rows[0]["priority"] == 100  # CONTRACTS.md §4.4 JOB_PRIORITY['generate']


def test_replenish_once_second_pass_enqueues_nothing_new() -> None:
    _seed_concept_state("arrays_hashing", rating=1250)
    settings = get_settings()

    first = replenish_once(TEST_USER_ID, settings=settings, max_enqueue_per_pass=200)
    assert first.jobs_enqueued, "sanity: first pass should have enqueued something"
    assert first.jobs_skipped == []  # cap generous enough that nothing was capped either

    count_after_first = query("select count(*) as n from jobs where kind = 'generate';")[0]["n"]

    second = replenish_once(TEST_USER_ID, settings=settings, max_enqueue_per_pass=200)
    assert second.jobs_enqueued == []

    count_after_second = query("select count(*) as n from jobs where kind = 'generate';")[0]["n"]
    assert count_after_second == count_after_first


def test_replenish_once_does_not_plateau_once_every_slot_is_terminally_dead() -> None:
    # QA-PLAN.md §2.11, confirmed live: a fixed 0..watermark-1 slot range plateaus a cell below
    # watermark forever once every slot's generate job has resolved without contributing to the
    # approved pool (dead-lettered here for a deterministic repro; a `done`-but-rejected outcome
    # hits the exact same "every slot key already exists" wall). Deficit stays 3 throughout — no
    # inventory is ever seeded — so a healthy replenish must keep finding fresh slot numbers.
    _seed_concept_state("arrays_hashing", rating=1250)  # band 1200
    settings = get_settings()
    assert settings.BUFFER_LOW_WATERMARK == 3

    first = replenish_once(TEST_USER_ID, settings=settings, max_enqueue_per_pass=200)
    first_slots = sorted(k for k in first.jobs_enqueued if k.startswith("generate:arrays_hashing:1200:"))
    assert first_slots == [
        "generate:arrays_hashing:1200:0",
        "generate:arrays_hashing:1200:1",
        "generate:arrays_hashing:1200:2",
    ]

    # Simulate every one of those attempts exhausting its retries — the fixed-range bug's
    # trigger condition: every slot key in 0..watermark-1 now permanently exists.
    query("update jobs set status = 'dead' where kind = 'generate';")

    second = replenish_once(TEST_USER_ID, settings=settings, max_enqueue_per_pass=200)
    second_slots = sorted(k for k in second.jobs_enqueued if k.startswith("generate:arrays_hashing:1200:"))
    # The old fixed 0..2 range would find every key already taken and enqueue nothing here —
    # the cell would be stuck below watermark forever. Fresh slot numbers must appear instead.
    assert second_slots == [
        "generate:arrays_hashing:1200:3",
        "generate:arrays_hashing:1200:4",
        "generate:arrays_hashing:1200:5",
    ]


def test_replenish_once_honours_per_pass_cap_and_logs_skip(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # No inventory seeded at all -> every one of the 20 taxonomy concepts' weak+overload cells
    # is below watermark, far more candidate slots than the tiny cap below.
    result = replenish_once(TEST_USER_ID, max_enqueue_per_pass=5)

    assert len(result.jobs_enqueued) <= 5
    assert len(result.jobs_skipped) > 0, "cap should have been hit given zero inventory"
    assert len(result.jobs_enqueued) + len(result.jobs_skipped) >= 5

    captured = capsys.readouterr()
    assert "cap reached" in captured.out


def test_replenish_once_defaults_to_single_user_id() -> None:
    settings = get_settings()
    result = replenish_once(None, settings=settings, max_enqueue_per_pass=1)
    assert result.user_id == settings.SINGLE_USER_ID


# ---------------------------------------------------------------------------
# buffer_report
# ---------------------------------------------------------------------------


def test_buffer_report_reflects_depth_and_excludes_attempted_problems() -> None:
    _seed_concept_state("arrays_hashing", rating=1250)
    _seed_approved_problem("arrays_hashing", rating=1230)
    _seed_approved_problem("arrays_hashing", rating=1260, attempted=True)  # must not count

    report = buffer_report(TEST_USER_ID)
    entry = next(r for r in report if r["concept_id"] == "arrays_hashing" and r["band"] == 1200)

    assert entry["depth"] == 1
    assert entry["below_watermark"] is True
    assert entry["watermark"] == get_settings().BUFFER_LOW_WATERMARK


def test_buffer_report_is_read_only_and_enqueues_nothing() -> None:
    _seed_concept_state("arrays_hashing", rating=1250)
    buffer_report(TEST_USER_ID)
    rows = query("select count(*) as n from jobs;")
    assert rows[0]["n"] == 0
