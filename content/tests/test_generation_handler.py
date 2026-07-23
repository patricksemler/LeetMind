"""Tests for algolift_content.generation.handler.handle_generate — the terminal-vs-retryable
distinction is the whole point of this module (CONTRACTS.md §11), so it gets its own focused
test file. `get_invoker` is monkeypatched at the generator module level so these tests are fully
offline regardless of the real `GENERATOR_INVOKER` env setting."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from conftest import postgres_reachable
from pydantic import ValidationError
from ulid import ULID

from algolift_content.config import get_settings
from algolift_content.db import assert_test_database, get_pool, query
from algolift_content.generation.handler import handle_generate
from algolift_content.generation.invoker import InvokeResult, StubInvoker
from algolift_content.logging import get_logger
from algolift_content.models import GenerationConceptWeight, GenerationRequest
from algolift_content.queue import Job, WorkerContext

pytestmark = pytest.mark.skipif(
    not postgres_reachable(), reason="Postgres not reachable on TEST_DATABASE_URL"
)


@pytest.fixture(autouse=True)
def _clean_content_tables() -> Iterator[None]:
    # docs/CONTRACTS.md §13: assert (again, defense in depth) right before this destructive
    # fixture truncates — conftest.py already redirected+guarded DATABASE_URL at import time, but
    # this is the actual truncate call, so it re-checks its own target immediately beforehand.
    assert_test_database(get_settings().DATABASE_URL)
    pool = get_pool()
    sql = (
        "truncate table jobs, model_runs, verification_reports, problem_concepts, "
        "submissions, problem_versions, problems cascade;"
    )
    with pool.connection() as conn:
        conn.execute(sql)
    yield
    with pool.connection() as conn:
        conn.execute(sql)


def _make_job(payload: dict[str, Any], *, correlation_id: str | None = None) -> Job:
    now = datetime.now(UTC)
    return Job(
        id=str(ULID()),
        kind="generate",
        priority=100,
        payload=payload,
        status="leased",
        attempts=1,
        max_attempts=3,
        run_at=now,
        lease_expires_at=None,
        leased_by="test-worker",
        last_error=None,
        idempotency_key=None,
        correlation_id=correlation_id,
        created_at=now,
        updated_at=now,
    )


def _make_ctx() -> WorkerContext:
    return WorkerContext(
        stop_event=threading.Event(), heartbeat=lambda: True, logger=get_logger("test")
    )


def _request_payload(concept_id: str = "sliding_window") -> dict[str, Any]:
    request = GenerationRequest(
        concepts=[GenerationConceptWeight(id=concept_id, weight=1.0)],
        target_rating=1200.0,
        rating_tolerance=100.0,
        expected_minutes=(8, 20),
        prompt_version="v1",
    )
    return {"request": request.model_dump(mode="json")}


def test_handle_generate_acks_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "algolift_content.generation.generator.get_invoker", lambda settings=None: StubInvoker()
    )
    job = _make_job(_request_payload(), correlation_id="handler-test-success")

    handle_generate(job, _make_ctx())  # must not raise

    rows = query(
        "select status from model_runs where correlation_id = %s;", ("handler-test-success",)
    )
    assert [r["status"] for r in rows] == ["ok"]
    pv_rows = query("select state from problem_versions;")
    assert len(pv_rows) == 1 and pv_rows[0]["state"] == "candidate"


def test_handle_generate_acks_on_terminal_schema_exhaustion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A schema failure exhausted after all retries is terminal: `handle_generate` must return
    normally (so the caller's `run_worker` acks the job), NOT raise (which would trigger a queue
    retry of a job that will just fail the same way again)."""

    class _AlwaysGarbageInvoker:
        def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult:
            return InvokeResult(
                text="not json",
                model="fake",
                input_tokens=1,
                output_tokens=1,
                cost_usd=0.0,
                duration_ms=1,
            )

    monkeypatch.setattr(
        "algolift_content.generation.generator.get_invoker",
        lambda settings=None: _AlwaysGarbageInvoker(),
    )
    job = _make_job(_request_payload(), correlation_id="handler-test-exhausted")

    handle_generate(job, _make_ctx())  # must NOT raise — terminal, ack-worthy

    rows = query(
        "select status from model_runs where correlation_id = %s order by created_at;",
        ("handler-test-exhausted",),
    )
    assert rows and all(r["status"] == "schema_error" for r in rows)
    assert query("select 1 from problem_versions;") == []


def test_handle_generate_raises_on_infrastructure_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """An invoker/infrastructure failure must propagate out of `handle_generate` so the caller's
    `run_worker` treats it as a normal retryable job failure (CONTRACTS.md §5's queue.fail path),
    not an ack."""

    class _DeadInvoker:
        def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult:
            raise RuntimeError("claude binary crashed")

    monkeypatch.setattr(
        "algolift_content.generation.generator.get_invoker", lambda settings=None: _DeadInvoker()
    )
    job = _make_job(_request_payload(), correlation_id="handler-test-infra-failure")

    with pytest.raises(RuntimeError, match="claude binary crashed"):
        handle_generate(job, _make_ctx())

    rows = query(
        "select status from model_runs where correlation_id = %s;",
        ("handler-test-infra-failure",),
    )
    assert [r["status"] for r in rows] == ["invoke_error"]


def test_handle_generate_rejects_malformed_payload_without_calling_generator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("generate_problem should never be reached with a bad payload")

    monkeypatch.setattr("algolift_content.generation.handler.generate_problem", _boom)
    job = _make_job({"not": "a valid GenerateJobPayload"})

    with pytest.raises(ValidationError):
        handle_generate(job, _make_ctx())
