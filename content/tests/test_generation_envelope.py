"""Tests for algolift_content.generation.envelope — the delimited ALGOLIFT envelope wire format
that replaced prompt v1's single-JSON-object format (see envelope.py's module docstring for why:
a real `claude -p` call broke with `Expecting ',' delimiter: line 1 column 6384` trying to
JSON-escape a multi-line Python program mid-response)."""

from __future__ import annotations

import json
import re
from typing import Any

import pytest

from algolift_content.generation.envelope import (
    END_DELIM,
    HINT_SUBFIELDS,
    META_DELIM,
    REQUIRED_META_FIELDS,
    REQUIRED_SCALAR_FIELDS,
    EnvelopeError,
    build_envelope_spec,
    parse_envelope,
    render_envelope,
)
from algolift_content.models import ProblemVersion

# ---------------------------------------------------------------------------
# A complete, valid problem dict — the baseline every test starts from.
# ---------------------------------------------------------------------------


def _valid_problem() -> dict[str, Any]:
    return {
        "title": "Longest Run of a Single Character",
        "internal_name": "longest_uniform_run",
        "signature": {
            "name": "longestRun",
            "params": [{"name": "s", "type": "str"}],
            "returns": "int",
        },
        "examples": [
            {
                "args": ["aabbbcc"],
                "expected": 3,
                "explanation": 'The run "bbb" has length 3.',
            }
        ],
        "concepts": [{"id": "arrays_hashing", "role": "primary", "weight": 1.0}],
        "difficulty": {"rating": 950, "confidence": "generated"},
        "expected_active_minutes": [4, 10],
        "target_complexity": {"time": "O(n)", "space": "O(1)"},
        "comparator": "exact",
        "provenance": {
            "mode": "novel",
            "model": "test-model",
            "prompt_version": "v2",
            "generated_at": "2026-01-01T00:00:00Z",
        },
        "statement_md": (
            "Given a string `s`, return the length of the longest run of a single repeated "
            'character.\n\nFor example, in "aabbbcc" the answer is 3.'
        ),
        "constraints_md": "- `1 <= len(s) <= 10000`\n- lowercase letters only.",
        "reference_solution_py": (
            "def longestRun(s):\n"
            "    best = 1\n"
            "    current = 1\n"
            "    for i in range(1, len(s)):\n"
            "        if s[i] == s[i - 1]:\n"
            "            current += 1\n"
            "            best = max(best, current)\n"
            "        else:\n"
            "            current = 1\n"
            "    return best\n"
        ),
        "brute_force_py": (
            "def longestRun(s):\n"
            "    n = len(s)\n"
            "    best = 1\n"
            "    for i in range(n):\n"
            "        j = i\n"
            "        while j < n and s[j] == s[i]:\n"
            "            j += 1\n"
            "        best = max(best, j - i)\n"
            "    return best\n"
        ),
        "input_generator_py": (
            "def generate(rng):\n"
            "    n = rng.randint(1, 10000)\n"
            "    s = ''.join(rng.choice('abc') for _ in range(n))\n"
            "    return [s]\n"
        ),
        "mutants_py": [
            "def longestRun(s):\n    return 0\n",
            "def longestRun(s):\n    return 1\n",
            "def longestRun(s):\n    return len(s)\n",
        ],
        "hints": {
            "l1_orientation": "Look at each character compared to the one before it.",
            "l2_conceptual": "Track how long the current run is and the best seen so far.",
            "l3_structural": "Walk the string once, updating a counter and a best-so-far value.",
            "outline": "1) init counters. 2) walk. 3) update. 4) return best.",
            "editorial_md": (
                "## Approach\n\nSingle pass.\n\n## Complexity\n\nO(n) time, O(1) space."
            ),
        },
    }


def _sans_one_trailing_newline(text: str) -> str:
    """Line-based extraction (see `envelope._extract_block_content`) inherently swallows exactly
    ONE trailing newline of a field's raw content — the newline that visually separates the last
    line of content from the next delimiter line belongs to the delimiter boundary, not the
    content. A Python source string built as `"...\\n"` therefore round-trips as `"..."`
    (functionally identical — `exec`/`compile` don't require a trailing newline). Tests that
    assert exact round-trip equality use this helper to express that expectation precisely,
    instead of asserting a byte-for-byte identity the format never promised."""
    return text[:-1] if text.endswith("\n") else text


