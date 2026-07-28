"""Step 1 of the generation pipeline (PLAN_BACKEND.md §7.2).

Gathers the Elo profile plus reservations (amendment 30: pending `active`/`ready`/`building`
problems and every non-terminal job's `plan_json` count too, so concurrent jobs for one user can
never pick the same type or shape), scores a deterministic shortlist via `selection.py`, then
makes one LLM call to pick the primary type, support types, target rating, and premise from that
shortlist. Every field is validated against the constraints the LLM was given; one re-ask on
violation, then a fully deterministic fallback so the pipeline never stalls on a chatty or
unavailable model (decision 10).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import asyncpg
from pydantic import BaseModel, ValidationError

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
from leetmind.taxonomy import PROBLEM_TYPES

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
    """The planner CLI call's JSON-schema-validated output (§7.2)."""

    primary_type: str
    support_types: list[str] = []
    shape: str
    problem_rating: int
    premise: str
    rationale: str = ""


@dataclass(frozen=True)
class Plan:
    """The persisted `generation_jobs.plan_json` payload. `is_probe` is not something the LLM
    decides — it's a deterministic consequence of whether the chosen primary type has any
    evidence (§6.2), enforced after the fact rather than merely validated."""

    primary_type: str
    support_types: list[str]
    shape: str
    problem_rating: int
    premise: str
    is_probe: bool

    def to_json(self) -> dict[str, Any]:
        return {
            "primary_type": self.primary_type,
            "support_types": self.support_types,
            "shape": self.shape,
            "problem_rating": self.problem_rating,
            "premise": self.premise,
            "is_probe": self.is_probe,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Plan:
        return cls(
            primary_type=data["primary_type"],
            support_types=list(data.get("support_types") or []),
            shape=data["shape"],
            problem_rating=int(data["problem_rating"]),
            premise=data["premise"],
            is_probe=bool(data.get("is_probe", False)),
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
    return lru_shape(recency)


async def _recent_titles_and_premises(
    conn: asyncpg.Connection, user_id: UUID
) -> list[dict[str, str]]:
    """Anti-repetition context (§7.2): a problem's premise isn't stored on its own row, but it's
    exactly what the originating job's `plan_json` carried, so it's reconstructed from there."""
    rows = await conn.fetch(
        """
        SELECT p.title, gj.plan_json->>'premise' AS premise
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
        lo, hi = target_band(s.rating)
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

`problem_rating`: an integer inside the chosen type's `target_rating_band` (unless the type is
unevidenced, in which case rating is fixed elsewhere and you may pick anything in-band).

Difficulty rubric — justify the rating against this table:
{DIFFICULTY_RUBRIC}

Reserved types already in flight for this user (avoid echoing their premise/flavor):
{", ".join(sorted(set(reserved_types))) or "(none)"}

The user's last {len(recent)} problems (avoid repeating these titles or premises):
{chr(10).join(recent_lines)}

Write `premise`: a 2-3 sentence ORIGINAL scenario (not a known LeetCode problem's premise
verbatim) that the primary_type's technique will solve. Write `rationale`: one sentence for logs.

Respond with ONLY a JSON object with exactly these keys: primary_type, support_types, shape,
problem_rating, premise, rationale. No markdown fences, no prose outside the JSON.
"""


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
    current_prompt = prompt
    for attempt in range(2):  # one original call + one re-ask on violation (decision 10)
        try:
            output = await llm.complete(current_prompt, PlanOutput)
        except (LLMError, ValidationError) as exc:
            logger.warning("planner CLI call failed (attempt %d): %s", attempt, exc)
            break
        error = _validate(
            output,
            shortlist_slugs=shortlist_slugs,
            shape_for=shape_for,
            signal_by_slug=signal_by_slug,
            support_pool=support_pool,
        )
        if error is None:
            return output
        logger.warning("planner output violated constraints (attempt %d): %s", attempt, error)
        current_prompt = f"{prompt}\n\nYour previous answer was invalid: {error}\nRespond again."

    logger.warning("planner falling back to a deterministic plan (primary=%s)", fallback_primary)
    return _deterministic_plan(
        fallback_primary=fallback_primary, shape_for=shape_for, signal_by_slug=signal_by_slug
    )


async def plan_generation(
    conn: asyncpg.Connection, llm: LLMClient, *, user_id: UUID, job_id: UUID
) -> Plan:
    """The full step-1 pipeline: gather context, score the deterministic shortlist, call the
    planner CLI (validate/re-ask/fallback), and enforce the probe consequences (§6.2, §7.2)."""
    generation_index = await _generation_index(conn, user_id, job_id)
    signals = await gather_signals(conn, user_id)
    signal_by_slug = {s.slug: s for s in signals}

    probe_only = is_probe_generation(generation_index, signals)
    picks = shortlist(signals, probe_only=probe_only)
    picks_slugs = [p.slug for p in picks]
    shortlist_slugs = set(picks_slugs)

    reserved_types, reserved_shapes = await _reservations(conn, user_id)
    shape_for = {
        slug: await _lru_shape_for_type(conn, user_id, slug, reserved_shapes)
        for slug in picks_slugs
    }
    support_pool = {
        slug: support_candidates(
            signals, primary_slug=slug, primary_rating=signal_by_slug[slug].rating
        )
        for slug in picks_slugs
    }
    recent = await _recent_titles_and_premises(conn, user_id)

    prompt = _render_prompt(
        signals=signals,
        picks_slugs=picks_slugs,
        shape_for=shape_for,
        support_pool=support_pool,
        recent=recent,
        reserved_types=reserved_types,
    )

    output = await _call_planner(
        llm,
        prompt,
        shortlist_slugs=shortlist_slugs,
        shape_for=shape_for,
        signal_by_slug=signal_by_slug,
        support_pool=support_pool,
        fallback_primary=picks_slugs[0],
    )

    primary_signal = signal_by_slug[output.primary_type]
    is_probe = not primary_signal.evidenced
    if is_probe:
        # §6.2: "probe problems get is_probe=true, problem_rating=1000, and no support types —
        # nothing evidenced to lean on." Enforced, not merely requested of the model.
        support_types: list[str] = []
        problem_rating = PROBE_RATING
    else:
        support_types = output.support_types
        problem_rating = output.problem_rating

    return Plan(
        primary_type=output.primary_type,
        support_types=support_types,
        shape=shape_for[output.primary_type],
        problem_rating=problem_rating,
        premise=output.premise,
        is_probe=is_probe,
    )
