"""Real-Docker judge matrix (PLAN_BACKEND.md §12): pass/WA/error/timeout/memory-bomb/fork-bomb/
network-attempt fixtures, output-cap truncation, kill-by-name on wall timeout, and the
escape-attempt fixtures (seccomp-denied syscalls, a cancelled alarm, monkeypatched builtins) —
all of which must yield a plain `error`/`timeout` verdict, never a crash of the judge itself."""

from __future__ import annotations

import subprocess
import uuid

import pytest

from leetmind.judge import JudgeClient
from leetmind.schemas import TestCase, ValueType, Verdict


def _exec_id() -> str:
    return f"judgetest-{uuid.uuid4().hex[:10]}"


def _container_exists(exec_id: str) -> bool:
    out = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"name=exec-{exec_id}", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    return out.stdout.strip() != ""


INT_LIST = ValueType(kind="int", list_depth=1)
INT_TYPE = ValueType(kind="int")


async def test_all_tests_pass(judge_client: JudgeClient):
    code = (
        "def two_sum(nums, target):\n"
        "    for i in range(len(nums)):\n"
        "        for j in range(i + 1, len(nums)):\n"
        "            if nums[i] + nums[j] == target:\n"
        "                return [i, j]\n"
        "    return []\n"
    )
    tests = [
        TestCase(args=[[2, 7, 11, 15], 9], expected=[0, 1], value_type=INT_LIST),
        TestCase(args=[[3, 2, 4], 6], expected=[1, 2], value_type=INT_LIST),
    ]
    exec_id = _exec_id()
    outcomes = []
    async with judge_client.session(exec_id, code, "two_sum") as session:
        async for outcome in session.run(tests):
            outcomes.append(outcome)

    assert [o.verdict for o in outcomes] == [Verdict.PASS, Verdict.PASS]
    assert not _container_exists(exec_id)


async def test_wrong_answer_and_early_stop(judge_client: JudgeClient):
    code = "def solve(x):\n    return x + 1\n"
    tests = [
        TestCase(args=[1], expected=99, value_type=INT_TYPE),  # wrong on the first test
        TestCase(args=[2], expected=3, value_type=INT_TYPE),  # never reached
    ]
    exec_id = _exec_id()
    outcomes = []
    async with judge_client.session(exec_id, code, "solve") as session:
        async for outcome in session.run(tests):
            outcomes.append(outcome)
            if outcome.verdict != Verdict.PASS:
                break  # §8.3: stop sending after the first failure

    assert len(outcomes) == 1
    assert outcomes[0].verdict == Verdict.WRONG_ANSWER
    assert not _container_exists(exec_id)


async def test_exception_yields_error_verdict(judge_client: JudgeClient):
    code = "def solve(x):\n    return 1 / 0\n"
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve") as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.ERROR
    assert "ZeroDivisionError" in (outcomes[0].error or "")


async def test_timeout_verdict(judge_client: JudgeClient):
    code = "import time\n" "def solve(x):\n" "    time.sleep(30)\n" "    return x\n"
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve", per_test_limit_s=1.0) as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.TIMEOUT
    assert not _container_exists(exec_id)


async def test_memory_bomb_yields_error_not_crash(judge_client: JudgeClient):
    code = (
        "def solve(x):\n"
        "    data = []\n"
        "    while True:\n"
        "        data.append('x' * 10**7)\n"
        "    return x\n"
    )
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve", per_test_limit_s=5.0) as session:
        outcomes = [o async for o in session.run(tests)]

    # Killed by the container's --memory cap, not by our own logic — only its own run dies.
    assert outcomes[0].verdict in (Verdict.ERROR, Verdict.TIMEOUT)
    assert not _container_exists(exec_id)


async def test_network_attempt_unreachable(judge_client: JudgeClient):
    code = (
        "import socket\n"
        "def solve(x):\n"
        "    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n"
        "    s.settimeout(2)\n"
        "    s.connect(('8.8.8.8', 80))\n"
        "    return x\n"
    )
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve") as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.ERROR


async def test_fork_bomb_denied_by_seccomp(judge_client: JudgeClient):
    code = (
        "import os\n"
        "def solve(x):\n"
        "    while True:\n"
        "        os.fork()\n"
        "    return x\n"
    )
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve", per_test_limit_s=3.0) as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.ERROR
    assert "PermissionError" in (outcomes[0].error or "")


