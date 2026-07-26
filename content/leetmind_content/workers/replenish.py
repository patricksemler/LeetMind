"""Replenishment — the demand-predicting buffer worker (docs/CONTRACTS.md §11, PLAN.md §5
"Replenishment").

The user-facing practice loop only ever reads from the `approved` pool; this worker's whole
job is to keep that pool ahead of demand so LLM downtime or verification failures degrade buffer
*depth*, never a live practice session (PLAN.md §5).

Three pieces:
  - `compute_demand(user_id)` — predicts which concept x rating-band cells upcoming practice is
    likely to draw from (see its docstring for "decision #4", the prediction rule).
  - `replenish_once(...)` — one pass: for each predicted cell, count approved-and-unattempted
    inventory, and enqueue `generate` jobs for cells below `BUFFER_LOW_WATERMARK`, at the lowest
    queue priority, capped per pass.
  - `run_replenish_loop(...)` — ticks `replenish_once` every `REPLENISH_INTERVAL_MS`.

Plus `buffer_report(user_id)`, a read-only per-cell depth snapshot for `/api/system/stats`
(CONTRACTS.md §9 "buffer depth per band").
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from leetmind_content.config import Settings, get_settings
from leetmind_content.db import get_pool, query
from leetmind_content.generation.prompts.v1 import PROMPT_VERSION
from leetmind_content.logging import get_logger
from leetmind_content.models import GenerationConceptWeight, GenerationRequest
from leetmind_content.queue import Queue

log = get_logger("content-replenish")

#: Rating bands are 200 wide, keyed by floor(rating/200)*200 (CONTRACTS.md §11).
BAND_WIDTH = 200

#: How far above a concept's current band the "next overload step" cell sits (PLAN.md §8: the
#: practice deliberately reaches for a problem "slightly above band" to test the ceiling).
OVERLOAD_STEP = BAND_WIDTH

#: Ceiling on predicted bands, matching the taxonomy seed's `concepts.max_rating` convention
#: (CONTRACTS.md §3) — there is no point predicting demand for a band nothing will ever be rated
#: into.
MAX_BAND = 2400

#: Bound on how many `generate` jobs one `replenish_once` pass will attempt to enqueue, so a
#: profile with many simultaneously-under-watermark cells can't turn a single pass into an
#: unbounded burst of DB writes. Not a CONTRACTS.md env var (there wasn't one listed for it) —
#: exposed as a parameter with this default so tests can exercise the cap deterministically.
DEFAULT_MAX_ENQUEUE_PER_PASS = 20

#: How many recent titles for a concept to feed back as `similarity_exclusions` (PLAN.md §5).
SIMILARITY_EXCLUSION_LIMIT = 5

#: Default `expected_minutes` band handed to generation requests raised by replenishment. Kept
#: modest/deliberately generic — replenishment doesn't know whether the problem will eventually
#: be served at level, above band, or as a spaced review; only its concept and rating band.
DEFAULT_EXPECTED_MINUTES: tuple[int, int] = (8, 20)


def _band_for_rating(rating: float) -> int:
    return int(rating // BAND_WIDTH) * BAND_WIDTH


@dataclass(frozen=True)
class BandCell:
    """One concept x rating-band target identified by `compute_demand`."""

    concept_id: str
    band: int
    reasons: tuple[str, ...]  # subset of {"weak", "due_review", "overload"}
    rating: float
    uncertainty: float

    @property
    def idempotency_prefix(self) -> str:
        return f"generate:{self.concept_id}:{self.band}:"


def compute_demand(user_id: str, *, settings: Settings | None = None) -> list[BandCell]:
    """Predicts the concept x rating-band cells upcoming practice is likely to draw from.

    THE PREDICTION RULE (decision #4 — kept legible on purpose, this is the entire
    replenishment strategy):

    For every concept in the taxonomy (`concepts`), using the user's `user_concept_state` row
    for that concept when one exists, else the column defaults (rating=1200, uncertainty=350,
    never practiced, no review due) — an unpracticed concept is exactly as much a target as a
    freshly-seeded one, so every concept is considered, not just ones the user has touched:

      1. **weak** — the concept's own current band (`floor(rating/200)*200`) is always a target
         cell. PLAN.md §7's 65-80%-success-band "working set" problems for that concept live
         here by construction; it is the band every future at-level practice problem pulls from.
         Lower rating (weaker concept) sorts first — see the ordering note below.
      2. **due_review** — if `next_review_at` is set and `<= now()`, the SAME cell (current
         band) additionally carries this reason. A review reuses the concept's current band; it
         is not a different band, only an added urgency signal used for ordering.
      3. **overload** — the band one step above the concept's current band
         (`band + OVERLOAD_STEP`), capped at `MAX_BAND`, is always also a target cell —
         PLAN.md §8's "above band" stretch (a problem slightly above where the user
         currently sits) needs a pre-approved supply ready the moment the user is due for one.

    Cells are deduplicated by `(concept_id, band)` — if one concept's overload band happens to
    coincide with a rating value another concept's own band also occupies, they're still
    separate cells (band alone doesn't identify a cell, `(concept_id, band)` does).

    Returned list is sorted most-urgent-first: `due_review` cells before non-review cells, then
    `weak` before overload-only cells, then ascending `rating` (weaker concepts first) — overload
    cells are the least time-sensitive target (headroom for a stretch problem, not a gap in
    today's practice), so they sort last among otherwise-equal cells.
    """
    del settings  # accepted for API symmetry with other functions in this module; unused here
    rows = query(
        """
        select c.id as concept_id,
               coalesce(ucs.rating, 1200) as rating,
               coalesce(ucs.uncertainty, 350) as uncertainty,
               ucs.next_review_at
        from concepts c
        left join user_concept_state ucs on ucs.concept_id = c.id and ucs.user_id = %s
        order by c.sort_order, c.id;
        """,
        (user_id,),
    )

    cells: dict[tuple[str, int], dict[str, Any]] = {}

    def touch(concept_id: str, band: int, reason: str, rating: float, uncertainty: float) -> None:
        entry = cells.setdefault(
            (concept_id, band), {"reasons": set(), "rating": rating, "uncertainty": uncertainty}
        )
        entry["reasons"].add(reason)

    now = datetime.now(UTC)
    for row in rows:
        concept_id = row["concept_id"]
        rating = float(row["rating"])
        uncertainty = float(row["uncertainty"])
        band = _band_for_rating(rating)
        next_review_at = row["next_review_at"]
        due = next_review_at is not None and next_review_at <= now

        touch(concept_id, band, "weak", rating, uncertainty)
        if due:
            touch(concept_id, band, "due_review", rating, uncertainty)

        overload_band = min(band + OVERLOAD_STEP, MAX_BAND)
        if overload_band > band:
            touch(concept_id, overload_band, "overload", rating, uncertainty)

    result = [
        BandCell(
            concept_id=concept_id,
            band=band,
            reasons=tuple(sorted(v["reasons"])),
            rating=v["rating"],
            uncertainty=v["uncertainty"],
        )
        for (concept_id, band), v in cells.items()
    ]
    result.sort(
        key=lambda cell: (
            0 if "due_review" in cell.reasons else 1,
            0 if "weak" in cell.reasons else 1,
            cell.rating,
        )
    )
    return result


def _approved_unattempted_count(user_id: str, concept_id: str, band: int) -> int:
    """Counts approved problem versions, primarily tagged `concept_id`, whose difficulty rating
    falls in `[band, band + BAND_WIDTH)`, that `user_id` has never submitted against — "a problem
    the user already submitted against doesn't count as buffer" (task brief)."""
    rows = query(
        """
        select count(*) as n
        from problem_versions pv
        join problem_concepts pc
          on pc.problem_version_id = pv.id and pc.concept_id = %s and pc.role = 'primary'
        where pv.state = 'approved'
          and pv.difficulty_rating >= %s and pv.difficulty_rating < %s
          and not exists (
            select 1 from submissions sub
            where sub.problem_version_id = pv.id and sub.user_id = %s
          );
        """,
        (concept_id, band, band + BAND_WIDTH, user_id),
    )
    return int(rows[0]["n"]) if rows else 0


def _existing_attempt_count(cell: BandCell) -> int:
    """How many `generate` job attempts for this cell have reached a TERMINAL state (`done` or
    `dead` — excludes `queued`/`leased`, still-pending attempts that might yet fill the deficit on
    their own) — the starting offset for this pass's new slot numbers, instead of always starting
    a fixed `0..watermark-1` range from 0.

    A terminal `done` job is counted here even though `handle_generate` never records whether the
    problem version it produced was ultimately `approved` or `rejected` by verification (no column
    links a `jobs` row to that outcome) — but that's fine: if it HAD contributed to the approved
    pool, `_approved_unattempted_count` would already reflect that and `replenish_once` would have
    skipped this cell before ever calling this function (the `covered >= watermark` check). Being
    counted here specifically means "this attempt is over, whatever its outcome" — which is
    exactly the condition under which its slot number should never be retried again. See
    `replenish_once`'s docstring for why a fixed 0..watermark-1 range plateaus the buffer below
    watermark forever once every slot in it has been consumed by a rejected attempt."""
    rows = query(
        "select count(*) as n from jobs "
        "where kind = 'generate' and idempotency_key like %s and status not in ('queued', 'leased');",
        (cell.idempotency_prefix + "%",),
    )
    return int(rows[0]["n"]) if rows else 0


def _recent_titles(concept_id: str, limit: int = SIMILARITY_EXCLUSION_LIMIT) -> list[str]:
    """Recent titles touching `concept_id` (any non-rejected state), newest first — fed back as
    `similarity_exclusions` (CONTRACTS.md §4.4) so replenishment-driven generation doesn't repeat
    recent content for that concept."""
    rows = query(
        """
        select pv.title
        from problem_versions pv
        join problem_concepts pc on pc.problem_version_id = pv.id
        where pc.concept_id = %s and pv.state in ('candidate', 'verifying', 'approved')
        order by pv.created_at desc
        limit %s;
        """,
        (concept_id, limit),
    )
    return [r["title"] for r in rows]


def _build_generation_request(cell: BandCell) -> GenerationRequest:
    """Turns a predicted `BandCell` into a `GenerationRequest` (CONTRACTS.md §4.4) targeting the
    middle of the cell's band, single-concept (replenishment predicts demand per concept; a
    request naming exactly the concept it's filling keeps buffer accounting 1:1 with what gets
    generated — multi-concept composition is left to the model's own judgement within the
    `required_patterns`/`forbidden_patterns` the prompt already supports, not orchestrated here)."""
    band_mid = float(cell.band + BAND_WIDTH / 2)
    return GenerationRequest(
        concepts=[GenerationConceptWeight(id=cell.concept_id, weight=1.0)],
        target_rating=band_mid,
        rating_tolerance=BAND_WIDTH / 2,
        expected_minutes=DEFAULT_EXPECTED_MINUTES,
        target_complexity=None,
        required_patterns=[],
        forbidden_patterns=[],
        similarity_exclusions=_recent_titles(cell.concept_id),
        comparator_hint=None,
        allow_types=["int", "float", "bool", "str", "list"],
        prompt_version=PROMPT_VERSION,
    )


@dataclass
class ReplenishResult:
    user_id: str
    cells_considered: int
    cells_below_watermark: int
    jobs_enqueued: list[str]
    jobs_skipped: list[str]
    correlation_id: str | None = None


def replenish_once(
    user_id: str | None = None,
    *,
    settings: Settings | None = None,
    max_enqueue_per_pass: int = DEFAULT_MAX_ENQUEUE_PER_PASS,
    correlation_id: str | None = None,
) -> ReplenishResult:
    """One replenishment pass for `user_id` (default: `SINGLE_USER_ID`, CONTRACTS.md §1).

    For every predicted cell (`compute_demand`), counts approved-and-unattempted inventory; if
    it's below `BUFFER_LOW_WATERMARK`, enqueues `generate` jobs (lowest queue priority — the
    default `generate` priority from `JOB_PRIORITY`, CONTRACTS.md §4.4) for the missing slots,
    using `idempotency_key = generate:<concept>:<band>:<slot>` (CONTRACTS.md §4.4's exact format)
    — `enqueue`'s `on conflict (idempotency_key) do nothing` (CONTRACTS.md §5) is what makes a
    repeated pass over an already-covered slot a no-op, so restarts (or back-to-back ticks before
    a prior job has resolved) don't pile up duplicate generate jobs for the same slot.

    `slot` is NOT a fixed `0..watermark-1` range recomputed fresh each pass — it starts from
    `_existing_attempt_count(cell)`, the number of `generate` attempts EVER made for this cell
    (any outcome). A fixed range would plateau the buffer below watermark forever once every slot
    in it happened to be consumed by a `rejected` (not `approved`) problem version: `rejected`
    still leaves the job row in place, `on conflict` still no-ops every future attempt at that
    same key, and a fixed range has nowhere else to go. Starting from the all-time attempt count
    means every pass's new attempts get slot numbers nothing has ever used, so a string of
    rejections thins the pass rate but never blocks progress outright — confirmed as the
    mechanism behind a real plateau (QA-PLAN.md §2.11).

    Never enqueues more than `max_enqueue_per_pass` jobs in one call: once that many slots have
    been attempted (successful or not — an `on conflict` no-op still costs a statement), every
    remaining candidate slot across every remaining cell is recorded in `jobs_skipped` and
    logged, rather than silently dropped.
    """
    s = settings or get_settings()
    uid = user_id or s.SINGLE_USER_ID
    watermark = s.BUFFER_LOW_WATERMARK

    cells = compute_demand(uid, settings=s)
    pool = get_pool()
    queue = Queue(pool)

    enqueued: list[str] = []
    skipped: list[str] = []
    cells_below_watermark = 0
    attempted = 0

    for cell in cells:
        covered = _approved_unattempted_count(uid, cell.concept_id, cell.band)
        if covered >= watermark:
            continue
        cells_below_watermark += 1
        deficit = watermark - covered
        slot_offset = _existing_attempt_count(cell)

        request: GenerationRequest | None = None
        for i in range(deficit):
            slot = slot_offset + i
            idempotency_key = f"{cell.idempotency_prefix}{slot}"
            if attempted >= max_enqueue_per_pass:
                skipped.append(idempotency_key)
                continue
            attempted += 1
            if request is None:
                request = _build_generation_request(cell)
            job = queue.enqueue(
                pool,
                "generate",
                {"request": request.model_dump(mode="json"), "correlation_id": correlation_id},
                idempotency_key=idempotency_key,
                correlation_id=correlation_id,
            )
            if job is not None:
                enqueued.append(idempotency_key)
                log.info(
                    "replenish: enqueued generate job",
                    concept_id=cell.concept_id,
                    band=cell.band,
                    slot=slot,
                    reasons=list(cell.reasons),
                    idempotency_key=idempotency_key,
                    job_id=job.id,
                )
            # job is None => idempotency-key collision, i.e. this slot is already covered by an
            # in-flight (or already-terminal, see the docstring's known-limitation note) job —
            # not a "skip due to cap", a normal idempotent no-op.

    if skipped:
        log.warning(
            "replenish: per-pass enqueue cap reached; remaining slots skipped this pass",
            user_id=uid,
            cap=max_enqueue_per_pass,
            skipped_count=len(skipped),
            skipped_keys=skipped[:50],
        )

    log.info(
        "replenish pass complete",
        user_id=uid,
        cells_considered=len(cells),
        cells_below_watermark=cells_below_watermark,
        enqueued=len(enqueued),
        skipped=len(skipped),
    )

    return ReplenishResult(
        user_id=uid,
        cells_considered=len(cells),
        cells_below_watermark=cells_below_watermark,
        jobs_enqueued=enqueued,
        jobs_skipped=skipped,
        correlation_id=correlation_id,
    )


def buffer_report(
    user_id: str | None = None, *, settings: Settings | None = None
) -> list[dict[str, Any]]:
    """Per-cell buffer depth snapshot, read-only (no enqueueing) — feeds `/api/system/stats`
    (CONTRACTS.md §9: "buffer depth per band")."""
    s = settings or get_settings()
    uid = user_id or s.SINGLE_USER_ID
    cells = compute_demand(uid, settings=s)
    report: list[dict[str, Any]] = []
    for cell in cells:
        depth = _approved_unattempted_count(uid, cell.concept_id, cell.band)
        report.append(
            {
                "concept_id": cell.concept_id,
                "band": cell.band,
                "reasons": list(cell.reasons),
                "rating": cell.rating,
                "uncertainty": cell.uncertainty,
                "depth": depth,
                "watermark": s.BUFFER_LOW_WATERMARK,
                "below_watermark": depth < s.BUFFER_LOW_WATERMARK,
            }
        )
    return report


def run_replenish_loop(
    *,
    settings: Settings | None = None,
    stop_event: threading.Event | None = None,
    user_id: str | None = None,
) -> None:
    """Ticks `replenish_once` every `REPLENISH_INTERVAL_MS` (CONTRACTS.md §2) until `stop_event`
    is set. Runs an initial pass immediately on entry (there is no reason to wait a full interval
    before the first fill on process start). A single tick's exception is logged and swallowed —
    one bad pass (e.g. a transient DB hiccup) should not kill the whole background loop."""
    s = settings or get_settings()
    stop = stop_event if stop_event is not None else threading.Event()
    interval_s = s.REPLENISH_INTERVAL_MS / 1000

    while not stop.is_set():
        try:
            replenish_once(user_id, settings=s)
        except Exception:
            log.exception("replenish loop: tick failed")
        stop.wait(interval_s)
