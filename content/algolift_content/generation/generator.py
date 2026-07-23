"""`generate_problem` — the generation pipeline (docs/CONTRACTS.md §11): build prompt -> invoke
-> parse -> (retry on schema failure) -> persist candidate + enqueue verification.

Two very different kinds of failure are modeled as two different Python exception types, because
`algolift_content.generation.handler.handle_generate` must treat them completely differently:

  - `GenerationSchemaExhausted` — the model kept invoking successfully but never produced text
    that parses as a `ProblemVersion`, even after `GENERATOR_MAX_SCHEMA_RETRIES` repair attempts.
    This is a TERMINAL outcome: every attempt is already durably recorded as a `model_runs` row
    (`status='schema_error'`), and nothing about retrying the whole job later would help (the
    model would just fail the same way again, burning more tokens). The handler acks the job.
  - Anything else that escapes this module (`InvokerError` from a dead/unauthenticated CLI, a
    DB error, ...) is an infrastructure failure: transient, and worth the queue's normal
    retry-with-backoff. It is allowed to propagate normally.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Literal

from psycopg.types.json import Json
from pydantic import ValidationError
from ulid import ULID

from algolift_content.config import Settings, get_settings
from algolift_content.db import get_pool, query, transaction
from algolift_content.generation.envelope import EnvelopeError, parse_envelope
from algolift_content.generation.invoker import Invoker, InvokeResult, get_invoker
from algolift_content.generation.prompts.v2 import (
    PROMPT_VERSION,
    build_generation_prompt,
    build_repair_prompt,
)
from algolift_content.logging import get_logger
from algolift_content.models import GenerationRequest, ModelRun, ProblemVersion
from algolift_content.queue import Queue

log = get_logger("content-generation-generator")


class GenerationSchemaExhausted(RuntimeError):
    """Terminal outcome (see module docstring): `GENERATOR_MAX_SCHEMA_RETRIES` retries were spent
    and the model never produced text parseable as a `ProblemVersion`. Every attempt is already
    recorded in `model_runs`; the caller should treat this as "done, nothing to show for it", not
    as something a queue retry could fix."""

    def __init__(self, message: str, *, attempts: int, last_errors: str) -> None:
        super().__init__(message)
        self.attempts = attempts
        self.last_errors = last_errors


@dataclass
class GeneratedCandidate:
    """The result of a successful `generate_problem` call."""

    problem_id: str
    problem_version_id: str
    version: int
    problem_version: ProblemVersion
    model_run_id: str
    verify_job_id: str | None
    attempts: int


def _format_validation_error(exc: ValidationError) -> str:
    lines = [
        f"  - {'.'.join(str(p) for p in err['loc']) or '(root)'}: {err['msg']}"
        for err in exc.errors()
    ]
    return f"{exc.error_count()} validation error(s):\n" + "\n".join(lines)


def _output_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _model_run_request_payload(
    request_dict: dict[str, Any], result: InvokeResult | None
) -> dict[str, Any]:
    """`model_runs` has no dedicated usage column (that table is owned by a migration this agent
    does not touch), so the invocation's usage/model-attribution detail is nested into the
    `request` jsonb column instead, alongside the original `GenerationRequest` dump, under
    `usage`/`model_usage` keys — see `InvokeResult.usage`/`InvokeResult.model_usage`'s docstrings
    for what each holds and why `input_tokens`/`output_tokens` alone are not enough (a single
    `claude -p` call can span more than one model, and prompt tokens can be mostly cache
    reads/writes rather than fresh `input_tokens`). Returns a NEW dict each time — never mutates
    the shared `request_dict` built once per `generate_problem` call, since multiple attempts
    (with different usage each) share that base dict."""
    payload = dict(request_dict)
    if result is not None:
        if result.usage is not None:
            payload["usage"] = result.usage
        if result.model_usage is not None:
            payload["model_usage"] = result.model_usage
    return payload


def _insert_model_run(run: ModelRun, *, conn: Any = None) -> None:
    """Writes one `model_runs` row (CONTRACTS.md §3). Called with `conn=None` for immediate,
    independently-committed writes (every failed attempt — these must survive even if the overall
    job later fails for an unrelated reason) and with an explicit transaction connection for the
    single successful attempt's row, which must live or die atomically with the `problem_versions`
    row and `verify` job it accompanies (CONTRACTS.md §11 test 1)."""
    sql = """
        insert into model_runs
          (id, kind, invoker, model, prompt_version, request, duration_ms, output_hash,
           input_tokens, output_tokens, cost_usd, problem_version_id, status, error,
           correlation_id, created_at)
        values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """
    params = (
        run.id,
        run.kind,
        run.invoker,
        run.model,
        run.prompt_version,
        Json(run.request),
        run.duration_ms,
        run.output_hash,
        run.input_tokens,
        run.output_tokens,
        run.cost_usd,
        run.problem_version_id,
        run.status,
        run.error,
        run.correlation_id,
        run.created_at,
    )
    query(sql, params, conn=conn)


def _persist_candidate(
    problem_version: ProblemVersion,
    *,
    ok_model_run: ModelRun,
    correlation_id: str | None,
) -> GeneratedCandidate:
    """CONTRACTS.md §11: "On success: create the problems row (if new) + a problem_versions row
    with state='candidate', then enqueue a verify job in the SAME transaction with
    idempotency_key = verify:<problem_version_id>." The successful attempt's `model_runs` row
    (status='ok') is written in the SAME transaction too — a forced failure anywhere in this
    block must roll back all four writes together (problems/problem_versions/model_runs/jobs),
    which is exactly what the generation test suite's rollback test asserts.

    A fresh `problem_id`/`version=1` are always assigned here, overwriting whatever the model put
    in those fields — CONTRACTS.md §11 only covers NEW-problem generation (there is no revision
    flow in this module), and a server-assigned id is the only safe primary key source for
    untrusted model output.
    """
    problem_id = str(ULID())
    problem_version_id = str(ULID())
    problem_version.problem_id = problem_id
    problem_version.version = 1

    content = problem_version.model_dump(mode="json")
    low_minutes, high_minutes = problem_version.expected_active_minutes

    queue = Queue(get_pool())

    with transaction() as conn:
        query(
            "insert into problems (id, internal_name) values (%s, %s) "
            "on conflict (id) do nothing;",
            (problem_id, problem_version.internal_name),
            conn=conn,
        )
        query(
            """
            insert into problem_versions
              (id, problem_id, version, state, content, title, difficulty_rating,
               difficulty_confidence, expected_min_minutes, expected_max_minutes, comparator,
               provenance, created_at)
            values (%s,%s,%s,'candidate',%s,%s,%s,%s,%s,%s,%s,%s, now());
            """,
            (
                problem_version_id,
                problem_id,
                1,
                Json(content),
                problem_version.title,
                problem_version.difficulty.rating,
                problem_version.difficulty.confidence,
                low_minutes,
                high_minutes,
                problem_version.comparator,
                Json(problem_version.provenance.model_dump(mode="json")),
            ),
            conn=conn,
        )

        ok_model_run.problem_version_id = problem_version_id
        _insert_model_run(ok_model_run, conn=conn)

        job = queue.enqueue(
            conn,
            "verify",
            {"problem_version_id": problem_version_id, "correlation_id": correlation_id},
            idempotency_key=f"verify:{problem_version_id}",
            correlation_id=correlation_id,
        )

    return GeneratedCandidate(
        problem_id=problem_id,
        problem_version_id=problem_version_id,
        version=1,
        problem_version=problem_version,
        model_run_id=ok_model_run.id,
        verify_job_id=job.id if job is not None else None,
        attempts=0,  # filled in by the caller, which knows the attempt count
    )


def generate_problem(
    request: GenerationRequest,
    *,
    correlation_id: str | None = None,
    invoker: Invoker | None = None,
    settings: Settings | None = None,
) -> GeneratedCandidate:
    """The full generation pipeline for one `GenerationRequest` (CONTRACTS.md §11):

        build prompt -> invoke -> strip accidental fence -> parse as ProblemVersion
          -> (on schema failure) retry with build_repair_prompt, up to
             GENERATOR_MAX_SCHEMA_RETRIES times
          -> on success, persist candidate + enqueue verify (one transaction)

    Every invocation (success, schema failure, or invoker failure) writes a `model_runs` row —
    this is never skipped, including on the path that ultimately raises.

    Raises:
        GenerationSchemaExhausted: terminal — see module docstring. Every attempt has already
            been recorded in `model_runs`; no `problem_versions` row was created.
        Exception: whatever the invoker or the database raised, for a genuine infrastructure
            failure — propagates so the caller (a queue job handler) can retry later. The failing
            attempt is still recorded as a `model_runs` row (`status='invoke_error'`) before this
            re-raises.
    """
    s = settings or get_settings()
    active_invoker = invoker or get_invoker(s)
    invoker_name = s.GENERATOR_INVOKER
    request_dict = request.model_dump(mode="json")
    max_total_attempts = max(1, s.GENERATOR_MAX_SCHEMA_RETRIES + 1)

    prompt = build_generation_prompt(request)
    last_errors = ""

    for attempt_index in range(max_total_attempts):
        kind: Literal["generate", "repair"] = "generate" if attempt_index == 0 else "repair"
        is_last_attempt = attempt_index == max_total_attempts - 1

        try:
            result = active_invoker.invoke(prompt, timeout_ms=s.GENERATOR_TIMEOUT_MS)
        except Exception as exc:
            _insert_model_run(
                ModelRun(
                    kind=kind,
                    invoker=invoker_name,
                    model=None,
                    prompt_version=PROMPT_VERSION,
                    request=request_dict,
                    duration_ms=None,
                    output_hash=None,
                    input_tokens=None,
                    output_tokens=None,
                    cost_usd=None,
                    problem_version_id=None,
                    status="invoke_error",
                    error=str(exc),
                    correlation_id=correlation_id,
                )
            )
            log.error(
                "generation invoke failed",
                attempt=attempt_index + 1,
                invoker=invoker_name,
                error=str(exc),
                correlation_id=correlation_id,
            )
            raise

        output_hash = _output_hash(result.text)

        assembled: dict[str, Any] | None = None
        error_text: str | None = None
        try:
            assembled = parse_envelope(result.text)
        except EnvelopeError as exc:
            error_text = str(exc)

        problem_version: ProblemVersion | None = None
        if error_text is None:
            try:
                problem_version = ProblemVersion.model_validate(assembled)
            except ValidationError as exc:
                error_text = _format_validation_error(exc)

        if error_text is not None:
            _insert_model_run(
                ModelRun(
                    kind=kind,
                    invoker=invoker_name,
                    model=result.model,
                    prompt_version=PROMPT_VERSION,
                    request=_model_run_request_payload(request_dict, result),
                    duration_ms=result.duration_ms,
                    output_hash=output_hash,
                    input_tokens=result.input_tokens,
                    output_tokens=result.output_tokens,
                    cost_usd=result.cost_usd,
                    problem_version_id=None,
                    status="schema_error",
                    error=error_text,
                    correlation_id=correlation_id,
                )
            )
            last_errors = error_text
            log.warning(
                "generation schema failure",
                attempt=attempt_index + 1,
                max_total_attempts=max_total_attempts,
                error=error_text[:2000],
                correlation_id=correlation_id,
            )
            if is_last_attempt:
                raise GenerationSchemaExhausted(
                    f"generation exhausted {max_total_attempts} attempt(s) without a valid "
                    f"ProblemVersion: {error_text}",
                    attempts=attempt_index + 1,
                    last_errors=last_errors,
                )
            prompt = build_repair_prompt(request, result.text, error_text)
            continue

        assert problem_version is not None  # narrows for type-checkers; guaranteed by above
        ok_run = ModelRun(
            kind=kind,
            invoker=invoker_name,
            model=result.model,
            prompt_version=PROMPT_VERSION,
            request=_model_run_request_payload(request_dict, result),
            duration_ms=result.duration_ms,
            output_hash=output_hash,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cost_usd=result.cost_usd,
            problem_version_id=None,  # filled in by _persist_candidate once the id is known
            status="ok",
            error=None,
            correlation_id=correlation_id,
        )
        candidate = _persist_candidate(
            problem_version, ok_model_run=ok_run, correlation_id=correlation_id
        )
        candidate.attempts = attempt_index + 1
        log.info(
            "generation succeeded",
            attempt=candidate.attempts,
            problem_id=candidate.problem_id,
            problem_version_id=candidate.problem_version_id,
            verify_job_id=candidate.verify_job_id,
            correlation_id=correlation_id,
        )
        return candidate

    raise AssertionError("unreachable: loop always returns or raises")  # pragma: no cover
