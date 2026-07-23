"""Tests for algolift_content.generation.generator.generate_problem — the build-prompt -> invoke
-> parse -> (retry) -> persist+enqueue pipeline (CONTRACTS.md §11). Uses StubInvoker and small
fake Invoker test doubles; never the real `claude` binary. Requires Postgres (skips the whole
module otherwise) with migrations applied — writes/reads the real `problems`, `problem_versions`,
`model_runs`, and `jobs` tables, cleaning up after itself.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from conftest import postgres_reachable

from algolift_content.config import get_settings
from algolift_content.db import assert_test_database, get_pool, query
from algolift_content.generation.generator import (
    GenerationSchemaExhausted,
    generate_problem,
)
from algolift_content.generation.invoker import InvokeResult, StubInvoker
from algolift_content.models import GenerationConceptWeight, GenerationRequest
from algolift_content.queue import Queue

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
    with pool.connection() as conn:
        conn.execute(
            "truncate table jobs, model_runs, verification_reports, problem_concepts, "
            "submissions, problem_versions, problems cascade;"
        )
    yield
    with pool.connection() as conn:
        conn.execute(
            "truncate table jobs, model_runs, verification_reports, problem_concepts, "
            "submissions, problem_versions, problems cascade;"
        )


def _request(concept_id: str = "sliding_window") -> GenerationRequest:
    return GenerationRequest(
        concepts=[GenerationConceptWeight(id=concept_id, weight=1.0)],
        target_rating=1300.0,
        rating_tolerance=100.0,
        expected_minutes=(8, 20),
        prompt_version="v2",
    )


def _model_runs_for(correlation_id: str) -> list[dict[str, Any]]:
    return query(
        "select * from model_runs where correlation_id = %s order by created_at asc;",
        (correlation_id,),
    )


class _GarbageThenValidInvoker:
    """First call returns unparseable garbage (schema_error); second call delegates to a real
    StubInvoker (valid ProblemVersion, schema_error -> ok on retry)."""

    def __init__(self) -> None:
        self.calls = 0
        self._stub = StubInvoker()

    def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult:
        self.calls += 1
        if self.calls == 1:
            return InvokeResult(
                text="this is not { valid json at all",
                model="fake-model",
                input_tokens=10,
                output_tokens=5,
                cost_usd=0.001,
                duration_ms=50,
            )
        return self._stub.invoke(prompt, timeout_ms=timeout_ms)


class _AlwaysGarbageInvoker:
    def __init__(self) -> None:
        self.calls = 0

    def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult:
        self.calls += 1
        return InvokeResult(
            text=f"still not valid json, attempt {self.calls}",
            model="fake-model",
            input_tokens=10,
            output_tokens=5,
            cost_usd=0.001,
            duration_ms=50,
        )


class _AlwaysRaisingInvoker:
    def invoke(self, prompt: str, *, timeout_ms: int) -> InvokeResult:
        raise RuntimeError("simulated infrastructure failure (e.g. claude binary crashed)")


# ---------------------------------------------------------------------------
# 1. StubInvoker end-to-end, one transaction, rollback on forced failure
# ---------------------------------------------------------------------------


def test_generate_problem_end_to_end_with_stub_invoker() -> None:
    correlation_id = "test-corr-e2e"
    candidate = generate_problem(
        _request(), correlation_id=correlation_id, invoker=StubInvoker()
    )

    assert candidate.attempts == 1
    assert candidate.verify_job_id is not None

    pv_row = query(
        "select state, difficulty_rating from problem_versions where id = %s;",
        (candidate.problem_version_id,),
    )
    assert pv_row and pv_row[0]["state"] == "candidate"

    runs = _model_runs_for(correlation_id)
    assert len(runs) == 1
    assert runs[0]["status"] == "ok"
    assert runs[0]["problem_version_id"] == candidate.problem_version_id
    assert runs[0]["kind"] == "generate"
    # v2 (the ALGOLIFT-envelope prompt) is the default now.
    assert runs[0]["prompt_version"] == "v2"
    # usage/model_usage are nested into the request jsonb (model_runs has no dedicated usage
    # column) — see generator._model_run_request_payload.
    assert runs[0]["request"]["usage"]["output_tokens"] > 0
    assert "stub-v1" in runs[0]["request"]["model_usage"]

    job_row = query(
        "select idempotency_key, kind, status, priority from jobs "
        "where idempotency_key = %s;",
        (f"verify:{candidate.problem_version_id}",),
    )
    assert job_row and job_row[0]["kind"] == "verify"
    assert job_row[0]["status"] == "queued"


def test_generate_problem_forced_failure_rolls_back_everything(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    correlation_id = "test-corr-rollback"

    def raising_enqueue(self: Queue, executor: Any, kind: str, payload: Any, **kwargs: Any) -> Any:
        raise RuntimeError("forced failure inside the persist transaction")

    monkeypatch.setattr(Queue, "enqueue", raising_enqueue)

    with pytest.raises(RuntimeError, match="forced failure"):
        generate_problem(_request(), correlation_id=correlation_id, invoker=StubInvoker())

    assert query("select 1 from problem_versions;") == []
    assert _model_runs_for(correlation_id) == []
    assert query("select 1 from problems;") == []
    assert query("select 1 from jobs;") == []


# ---------------------------------------------------------------------------
# 2. Schema-failure retry: garbage then valid -> two model_runs rows
# ---------------------------------------------------------------------------


def test_generate_problem_retries_on_schema_failure_then_succeeds() -> None:
    correlation_id = "test-corr-retry"
    invoker = _GarbageThenValidInvoker()

    candidate = generate_problem(_request(), correlation_id=correlation_id, invoker=invoker)

    assert invoker.calls == 2
    assert candidate.attempts == 2

    runs = _model_runs_for(correlation_id)
    assert [r["status"] for r in runs] == ["schema_error", "ok"]
    assert runs[0]["kind"] == "generate"
    assert runs[1]["kind"] == "repair"
    assert runs[0]["problem_version_id"] is None
    assert runs[1]["problem_version_id"] == candidate.problem_version_id
    # Garbage (non-envelope) text fails at the envelope-parsing stage now, not JSON decoding —
    # the error names the specific missing delimiter (EnvelopeError, see envelope.py).
    assert "<<<ALGOLIFT_META>>>" in (runs[0]["error"] or "")


# ---------------------------------------------------------------------------
# 3. Exhausted retries -> terminal GenerationSchemaExhausted, no problem_versions row
# ---------------------------------------------------------------------------


def test_generate_problem_raises_terminal_error_after_exhausting_retries() -> None:
    correlation_id = "test-corr-exhausted"
    settings = get_settings().model_copy(update={"GENERATOR_MAX_SCHEMA_RETRIES": 1})
    invoker = _AlwaysGarbageInvoker()

    with pytest.raises(GenerationSchemaExhausted) as exc_info:
        generate_problem(
            _request(), correlation_id=correlation_id, invoker=invoker, settings=settings
        )

    assert exc_info.value.attempts == 2  # 1 initial + 1 retry
    assert invoker.calls == 2

    runs = _model_runs_for(correlation_id)
    assert len(runs) == 2
    assert all(r["status"] == "schema_error" for r in runs)
    assert [r["kind"] for r in runs] == ["generate", "repair"]

    assert query("select 1 from problem_versions;") == []
    assert query("select 1 from jobs;") == []


def test_generate_problem_records_invoke_error_and_reraises() -> None:
    correlation_id = "test-corr-invoke-error"

    with pytest.raises(RuntimeError, match="simulated infrastructure failure"):
        generate_problem(
            _request(), correlation_id=correlation_id, invoker=_AlwaysRaisingInvoker()
        )

    runs = _model_runs_for(correlation_id)
    assert len(runs) == 1
    assert runs[0]["status"] == "invoke_error"
    assert "simulated infrastructure failure" in runs[0]["error"]
    assert query("select 1 from problem_versions;") == []


def test_generate_problem_overrides_model_supplied_problem_id() -> None:
    """The model's own `problem_id`/`version` fields are never trusted for a brand-new
    problem — the server always assigns fresh ones (see generator.py's `_persist_candidate`
    docstring)."""
    candidate = generate_problem(
        _request(), correlation_id="test-corr-id-override", invoker=StubInvoker()
    )
    assert candidate.problem_version.problem_id == candidate.problem_id
    assert candidate.version == 1

    row = query("select id from problems where id = %s;", (candidate.problem_id,))
    assert row