def _assemble(problem: dict[str, Any]) -> dict[str, Any]:
    """`parse_envelope`'s output shape, for direct comparison — adds the synthesized fields."""
    assembled = dict(problem)
    assembled["problem_id"] = "new"
    assembled["version"] = 1
    assembled["state"] = "candidate"
    assembled["hidden_tests"] = []
    assembled["checker_py"] = None
    return assembled


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_round_trip() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    assembled = parse_envelope(text)

    assert assembled["title"] == problem["title"]
    assert assembled["statement_md"] == _sans_one_trailing_newline(problem["statement_md"])
    assert assembled["reference_solution_py"] == _sans_one_trailing_newline(
        problem["reference_solution_py"]
    )
    assert assembled["mutants_py"] == [
        _sans_one_trailing_newline(m) for m in problem["mutants_py"]
    ]
    assert assembled["hints"] == {
        k: _sans_one_trailing_newline(v) for k, v in problem["hints"].items()
    }
    assert assembled["problem_id"] == "new"
    assert assembled["version"] == 1
    assert assembled["state"] == "candidate"
    assert assembled["hidden_tests"] == []
    assert assembled["checker_py"] is None


def test_round_trip_produces_a_gate_ready_problem_version() -> None:
    """envelope -> ProblemVersion -> gate-ready: the whole point of the format."""
    problem = _valid_problem()
    text = render_envelope(problem)
    assembled = parse_envelope(text)
    pv = ProblemVersion.model_validate(assembled)  # must not raise

    assert pv.state == "candidate"
    assert pv.problem_id == "new"
    assert len(pv.mutants_py) == 3
    assert pv.hints.l1_orientation == problem["hints"]["l1_orientation"]


def test_build_envelope_spec_matches_module_constants() -> None:
    spec = build_envelope_spec()
    assert spec.required_meta_fields == REQUIRED_META_FIELDS
    assert spec.required_scalar_fields == REQUIRED_SCALAR_FIELDS
    assert spec.hint_subfields == HINT_SUBFIELDS
    assert spec.min_mutants == 3
    assert spec.max_mutants == 5


# ---------------------------------------------------------------------------
# Field order is irrelevant
# ---------------------------------------------------------------------------


def test_field_order_is_shuffled_and_still_parses() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)

    # Split into (delimiter_line, content) segments and shuffle the FIELD ones (keep META first,
    # END last, since render_envelope already puts them there — shuffling is about the FIELD
    # blocks in between).
    lines = text.splitlines()
    meta_idx = lines.index(META_DELIM)
    end_idx = lines.index(END_DELIM)
    assert meta_idx == 0 and end_idx == len(lines) - 1

    # Find each field delimiter's line index within the FIELD region.
    field_starts = [
        i for i, line in enumerate(lines) if re.match(r"^<<<ALGOLIFT_FIELD:", line)
    ]
    segments = []
    for i, start in enumerate(field_starts):
        stop = field_starts[i + 1] if i + 1 < len(field_starts) else end_idx
        segments.append(lines[start:stop])

    # Reverse the order of all field segments — a maximally different order from canonical.
    shuffled = [lines[meta_idx]] + [lines[meta_idx + 1]]  # META delim + its JSON line
    # meta content might span exactly one line since render_envelope compacts it via json.dumps
    for seg in reversed(segments):
        shuffled.extend(seg)
    shuffled.append(lines[end_idx])

    shuffled_text = "\n".join(shuffled)
    assembled = parse_envelope(shuffled_text)
    pv = ProblemVersion.model_validate(assembled)
    assert pv.title == problem["title"]
    assert pv.mutants_py == [_sans_one_trailing_newline(m) for m in problem["mutants_py"]]


def test_meta_does_not_need_to_be_first() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    lines = text.splitlines()
    meta_idx = lines.index(META_DELIM)
    meta_block = lines[meta_idx : meta_idx + 2]
    rest = lines[:meta_idx] + lines[meta_idx + 2 :]
    # Move META block to just before END.
    end_pos = rest.index(END_DELIM)
    reordered = rest[:end_pos] + meta_block + rest[end_pos:]
    assembled = parse_envelope("\n".join(reordered))
    assert assembled["title"] == problem["title"]


# ---------------------------------------------------------------------------
# Tolerances: wrapping fence, leading prose
# ---------------------------------------------------------------------------


def test_tolerates_wrapping_code_fence_around_whole_response() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    fenced = f"```\n{text}```"
    assembled = parse_envelope(fenced)
    assert assembled["title"] == problem["title"]


