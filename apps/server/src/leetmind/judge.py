"""Docker run orchestration + server-side comparator (PLAN_BACKEND.md §8).

Two principles drive this module, per §8.2: user code never shares a process with anything that
must survive it (that's judge/runner.py + judge/child.py, inside the container), and no secret
ever enters the container — expected outputs, public/private labels, and verdict logic (this
file) all live server-side. The container is a dumb executor; this file decides what passed.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Sequence
from types import TracebackType
from typing import Any

from leetmind.config import Settings, get_settings
from leetmind.schemas import TestCase, TestOutcome, Verdict, values_equal

logger = logging.getLogger("leetmind.judge")


def _docker_run_args(name: str, image: str, memory: str, cpus: str, pids_limit: int) -> list[str]:
    """PLAN_BACKEND.md §8.1's exact flags. `--rm` reclaims the container on exit; the
    deterministic `--name` is what lets timeout cleanup kill the right one even if this
    process's own subprocess handle is gone."""
    return [
        "docker",
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:size=64m,noexec",
        "--memory",
        memory,
        "--memory-swap",
        memory,
        "--cpus",
        cpus,
        "--pids-limit",
        str(pids_limit),
        "--user",
        "65534:65534",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        image,
    ]


async def _kill_container(name: str) -> None:
    """Idempotent: a container that already exited (the common case — `--rm` already reaped it)
    just makes `docker kill` fail harmlessly."""
    proc = await asyncio.create_subprocess_exec(
        "docker",
        "kill",
        name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()


def _to_outcome(index: int, test: TestCase, raw: dict[str, Any]) -> TestOutcome:
    duration_ms = int(raw.get("duration_ms") or 0)
    kind = raw.get("outcome")
    if kind == "timeout":
        return TestOutcome(index=index, verdict=Verdict.TIMEOUT, duration_ms=duration_ms)
    if kind == "error":
        return TestOutcome(
            index=index,
            verdict=Verdict.ERROR,
            error=str(raw.get("error", "")),
            printed=str(raw.get("printed", "")),
            duration_ms=duration_ms,
        )
    value = raw.get("value")
    passed = values_equal(
        test.expected, value, test.value_type, order_insensitive=test.order_insensitive
    )
    return TestOutcome(
        index=index,
        verdict=Verdict.PASS if passed else Verdict.WRONG_ANSWER,
        value=value,
        printed=str(raw.get("printed", "")),
        duration_ms=duration_ms,
    )


class JudgeSession:
    """One judge container's lifetime, scoped to a single execution (run or submit).

    Use as an async context manager. `__aexit__` unconditionally kills the named container and
    releases the concurrency slot — whether the caller consumed every test, broke out early on
    the first private-test failure (§8.3: "the comparator... simply stops sending and kills the
    container"), or an exception propagated. Cleanup never depends on generator garbage
    collection.
    """

    def __init__(
        self,
        *,
        semaphore: asyncio.Semaphore,
        execution_id: str,
        code: str,
        func_name: str,
        image: str,
        memory: str,
        cpus: str,
        pids_limit: int,
        wall_s: float,
        per_test_limit_s: float,
    ) -> None:
        self._semaphore = semaphore
        self._container_name = f"exec-{execution_id}"
        self._code = code
        self._func_name = func_name
        self._image = image
        self._memory = memory
        self._cpus = cpus
        self._pids_limit = pids_limit
        self._wall_s = wall_s
        self._per_test_limit_s = per_test_limit_s
        self._proc: asyncio.subprocess.Process | None = None
        self._deadline = 0.0
        self._acquired = False

    async def __aenter__(self) -> JudgeSession:
        await self._semaphore.acquire()
        self._acquired = True
        self._proc = await asyncio.create_subprocess_exec(
            *_docker_run_args(
                self._container_name, self._image, self._memory, self._cpus, self._pids_limit
            ),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._deadline = time.monotonic() + self._wall_s
        assert self._proc.stdin is not None
        handshake = json.dumps(
            {"code": self._code, "func_name": self._func_name, "limit_s": self._per_test_limit_s}
        )
        self._proc.stdin.write((handshake + "\n").encode())
        await self._proc.stdin.drain()
        return self

    async def run(self, tests: Sequence[TestCase]) -> AsyncIterator[TestOutcome]:
        """Streams one test input at a time and yields one outcome per response — never holding
        an input the container hasn't run yet (§8.2). The caller decides when to stop (e.g. the
        first private-test failure); breaking out of the `async for` is safe, cleanup happens in
        `__aexit__` regardless."""
        assert self._proc is not None
        assert self._proc.stdin is not None
        assert self._proc.stdout is not None
        for index, test in enumerate(tests):
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                yield TestOutcome(
                    index=index, verdict=Verdict.TIMEOUT, error="judge wall-clock exceeded"
                )
                return
            self._proc.stdin.write((json.dumps({"args": test.args}) + "\n").encode())
            try:
                await asyncio.wait_for(self._proc.stdin.drain(), timeout=remaining)
                line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=remaining)
            except TimeoutError:
                yield TestOutcome(
                    index=index, verdict=Verdict.TIMEOUT, error="judge wall-clock exceeded"
                )
                return
            if not line:
                yield TestOutcome(
                    index=index, verdict=Verdict.ERROR, error="judge container exited unexpectedly"
                )
                return
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                yield TestOutcome(
                    index=index, verdict=Verdict.ERROR, error="malformed judge protocol response"
                )
                return
            yield _to_outcome(index, test, raw)

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        try:
            if self._proc is not None and self._proc.stdin is not None:
                with contextlib.suppress(OSError):
                    self._proc.stdin.close()
            await _kill_container(self._container_name)
            if self._proc is not None:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._proc.wait(), timeout=5)
        finally:
            if self._acquired:
                self._semaphore.release()


class JudgeClient:
    """Owns the process-local concurrency semaphore (`JUDGE_CONCURRENCY`, §8.1) shared across
    every session — v1 mandates a single server process (amendment 35), so this in-memory
    semaphore is the whole guard."""

    def __init__(self, settings: Settings | None = None) -> None:
        s = settings or get_settings()
        self._image = s.judge_image
        self._memory = s.judge_memory
        self._cpus = s.judge_cpus
        self._pids_limit = s.judge_pids_limit
        self._interactive_wall_s = s.judge_interactive_wall_s
        self._per_test_limit_s = s.judge_per_test_limit_s
        self._semaphore = asyncio.Semaphore(s.judge_concurrency)

    def session(
        self,
        execution_id: str,
        code: str,
        func_name: str,
        *,
        wall_s: float | None = None,
        per_test_limit_s: float | None = None,
    ) -> JudgeSession:
        return JudgeSession(
            semaphore=self._semaphore,
            execution_id=execution_id,
            code=code,
            func_name=func_name,
            image=self._image,
            memory=self._memory,
            cpus=self._cpus,
            pids_limit=self._pids_limit,
            wall_s=wall_s if wall_s is not None else self._interactive_wall_s,
            per_test_limit_s=per_test_limit_s
            if per_test_limit_s is not None
            else self._per_test_limit_s,
        )
