"""The LEETMIND envelope — a delimited wire format for generation responses that needs no string
escaping (docs/CONTRACTS.md §11, PLAN.md §12 risk 1).

## Why this exists

Prompt `v1` asked the model to emit a single JSON object containing several multi-line Python
programs (`reference_solution_py`, `brute_force_py`, `input_generator_py`, `mutants_py[]`, optional
`checker_py`) plus multi-line markdown (`statement_md`, `constraints_md`, `hints.editorial_md`).
Every newline and quote inside those strings has to be escaped perfectly across thousands of
output tokens for `json.loads` to succeed — a real `claude -p` call broke exactly this way
(`Expecting ',' delimiter: line 1 column 6384`). Retrying harder does not fix a fragile format.

The envelope sidesteps the problem instead of mitigating it: only a small, flat metadata object is
JSON (title, internal_name, signature, examples, concepts, difficulty, expected_active_minutes,
target_complexity, comparator, provenance — nothing multi-line). Every multi-line field (markdown
or Python source) is a raw, **verbatim** block between two sentinel lines, mirroring the sandbox
result protocol already used by `packages/sandbox/runners/python/runner.py`
(`<<<LEETMIND_RESULT>>>` + one trailing JSON object) and documented in CONTRACTS.md §6:

    <<<LEETMIND_META>>>
    { ...compact JSON, meta fields only, no multi-line strings... }
    <<<LEETMIND_FIELD:statement_md>>>
    ...raw markdown, verbatim, no escaping...
    <<<LEETMIND_FIELD:constraints_md>>>
    ...
    <<<LEETMIND_FIELD:reference_solution_py>>>
    ...raw python, verbatim...
    <<<LEETMIND_FIELD:brute_force_py>>>
    ...
    <<<LEETMIND_FIELD:input_generator_py>>>
    ...
    <<<LEETMIND_FIELD:checker_py>>>            (optional)
    ...
    <<<LEETMIND_FIELD:mutants_py[0]>>>
    ...
    <<<LEETMIND_FIELD:mutants_py[1]>>>
    ...
    <<<LEETMIND_FIELD:mutants_py[2]>>>
    ...
    <<<LEETMIND_FIELD:hints.l1_orientation>>>
    ...
    <<<LEETMIND_FIELD:hints.l2_conceptual>>>
    <<<LEETMIND_FIELD:hints.l3_structural>>>
    <<<LEETMIND_FIELD:hints.outline>>>
    <<<LEETMIND_FIELD:hints.editorial_md>>>
    <<<LEETMIND_END>>>

`problem_id`, `version`, `state`, and `hidden_tests` are deliberately NOT part of the envelope at
all — they are always server-assigned/defaulted (`"new"`/`1`/`"candidate"`/`[]`), so there is no
reason to spend model tokens or error surface on them.

## Parsing guarantees (read before changing this file)

  - **Field order is irrelevant.** Every block is found by scanning for its delimiter line; blocks
    may appear in any order and `<<<LEETMIND_META>>>` need not be first.
  - **Leading/trailing prose is tolerated.** Anything before the first delimiter or after
    `<<<LEETMIND_END>>>` is ignored — a model that adds "Here is the problem:" before the envelope
    or a trailing remark after it will still parse.
  - **A wrapping ``` fence around the WHOLE response** is stripped if the entire (trimmed) response
    is a single fenced block. A ``` fence wrapping an INDIVIDUAL field's content is also stripped,
    along with exactly one leading and one trailing blank line around it (models routinely add
    these even when told not to — tolerating them costs nothing).
  - **A delimiter only counts if the ENTIRE line is exactly the delimiter text** (no leading
    whitespace, nothing else on the line — trailing whitespace is tolerated and stripped). This is
    a deliberate, documented trade-off: `print("<<<LEETMIND_FIELD:x>>>")` is safe (extra characters
    on the line disqualify it), but a raw/triple-quoted Python string that happens to contain a
    line whose ENTIRE content is byte-for-byte one of our delimiters will incorrectly be treated as
    a real delimiter and split the field there. This is exercised and asserted in
    `content/tests/test_generation_envelope.py` — the resulting behavior (the field's content is
    truncated at that line, and whatever comes after is parsed as if it were the next field) is
    considered acceptable: the probability of a generated solution containing a bare line that is
    byte-identical to `<<<LEETMIND_FIELD:...>>>` is effectively nil, versus the near-certainty of
    JSON-escaping corruption in the old format.
  - **Unknown field names are rejected** (reported by name, so the repair prompt can tell the model
    exactly what to remove) — this catches typos/hallucinated field names early rather than
    silently dropping them.
  - **Missing required blocks are reported precisely** — by exact field name, not a generic
    "invalid input" message — because `EnvelopeError`'s text is fed back to the model verbatim on
    the repair attempt (see `prompts/v2.build_repair_prompt`).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

META_DELIM = "<<<LEETMIND_META>>>"
END_DELIM = "<<<LEETMIND_END>>>"
FIELD_DELIM_PREFIX = "<<<LEETMIND_FIELD:"
FIELD_DELIM_SUFFIX = ">>>"

#: Required top-level keys of the `<<<LEETMIND_META>>>` JSON object. Deliberately excludes
#: `problem_id`/`version`/`state`/`hidden_tests` (server-assigned/defaulted, see module docstring)
#: and every multi-line field (those are `<<<LEETMIND_FIELD:...>>>` blocks instead).
REQUIRED_META_FIELDS: tuple[str, ...] = (
    "title",
    "internal_name",
    "signature",
    "examples",
    "concepts",
    "difficulty",
    "expected_active_minutes",
    "target_complexity",
    "comparator",
    "provenance",
)

#: Required scalar (non-indexed, non-dotted) `<<<LEETMIND_FIELD:...>>>` blocks.
REQUIRED_SCALAR_FIELDS: tuple[str, ...] = (
    "statement_md",
    "constraints_md",
    "reference_solution_py",
    "brute_force_py",
    "input_generator_py",
)

#: Optional scalar field(s) — present only when relevant (e.g. `comparator == "checker_py"`).
OPTIONAL_SCALAR_FIELDS: tuple[str, ...] = ("checker_py",)

MUTANT_FIELD_PREFIX = "mutants_py"
MIN_MUTANTS = 3
MAX_MUTANTS = 5

HINT_FIELD_PREFIX = "hints"
HINT_SUBFIELDS: tuple[str, ...] = (
    "l1_orientation",
    "l2_conceptual",
    "l3_structural",
    "outline",
    "editorial_md",
)

#: Canonical emission order used by `render_envelope` (parsing itself is order-tolerant).
_CANONICAL_FIELD_ORDER: tuple[str, ...] = (
    "statement_md",
    "constraints_md",
    "reference_solution_py",
    "brute_force_py",
    "input_generator_py",
    "checker_py",
    *(f"{MUTANT_FIELD_PREFIX}[{i}]" for i in range(MAX_MUTANTS)),
    *(f"{HINT_FIELD_PREFIX}.{sub}" for sub in HINT_SUBFIELDS),
)


class EnvelopeError(ValueError):
    """Raised by `parse_envelope` for any structural problem: a missing/duplicate delimiter, a
    missing or unknown field, or META text that isn't a valid JSON object. The message is written
    to be fed back to the model verbatim on the repair attempt (`prompts/v2.build_repair_prompt`)
    — precise about WHICH delimiter/field, never a generic "malformed input"."""


@dataclass(frozen=True)
class EnvelopeSpec:
    """Machine-readable description of the envelope schema — used by `parse_envelope` for
    validation and exposed so tests (and any future tooling, e.g. a prompt-doc generator) don't
    have to hardcode field lists separately from the parser."""

    required_meta_fields: tuple[str, ...] = REQUIRED_META_FIELDS
    required_scalar_fields: tuple[str, ...] = REQUIRED_SCALAR_FIELDS
    optional_scalar_fields: tuple[str, ...] = OPTIONAL_SCALAR_FIELDS
    mutant_field_prefix: str = MUTANT_FIELD_PREFIX
    min_mutants: int = MIN_MUTANTS
    max_mutants: int = MAX_MUTANTS
    hint_field_prefix: str = HINT_FIELD_PREFIX
    hint_subfields: tuple[str, ...] = HINT_SUBFIELDS
    meta_delim: str = META_DELIM
    end_delim: str = END_DELIM
    field_delim_prefix: str = FIELD_DELIM_PREFIX
    field_delim_suffix: str = FIELD_DELIM_SUFFIX


def build_envelope_spec() -> EnvelopeSpec:
    """Returns the (singleton-shaped) envelope schema description. A plain function rather than a
    module-level constant so callers can't accidentally mutate the shared instance."""
    return EnvelopeSpec()


