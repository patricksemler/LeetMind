"""Deterministic activity selection for the generation pipeline.

The adaptive scorer already owns the decisions that matter: which concept needs work, what target
rating fits the learner, and which activity shape is least recently used. Making another model
choose among those constrained values added latency and a second semantic-failure surface without
adding information. Planning is therefore DB + pure selection only; the builder remains responsible
for the creative premise.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import asyncpg
from pydantic import BaseModel, ConfigDict, ValidationError

from leetmind.db import load_jsonb
from leetmind.elo import DEFAULT_RATING
from leetmind.llm import LLMClient, LLMError
from leetmind.ratings import ensure_ratings
from leetmind.selection import (
    PROBE_RATING,
    TypeSignal,
    is_probe_generation,
    lru_shape,
    shortlist,
    support_candidates,
    target_band,
)
from leetmind.taxonomy import PROBLEM_TYPES, TYPE_SHAPES

logger = logging.getLogger("leetmind.planner")

RECENT_WINDOW = 8  # §6.2 repetition window; also how far back anti-repetition context looks

DIFFICULTY_RUBRIC = """\
| Band | Structural requirement |
|---|---|
| <=1000 | direct application of the type's basic pattern; one loop / one structure; no twist |
| 1000-1200 | the standard technique plus one small twist or extra bookkeeping |
| 1200-1400 | a non-obvious invariant, or two techniques composed; naive is clearly too slow |
| 1400-1600 | a multi-step insight; tight constraints; adversarial edge cases |
| 1600+ | layered insights or an unusual reformulation of a known pattern |"""

_PREMISE_MAX_CHARS = 2000


class PlanOutput(BaseModel):
    """Legacy planner output retained for fixture/backward-compatible helper tests."""

    model_config = ConfigDict(extra="forbid")

    primary_type: str
    support_types: list[str] = []
    shape: str
    problem_rating: int
    premise: str
    rationale: str = ""


class PlanReviewOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aligned_with_activity: bool
    issues: list[str]

@dataclass(frozen=True)
class Plan:
    """Versioned `generation_jobs.plan_json` payload.

    `support_types` are options the single creative builder may use; it is not forced to add
    scaffolding. `recent_problems` supplies anti-repetition context without requiring a separate
    premise-generating model call. `legacy_premise` is read only from v1 jobs and is explicitly
    advisory so a crash-resumed job cannot recreate the old premise-vs-problem rejection loop.
    """

    primary_type: str
    support_types: list[str]
    shape: str
    problem_rating: int
    premise: str
    is_probe: bool
    recent_problems: list[dict[str, str]] | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "version": 2,
            "primary_type": self.primary_type,
            "support_candidates": self.support_types,
            "shape": self.shape,
            "problem_rating": self.problem_rating,
            "is_probe": self.is_probe,
            "recent_problems": self.recent_problems or [],
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Plan:
        support = data.get("support_candidates")
        if support is None:
            support = data.get("support_types")
        return cls(
            primary_type=data["primary_type"],
            support_types=list(support or []),
            shape=data["shape"],
            problem_rating=int(data["problem_rating"]),
            premise=data.get("premise") or "",
            is_probe=bool(data.get("is_probe", False)),
            recent_problems=list(data.get("recent_problems") or []),
        )


async def _generation_index(conn: asyncpg.Connection, user_id: UUID, exclude_job_id: UUID) -> int:
    """This job's 0-indexed ordinal among the user's jobs — the coverage-first probe policy
    (`is_probe_generation`) alternates on it. The job row itself already exists (queued) by the
    time planning runs, so it's excluded from its own count."""
    count = await conn.fetchval(
        "SELECT COUNT(*) FROM generation_jobs WHERE user_id = $1 AND id <> $2",
        user_id,
        exclude_job_id,
    )
    return int(count)


