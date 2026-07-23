"""`handle_verify` — the `verify` job-kind handler (CONTRACTS.md §5 `JobHandler` shape), ready to
be registered into `content/algolift_content/workers/content_worker.py`'s `HANDLERS` dict:

    from algolift_content.verification import handle_verify
    HANDLERS["verify"] = handle_verify

**Rejection vs. infrastructure-failure, made explicit:** a genuine verification REJECTION (a
candidate problem that fails one of the six stages) is a SUCCESSFUL outcome from the job queue's
point of view — the job did its job; there is nothing to retry, since re-running the same
candidate through the same deterministic gate will fail the same way. `handle_verify` therefore
returns normally (causing `algolift_content.queue.run_worker` to `ack()` the job) whenever
`verify_problem_version` returns a report at all, whether `report.passed` is True or False.

It re-raises whenever `verify_problem_version` itself raises, which only happens for genuine
infrastructure problems: `algolift_content.sandbox.SandboxUnavailable` (docker/node down, the
bridge crashed, ...), a database error from the persistence transaction, or any other unexpected
exception. Re-raising lets `run_worker` call `queue.fail()`, which requeues the job for retry
(and eventually parks it as `dead` after `max_attempts`) — exactly what CONTRACTS.md §5 intends
for a job that couldn't be executed, as opposed to one that executed and produced a real (if
negative) result.
"""

from __future__ import annotations

from typing import Any

from algolift_content.db import query_one
from algolift_content.logging import get_logger
from algolift_content.models import VerifyJobPayload
from algolift_content.queue import Job, WorkerContext
from algolift_content.verification.runner import verify_problem_version

log = get_logger("content-verify")


def handle_verify(job: Job, ctx: WorkerContext) -> None:
    payload = VerifyJobPayload.model_validate(job.payload)

    row: dict[str, Any] | None = query_one(
        "select content from problem_versions where id = %s", (payload.problem_version_id,)
    )
    if row is None:
        # No such problem_versions row (yet). This can legitimately be a race — the row-creating
        # transaction (generation worker) hasn't become visible yet — so raise and let the queue
        # retry rather than treating a merely-not-yet-visible row as a permanent problem.
        raise RuntimeError(f"problem_versions row not found for id={payload.problem_version_id!r}")

    # Any exception from here (SandboxUnavailable, a DB error, ...) is an infrastructure failure
    # and is deliberately left to propagate — see module docstring.
    report = verify_problem_version(
        payload.problem_version_id,
        content=row["content"],
        correlation_id=payload.correlation_id,
    )

    log.info(
        "verification complete",
        problem_version_id=payload.problem_version_id,
        passed=report.passed,
        failed_stage=report.failed_stage,
        duration_ms=report.duration_ms,
    )
    # A completed report — pass OR fail — is a successful job outcome: return normally so
    # run_worker acks it. Do not raise for a rejection.