def test_tolerates_leading_and_trailing_prose() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    wrapped = f"Sure, here is the problem:\n\n{text}\nHope that helps!"
    assembled = parse_envelope(wrapped)
    assert assembled["title"] == problem["title"]


def test_tolerates_field_level_fence_and_stray_blank_lines() -> None:
    problem = _valid_problem()
    # Manually build an envelope where one field's content is wrapped in a ```python fence with
    # stray blank lines around it, simulating a model that ignores "no fence" instructions.
    meta = {k: problem[k] for k in REQUIRED_META_FIELDS}
    text = (
        f"{META_DELIM}\n{json.dumps(meta)}\n"
        f"<<<ALGOLIFT_FIELD:statement_md>>>\n{problem['statement_md']}\n"
        f"<<<ALGOLIFT_FIELD:constraints_md>>>\n{problem['constraints_md']}\n"
        "<<<ALGOLIFT_FIELD:reference_solution_py>>>\n"
        "\n```python\n" + problem["reference_solution_py"] + "```\n\n"
        f"<<<ALGOLIFT_FIELD:brute_force_py>>>\n{problem['brute_force_py']}\n"
        f"<<<ALGOLIFT_FIELD:input_generator_py>>>\n{problem['input_generator_py']}\n"
        f"<<<ALGOLIFT_FIELD:mutants_py[0]>>>\n{problem['mutants_py'][0]}\n"
        f"<<<ALGOLIFT_FIELD:mutants_py[1]>>>\n{problem['mutants_py'][1]}\n"
        f"<<<ALGOLIFT_FIELD:mutants_py[2]>>>\n{problem['mutants_py'][2]}\n"
        f"<<<ALGOLIFT_FIELD:hints.l1_orientation>>>\n{problem['hints']['l1_orientation']}\n"
        f"<<<ALGOLIFT_FIELD:hints.l2_conceptual>>>\n{problem['hints']['l2_conceptual']}\n"
        f"<<<ALGOLIFT_FIELD:hints.l3_structural>>>\n{problem['hints']['l3_structural']}\n"
        f"<<<ALGOLIFT_FIELD:hints.outline>>>\n{problem['hints']['outline']}\n"
        f"<<<ALGOLIFT_FIELD:hints.editorial_md>>>\n{problem['hints']['editorial_md']}\n"
        f"{END_DELIM}\n"
    )
    assembled = parse_envelope(text)
    assert assembled["reference_solution_py"] == _sans_one_trailing_newline(
        problem["reference_solution_py"]
    )


# ---------------------------------------------------------------------------
# Missing / unknown fields -> precise EnvelopeError
# ---------------------------------------------------------------------------


def test_missing_meta_delimiter_raises_precise_error() -> None:
    with pytest.raises(EnvelopeError, match=re.escape(META_DELIM)):
        parse_envelope("just some text with no delimiters at all")


def test_missing_end_delimiter_raises_precise_error() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    truncated = text.replace(f"{END_DELIM}\n", "")
    with pytest.raises(EnvelopeError, match=re.escape(END_DELIM)):
        parse_envelope(truncated)


def test_missing_required_meta_field_is_named_precisely() -> None:
    problem = _valid_problem()
    del problem["difficulty"]
    del problem["comparator"]
    meta = {k: problem[k] for k in REQUIRED_META_FIELDS if k in problem}
    text = _hand_build_envelope(problem, meta_override=meta)
    with pytest.raises(EnvelopeError) as exc_info:
        parse_envelope(text)
    msg = str(exc_info.value)
    assert "difficulty" in msg
    assert "comparator" in msg


def test_missing_required_field_block_is_named_precisely() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    # Remove the constraints_md field block entirely.
    pattern = re.compile(
        r"<<<ALGOLIFT_FIELD:constraints_md>>>\n.*?(?=<<<ALGOLIFT_FIELD:)", re.DOTALL
    )
    stripped = pattern.sub("", text, count=1)
    with pytest.raises(EnvelopeError, match="constraints_md"):
        parse_envelope(stripped)


def test_missing_hint_subfield_is_named_precisely() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    pattern = re.compile(
        r"<<<ALGOLIFT_FIELD:hints\.outline>>>\n.*?(?=<<<ALGOLIFT_FIELD:)", re.DOTALL
    )
    stripped = pattern.sub("", text, count=1)
    with pytest.raises(EnvelopeError, match=r"hints\.outline"):
        parse_envelope(stripped)