async def _reservations(
    conn: asyncpg.Connection, user_id: UUID
) -> tuple[list[str], dict[str, list[str]]]:
    """Amendment 30: pending type/shape choices, most-recent-first. `problems` covers completed
    jobs' output not yet resolved (`active`/`ready`); `generation_jobs.plan_json` covers every
    stage from "planned" through `verifying` (that row's `problems` entry, if any, is still
    `building` and isn't double-counted here)."""
    problem_rows = await conn.fetch(
        """
        SELECT primary_type, shape FROM problems
        WHERE user_id = $1 AND status IN ('active', 'ready')
        ORDER BY created_at DESC
        """,
        user_id,
    )
    job_rows = await conn.fetch(
        """
        SELECT plan_json FROM generation_jobs
        WHERE user_id = $1 AND status NOT IN ('ready', 'failed') AND plan_json IS NOT NULL
        ORDER BY created_at DESC
        """,
        user_id,
    )

    types: list[str] = []
    shapes_by_type: dict[str, list[str]] = {}
    for row in problem_rows:
        types.append(row["primary_type"])
        shapes_by_type.setdefault(row["primary_type"], []).append(row["shape"])
    for row in job_rows:
        plan = load_jsonb(row["plan_json"])
        primary = plan.get("primary_type")
        shape = plan.get("shape")
        if not primary:
            continue
        types.append(primary)
        if shape:
            shapes_by_type.setdefault(primary, []).append(shape)
    return types, shapes_by_type


async def _resolved_history(
    conn: asyncpg.Connection, user_id: UUID, limit: int = RECENT_WINDOW
) -> list[asyncpg.Record]:
    rows: list[asyncpg.Record] = await conn.fetch(
        """
        SELECT primary_type, shape, resolved_at
        FROM problems
        WHERE user_id = $1 AND status IN ('solved', 'given_up') AND resolved_at IS NOT NULL
        ORDER BY resolved_at DESC
        LIMIT $2
        """,
        user_id,
        limit,
    )
    return rows


async def _last_resolved_at(conn: asyncpg.Connection, user_id: UUID) -> dict[str, datetime]:
    rows = await conn.fetch(
        """
        SELECT primary_type, MAX(resolved_at) AS last_resolved
        FROM problems
        WHERE user_id = $1 AND status IN ('solved', 'given_up') AND resolved_at IS NOT NULL
        GROUP BY primary_type
        """,
        user_id,
    )
    return {r["primary_type"]: r["last_resolved"] for r in rows}


async def _shape_history_for_type(
    conn: asyncpg.Connection, user_id: UUID, primary_type: str
) -> list[str]:
    """Unbounded (not windowed to `RECENT_WINDOW`) so a type resolved long ago still rotates its
    shapes correctly rather than reading as "never used" (invariant I4)."""
    rows = await conn.fetch(
        """
        SELECT shape FROM problems
        WHERE user_id = $1 AND primary_type = $2 AND status IN ('solved', 'given_up')
          AND resolved_at IS NOT NULL
        ORDER BY resolved_at DESC
        """,
        user_id,
        primary_type,
    )
    return [r["shape"] for r in rows]


async def _lru_shape_for_type(
    conn: asyncpg.Connection,
    user_id: UUID,
    primary_type: str,
    reserved_shapes: dict[str, list[str]],
) -> str:
    ordered = list(reserved_shapes.get(primary_type, []))
    ordered += await _shape_history_for_type(conn, user_id, primary_type)
    recency: dict[str, float] = {}
    for index, shape in enumerate(ordered):
        recency.setdefault(shape, float(index))  # first (most recent) occurrence wins
    return lru_shape(recency, TYPE_SHAPES[primary_type])


async def _recent_titles_and_premises(
    conn: asyncpg.Connection, user_id: UUID
) -> list[dict[str, str]]:
    """Anti-repetition context for the creative builder.

    V1 jobs carried a planner-authored premise; V2 deliberately does not. Use the persisted problem
    statement as the durable scenario summary, with the legacy premise preferred where available.
    """
    rows = await conn.fetch(
        """
        SELECT p.title, COALESCE(NULLIF(gj.plan_json->>'premise', ''), p.statement_md) AS premise
        FROM problems p
        JOIN generation_jobs gj ON gj.problem_id = p.id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC
        LIMIT $2
        """,
        user_id,
        RECENT_WINDOW,
    )
    return [{"title": r["title"], "premise": r["premise"] or ""} for r in rows]


