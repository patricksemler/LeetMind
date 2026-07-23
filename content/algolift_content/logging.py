"""structlog configuration emitting single-line JSON to stdout, matching docs/CONTRACTS.md §1.

Required fields on every line: `ts, level, service, msg, correlation_id?, job_id?,
submission_id?, worker_id?`. Mirrors `packages/shared/src/logger.ts` (AsyncLocalStorage there,
`contextvars` here).

Usage:
    from algolift_content.logging import get_logger, bind_context, with_context

    log = get_logger("content-worker")
    bind_context(worker_id="host-123")
    log.info("worker started")

    with with_context(job_id=job.id, correlation_id=job.correlation_id):
        log.info("claimed job")
"""

from __future__ import annotations

import contextvars
import logging
import sys
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import structlog

_CONTEXT: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar(
    "algolift_log_context", default=None
)

_CONTEXT_KEYS = ("correlation_id", "job_id", "submission_id", "worker_id")


def _current_context() -> dict[str, str]:
    return _CONTEXT.get() or {}


def get_correlation_id() -> str | None:
    """Returns the correlation_id bound in the current context, if any."""
    return _current_context().get("correlation_id")


def new_correlation_id() -> str:
    """Generates a fresh correlation id (ULID-shaped-enough via uuid4 hex; callers that need a
    true ULID should use `ulid.new()` from python-ulid and pass it into bind_context instead)."""
    return uuid.uuid4().hex


def bind_context(**kw: str) -> None:
    """Merges `kw` into the active log context for the remainder of the current execution
    (mutates in place, mirrors `withContext` in the TS logger). Only the CONTRACTS §1 field
    names (correlation_id, job_id, submission_id, worker_id) are meaningful downstream, but any
    key is accepted/stored."""
    current = _current_context().copy()
    current.update({k: v for k, v in kw.items() if v is not None})
    _CONTEXT.set(current)


@contextmanager
def with_context(**kw: str) -> Iterator[None]:
    """Runs the enclosed block with `kw` merged into the active log context, restoring the prior
    context on exit (mirrors `runWithContext`, but merges rather than replaces)."""
    merged = _current_context().copy()
    merged.update({k: v for k, v in kw.items() if v is not None})
    token = _CONTEXT.set(merged)
    try:
        yield
    finally:
        _CONTEXT.reset(token)


def _inject_context(logger: Any, method_name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    ctx = _current_context()
    for key in _CONTEXT_KEYS:
        if key in ctx and key not in event_dict:
            event_dict[key] = ctx[key]
    return event_dict


def _rename_event_to_msg(
    logger: Any, method_name: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    if "event" in event_dict:
        event_dict["msg"] = event_dict.pop("event")
    return event_dict


_CONFIGURED = False


def configure_logging(level: str = "info", service: str = "content") -> None:
    """Configures structlog + stdlib logging for single-line JSON output. Idempotent — safe to
    call multiple times (e.g. once per process entrypoint, once per test)."""
    global _CONFIGURED
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, level.upper(), logging.INFO),
    )

    structlog.configure(
        processors=[
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", key="ts"),
            _inject_context,
            _rename_event_to_msg,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )
    _CONFIGURED = True


def get_logger(service: str) -> structlog.stdlib.BoundLogger:
    """Returns a structlog logger bound with `service`. Configures logging with default settings
    on first use if `configure_logging` hasn't been called explicitly yet (so importing modules
    can call `get_logger` at module scope without every entrypoint remembering to configure)."""
    if not _CONFIGURED:
        configure_logging()
    return structlog.get_logger(service=service)
