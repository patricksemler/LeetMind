"""`handle_generate` — the `'generate'` job handler (docs/CONTRACTS.md §11), registered by
`algolift_content.workers.content_worker` (see that module's "SEAM FOR FOLLOW-UP AGENTS" docstring
— replace `HANDLERS["generate"]` with `algolift_content.generation.handler.handle_generate`).

Import path for wiring: `algolift_content.generation.handler.handle_generate`.
"""

from __future__ import annotations

from algolift_content.generation.generator import GenerationSchemaExhausted, generate_problem
from algolift_content.logging import get_logger
from algolift_content.models import GenerateJobPayload
from algolift_content.queue import Job, WorkerContext

log = get_logger("content-generation-handler")


def handle_generate(job: Job, ctx: WorkerContext) -> None:
    """Job handler for `kind='generate'`.

    Terminal vs. retryable, made explicit (CONTRACTS.md §11):

      - `GenerationSchemaExhausted` (the model invoked successfully every time but never
        produced a schema-valid `ProblemVersion`, even after `GENERATOR_MAX_SCHEMA_RETRIES`
        repair attempts) is caught HERE and swallowed. Every attempt is already durably recorded
        as a `model_runs` row (`status='schema_error'`) by `generate_problem`, so nothing is
        lost; there is no `problem_versions` row and nothing more a retry of this same job would
        accomplish (the model would just fail the same way again). The handler returns
        normally, `run_worker` acks the job as done.
      - Anything else — an `InvokerError` (missing/unauthenticated `claude` binary, timeout,
        malformed CLI envelope beyond the invoker's own fallback handling) or a database error —
        is an infrastructure failure that a later retry has a real chance of fixing. It is NOT
        caught here: it propagates out of this function, `run_worker` calls `queue.fail(...)`,
        and the job is retried with backoff (eventually dead-lettered after `max_attempts`) per
        the normal queue semantics (CONTRACTS.md §5).
    """
    payload = GenerateJobPayload.model_validate(job.payload)
    correlation_id = payload.correlation_id or job.correlation_id

    try:
        candidate = generate_problem(payload.request, correlation_id=correlation_id)
    except GenerationSchemaExhausted as exc:
        log.warning(
            "generation exhausted schema retries; terminal outcome, acking job",
            job_id=job.id,
            attempts=exc.attempts,
            last_errors=exc.last_errors[:2000],
            correlation_id=correlation_id,
        )
        return

    log.info(
        "generate job completed",
        job_id=job.id,
        problem_id=candidate.problem_id,
        problem_version_id=candidate.problem_version_id,
        attempts=candidate.attempts,
        verify_job_id=candidate.verify_job_id,
        correlation_id=correlation_id,
    )
