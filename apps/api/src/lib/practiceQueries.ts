// DB-coupled helpers for the practice loop (routes/practice.ts): everything here talks to the
// database, in contrast to the pure selection helpers in ./practiceSelection.ts.
import { query, withTransaction } from "@leetmind/db";
import { GenerationRequestSchema } from "@leetmind/shared";
import { COLD_START_PROBLEM_COUNT, type ColdStartHistoryEntry } from "@leetmind/learner";
import type { Deps } from "../deps.js";
import { bandOf } from "./practiceSelection.js";

/** Must track content/leetmind_content/generation/prompts/v1.py's `PROMPT_VERSION` — the content
 * plane is a separate Python codebase apps/api may not import, so this is a documented
 * cross-language constant, not a guess. Kept in step with routes/generate.ts. */
const PROMPT_VERSION = "v1";

/** Elevated above the replenishment worker's default `generate` priority (100) but below the
 * manual `/api/generate-now` escape hatch (1): a user actively waiting on this problem should jump
 * ahead of speculative background replenishment. */
export const PRACTICE_GENERATE_PRIORITY = 20;

/**
 * At most one in-flight generation per (user, concept, band) cell.
 *
 * The key deliberately carries a monotonically increasing `slot` rather than being a single fixed
 * string: `enqueue`'s `on conflict (idempotency_key) do nothing` is permanent, so a fixed key would
 * no-op forever the moment its first job finished — the cell could never be generated for again.
 * This mirrors the slot scheme the Python replenishment worker already uses (QA-PLAN.md §2.11
 * documents the plateau a fixed range caused there), and the in-flight check below is what keeps a
 * client polling every two seconds from enqueuing a job per poll.
 */
async function findInFlightGeneration(prefix: string): Promise<{ id: string } | null> {
  const rows = await query<{ id: string }>(
    `select id from jobs
      where kind = 'generate'
        and status in ('queued', 'leased')
        and idempotency_key like $1
      order by created_at desc
      limit 1`,
    [`${prefix}%`],
  );
  return rows[0] ?? null;
}

async function attemptCount(prefix: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `select count(*) as n from jobs where kind = 'generate' and idempotency_key like $1`,
    [`${prefix}%`],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Problem versions this user saw during a baseline, back when baselines existed.
 *
 * The baseline product surface is gone, but its tables are retained as read-only history
 * (migration 007) and a long-lived local install can still hold rows here. A baseline skip wrote no
 * submission, so `listApprovedUnattempted` would happily re-offer a problem the user had already
 * marked "I haven't learned this yet" — which is both a bad experience and bad evidence, since the
 * answer to "can you do this?" is already recorded. Cheap to keep, and it costs nothing on a fresh
 * install where the tables are empty.
 */
export async function seenInBaseline(userId: string): Promise<Set<string>> {
  const rows = await query<{ problem_version_id: string }>(
    `select bi.problem_version_id
       from baseline_items bi
       join baseline_sessions bs on bs.id = bi.baseline_session_id
      where bs.user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.problem_version_id));
}

/** Recent titles for this concept, fed back as `similarity_exclusions` so generation doesn't
 * repeat content the user has just seen. Same signal the replenishment worker uses. */
export async function recentTitles(conceptId: string, limit = 10): Promise<string[]> {
  const rows = await query<{ title: string }>(
    `select pv.title
       from problem_versions pv
       join problem_concepts pc on pc.problem_version_id = pv.id
      where pc.concept_id = $1
        and pv.state in ('candidate', 'verifying', 'approved')
      order by pv.created_at desc
      limit $2`,
    [conceptId, limit],
  );
  return rows.map((r) => r.title);
}

/**
 * This user's resolved attempts so far, oldest first, in the shape `nextColdStartStep` wants.
 *
 * Derived from `learning_events` rather than persisted as a cold-start session, which is what lets
 * the cold start have no product surface at all: there is no row to create on first visit, nothing
 * to resume, and nothing left dangling if the user closes the tab three problems in. The phase is
 * simply "this user has fewer than N learning events", which is true or false on every request
 * without anything having been set up.
 */
export async function coldStartHistory(userId: string): Promise<ColdStartHistoryEntry[]> {
  // The primary concept comes from a scalar subquery rather than a join, for two reasons. A join
  // would DROP any event whose problem has since been retired or lost its concept rows — leaving
  // that user permanently in the cold start, being handed calibration problems forever. And a join
  // would DOUBLE-count an event if a problem ever carried two primary concepts (the content schema
  // forbids it; the table does not).
  const rows = await query<{ concept_id: string | null; kind: string; outcome: number }>(
    `select (select pc.concept_id
               from problem_concepts pc
              where pc.problem_version_id = le.problem_version_id
                and pc.role = 'primary'
              limit 1) as concept_id,
            le.kind,
            le.outcome
       from learning_events le
      where le.user_id = $1
        and le.kind in ('submission', 'give_up', 'skip')
      order by le.created_at asc
      limit $2`,
    [userId, COLD_START_PROBLEM_COUNT],
  );

  return rows.map((r) => ({
    // An unattributable event still counts toward "how far into the cold start are we" and still
    // moves the difficulty target; it just can't mark a concept as probed. The empty string never
    // matches a real concept id, which is exactly the behaviour wanted.
    concept_id: r.concept_id ?? "",
    outcome:
      r.kind === "submission" && r.outcome > 0.2 ? "solved" : r.kind === "skip" ? "skipped" : "failed",
  }));
}

export interface EnsureGenerationResult {
  jobId: string | null;
  enqueued: boolean;
}

/**
 * Ensures a `generate` job is in flight for this cell, without ever stacking duplicates. Returns
 * the existing job when one is already queued or leased.
 */
export async function ensureGeneration(
  deps: Deps,
  opts: {
    userId: string;
    conceptId: string;
    targetRating: number;
    correlationId?: string;
    priority: number;
  },
): Promise<EnsureGenerationResult> {
  const prefix = `generate:practice:${opts.userId}:${opts.conceptId}:${bandOf(opts.targetRating)}:`;

  const inFlight = await findInFlightGeneration(prefix);
  if (inFlight) return { jobId: inFlight.id, enqueued: false };

  const slot = await attemptCount(prefix);
  const generationRequest = GenerationRequestSchema.parse({
    concepts: [{ id: opts.conceptId, weight: 1 }],
    target_rating: opts.targetRating,
    rating_tolerance: 100,
    expected_minutes: [5, 20],
    required_patterns: [],
    forbidden_patterns: [],
    similarity_exclusions: await recentTitles(opts.conceptId),
    allow_types: [],
    prompt_version: PROMPT_VERSION,
  });

  const job = await withTransaction((client) =>
    deps.queue.enqueue(client, {
      kind: "generate",
      payload: { request: generationRequest, correlation_id: opts.correlationId },
      priority: opts.priority,
      idempotencyKey: `${prefix}${slot}`,
      correlationId: opts.correlationId,
    }),
  );

  // `null` means another request won the race on this exact key between the in-flight check and
  // the insert. Re-read rather than reporting "no generation happening", which would make the
  // client show an error state for a job that is in fact running.
  if (!job) {
    const raced = await findInFlightGeneration(prefix);
    return { jobId: raced?.id ?? null, enqueued: false };
  }
  return { jobId: job.id, enqueued: true };
}