_FIELD_DELIM_LINE_RE = re.compile(
    re.escape(FIELD_DELIM_PREFIX) + r"(?P<field>\S+)" + re.escape(FIELD_DELIM_SUFFIX)
)
_MUTANT_NAME_RE = re.compile(re.escape(MUTANT_FIELD_PREFIX) + r"\[(?P<index>\d+)\]$")
_FENCE_RE = re.compile(r"^```[A-Za-z0-9_-]*\n(.*)\n```$", re.DOTALL)


@dataclass
class _Delimiter:
    line_idx: int
    kind: str  # "META" | "END" | "FIELD"
    field_name: str | None = None


def _strip_wrapping_fence(text: str) -> str:
    """Strips a single ``` fence wrapping the ENTIRE (trimmed) response, if present. A model that
    ignores "no code fence" and wraps its whole answer in one ```/``` pair still parses."""
    stripped = text.strip()
    match = _FENCE_RE.match(stripped)
    return match.group(1) if match else text


def _extract_block_content(raw_lines: list[str]) -> str:
    """Joins the lines of one delimited block back into text, stripping exactly one leading and
    one trailing blank line (a common stray artifact of model formatting) and then a wrapping
    ```lang / ``` fence if the model added one anyway despite the "verbatim, no fence" prompt
    instruction. Everything else — internal blank lines, indentation, trailing whitespace on
    interior lines — is preserved byte-for-byte."""
    lines = list(raw_lines)
    if lines and lines[0].strip() == "":
        lines = lines[1:]
    if lines and lines[-1].strip() == "":
        lines = lines[:-1]
    content = "\n".join(lines)
    fence_match = _FENCE_RE.match(content)
    if fence_match:
        content = fence_match.group(1)
    return content


