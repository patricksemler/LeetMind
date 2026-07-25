"""Tests for leetmind_content.generation.invoker: ClaudeInvoker argv/envelope handling (mocked
subprocess — never the real `claude` binary in this test module), StubInvoker determinism and
gate-shaped output, and the get_invoker() factory."""

from __future__ import annotations

import json
import subprocess
from typing import Any

import pytest
from pydantic import ValidationError

from leetmind_content.config import Settings
from leetmind_content.generation.envelope import parse_envelope
from leetmind_content.generation.invoker import (
    ClaudeInvoker,
    CodexInvoker,
    InvokerError,
    StubInvoker,
    get_invoker,
)
from leetmind_content.generation.prompts.v2 import build_generation_prompt
from leetmind_content.models import (
    GenerationConceptWeight,
    GenerationRequest,
    ProblemVersion,
)

# ---------------------------------------------------------------------------
# ClaudeInvoker — argv construction + envelope parsing (mocked subprocess)
# ---------------------------------------------------------------------------


def _fake_settings(**overrides: Any) -> Settings:
    return Settings(**overrides)


def test_claude_invoker_argv_has_no_shell_and_correct_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_which(name: str) -> str:
        return f"/usr/local/bin/{name}"

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        envelope = {
            "result": '{"ok": true}',
            "is_error": False,
            "duration_ms": 1234,
            "total_cost_usd": 0.05,
            "usage": {"input_tokens": 111, "output_tokens": 22},
            "modelUsage": {"claude-opus-4-8[1m]": {"inputTokens": 111}},
        }
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(envelope), stderr="")

    monkeypatch.setattr("leetmind_content.generation.invoker.shutil.which", fake_which)
    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", fake_run)

    invoker = ClaudeInvoker(claude_bin="claude")
    result = invoker.invoke("hello world prompt", timeout_ms=5000)

    assert captured["argv"] == ["claude", "-p", "hello world prompt", "--output-format", "json"]
    # No shell=True, ever (CONTRACTS.md §11).
    assert captured["kwargs"].get("shell", False) is False
    assert "shell" not in captured["kwargs"] or captured["kwargs"]["shell"] is False
    assert captured["kwargs"]["capture_output"] is True
    assert captured["kwargs"]["text"] is True

    assert result.text == '{"ok": true}'
    assert result.model == "claude-opus-4-8[1m]"
    assert result.input_tokens == 111
    assert result.output_tokens == 22
    assert result.cost_usd == 0.05
    assert result.duration_ms == 1234


def test_claude_invoker_adds_model_flag_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """`GENERATOR_MODEL` (or an explicit `model=` constructor arg) must add `--model <name>` to
    argv — unset means no flag at all (CLI default), never a silently-implicit model choice."""
    captured: dict[str, Any] = {}

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        captured["argv"] = argv
        envelope = {"result": "ok", "is_error": False}
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(envelope), stderr="")

    monkeypatch.setattr(
        "leetmind_content.generation.invoker.shutil.which", lambda name: "/usr/local/bin/claude"
    )
    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", fake_run)

    invoker = ClaudeInvoker(claude_bin="claude", model="claude-sonnet-5")
    invoker.invoke("hi", timeout_ms=5000)
    assert captured["argv"] == [
        "claude",
        "-p",
        "hi",
        "--output-format",
        "json",
        "--model",
        "claude-sonnet-5",
    ]

    # Falls back to Settings.GENERATOR_MODEL when no explicit model= is given.
    settings = Settings(GENERATOR_MODEL="claude-opus-4-8")
    invoker2 = ClaudeInvoker(claude_bin="claude", settings=settings)
    invoker2.invoke("hi", timeout_ms=5000)
    assert "--model" in captured["argv"] and "claude-opus-4-8" in captured["argv"]

    # Unset (default) ⇒ no --model flag at all.
    invoker3 = ClaudeInvoker(claude_bin="claude", settings=Settings())
    invoker3.invoke("hi", timeout_ms=5000)
    assert "--model" not in captured["argv"]


