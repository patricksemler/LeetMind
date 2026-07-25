"""Stage 1 — schema (CONTRACTS.md §10).

Fails when: pydantic parse fails; hint L1/L2 contain code fences or named algorithms;
constraints unparseable; concept weights don't sum to ~1.0.

Pure Python — no sandbox. Concept-weight-sums-to-1.0 and exactly-one-primary-concept are already
enforced by `ProblemVersion`'s own pydantic validators (`leetmind_content.models`), so a pydantic
parse failure covers those two conditions; this stage adds the checks pydantic can't express:
banned hint vocabulary and "constraints_md isn't just blank/missing".
"""

from __future__ import annotations

import time
from typing import Any

from pydantic import ValidationError

from leetmind_content.models import ProblemVersion, StageResult
from leetmind_content.verification.banned_words import find_banned_terms

STAGE = "schema"


def run(content: dict[str, Any] | ProblemVersion) -> tuple[StageResult, ProblemVersion | None]:
    """Returns `(StageResult, parsed_problem_or_None)`. `parsed_problem` is `None` iff the
    result failed — every downstream stage operates on the parsed `ProblemVersion`, never on the
    raw dict, so this is the one place the untyped `content jsonb` becomes a typed object."""
    started = time.monotonic()

    if isinstance(content, ProblemVersion):
        problem = content
    else:
        try:
            problem = ProblemVersion.model_validate(content)
        except ValidationError as exc:
            duration_ms = int((time.monotonic() - started) * 1000)
            return (
                StageResult(
                    stage=STAGE,
                    status="failed",
                    duration_ms=duration_ms,
                    details={
                        "reason": "pydantic_parse_failed",
                        "errors": exc.errors(include_url=False),
                    },
                ),
                None,
            )

    problems_found: dict[str, list[str]] = {}

    l1_hits = find_banned_terms(problem.hints.l1_orientation)
    if l1_hits:
        problems_found["l1_orientation"] = l1_hits
    l2_hits = find_banned_terms(problem.hints.l2_conceptual)
    if l2_hits:
        problems_found["l2_conceptual"] = l2_hits

    constraints_ok = bool(problem.constraints_md and problem.constraints_md.strip())

    duration_ms = int((time.monotonic() - started) * 1000)

    if problems_found:
        return (
            StageResult(
                stage=STAGE,
                status="failed",
                duration_ms=duration_ms,
                details={"reason": "banned_hint_vocabulary", "hits": problems_found},
            ),
            None,
        )

    if not constraints_ok:
        return (
            StageResult(
                stage=STAGE,
                status="failed",
                duration_ms=duration_ms,
                details={
                    "reason": "constraints_md_unparseable",
                    "constraints_md": problem.constraints_md,
                },
            ),
            None,
        )

    return (
        StageResult(
            stage=STAGE,
            status="passed",
            duration_ms=duration_ms,
            details={"concept_count": len(problem.concepts)},
        ),
        problem,
    )