def _classify_field_name(
    name: str, spec: EnvelopeSpec
) -> tuple[str, int | str | None]:
    """Returns (`"scalar"` | `"mutant"` | `"hint"` | `"unknown"`, extra) for one FIELD delimiter's
    captured name. `extra` is the mutant index (int) for `"mutant"`, the hint subfield (str) for
    `"hint"`, else `None`."""
    if name in spec.required_scalar_fields or name in spec.optional_scalar_fields:
        return "scalar", None
    mutant_match = _MUTANT_NAME_RE.match(name)
    if mutant_match:
        return "mutant", int(mutant_match.group("index"))
    if name.startswith(f"{spec.hint_field_prefix}."):
        subfield = name[len(spec.hint_field_prefix) + 1 :]
        if subfield in spec.hint_subfields and "." not in subfield:
            return "hint", subfield
    return "unknown", None


def _find_delimiters(lines: list[str]) -> list[_Delimiter]:
    delimiters: list[_Delimiter] = []
    for idx, raw_line in enumerate(lines):
        # Delimiters must occupy the WHOLE line (module docstring's "line start" contract).
        # Trailing whitespace is tolerated and stripped; leading whitespace disqualifies a line.
        candidate = raw_line.rstrip()
        if candidate == META_DELIM:
            delimiters.append(_Delimiter(idx, "META"))
        elif candidate == END_DELIM:
            delimiters.append(_Delimiter(idx, "END"))
        else:
            match = _FIELD_DELIM_LINE_RE.fullmatch(candidate)
            if match:
                delimiters.append(_Delimiter(idx, "FIELD", match.group("field")))
    return delimiters


