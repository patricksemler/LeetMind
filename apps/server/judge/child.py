#!/usr/bin/env python3
"""Per-test child interpreter (PLAN_BACKEND.md §8.2, amendment 38).

Freshly spawned by runner.py for every single test — no state leaks between tests. Installs a
seccomp-BPF filter immediately before running user code, denying process creation (fork/vfork/
clone/clone3), setsid/setpgid, ptrace, and the kill family. Consequence: a grandchild that
re-setsid's out of the process group runner.py kills can never exist, and this process cannot
signal its own parent. User code cannot spawn processes or threads — acceptable for v1 algorithm
problems.

Nothing here decides pass/fail or enforces the timeout: this process just runs one function on one
input and reports what happened. The server-side comparator (judge.py) owns the verdict.
"""

from __future__ import annotations

import contextlib
import ctypes
import ctypes.util
import io
import json
import sys
import traceback
from typing import Any

TRACEBACK_CAP = 4096

# Amendment 38: process creation, session/group escape, ptrace, and signalling — not a general
# syscall allowlist. Everything else (compute, stdlib data structures, printing) stays allowed.
_DENIED_SYSCALLS = (
    "fork",
    "vfork",
    "clone",
    "clone3",
    "setsid",
    "setpgid",
    "ptrace",
    "kill",
    "tkill",
    "tgkill",
)

_SCMP_ACT_ALLOW = 0x7FFF0000
_EPERM = 1


def _install_seccomp_filter() -> None:
    """Best-effort by design: if libseccomp isn't loadable, syscalls stay allowed and the
    container-level flags (--cap-drop, --pids-limit, --network none, non-root) remain the
    fallback layer — a missing library shouldn't turn every legitimate submission into an error."""
    path = ctypes.util.find_library("seccomp")
    if not path:
        return
    try:
        lib = ctypes.CDLL(path)
    except OSError:
        return

    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint,
    ]
    lib.seccomp_load.restype = ctypes.c_int
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]

    ctx = lib.seccomp_init(ctypes.c_uint32(_SCMP_ACT_ALLOW))
    if not ctx:
        return
    try:
        scmp_act_errno = ctypes.c_uint32(0x00050000 | _EPERM)
        for name in _DENIED_SYSCALLS:
            nr = lib.seccomp_syscall_resolve_name(name.encode())
            if nr == -1:
                continue
            lib.seccomp_rule_add(ctx, scmp_act_errno, ctypes.c_int(nr), ctypes.c_uint(0))
        lib.seccomp_load(ctx)
    finally:
        lib.seccomp_release(ctx)


def main() -> None:
    request = json.loads(sys.stdin.readline())
    code = request["code"]
    func_name = request["func_name"]
    args = request["args"]

    _install_seccomp_filter()

    namespace: dict[str, Any] = {}
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<submission>", "exec"), namespace)  # noqa: S102
            func = namespace[func_name]
            value = func(*args)
        json.dumps(value)  # fail here (as a normal error) if value leaves the §8.4 grammar
    except Exception:  # noqa: BLE001 — arbitrary user code; anything it raises is a plain verdict
        tb = traceback.format_exc()[-TRACEBACK_CAP:]
        print(json.dumps({"error": tb, "printed": buf.getvalue()}))
        return

    print(json.dumps({"value": value, "printed": buf.getvalue()}))


if __name__ == "__main__":
    main()