async def test_ptrace_denied_by_seccomp(judge_client: JudgeClient):
    code = (
        "import ctypes\n"
        "def solve(x):\n"
        "    libc = ctypes.CDLL('libc.so.6', use_errno=True)\n"
        "    ret = libc.ptrace(0, 0, 0, 0)\n"
        "    err = ctypes.get_errno()\n"
        "    if ret != -1 or err != 1:\n"
        "        raise AssertionError(f'ptrace not blocked: ret={ret} errno={err}')\n"
        "    return x\n"
    )
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve") as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.PASS, outcomes[0].error


async def test_setsid_and_kill_denied_by_seccomp(judge_client: JudgeClient):
    code = (
        "import ctypes, os\n"
        "def solve(x):\n"
        "    libc = ctypes.CDLL('libc.so.6', use_errno=True)\n"
        "    setsid_ret = libc.setsid()\n"
        "    setsid_err = ctypes.get_errno()\n"
        "    ctypes.set_errno(0)\n"
        "    kill_ret = libc.kill(os.getppid(), 9)\n"
        "    kill_err = ctypes.get_errno()\n"
        "    if (setsid_ret, setsid_err) != (-1, 1):\n"
        "        raise AssertionError('setsid not blocked')\n"
        "    if (kill_ret, kill_err) != (-1, 1):\n"
        "        raise AssertionError('kill not blocked')\n"
        "    return x\n"
    )
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve") as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.PASS, outcomes[0].error


async def test_cancelled_alarm_does_not_defeat_timeout(judge_client: JudgeClient):
    """There is no in-process alarm to cancel by design (§8.2) — the kill comes from the
    executor, outside the child entirely. Confirm ignoring SIGALRM changes nothing."""
    code = (
        "import signal\n"
        "def solve(x):\n"
        "    signal.signal(signal.SIGALRM, signal.SIG_IGN)\n"
        "    signal.alarm(0)\n"
        "    while True:\n"
        "        pass\n"
        "    return x\n"
    )
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve", per_test_limit_s=1.0) as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.TIMEOUT
    assert not _container_exists(exec_id)


async def test_monkeypatched_builtins_do_not_escape(judge_client: JudgeClient):
    """Patching os.kill/builtins inside the child can't touch the executor: it's a separate OS
    process. The child just quietly fails to sabotage anything and the real kill still lands."""
    code = (
        "import os, time\n"
        "def solve(x):\n"
        "    os.kill = lambda *a, **k: None\n"
        "    os.killpg = lambda *a, **k: None\n"
        "    time.sleep(30)\n"
        "    return x\n"
    )
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve", per_test_limit_s=1.0) as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.TIMEOUT
    assert not _container_exists(exec_id)


async def test_printed_output_is_capped(judge_client: JudgeClient):
    code = "def solve(x):\n" "    print('y' * 20000)\n" "    return x\n"
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve") as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.PASS
    assert len(outcomes[0].printed) <= 4096


async def test_error_message_is_capped(judge_client: JudgeClient):
    code = "def solve(x):\n" "    raise ValueError('e' * 20000)\n"
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve") as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.ERROR
    assert len(outcomes[0].error or "") <= 4096


async def test_wall_clock_kills_container_by_name(judge_client: JudgeClient):
    """The session-level wall clock (not the per-test child timeout) is the safety net over the
    whole container; it must kill the named container even mid-test."""
    code = "import time\n" "def solve(x):\n" "    time.sleep(30)\n" "    return x\n"
    tests = [TestCase(args=[1], expected=1, value_type=INT_TYPE)]
    exec_id = _exec_id()
    # per_test_limit_s outlives the session wall clock, so the wall clock — not the in-container
    # executor — has to be what ends this session.
    async with judge_client.session(
        exec_id, code, "solve", wall_s=2.0, per_test_limit_s=30.0
    ) as session:
        outcomes = [o async for o in session.run(tests)]

    assert outcomes[0].verdict == Verdict.TIMEOUT
    assert not _container_exists(exec_id)


@pytest.mark.parametrize("order_insensitive", [False, True])
async def test_order_insensitive_end_to_end(judge_client: JudgeClient, order_insensitive: bool):
    code = "def solve(x):\n" "    return list(reversed(x))\n"
    tests = [
        TestCase(
            args=[[1, 2, 3]],
            expected=[1, 2, 3],
            value_type=INT_LIST,
            order_insensitive=order_insensitive,
        )
    ]
    exec_id = _exec_id()
    async with judge_client.session(exec_id, code, "solve") as session:
        outcomes = [o async for o in session.run(tests)]

    expected_verdict = Verdict.PASS if order_insensitive else Verdict.WRONG_ANSWER
    assert outcomes[0].verdict == expected_verdict