def test_claude_invoker_sums_cache_tokens_and_attributes_dominant_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Real observed envelope shape: `usage.input_tokens` is only the UNCACHED remainder
    (`input_tokens=2` against `cache_creation_input_tokens=6236` +
    `cache_read_input_tokens=18689` on a real ~2712-output-token call), and `modelUsage` can hold
    MORE THAN ONE model in a single `-p` invocation. `InvokeResult.input_tokens` must be the sum
    of all three input-token components, `cost_usd` must come straight from `total_cost_usd`
    (never recomputed), and `model` must be the entry with the most output tokens — not whichever
    key happens to sort/insert first."""
    monkeypatch.setattr(
        "leetmind_content.generation.invoker.shutil.which", lambda name: "/usr/local/bin/claude"
    )

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        envelope = {
            "result": "the generated envelope text",
            "is_error": False,
            "duration_ms": 9000,
            "total_cost_usd": 0.0723955,
            "usage": {
                "cache_creation": {"ephemeral_5m_input_tokens": 6236},
                "cache_creation_input_tokens": 6236,
                "cache_read_input_tokens": 18689,
                "inference_geo": "us",
                "input_tokens": 2,
                "iterations": 1,
                "output_tokens": 2712,
                "server_tool_use": {"web_search_requests": 0},
                "service_tier": "standard",
                "speed": "normal",
            },
            "modelUsage": {
                "claude-haiku-4-5-20251001": {
                    "inputTokens": 500,
                    "outputTokens": 12,
                },
                "claude-opus-4-8[1m]": {
                    "inputTokens": 24927,
                    "outputTokens": 2700,
                },
            },
        }
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(envelope), stderr="")

    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", fake_run)

    invoker = ClaudeInvoker(claude_bin="claude")
    result = invoker.invoke("prompt", timeout_ms=5000)

    # The dominant (most output tokens) model, not the first modelUsage key.
    assert result.model == "claude-opus-4-8[1m]"
    # Sum of input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
    assert result.input_tokens == 2 + 6236 + 18689
    assert result.output_tokens == 2712
    assert result.cache_creation_input_tokens == 6236
    assert result.cache_read_input_tokens == 18689
    # cost_usd is read straight from total_cost_usd, never recomputed.
    assert result.cost_usd == pytest.approx(0.0723955)
    # Full usage/modelUsage maps are preserved for model_runs.request.
    assert result.usage is not None and result.usage["service_tier"] == "standard"
    assert result.model_usage is not None
    assert set(result.model_usage.keys()) == {
        "claude-haiku-4-5-20251001",
        "claude-opus-4-8[1m]",
    }


def test_claude_invoker_falls_back_gracefully_on_malformed_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-JSON (or non-object-JSON) stdout must not raise — it's treated as raw result text
    and logged at warn, per CONTRACTS.md §11 ("be defensive about envelope shape changes")."""
    monkeypatch.setattr(
        "leetmind_content.generation.invoker.shutil.which", lambda name: "/usr/local/bin/claude"
    )

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(argv, 0, stdout="this is not json at all", stderr="")

    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", fake_run)

    invoker = ClaudeInvoker(claude_bin="claude")
    result = invoker.invoke("prompt", timeout_ms=5000)

    assert result.text == "this is not json at all"
    assert result.model is None
    assert result.input_tokens is None
    assert result.cost_usd is None


def test_claude_invoker_falls_back_when_envelope_is_json_but_not_an_object(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "leetmind_content.generation.invoker.shutil.which", lambda name: "/usr/local/bin/claude"
    )

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps([1, 2, 3]), stderr="")

    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", fake_run)

    invoker = ClaudeInvoker(claude_bin="claude")
    result = invoker.invoke("prompt", timeout_ms=5000)

    assert result.text == json.dumps([1, 2, 3])
    assert result.model is None


def test_claude_invoker_raises_on_nonzero_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "leetmind_content.generation.invoker.shutil.which", lambda name: "/usr/local/bin/claude"
    )

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(argv, 1, stdout="", stderr="boom: internal error")

    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", fake_run)

    invoker = ClaudeInvoker(claude_bin="claude")
    with pytest.raises(InvokerError, match="exited 1"):
        invoker.invoke("prompt", timeout_ms=5000)


def test_claude_invoker_raises_clear_error_when_binary_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("leetmind_content.generation.invoker.shutil.which", lambda name: None)

    invoker = ClaudeInvoker(claude_bin="claude-does-not-exist")
    with pytest.raises(InvokerError, match="not found on PATH"):
        invoker.invoke("prompt", timeout_ms=5000)


def test_claude_invoker_raises_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "leetmind_content.generation.invoker.shutil.which", lambda name: "/usr/local/bin/claude"
    )

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(cmd=argv, timeout=kwargs.get("timeout", 0))

    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", fake_run)

    invoker = ClaudeInvoker(claude_bin="claude")
    with pytest.raises(InvokerError, match="did not return within"):
        invoker.invoke("prompt", timeout_ms=1000)


def test_claude_invoker_raises_on_is_error_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "leetmind_content.generation.invoker.shutil.which", lambda name: "/usr/local/bin/claude"
    )

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        envelope = {"result": "rate limited", "is_error": True}
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(envelope), stderr="")

    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", fake_run)

    invoker = ClaudeInvoker(claude_bin="claude")
    with pytest.raises(InvokerError, match="rate limited"):
        invoker.invoke("prompt", timeout_ms=5000)


# ---------------------------------------------------------------------------
# StubInvoker — deterministic, offline, genuinely gate-shaped output
# ---------------------------------------------------------------------------


def _request(concept_id: str, **overrides: Any) -> GenerationRequest:
    defaults: dict[str, Any] = {
        "concepts": [GenerationConceptWeight(id=concept_id, weight=1.0)],
        "target_rating": 1200.0,
        "rating_tolerance": 100.0,
        "expected_minutes": (8, 20),
        "prompt_version": "v1",
    }
    defaults.update(overrides)
    return GenerationRequest(**defaults)