def test_unknown_meta_field_is_reported() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    text = text.replace(
        f"{META_DELIM}\n", f"{META_DELIM}\n", 1
    )  # no-op, keeps structure clear below
    meta_line_start = text.index(META_DELIM) + len(META_DELIM) + 1
    meta_line_end = text.index("\n", meta_line_start)
    meta = json.loads(text[meta_line_start:meta_line_end])
    meta["bogus_extra_field"] = "surprise"
    new_text = text[:meta_line_start] + json.dumps(meta) + text[meta_line_end:]
    with pytest.raises(EnvelopeError, match="bogus_extra_field"):
        parse_envelope(new_text)


def test_unknown_field_block_is_reported() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    injected = text.replace(
        END_DELIM, "<<<ALGOLIFT_FIELD:totally_made_up_field>>>\nsome content\n" + END_DELIM
    )
    with pytest.raises(EnvelopeError, match="totally_made_up_field"):
        parse_envelope(injected)


def test_duplicate_field_block_is_reported() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    dup_block = (
        "<<<ALGOLIFT_FIELD:statement_md>>>\n" + problem["statement_md"] + "\n"
    )
    injected = text.replace(END_DELIM, dup_block + END_DELIM)
    with pytest.raises(EnvelopeError, match="duplicate"):
        parse_envelope(injected)


def test_duplicate_meta_delimiter_is_reported() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    injected = text.replace(META_DELIM, f"{META_DELIM}\n{{}}\n{META_DELIM}", 1)
    with pytest.raises(EnvelopeError, match="duplicate"):
        parse_envelope(injected)


def test_meta_not_valid_json_raises_precise_error() -> None:
    text = f"{META_DELIM}\nthis is not json\n{END_DELIM}\n"
    with pytest.raises(EnvelopeError, match="not valid JSON"):
        parse_envelope(text)


def test_meta_not_an_object_raises_precise_error() -> None:
    text = f"{META_DELIM}\n[1, 2, 3]\n{END_DELIM}\n"
    with pytest.raises(EnvelopeError, match="JSON OBJECT"):
        parse_envelope(text)


# ---------------------------------------------------------------------------
# Mutants: indexed, contiguous, ordered, 3-5
# ---------------------------------------------------------------------------


def test_mutants_assembled_in_index_order_regardless_of_source_order() -> None:
    problem = _valid_problem()
    problem["mutants_py"] = ["MUTANT_ZERO", "MUTANT_ONE", "MUTANT_TWO", "MUTANT_THREE"]
    text = render_envelope(problem)
    # Physically reorder the mutant blocks in the text (index 2, then 0, then 3, then 1).
    blocks = {}
    for i in range(4):
        marker = f"<<<ALGOLIFT_FIELD:mutants_py[{i}]>>>"
        start = text.index(marker)
        next_delim = text.index("<<<ALGOLIFT_", start + len(marker))
        blocks[i] = text[start:next_delim]
    without_mutants = text
    for block in blocks.values():
        without_mutants = without_mutants.replace(block, "")
    reordered_mutants = blocks[2] + blocks[0] + blocks[3] + blocks[1]
    final_text = without_mutants.replace(END_DELIM, reordered_mutants + END_DELIM)

    assembled = parse_envelope(final_text)
    assert assembled["mutants_py"] == ["MUTANT_ZERO", "MUTANT_ONE", "MUTANT_TWO", "MUTANT_THREE"]


def test_mutant_gap_is_rejected() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    # Rename mutants_py[1] to mutants_py[3], leaving a gap at index 1.
    gapped = text.replace("mutants_py[1]", "mutants_py[3]")
    # mutants_py[3] alone (index 3) is also out of the contiguous 0,1,2 set -> should error.
    with pytest.raises(EnvelopeError):
        parse_envelope(gapped)


def test_too_few_mutants_is_rejected() -> None:
    problem = _valid_problem()
    problem["mutants_py"] = problem["mutants_py"][:2]  # only 2, need >= 3
    text = _hand_build_envelope(problem)
    with pytest.raises(EnvelopeError, match="at least 3"):
        parse_envelope(text)


def test_mutant_index_out_of_range_is_rejected() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    out_of_range = text.replace("mutants_py[2]", "mutants_py[9]")
    with pytest.raises(EnvelopeError, match="out of range"):
        parse_envelope(out_of_range)