def parse_envelope(text: str) -> dict[str, Any]:
    """Parses one model response in the LEETMIND envelope format into a plain dict shaped exactly
    like `leetmind_content.models.ProblemVersion`'s constructor arguments (minus
    `problem_id`/`version`/`state`, which the caller always overwrites, and `hidden_tests`, always
    `[]` — see `_persist_candidate`). Raises `EnvelopeError` with a precise, model-feedback-ready
    message on any structural problem. Does NOT validate field VALUES (e.g. that `signature` is
    shaped correctly) — that is `ProblemVersion.model_validate`'s job, one layer up."""
    spec = build_envelope_spec()
    working = _strip_wrapping_fence(text)
    lines = working.splitlines()
    delimiters = _find_delimiters(lines)

    meta_delims = [d for d in delimiters if d.kind == "META"]
    end_delims = [d for d in delimiters if d.kind == "END"]
    field_delims = [d for d in delimiters if d.kind == "FIELD"]

    if not meta_delims:
        raise EnvelopeError(
            f"missing {META_DELIM} delimiter — the response must contain a line that is EXACTLY "
            f"`{META_DELIM}` (no leading/trailing text on that line) followed by the compact "
            "metadata JSON object."
        )
    if len(meta_delims) > 1:
        raise EnvelopeError(
            f"duplicate {META_DELIM} delimiter — it must appear exactly once, but was found on "
            f"lines {[d.line_idx + 1 for d in meta_delims]}."
        )
    if not end_delims:
        raise EnvelopeError(
            f"missing {END_DELIM} delimiter — the response must end its structured section with "
            f"a line that is EXACTLY `{END_DELIM}`."
        )
    if len(end_delims) > 1:
        raise EnvelopeError(
            f"duplicate {END_DELIM} delimiter — it must appear exactly once, but was found on "
            f"lines {[d.line_idx + 1 for d in end_delims]}. (If one of your FIELD blocks' raw "
            f"content happens to contain a line that is byte-for-byte `{END_DELIM}`, that line "
            "will be misread as a real delimiter — rename/reword it.)"
        )

    seen_field_names: dict[str, int] = {}
    duplicate_fields: list[str] = []
    for d in field_delims:
        assert d.field_name is not None
        if d.field_name in seen_field_names:
            duplicate_fields.append(d.field_name)
        else:
            seen_field_names[d.field_name] = d.line_idx

    if duplicate_fields:
        raise EnvelopeError(
            "duplicate <<<LEETMIND_FIELD:...>>> block(s) — each field name must appear at most "
            f"once, but these appeared more than once: {', '.join(sorted(set(duplicate_fields)))}."
        )

    # Sort ALL delimiters by position so each block's content is bounded by whichever delimiter
    # (of any kind) comes next — this is what makes field ORDER irrelevant to parsing.
    ordered = sorted(delimiters, key=lambda d: d.line_idx)
    blocks: dict[int, str] = {}
    for i, d in enumerate(ordered):
        start = d.line_idx + 1
        end = ordered[i + 1].line_idx if i + 1 < len(ordered) else len(lines)
        blocks[id(d)] = _extract_block_content(lines[start:end])

    meta_raw = blocks[id(meta_delims[0])]
    try:
        meta = json.loads(meta_raw) if meta_raw.strip() else None
    except json.JSONDecodeError as exc:
        preview = meta_raw[:300] + ("..." if len(meta_raw) > 300 else "")
        raise EnvelopeError(
            f"the {META_DELIM} block is not valid JSON: {exc}. Block content started with: "
            f"{preview!r}"
        ) from exc
    if not isinstance(meta, dict):
        raise EnvelopeError(
            f"the {META_DELIM} block must be a JSON OBJECT (got "
            f"{type(meta).__name__ if meta is not None else 'empty content'})."
        )

    missing_meta = sorted(set(spec.required_meta_fields) - set(meta.keys()))
    unknown_meta = sorted(set(meta.keys()) - set(spec.required_meta_fields))

    scalar_fields: dict[str, str] = {}
    mutant_fields: dict[int, str] = {}
    hint_fields: dict[str, str] = {}
    unknown_field_names: list[str] = []

    for d in field_delims:
        assert d.field_name is not None
        kind, extra = _classify_field_name(d.field_name, spec)
        content = blocks[id(d)]
        if kind == "scalar":
            scalar_fields[d.field_name] = content
        elif kind == "mutant":
            assert isinstance(extra, int)
            mutant_fields[extra] = content
        elif kind == "hint":
            assert isinstance(extra, str)
            hint_fields[extra] = content
        else:
            unknown_field_names.append(d.field_name)

    missing_scalars = sorted(set(spec.required_scalar_fields) - set(scalar_fields.keys()))
    missing_hints = sorted(
        f"{spec.hint_field_prefix}.{sub}"
        for sub in set(spec.hint_subfields) - set(hint_fields.keys())
    )

    mutant_indices = sorted(mutant_fields.keys())
    mutant_issues: list[str] = []
    if any(idx >= spec.max_mutants or idx < 0 for idx in mutant_indices):
        out_of_range = [idx for idx in mutant_indices if idx >= spec.max_mutants or idx < 0]
        mutant_issues.append(
            f"{spec.mutant_field_prefix}[...] index out of range (must be "
            f"0-{spec.max_mutants - 1}): {out_of_range}"
        )
    in_range_indices = sorted(
        idx for idx in mutant_indices if 0 <= idx < spec.max_mutants
    )
    expected_prefix = list(range(len(in_range_indices)))
    if in_range_indices != expected_prefix:
        mutant_issues.append(
            f"{spec.mutant_field_prefix}[...] indices must be contiguous starting at 0 with no "
            f"gaps; found indices {in_range_indices}, expected a prefix of "
            f"{list(range(spec.max_mutants))}"
        )
    elif len(in_range_indices) < spec.min_mutants:
        have = [f"{spec.mutant_field_prefix}[{i}]" for i in in_range_indices]
        need = [f"{spec.mutant_field_prefix}[{i}]" for i in range(spec.min_mutants)]
        mutant_issues.append(
            f"need at least {spec.min_mutants} mutants_py FIELD blocks ({', '.join(need)}); "
            f"found only {len(have)} ({', '.join(have) if have else 'none'})"
        )

    issues: list[str] = []
    if missing_meta:
        issues.append(
            f"missing required {META_DELIM} field(s) in the JSON object: {', '.join(missing_meta)}"
        )
    if unknown_meta:
        issues.append(
            f"unknown {META_DELIM} field(s) (not part of the envelope schema — remove them, or "
            f"if they're multi-line content they belong in a "
            f"<<<LEETMIND_FIELD:...>>> block instead): {', '.join(unknown_meta)}"
        )
    if unknown_field_names:
        issues.append(
            "unknown <<<LEETMIND_FIELD:...>>> block name(s) (not part of the envelope schema): "
            + ", ".join(sorted(set(unknown_field_names)))
        )
    if missing_scalars:
        issues.append(
            "missing required <<<LEETMIND_FIELD:...>>> block(s): "
            + ", ".join(f"<<<LEETMIND_FIELD:{name}>>>" for name in missing_scalars)
        )
    if missing_hints:
        issues.append(
            "missing required <<<LEETMIND_FIELD:hints.*>>> block(s): "
            + ", ".join(f"<<<LEETMIND_FIELD:{name}>>>" for name in missing_hints)
        )
    issues.extend(mutant_issues)

    if issues:
        raise EnvelopeError(
            "envelope validation failed with the following problem(s):\n"
            + "\n".join(f"  - {issue}" for issue in issues)
        )

    assembled: dict[str, Any] = dict(meta)
    assembled["problem_id"] = "new"
    assembled["version"] = 1
    assembled["state"] = "candidate"
    assembled["hidden_tests"] = []
    assembled["statement_md"] = scalar_fields["statement_md"]
    assembled["constraints_md"] = scalar_fields["constraints_md"]
    assembled["reference_solution_py"] = scalar_fields["reference_solution_py"]
    assembled["brute_force_py"] = scalar_fields["brute_force_py"]
    assembled["input_generator_py"] = scalar_fields["input_generator_py"]
    assembled["checker_py"] = scalar_fields.get("checker_py")
    assembled["mutants_py"] = [mutant_fields[i] for i in in_range_indices]
    assembled["hints"] = {sub: hint_fields[sub] for sub in spec.hint_subfields}
    return assembled