@pytest.mark.parametrize("concept_id", ["sliding_window", "arrays_hashing"])
def test_stub_invoker_returns_valid_problem_version_for_known_concepts(concept_id: str) -> None:
    request = _request(concept_id)
    prompt = build_generation_prompt(request)

    invoker = StubInvoker()
    result = invoker.invoke(prompt, timeout_ms=1000)

    # StubInvoker emits LEETMIND envelope text, not JSON — genuinely exercising parse_envelope,
    # the same code path a real `claude -p` response goes through.
    assembled = parse_envelope(result.text)
    problem_version = ProblemVersion.model_validate(assembled)  # must not raise

    assert problem_version.state == "candidate"
    assert any(c.id == concept_id and c.role == "primary" for c in problem_version.concepts)
    assert 3 <= len(problem_version.mutants_py) <= 5
    assert problem_version.hidden_tests == []
    assert result.model == "stub-v1"
    assert result.cost_usd == 0.0


def test_stub_invoker_falls_back_to_default_template_for_unknown_concept() -> None:
    request = _request("graph_traversal")
    prompt = build_generation_prompt(request)

    invoker = StubInvoker()
    result = invoker.invoke(prompt, timeout_ms=1000)
    problem_version = ProblemVersion.model_validate(parse_envelope(result.text))

    # Concept metadata always reflects the actual request even when the underlying template's
    # story doesn't have dedicated content for that concept.
    assert any(c.id == "graph_traversal" and c.role == "primary" for c in problem_version.concepts)


def test_stub_invoker_respects_requested_rating_and_minutes() -> None:
    request = _request("sliding_window", target_rating=1750.0, expected_minutes=(15, 30))
    prompt = build_generation_prompt(request)

    invoker = StubInvoker()
    result = invoker.invoke(prompt, timeout_ms=1000)
    problem_version = ProblemVersion.model_validate(parse_envelope(result.text))

    assert problem_version.difficulty.rating == 1750
    assert problem_version.expected_active_minutes == (15, 30)


def test_stub_invoker_hints_avoid_banned_words() -> None:
    """The stub's own templates must satisfy the same schema-stage hint rule real generations
    are held to (CONTRACTS.md §10) — otherwise it would be useless as an offline stand-in for
    exercising the verification gate."""
    from leetmind_content.generation.prompts.v1 import BANNED_HINT_WORDS

    for concept_id in ("sliding_window", "arrays_hashing"):
        request = _request(concept_id)
        prompt = build_generation_prompt(request)
        result = StubInvoker().invoke(prompt, timeout_ms=1000)
        problem_version = ProblemVersion.model_validate(parse_envelope(result.text))
        for level in (problem_version.hints.l1_orientation, problem_version.hints.l2_conceptual):
            lowered = level.lower()
            for word in BANNED_HINT_WORDS:
                assert word not in lowered, f"{concept_id}: hint contains banned word {word!r}"
            assert "```" not in level


def test_stub_invoker_is_offline_and_makes_no_subprocess_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("StubInvoker must never shell out")

    monkeypatch.setattr("leetmind_content.generation.invoker.subprocess.run", _boom)
    request = _request("sliding_window")
    prompt = build_generation_prompt(request)
    StubInvoker().invoke(prompt, timeout_ms=1000)  # must not raise


def test_stub_invoker_handles_a_prompt_with_no_embedded_request_block() -> None:
    """Robustness: garbage/unrelated prompt text still yields a valid ProblemVersion via the
    default template, rather than raising."""
    result = StubInvoker().invoke("not a real generation prompt", timeout_ms=1000)
    ProblemVersion.model_validate(parse_envelope(result.text))  # must not raise


# ---------------------------------------------------------------------------
# get_invoker() factory
# ---------------------------------------------------------------------------


def test_get_invoker_selects_stub() -> None:
    settings = _fake_settings(GENERATOR_INVOKER="stub")
    invoker = get_invoker(settings)
    assert isinstance(invoker, StubInvoker)


def test_get_invoker_selects_claude() -> None:
    settings = _fake_settings(GENERATOR_INVOKER="claude")
    invoker = get_invoker(settings)
    assert isinstance(invoker, ClaudeInvoker)


def test_get_invoker_selects_codex_and_it_raises_not_implemented() -> None:
    settings = _fake_settings(GENERATOR_INVOKER="codex")
    invoker = get_invoker(settings)
    assert isinstance(invoker, CodexInvoker)
    with pytest.raises(NotImplementedError, match="decision #3"):
        invoker.invoke("prompt", timeout_ms=1000)


def test_generation_request_still_validates_normally() -> None:
    # Sanity: GenerationConceptWeight/GenerationRequest construction used throughout this module
    # actually round-trips through pydantic validation without our test helper silently building
    # something invalid.
    with pytest.raises(ValidationError):
        GenerationConceptWeight(id="x", weight=2.0)
