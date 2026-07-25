"""Codegen helpers used by the (future) verification stages.

`build_solution_module` / `render_generator_module` do text normalization ONLY — they never
execute or import the source they're given, because generated code is untrusted (PLAN.md §3:
"never run generated code in the worker process"). `seeded_inputs` is the one function here that
actually *runs* generated code (a problem's `input_generator_py`), and it always does so inside
the sandbox via `leetmind_content.sandbox.run_raw` — never in this process.
"""

from __future__ import annotations

import json
import re
from typing import Any

from leetmind_content.config import Settings, get_settings
from leetmind_content.logging import get_logger
from leetmind_content.models import Signature
from leetmind_content.sandbox import SandboxLimits, SandboxRequest, SandboxUnavailable, run_raw

log = get_logger("content-codegen")

_FENCE_RE = re.compile(r"^```(?:python)?\n(.*?)\n```$", re.DOTALL)
_GENERATE_DEF_RE = re.compile(r"^\s*def\s+generate\s*\(", re.MULTILINE)


class GeneratorContractError(RuntimeError):
    """Raised when `input_generator_py` (or its output) doesn't match the documented
    `generate(rng)` contract — a content-authoring bug, not a sandbox infrastructure failure
    (which raises `SandboxUnavailable` instead)."""


def build_solution_module(source: str) -> str:
    """Normalizes a solution/reference/mutant source string before it's written into a sandbox
    bundle as `solution.py` (CONTRACTS.md §7): normalizes line endings, strips a BOM, strips a
    leading/trailing markdown code fence if the model included one despite instructions not to,
    and ensures a trailing newline. Never executes or imports `source`."""
    text = source.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    stripped = text.strip()
    fence_match = _FENCE_RE.match(stripped)
    if fence_match:
        text = fence_match.group(1)
    if not text.endswith("\n"):
        text += "\n"
    return text


def render_generator_module(input_generator_py: str) -> str:
    """Normalizes `input_generator_py` the same way `build_solution_module` does, plus a cheap
    static check (regex only, no execution) that the documented `generate(rng)` entrypoint is
    present. Raises `GeneratorContractError` if not.

    THE `generate(rng)` CONTRACT (see also `seeded_inputs` below and content/README.md — the
    generation prompt must teach the model to emit exactly this shape):

        The generator module must define exactly one top-level function:

            def generate(rng: random.Random) -> list:
                ...
                return [arg0, arg1, ...]

        `generate` takes the seeded `random.Random` instance it should draw randomness from (it
        must NOT reseed or use Python's global `random` module — the seed is the whole point:
        reproducibility) and returns the positional argument list for exactly one test case, in
        the same order as `signature.params`.
    """
    text = build_solution_module(input_generator_py)
    if not _GENERATE_DEF_RE.search(text):
        raise GeneratorContractError(
            "input_generator_py does not define a top-level `def generate(rng): ...` function "
            "(see the generate(rng) contract documented on leetmind_content.codegen.seeded_inputs)"
        )
    return text


_DRIVER_FOOTER_TEMPLATE = """

def _leetmind_generate_cases():
    import json as _leetmind_json
    import random as _leetmind_random
    import sys as _leetmind_sys

    seed_start = {seed_start}
    count = {count}
    cases = []
    for _i in range(count):
        seed = seed_start + _i
        rng = _leetmind_random.Random(seed)
        args = generate(rng)
        cases.append({{"seed": seed, "args": args}})
    _leetmind_sys.stdout.write(_leetmind_json.dumps({{"cases": cases}}))


if __name__ == "__main__":
    _leetmind_generate_cases()
"""


def _render_driver(generator_module: str, *, count: int, seed_start: int) -> str:
    return generator_module + _DRIVER_FOOTER_TEMPLATE.format(seed_start=seed_start, count=count)


def seeded_inputs(
    generator_source: str,
    signature: Signature | dict[str, Any] | None,
    count: int,
    seed_start: int,
    *,
    image: str | None = None,
    limits: SandboxLimits | None = None,
    settings: Settings | None = None,
) -> list[dict[str, Any]]:
    """Runs a problem's `input_generator_py` inside the sandbox (see the `generate(rng)`
    contract on `render_generator_module`) and returns `count` seeded cases as
    `[{"seed": int, "args": [...]}, ...]`, driving `generate(rng)` once per case with
    `random.Random(seed_start)`, `random.Random(seed_start + 1)`, ... — all `count` calls happen
    inside a **single** sandbox invocation (batching matters: one container per case would be
    unusably slow for e.g. `VERIFY_DIFFERENTIAL_CASES`-sized suites).

    NEVER runs `generator_source` in this (worker) process — generated code is untrusted
    (PLAN.md §3) — always via `sandbox.run_raw`.

    Raises:
        GeneratorContractError: `input_generator_py` doesn't define `generate(rng)`, or its
            output doesn't match the documented shape (wrong arg count for `signature`, etc.).
        SandboxUnavailable: infrastructure failure (node/docker missing, bridge crashed, ...).
    """
    if count <= 0:
        return []

    s = settings or get_settings()
    resolved_image = image or s.SANDBOX_PYTHON_IMAGE
    resolved_limits = limits or SandboxLimits.from_settings(s)

    generator_module = render_generator_module(generator_source)
    driver = _render_driver(generator_module, count=count, seed_start=seed_start)

    request = SandboxRequest(
        image=resolved_image,
        files={"driver.py": driver},
        # `files` are mounted read-only at /bundle (packages/sandbox/src/run.ts's
        # materializeBundle + buildDockerArgs: `-v <bundleDir>:/bundle:ro`), while the
        # container's cwd is `-w /work` — a separate, empty tmpfs. argv must reference the
        # bundle path explicitly (see docker/runner-python/Dockerfile's own comment: "the
        # sandbox always supplies argv explicitly, e.g. ["python3", "/bundle/runner.py"]");
        # a bare "driver.py" resolves against /work and can never be found there. Verified
        # against the real sandbox CLI bridge (`node --import tsx packages/sandbox/src/cli.ts
        # exec`) while implementing leetmind_content.verification, which is the first caller
        # of seeded_inputs() to exercise it end-to-end.
        argv=["python3", "/bundle/driver.py"],
        limits=resolved_limits,
    )
    result = run_raw(request, settings=s)

    if result.timed_out:
        raise SandboxUnavailable(f"input_generator_py timed out generating {count} case(s)")
    if result.exit_code != 0:
        raise GeneratorContractError(
            f"input_generator_py exited {result.exit_code}: stderr_tail={result.stderr[-2000:]!r}"
        )
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GeneratorContractError(
            "input_generator_py driver did not print valid JSON: "
            f"stdout_tail={result.stdout[-2000:]!r}"
        ) from exc

    cases = parsed.get("cases") if isinstance(parsed, dict) else None
    if not isinstance(cases, list):
        raise GeneratorContractError(
            f"input_generator_py driver produced an unexpected shape: {parsed!r}"
        )

    if isinstance(signature, Signature):
        params = signature.params
    else:
        params = (signature or {}).get("params")
    expected_arity = len(params) if params is not None else None

    for case in cases:
        if not isinstance(case, dict) or "seed" not in case or "args" not in case:
            raise GeneratorContractError(f"malformed case from generator driver: {case!r}")
        if expected_arity is not None and len(case["args"]) != expected_arity:
            raise GeneratorContractError(
                f"generate(rng) returned {len(case['args'])} args, expected {expected_arity} "
                f"(signature has {expected_arity} params); case={case!r}"
            )

    return cases  # type: ignore[no-any-return]