async def gather_signals(conn: asyncpg.Connection, user_id: UUID) -> list[TypeSignal]:
    """The full per-type input to `selection.py`, including amendment 30's pending reservations
    folded into the repetition count."""
    await ensure_ratings(conn, user_id)
    rating_rows = await conn.fetch(
        "SELECT type_slug, rating, attempts FROM ratings WHERE user_id = $1", user_id
    )
    ratings_by_type = {r["type_slug"]: (r["rating"], r["attempts"]) for r in rating_rows}

    reserved_types, _ = await _reservations(conn, user_id)
    resolved_rows = await _resolved_history(conn, user_id)
    last_resolved = await _last_resolved_at(conn, user_id)

    # Reservations read as "just happened," ahead of the actually-resolved history, then
    # windowed — amendment 30's "the repetition window... counts pending work too."
    window = (reserved_types + [r["primary_type"] for r in resolved_rows])[:RECENT_WINDOW]

    now = datetime.now(UTC)
    signals = []
    for slug in PROBLEM_TYPES:
        rating, attempts = ratings_by_type.get(slug, (float(DEFAULT_RATING), 0))
        last_at = last_resolved.get(slug)
        days_since = (now - last_at).total_seconds() / 86400 if last_at else None
        signals.append(
            TypeSignal(
                slug=slug,
                rating=rating,
                attempts=attempts,
                days_since_resolved=days_since,
                repetition_count=window.count(slug),
            )
        )
    return signals


def _render_prompt(
    *,
    signals: list[TypeSignal],
    picks_slugs: list[str],
    shape_for: dict[str, str],
    support_pool: dict[str, list[str]],
    recent: list[dict[str, str]],
    reserved_types: list[str],
) -> str:
    signal_by_slug = {s.slug: s for s in signals}
    profile_lines = [
        f"- {s.slug}: rating={s.rating:.0f} attempts={s.attempts} "
        f"evidenced={'yes' if s.evidenced else 'no'}"
        for s in signals
    ]
    shortlist_lines = []
    for slug in picks_slugs:
        s = signal_by_slug[slug]
        lo, hi = target_band(s.rating) if s.evidenced else (PROBE_RATING, PROBE_RATING)
        support = support_pool.get(slug) or []
        shortlist_lines.append(
            f"- {slug}: rating={s.rating:.0f} evidenced={'yes' if s.evidenced else 'no'} "
            f"required_shape={shape_for[slug]!r} target_rating_band=[{lo:.0f}, {hi:.0f}] "
            f"support_candidates={support}"
        )
    recent_lines = [f'- "{r["title"]}": {r["premise"]}' for r in recent] or ["- (none yet)"]

    return f"""\
You are picking the next practice problem to generate for a LeetCode-style learning app.

Full per-type learner profile (rating is an Elo-style estimate, attempts=0 means unevidenced):
{chr(10).join(profile_lines)}

You MUST choose `primary_type` from this shortlist only (already scored by weakness, coverage,
staleness, and anti-repetition — do not second-guess the selection, only pick among them):
{chr(10).join(shortlist_lines)}

For whichever primary_type you choose, `shape` MUST be exactly its `required_shape` above — this
is fixed by a least-recently-used rotation, not your choice to make.

`support_types`: 0-2 types drawn ONLY from that primary type's `support_candidates` list above.
Support types are scaffolding only (their rating never changes) — pick types the learner is
already strong in, when they'd plausibly help frame the problem. Leave empty if none fit.

`problem_rating`: an integer inside the chosen type's `target_rating_band`. An unevidenced type's
band is exactly [{PROBE_RATING}, {PROBE_RATING}] because coverage probes must be direct,
beginner-level applications of the type's basic pattern.

Difficulty rubric — justify the rating against this table:
{DIFFICULTY_RUBRIC}

Before responding, silently reject any candidate premise whose natural efficient solution does
not centrally use the chosen primary_type and required_shape, whose input properties break that
technique, or whose insight falls outside the exact target_rating_band. For a 1000 probe, avoid
famous harder variants and use only the direct canonical pattern.

Reserved types already in flight for this user (avoid echoing their premise/flavor):
{", ".join(sorted(set(reserved_types))) or "(none)"}

The user's last {len(recent)} problems (avoid repeating these titles or premises):
{chr(10).join(recent_lines)}

Write `premise`: a 2-3 sentence ORIGINAL scenario (not a known LeetCode problem's premise
verbatim) that the primary_type's technique will solve. Write `rationale`: one sentence for logs.

Respond with ONLY a JSON object with exactly these keys: primary_type, support_types, shape,
problem_rating, premise, rationale. No markdown fences, no prose outside the JSON.
"""


