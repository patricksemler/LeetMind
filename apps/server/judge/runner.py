#!/usr/bin/env python3
"""In-container executor (PLAN_BACKEND.md §8.2, amendment 38).

Reads a handshake, then reads one test input at a time from stdin and writes one result line to
stdout — never holding an input it hasn't run, never seeing expected outputs or labels, so there
is nothing in here worth stealing (that's the point of the split with the server-side comparator).

Each test runs in a fresh child interpreter (child.py), spawned in its own session/process group.
On timeout this process kills that whole group, then sweeps /proc for any same-UID survivor —
belt and braces under the container's --pids-limit. There is no in-process alarm: the timeout is
enforced entirely from outside, so nothing user code does inside the child can cancel it.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time

CHILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "child.py")
PRINTED_CAP = 4096
ERROR_CAP = 4096


def _read_line(stream: object) -> str | None:
    line = stream.readline()  # type: ignore[attr-defined]
    return line if line else None


def _kill_group_and_sweep(child_pid: int) -> None:
    try:
        pgid = os.getpgid(child_pid)
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass

    my_pid = os.getpid()
    my_uid = os.getuid()
    try:
        entries = os.listdir("/proc")
    except OSError:
        return
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == my_pid:
            continue
        try:
            st = os.stat(f"/proc/{entry}")
            if st.st_uid != my_uid:
                continue
            os.kill(pid, signal.SIGKILL)
        except OSError:
            continue


def _run_one(code: str, func_name: str, args: list[object], limit_s: float) -> dict[str, object]:
    proc = subprocess.Popen(  # noqa: S603
        [sys.executable, "-u", CHILD],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    payload = json.dumps({"code": code, "func_name": func_name, "args": args}).encode()
    start = time.monotonic()
    timed_out = False
    out = b""
    try:
        out, _ = proc.communicate(input=payload + b"\n", timeout=limit_s)
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        # Always kill + sweep, timeout or not: a child that raced ahead of us shouldn't leave
        # anything behind either.
        _kill_group_and_sweep(proc.pid)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

    duration_ms = int((time.monotonic() - start) * 1000)

    if timed_out:
        return {"outcome": "timeout", "duration_ms": duration_ms}

    text = out.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0 or not text:
        return {
            "outcome": "error",
            "error": f"process exited abnormally (code {proc.returncode})"[:ERROR_CAP],
            "duration_ms": duration_ms,
        }

    try:
        parsed = json.loads(text.splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return {"outcome": "error", "error": "malformed child output", "duration_ms": duration_ms}

    printed = str(parsed.get("printed", ""))[:PRINTED_CAP]
    if "error" in parsed:
        return {
            "outcome": "error",
            "error": str(parsed["error"])[:ERROR_CAP],
            "printed": printed,
            "duration_ms": duration_ms,
        }
    return {
        "outcome": "value",
        "value": parsed.get("value"),
        "printed": printed,
        "duration_ms": duration_ms,
    }


def main() -> None:
    handshake_line = _read_line(sys.stdin)
    if handshake_line is None:
        return
    handshake = json.loads(handshake_line)
    code = handshake["code"]
    func_name = handshake["func_name"]
    limit_s = float(handshake["limit_s"])

    while True:
        line = _read_line(sys.stdin)
        if line is None:
            break
        test = json.loads(line)
        result = _run_one(code, func_name, test["args"], limit_s)
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
