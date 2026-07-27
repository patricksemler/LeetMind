"""Tests for leetmind_content.generation.prompts.v2 — the prompt builder itself (no model calls)."""

from __future__ import annotations

from leetmind_content.generation.prompts.v2 import (
    BANNED_HINT_WORDS,
    PROMPT_VERSION,
    REQUEST_JSON_BEGIN,
    REQUEST_JSON_END,
    build_generation_prompt,
    build_repair_prompt,
)
from leetmind_content.models import GenerationConceptWeight, GenerationRequest, TargetComplexity


def _sample_request() -> GenerationRequest:
    return GenerationRequest(
        concepts=[
            GenerationConceptWeight(id="sliding_window", weight=0.7),
            GenerationConceptWeight(id="arrays_hashing", weight=0.3),
        ],
        target_rating=1350.0,
        rating_tolerance=120.0,
        expected_minutes=(10, 25),
        target_complexity=TargetComplexity(time="O(n)", space="O(1)"),
        required_patterns=["fixed-size window"],
        forbidden_patterns=["recursion"],
        similarity_exclusions=["Longest Balanced Substring", "Peak Element Finder"],
        comparator_hint="exact",
        allow_types=["int", "list[int]"],
        prompt_version=PROMPT_VERSION,
    )


def test_prompt_version_is_v2() -> None:
    assert PROMPT_VERSION == "v2"


def test_prompt_demands_envelope_format_no_fence() -> None:
    prompt = build_generation_prompt(_sample_request())
    assert "LEETMIND envelope" in prompt
    assert "no code fence" in prompt
    assert "no prose" in prompt.lower() or "nothing else" in prompt


def test_prompt_contains_generate_rng_contract_verbatim() -> None:
    prompt = build_generation_prompt(_sample_request())
    assert "def generate(rng: random.Random) -> list:" in prompt
    assert "rng.randint" in prompt
    # The worked example in the generator contract section.
    assert "maxPairSum" in prompt


def test_prompt_documents_signature_type_system() -> None:
    prompt = build_generation_prompt(_sample_request())
    for token in ("int", "float", "bool", "str", "list[<ParamType>]", "TreeNode", "ListNode"):
        assert token in prompt


def test_prompt_requires_independent_brute_force() -> None:
    prompt = build_generation_prompt(_sample_request())
    assert "INDEPENDENT" in prompt
    assert "brute_force_py" in prompt


def test_prompt_requires_three_to_five_mutants() -> None:
    prompt = build_generation_prompt(_sample_request())
    assert "3 to 5" in prompt
    assert "mutants_py" in prompt


def test_prompt_contains_banned_word_instruction() -> None:
    prompt = build_generation_prompt(_sample_request())
    assert "l1_orientation" in prompt
    assert "l2_conceptual" in prompt
    for word in BANNED_HINT_WORDS:
        assert word in prompt
    assert "case-insensitive" in prompt


def test_prompt_states_requested_concepts_rating_and_complexity() -> None:
    request = _sample_request()
    prompt = build_generation_prompt(request)
    assert "sliding_window" in prompt
    assert "arrays_hashing" in prompt
    # rating band: target 1350 +- 120 => 1230..1470
    assert "1230" in prompt
    assert "1470" in prompt
    assert "O(n)" in prompt
    assert "O(1)" in prompt
    assert "10-25 minutes" in prompt or ("10" in prompt and "25" in prompt)


def test_prompt_honours_similarity_exclusions_and_forbidden_patterns() -> None:
    request = _sample_request()
    prompt = build_generation_prompt(request)
    assert "Longest Balanced Substring" in prompt
    assert "Peak Element Finder" in prompt
    assert "recursion" in prompt
    assert "fixed-size window" in prompt


def test_prompt_neutral_story_framing_instruction_present() -> None:
    prompt = build_generation_prompt(_sample_request())
    assert "no characters, no company names, no fictional scenario" in prompt


def test_prompt_embeds_machine_readable_request_block() -> None:
    request = _sample_request()
    prompt = build_generation_prompt(request)
    assert REQUEST_JSON_BEGIN in prompt
    assert REQUEST_JSON_END in prompt
    begin_idx = prompt.index(REQUEST_JSON_BEGIN)
    end_idx = prompt.index(REQUEST_JSON_END)
    block = prompt[begin_idx + len(REQUEST_JSON_BEGIN) : end_idx]
    import json

    parsed = json.loads(block)
    assert parsed["target_rating"] == 1350.0
    assert parsed["concepts"][0]["id"] == "sliding_window"


def test_prompt_includes_a_compact_worked_example() -> None:
    prompt = build_generation_prompt(_sample_request())
    assert "worked example" in prompt.lower()
    # v2's worked example is rendered as raw LEETMIND envelope text (no JSON string-escaping),
    # not a JSON object, so the field names appear as delimiter blocks rather than quoted keys.
    assert "<<<LEETMIND_FIELD:reference_solution_py>>>" in prompt
    assert "<<<LEETMIND_FIELD:mutants_py[0]>>>" in prompt


def test_build_repair_prompt_includes_base_prompt_plus_errors_and_previous_output() -> None:
    request = _sample_request()
    previous_output = '{"title": "broken", "signature": {}}'
    errors = "  - concepts: field required\n  - difficulty: field required"

    repair_prompt = build_repair_prompt(request, previous_output, errors)

    # Still contains everything the base prompt does (same request block, still parseable).
    assert REQUEST_JSON_BEGIN in repair_prompt
    assert "def generate(rng: random.Random) -> list:" in repair_prompt
    # Plus the repair-specific content.
    assert "INVALID" in repair_prompt
    assert previous_output in repair_prompt
    assert "concepts: field required" in repair_prompt
    assert "difficulty: field required" in repair_prompt


def test_build_repair_prompt_truncates_very_long_previous_output() -> None:
    request = _sample_request()
    huge_output = "x" * 20000
    repair_prompt = build_repair_prompt(request, huge_output, "some error")
    assert "...(truncated)" in repair_prompt
    assert huge_output not in repair_prompt