# ---------------------------------------------------------------------------
# Dotted hint paths
# ---------------------------------------------------------------------------


def test_hints_assembled_into_nested_dict() -> None:
    problem = _valid_problem()
    text = render_envelope(problem)
    assembled = parse_envelope(text)
    assert set(assembled["hints"].keys()) == set(HINT_SUBFIELDS)
    for sub in HINT_SUBFIELDS:
        assert assembled["hints"][sub] == problem["hints"][sub]


# ---------------------------------------------------------------------------
# Verbatim content: quotes, newlines, backslashes, no escaping needed
# ---------------------------------------------------------------------------


def test_field_content_with_quotes_newlines_and_backslashes_is_preserved_verbatim() -> None:
    problem = _valid_problem()
    tricky = (
        'def longestRun(s):\n'
        '    """Docstring with "nested" quotes and a backslash: \\n literal."""\n'
        "    path = 'C:\\\\Users\\\\test'\n"
        "    best = 1\n"
        "    return best\n"
    )
    problem["reference_solution_py"] = tricky
    text = render_envelope(problem)
    assembled = parse_envelope(text)
    assert assembled["reference_solution_py"] == _sans_one_trailing_newline(tricky)
    # Sanity: this text would NOT have round-tripped through naive JSON string embedding without
    # correct escaping — here there is no escaping involved at all.
    assert '"nested"' in assembled["reference_solution_py"]
    assert "C:\\\\Users\\\\test" in assembled["reference_solution_py"]


def test_documented_edge_case_a_line_identical_to_a_delimiter_inside_content_is_misread() -> None:
    """Documented, tested limitation (envelope.py's module docstring): a delimiter only counts if
    the ENTIRE line matches — but that also means a field's raw content that happens to contain a
    bare line byte-identical to a real delimiter WILL be misread as one. `print("<<<ALGOLIFT_...")`
    is safe (extra characters on the line disqualify it); a line that is ONLY the delimiter text is
    not."""
    problem = _valid_problem()
    # Safe case: the delimiter-shaped text has other characters on the same line.
    problem["reference_solution_py"] = (
        'def longestRun(s):\n    print("<<<ALGOLIFT_FIELD:evil>>>")\n    return 1\n'
    )
    text = render_envelope(problem)
    assembled = parse_envelope(text)  # must NOT raise — the line isn't a bare delimiter
    assert '<<<ALGOLIFT_FIELD:evil>>>' in assembled["reference_solution_py"]

    # Unsafe case: a bare line that IS exactly a delimiter, embedded inside content.
    problem2 = _valid_problem()
    problem2["reference_solution_py"] = (
        "def longestRun(s):\n"
        "<<<ALGOLIFT_FIELD:evil>>>\n"  # a full, bare line identical to a delimiter
        "    return 1\n"
    )
    text2 = render_envelope(problem2)
    # Documented behavior: this splits reference_solution_py's content early and starts a new
    # (unknown) field named "evil" -> reported as an unknown field, not silently ignored.
    with pytest.raises(EnvelopeError, match="evil"):
        parse_envelope(text2)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _hand_build_envelope(
    problem: dict[str, Any], *, meta_override: dict[str, Any] | None = None
) -> str:
    """Builds an envelope even when `problem` is missing keys `render_envelope` would require
    (e.g. for "missing required field" tests) — `render_envelope` assumes a complete/valid dict,
    so tests that need an INCOMPLETE one construct the text directly."""
    if meta_override is not None:
        meta = meta_override
    else:
        meta = {k: problem[k] for k in REQUIRED_META_FIELDS if k in problem}
    parts = [META_DELIM, json.dumps(meta)]
    for name in REQUIRED_SCALAR_FIELDS:
        if name in problem:
            parts.append(f"<<<ALGOLIFT_FIELD:{name}>>>")
            parts.append(problem[name])
    for i, mutant in enumerate(problem.get("mutants_py", [])):
        parts.append(f"<<<ALGOLIFT_FIELD:mutants_py[{i}]>>>")
        parts.append(mutant)
    for sub in HINT_SUBFIELDS:
        hints = problem.get("hints", {})
        if sub in hints:
            parts.append(f"<<<ALGOLIFT_FIELD:hints.{sub}>>>")
            parts.append(hints[sub])
    parts.append(END_DELIM)
    return "\n".join(parts) + "\n"