def _render_plan_review_prompt(output: PlanOutput) -> str:
    return f"""\
You are an independent curriculum reviewer for an algorithm-practice app. Review this candidate
plan before any problem is built:

- primary_type: {output.primary_type}
- support_types: {output.support_types}
- shape: {output.shape}
- problem_rating: {output.problem_rating}
- premise: {output.premise}

Difficulty rubric:
{DIFFICULTY_RUBRIC}

Set aligned_with_activity=false if ANY of these are true:
1. The premise's natural efficient solution would not centrally exercise `primary_type`, or its
   input properties invalidate that technique and force a materially different one.
2. The computational task implied by the premise does not match `shape`.
3. The required insight is implausibly easy or hard for `problem_rating`. Be strict for ratings
   <=1000: these must be direct applications of the basic pattern, with no non-obvious invariant
   or famous harder variant disguised as a probe.
4. The premise is ambiguous or does not define a coherent algorithmic task.

Support types may scaffold the task but must not replace the primary type. When false, provide
1-3 short, concrete issues that tell the planner what premise or rating to change.

Respond with ONLY a JSON object with exactly these keys:
{{"aligned_with_activity": true_or_false, "issues": ["..."]}}
No markdown fences and no prose outside the JSON.
"""


async def _call_plan_reviewer(llm: LLMClient, output: PlanOutput) -> PlanReviewOutput:
    prompt = _render_plan_review_prompt(output)
    review = await llm.complete(prompt, PlanReviewOutput)
    if not review.aligned_with_activity and not review.issues:
        raise LLMError("issues must explain why aligned_with_activity is false")
    return review


def _validate(
    output: PlanOutput,
    *,
    shortlist_slugs: set[str],
    shape_for: dict[str, str],
    signal_by_slug: dict[str, TypeSignal],
    support_pool: dict[str, list[str]],
) -> str | None:
    """First violation found, or `None` if the plan satisfies every constraint it was given."""
    if output.primary_type not in shortlist_slugs:
        return f"primary_type must be one of the shortlisted types: {sorted(shortlist_slugs)}"
    if output.shape != shape_for[output.primary_type]:
        return (
            f"shape must be {shape_for[output.primary_type]!r} "
            f"(the required LRU shape for {output.primary_type})"
        )
    if len(output.support_types) > 2:
        return "support_types may include at most 2 types"
    if output.primary_type in output.support_types:
        return "support_types must not include primary_type"
    allowed = set(support_pool.get(output.primary_type, []))
    if not set(output.support_types) <= allowed:
        return f"support_types must be drawn from {sorted(allowed)}"
    signal = signal_by_slug[output.primary_type]
    if signal.evidenced:
        lo, hi = target_band(signal.rating)
        if not (lo <= output.problem_rating <= hi):
            return f"problem_rating must be within [{lo:.0f}, {hi:.0f}] for {output.primary_type}"
    elif output.problem_rating != PROBE_RATING:
        return f"problem_rating must be {PROBE_RATING} for an unevidenced probe type"
    if not output.premise.strip():
        return "premise must not be empty"
    if len(output.premise) > _PREMISE_MAX_CHARS:
        return "premise must be a short 2-3 sentence scenario"
    return None


