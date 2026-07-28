"""CLI subprocess adapter (PLAN_BACKEND.md §7.5, decision 12).

`LLMClient.complete` is the only entry point the rest of the generation pipeline uses: give it a
prompt and a pydantic schema, get back a validated instance. Everything else — which CLI, which
model, how its JSON envelope is shaped — is an implementation detail contained here.

Containment (amendments 37, 40): every invocation gets a sanitized allowlist environment (no
server secrets), a fresh empty temp dir as cwd, native JSON-schema enforcement, and a safe,
tool-less, non-persistent one-shot CLI mode. `LLM_CONTAINER=1` optionally wraps the call in its
own container for a genuine boundary on hosted deploys; local-first (decision 19) leaves it off
by default.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import tempfile
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from leetmind.config import Settings, get_settings
from leetmind.fixtures import fixture_response

logger = logging.getLogger("leetmind.llm")

T = TypeVar("T", bound=BaseModel)

# Only what a CLI needs to run and authenticate with its own already-logged-in session; server
# secrets (DATABASE_URL, SUPABASE_JWT_SECRET, ...) are never in this list (amendment 37).
_ENV_ALLOWLIST = (
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "SHELL",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
)

_RETRY_SUFFIX = (
    "\n\nYour previous response failed validation with this error:\n{error}\n"
    "Respond again with ONLY the corrected JSON — no prose, no markdown fences."
)


class LLMError(RuntimeError):
    """The CLI failed outright (nonzero exit, timeout, unparsable envelope)."""


def _sanitized_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k in _ENV_ALLOWLIST}


def _build_argv(settings: Settings, schema: type[BaseModel]) -> list[str]:
    extra = shlex.split(settings.llm_args) if settings.llm_args else []
    bin_name = settings.llm_bin or settings.llm_cli
    if settings.llm_cli == "claude":
        schema_json = json.dumps(schema.model_json_schema(), separators=(",", ":"))
        return [
            bin_name,
            "-p",
            "--output-format",
            "json",
            "--model",
            settings.llm_model,
            "--json-schema",
            schema_json,
            "--safe-mode",
            "--no-session-persistence",
            "--tools",
            "",
            *extra,
        ]
    if settings.llm_cli == "codex":
        return [bin_name, "exec", "--json", *extra]
    raise LLMError(f"unknown LLM_CLI {settings.llm_cli!r}")


def _containerize(argv: list[str], cwd: str, env: dict[str, str], settings: Settings) -> list[str]:
    """Amendment 40's optional genuine boundary: the CLI runs inside its own container, no volume
    mounts beyond the temp dir. The image must already have the CLI installed and authenticated —
    that's a deploy-time concern, out of scope here (§15)."""
    docker_args = ["docker", "run", "--rm", "-i", "-v", f"{cwd}:{cwd}:rw", "-w", cwd]
    for key, value in env.items():
        docker_args += ["-e", f"{key}={value}"]
    return [*docker_args, settings.llm_container_image, *argv]


def _unwrap_envelope(raw: str, settings: Settings) -> str:
    """Unwraps the CLI's own JSON envelope to get at the model's JSON body (still a string, still
    needs its own `json.loads`)."""
    text = raw.strip()
    if not text:
        raise LLMError("LLM CLI produced no output")

    if settings.llm_cli == "claude":
        try:
            envelope = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(f"could not parse claude CLI JSON envelope: {exc}") from exc
        if not isinstance(envelope, dict):
            raise LLMError("claude CLI envelope was not a JSON object")
        if envelope.get("is_error"):
            raise LLMError(f"claude CLI reported an error: {envelope.get('result')!r}")
        structured = envelope.get("structured_output")
        if isinstance(structured, dict):
            return json.dumps(structured)
        result = envelope.get("result")
        if not isinstance(result, str):
            raise LLMError("claude CLI envelope missing a string 'result' field")
        return result

    if settings.llm_cli == "codex":
        # `codex exec --json` streams one JSON object per line; the final line carries the
        # model's answer.
        last_line = text.splitlines()[-1]
        try:
            envelope = json.loads(last_line)
        except json.JSONDecodeError as exc:
            raise LLMError(f"could not parse codex CLI JSON output: {exc}") from exc
        if isinstance(envelope, dict):
            for key in ("content", "text", "message"):
                value = envelope.get(key)
                if isinstance(value, str):
                    return value
        raise LLMError("codex CLI output missing a recognizable text field")

    raise LLMError(f"unknown LLM_CLI {settings.llm_cli!r}")


class LLMClient:
    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    async def complete(self, prompt: str, schema: type[T]) -> T:
        """Runs the CLI, parses+validates its output against `schema`. One retry on a parse or
        validation failure, with the error appended to the prompt (decision 12); a second failure
        propagates so the caller (planner/builder) can fall back."""
        settings = self._settings
        try:
            return await self._complete_once(prompt, schema, settings)
        except (LLMError, ValidationError, json.JSONDecodeError) as exc:
            logger.warning("LLM call failed validation, retrying once: %s", exc)
            retry_prompt = prompt + _RETRY_SUFFIX.format(error=exc)
            return await self._complete_once(retry_prompt, schema, settings)

    async def _complete_once(self, prompt: str, schema: type[T], settings: Settings) -> T:
        if settings.llm_cli == "fixture":
            # No subprocess at all: a canned response by prompt marker (leetmind.fixtures), for a
            # live server with no CLI to call — e.g. the Playwright e2e smoke (§12). Deliberately
            # not caught by `complete()`'s retry-on-validation-failure: a fixture that doesn't
            # match should fail loudly, not retry into the same miss.
            return schema.model_validate(fixture_response(prompt))
        raw = await self._invoke(prompt, settings, schema)
        body = _unwrap_envelope(raw, settings)
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as exc:
            raise LLMError(f"model output was not valid JSON: {exc}") from exc
        return schema.model_validate(parsed)

    async def _invoke(self, prompt: str, settings: Settings, schema: type[BaseModel]) -> str:
        argv = _build_argv(settings, schema)
        env = _sanitized_env()

        with tempfile.TemporaryDirectory(prefix="leetmind-llm-") as cwd:
            run_argv = _containerize(argv, cwd, env, settings) if settings.llm_container else argv
            proc = await asyncio.create_subprocess_exec(
                *run_argv,
                cwd=None if settings.llm_container else cwd,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            assert proc.stdin is not None
            proc.stdin.write(prompt.encode())
            await proc.stdin.drain()
            proc.stdin.close()

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=settings.llm_timeout_s
                )
            except TimeoutError:
                proc.kill()
                await proc.wait()
                raise LLMError(
                    f"LLM CLI timed out after {settings.llm_timeout_s}s"
                ) from None

        if proc.returncode != 0:
            raise LLMError(
                f"LLM CLI exited {proc.returncode}: {stderr.decode(errors='replace')[:2000]}"
            )
        return stdout.decode()
