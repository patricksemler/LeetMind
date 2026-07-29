"""LLM CLI adapter tests (PLAN_BACKEND.md §7.5, §12): a fake `claude`-shaped script stands in for
the real CLI so the suite never depends on a live model or network access."""

from __future__ import annotations

import json
import stat
import textwrap
from pathlib import Path

import pytest
from pydantic import BaseModel

from leetmind.config import Settings
from leetmind.llm import LLMClient, LLMError, _build_argv


class Greeting(BaseModel):
    message: str


def _write_fake_cli(tmp_path: Path, script: str) -> str:
    path = tmp_path / "fake-claude"
    path.write_text(script)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def _settings(bin_path: str, **overrides: object) -> Settings:
    return Settings(_env_file=None, llm_cli="claude", llm_bin=bin_path, **overrides)  # type: ignore[arg-type]


async def test_complete_parses_envelope_and_body(tmp_path: Path):
    script = textwrap.dedent(
        """\
        #!/bin/sh
        cat >/dev/null
        printf '%s' '{"type":"result","is_error":false,"result":"{\\"message\\": \\"hi\\"}"}'
        """
    )
    bin_path = _write_fake_cli(tmp_path, script)
    client = LLMClient(_settings(bin_path))

    result = await client.complete("say hi", Greeting)

    assert result.message == "hi"


async def test_complete_prefers_native_structured_output(tmp_path: Path):
    script = textwrap.dedent(
        """\
        #!/bin/sh
        cat >/dev/null
        printf '%s' \
          '{"type":"result","is_error":false,"result":"not json",\
"structured_output":{"message":"structured"}}'
        """
    )
    bin_path = _write_fake_cli(tmp_path, script)
    client = LLMClient(_settings(bin_path))

    result = await client.complete("say hi", Greeting)

    assert result.message == "structured"


def test_claude_argv_enforces_schema_in_minimal_one_shot_mode():
    argv = _build_argv(_settings("/fake/claude"), Greeting)

    schema = json.loads(argv[argv.index("--json-schema") + 1])
    assert schema["properties"]["message"]["type"] == "string"
    assert "--safe-mode" in argv
    assert "--no-session-persistence" in argv
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--effort") + 1] == "low"
    assert "structured JSON" in argv[argv.index("--system-prompt") + 1]


async def test_nonzero_exit_raises(tmp_path: Path):
    script = "#!/bin/sh\ncat >/dev/null\necho 'boom' >&2\nexit 1\n"
    bin_path = _write_fake_cli(tmp_path, script)
    client = LLMClient(_settings(bin_path))

    with pytest.raises(LLMError, match="exited 1"):
        await client.complete("say hi", Greeting)


async def test_is_error_envelope_raises(tmp_path: Path):
    script = textwrap.dedent(
        """\
        #!/bin/sh
        cat >/dev/null
        printf '%s' '{"type":"result","is_error":true,"result":"rate limited"}'
        """
    )
    bin_path = _write_fake_cli(tmp_path, script)
    client = LLMClient(_settings(bin_path))

    with pytest.raises(LLMError, match="rate limited"):
        await client.complete("say hi", Greeting)


async def test_retries_once_on_invalid_json_then_succeeds(tmp_path: Path):
    # First call's stdin has no "RETRY" marker (the original prompt); second call's stdin
    # includes the retry suffix this adapter appends, so we can tell attempts apart.
    script = textwrap.dedent(
        """\
        #!/bin/sh
        input=$(cat)
        case "$input" in
          *"failed validation"*)
            printf '%s' '{"type":"result","is_error":false,"result":"{\\"message\\": \\"fixed\\"}"}'
            ;;
          *)
            printf '%s' '{"type":"result","is_error":false,"result":"not json"}'
            ;;
        esac
        """
    )
    bin_path = _write_fake_cli(tmp_path, script)
    client = LLMClient(_settings(bin_path))

    result = await client.complete("say hi", Greeting)

    assert result.message == "fixed"


async def test_fails_after_retry_exhausted(tmp_path: Path):
    script = textwrap.dedent(
        """\
        #!/bin/sh
        cat >/dev/null
        printf '%s' '{"type":"result","is_error":false,"result":"still not json"}'
        """
    )
    bin_path = _write_fake_cli(tmp_path, script)
    client = LLMClient(_settings(bin_path))

    with pytest.raises(LLMError):
        await client.complete("say hi", Greeting)


async def test_transport_failures_are_capped_at_two_total_invocations(monkeypatch):
    client = LLMClient(Settings(_env_file=None, llm_cli="claude", llm_bin="/unused"))
    calls = 0

    async def fail_invoke(prompt, settings, schema):  # noqa: ANN001, ANN202
        nonlocal calls
        calls += 1
        raise LLMError("provider unavailable")

    monkeypatch.setattr(client, "_invoke", fail_invoke)

    with pytest.raises(LLMError, match="provider unavailable"):
        await client.complete("say hi", Greeting)
    assert calls == 2


async def test_missing_binary_raises_llm_error(tmp_path: Path):
    # Regression: a nonexistent binary used to escape as FileNotFoundError, which neither the
    # planner nor the worker catches — the generation job kept its lease and re-crashed forever.
    # As LLMError it takes the normal failure path (deterministic fallback / failed job).
    missing = str(tmp_path / "no-such-cli")
    client = LLMClient(_settings(missing))

    with pytest.raises(LLMError, match="no-such-cli"):
        await client.complete("say hi", Greeting)


async def test_unexecutable_binary_raises_llm_error(tmp_path: Path):
    # Same escape path via PermissionError: the file exists but has no execute bit.
    path = tmp_path / "not-executable"
    path.write_text("#!/bin/sh\n")
    client = LLMClient(_settings(str(path)))

    with pytest.raises(LLMError, match="not-executable"):
        await client.complete("say hi", Greeting)


async def test_timeout_raises(tmp_path: Path):
    script = "#!/bin/sh\ncat >/dev/null\nsleep 5\n"
    bin_path = _write_fake_cli(tmp_path, script)
    client = LLMClient(_settings(bin_path, llm_timeout_s=0.2))

    with pytest.raises(LLMError, match="timed out"):
        await client.complete("say hi", Greeting)


async def test_server_secrets_not_in_child_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://should-not-leak")
    script = textwrap.dedent(
        """\
        #!/bin/sh
        cat >/dev/null
        if [ -n "$DATABASE_URL" ]; then
          printf '%s' '{"type":"result","is_error":false,"result":"{\\"message\\": \\"leaked\\"}"}'
        else
          printf '%s' '{"type":"result","is_error":false,"result":"{\\"message\\": \\"clean\\"}"}'
        fi
        """
    )
    bin_path = _write_fake_cli(tmp_path, script)
    client = LLMClient(_settings(bin_path))

    result = await client.complete("say hi", Greeting)

    assert result.message == "clean"