def _deterministic_plan(
    *, fallback_primary: str, shape_for: dict[str, str], signal_by_slug: dict[str, TypeSignal]
) -> PlanOutput:
    """The never-stalls fallback (§7.2): shortlist head, that type's LRU shape, the target band's
    midpoint, a generic premise request, no support types."""
    signal = signal_by_slug[fallback_primary]
    if signal.evidenced:
        lo, hi = target_band(signal.rating)
        rating = round((lo + hi) / 2)
    else:
        rating = PROBE_RATING
    return PlanOutput(
        primary_type=fallback_primary,
        support_types=[],
        shape=shape_for[fallback_primary],
        problem_rating=rating,
        premise=f"An original scenario exercising {fallback_primary.replace('_', ' ')}.",
        rationale="deterministic fallback: planner CLI unavailable or produced invalid output",
    )


async def _call_planner(
    llm: LLMClient,
    prompt: str,
    *,
    shortlist_slugs: set[str],
    shape_for: dict[str, str],
    signal_by_slug: dict[str, TypeSignal],
    support_pool: dict[str, list[str]],
    fallback_primary: str,
) -> PlanOutput:
    try:
        output = await llm.complete(prompt, PlanOutput)
    except (LLMError, ValidationError) as exc:
        logger.warning("legacy planner call failed: %s", exc)
    else:
        error = _validate(
            output,
            shortlist_slugs=shortlist_slugs,
            shape_for=shape_for,
            signal_by_slug=signal_by_slug,
            support_pool=support_pool,
        )
        if error is None:
            try:
                review = await _call_plan_reviewer(llm, output)
            except LLMError as exc:
                logger.warning("legacy plan reviewer failed: %s", exc)
            else:
                if review.aligned_with_activity:
                    return output
                error = (
                    "independent curriculum review found a mismatch: "
                    + "; ".join(review.issues)
                )
        logger.warning("legacy planner output violated constraints: %s", error)

    logger.warning("planner falling back to a deterministic plan (primary=%s)", fallback_primary)
    return _deterministic_plan(
        fallback_primary=fallback_primary, shape_for=shape_for, signal_by_slug=signal_by_slug
    )


async def plan_generation(
    conn: asyncpg.Connection, llm: LLMClient, *, user_id: UUID, job_id: UUID
) -> Plan:
    """Select the next activity without an LLM call.

    `llm` remains in the signature so injected workers and older call sites stay source-compatible;
    it is intentionally unused. Creativity belongs in the single builder call.
    """
    del llm
    generation_index = await _generation_index(conn, user_id, job_id)
    signals = await gather_signals(conn, user_id)
    signal_by_slug = {s.slug: s for s in signals}

    probe_only = is_probe_generation(generation_index, signals)
    picks = shortlist(signals, probe_only=probe_only)
    primary_type = picks[0].slug
    primary_signal = signal_by_slug[primary_type]

    _, reserved_shapes = await _reservations(conn, user_id)
    shape = await _lru_shape_for_type(conn, user_id, primary_type, reserved_shapes)
    recent = await _recent_titles_and_premises(conn, user_id)

    is_probe = not primary_signal.evidenced
    if is_probe:
        support_types: list[str] = []
        problem_rating = PROBE_RATING
    else:
        # Highest-rated eligible concepts first, capped before they reach the creative builder.
        allowed = support_candidates(
            signals, primary_slug=primary_type, primary_rating=primary_signal.rating
        )
        support_types = sorted(
            allowed, key=lambda slug: (-signal_by_slug[slug].rating, slug)
        )[:2]
        lo, hi = target_band(primary_signal.rating)
        problem_rating = round((lo + hi) / 2)

    return Plan(
        primary_type=primary_type,
        support_types=support_types,
        shape=shape,
        problem_rating=problem_rating,
        premise="",
        is_probe=is_probe,
        recent_problems=recent,
    )
