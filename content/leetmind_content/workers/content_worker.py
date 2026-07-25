"""Content worker entrypoint.

Run with:

    uv run python -m leetmind_content.workers.content_worker

Builds settings/logging/pool/queue, registers job-kind handlers in `HANDLERS`, and runs the
polling worker loop (`leetmind_content.queue.run_worker`) alongside a reaper thread. Handles
SIGINT/SIGTERM for graceful shutdown (CONTRACTS.md §5, §7).

Note (CONTRACTS.md §11, content/README.md): when `GENERATOR_INVOKER=claude`, this worker shells
out to the *host's* authenticated `claude` CLI, so it is normally run ON THE HOST, not inside
Docker — see content/README.md.

Job kinds handled: `verify` (the six-stage gate) and `generate` (model invocation). Both handlers
live in their own packages and are registered in `HANDLERS` below; `_dispatch`, the queue wiring,
the reaper, and the signal handling are all kind-agnostic, so adding a kind means adding a registry
entry and nothing else.
"""

from __future__ import annotations

import signal
import threading
from types import FrameType

from leetmind_content.config import get_settings
from leetmind_content.db import get_pool
from leetmind_content.generation import handle_generate
from leetmind_content.logging import configure_logging, get_logger
from leetmind_content.queue import Job, JobHandler, Queue, WorkerContext, run_worker, start_reaper
from leetmind_content.verification import handle_verify

log = get_logger("content-worker")


#: Job-kind -> handler registry, dispatched by `_dispatch` below.
#:
#: Both handlers take `(job, ctx)` and validate their own payload
#: (`VerifyJobPayload` / `GenerateJobPayload`). Each draws the same terminal-vs-retryable
#: distinction, which is what makes the queue behave sanely:
#:
#:   - `handle_verify` returns normally whenever the gate produced a report at all — a REJECTION
#:     is a successful outcome from the queue's point of view, so the job is acked, not retried.
#:     It raises only on genuine infrastructure failure (sandbox unavailable, DB error, missing
#:     problem_versions row), which the queue then retries with backoff.
#:   - `handle_generate` swallows `GenerationSchemaExhausted` (the model was reached but never
#:     produced schema-valid output — terminal, recorded in `model_runs`, acked) and lets
#:     invoker/DB errors propagate so the queue retries them.
HANDLERS: dict[str, JobHandler] = {
    "verify": handle_verify,
    "generate": handle_generate,
}


def _dispatch(job: Job, ctx: WorkerContext) -> None:
    handler = HANDLERS.get(job.kind)
    if handler is None:
        raise RuntimeError(f"no handler registered for job kind {job.kind!r}")
    handler(job, ctx)


def main() -> None:
    settings = get_settings()
    configure_logging(level=settings.LOG_LEVEL, service="content-worker")
    log.info("content worker starting", worker_id=settings.CONTENT_WORKER_ID)

    pool = get_pool()
    queue = Queue(
        pool,
        lease_seconds=settings.QUEUE_LEASE_SECONDS,
        worker_id=settings.CONTENT_WORKER_ID,
    )

    stop_event = threading.Event()

    def _handle_signal(signum: int, _frame: FrameType | None) -> None:
        log.info("shutdown signal received", signum=signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    reaper = start_reaper(
        queue, interval_ms=settings.QUEUE_REAPER_INTERVAL_MS, stop_event=stop_event
    )

    try:
        run_worker(
            queue,
            kinds=["verify", "generate"],
            concurrency=1,
            handler=_dispatch,
            worker_id=settings.CONTENT_WORKER_ID,
            stop_event=stop_event,
            poll_interval_ms=settings.QUEUE_POLL_INTERVAL_MS,
            heartbeat_ms=settings.QUEUE_HEARTBEAT_MS,
        )
    finally:
        stop_event.set()
        reaper.thread.join(timeout=5)
        log.info("content worker stopped")


if __name__ == "__main__":
    main()