def render_envelope(data: dict[str, Any]) -> str:
    """The inverse of `parse_envelope`: encodes a `ProblemVersion`-shaped dict (or any dict with
    the same keys) as LEETMIND envelope text. Used by `StubInvoker` (so the stub genuinely
    exercises `parse_envelope`, not a bypass of it) and by the round-trip test in
    `test_generation_envelope.py`. `data` must contain every key in `REQUIRED_META_FIELDS` plus
    `REQUIRED_SCALAR_FIELDS`, a `mutants_py` list (3-5 entries), a `hints` dict with all
    `HINT_SUBFIELDS`, and optionally `checker_py`."""
    spec = build_envelope_spec()
    meta = {k: data[k] for k in spec.required_meta_fields}
    parts: list[str] = [META_DELIM, json.dumps(meta, sort_keys=True)]

    def _field(name: str, content: str) -> None:
        parts.append(f"{FIELD_DELIM_PREFIX}{name}{FIELD_DELIM_SUFFIX}")
        parts.append(content)

    for name in spec.required_scalar_fields:
        _field(name, data[name])
    checker_py = data.get("checker_py")
    if checker_py:
        _field("checker_py", checker_py)
    mutants = data["mutants_py"]
    for i, mutant in enumerate(mutants):
        _field(f"{spec.mutant_field_prefix}[{i}]", mutant)
    hints = data["hints"]
    for sub in spec.hint_subfields:
        _field(f"{spec.hint_field_prefix}.{sub}", hints[sub])
    parts.append(END_DELIM)
    return "\n".join(parts) + "\n"
