import type { Express } from "express";
import { CONCEPTS } from "../fixtures/concepts.js";
import { conceptState, getProblemUserState, learningEvents, problemFixtures, problemsById, submissions } from "../state.js";
import { handle } from "./helpers.js";

export function registerProgressRoutes(app: Express): void {
  // --- GET /api/progress -------------------------------------------------------------------------

  // Mirrors the real `GET /api/progress` shape (apps/api/src/routes/progress.ts) exactly — field
  // names here used to drift from it (`solves_by_difficulty` vs real `solve_bands`, `id` vs real
  // `concept_id`, etc.), which is exactly the class of bug this endpoint's own web consumer
  // (Progress.tsx) was silently broken by (QA-PLAN.md §1.4): everything here shipped green against
  // this mock while rendering "No submissions yet" / duplicate-key errors / "due —" against the
  // real API.
  app.get(
    "/api/progress",
    handle((_req, res) => {
      const now = Date.now();
      const concepts = CONCEPTS.map((c) => {
        const cs = conceptState.get(c.id)!;
        return {
          concept_id: c.id,
          name: c.name,
          rating: Math.round(cs.rating),
          uncertainty: Math.round(cs.uncertainty),
          attempts: cs.attempts,
          solves: cs.solves,
          unassisted_solves: cs.unassisted_solves,
          skips: cs.skips,
          current_streak: cs.current_streak,
          best_streak: cs.best_streak,
          last_practiced_at: cs.last_practiced_at,
          next_review_at: cs.next_review_at,
          trend: cs.solves > cs.attempts / 2 ? "up" : cs.attempts > 0 ? "flat" : "flat",
        };
      });

      const reviewsDue = CONCEPTS.map((c) => {
        const cs = conceptState.get(c.id)!;
        if (!cs.next_review_at) return null;
        const dueAtMs = new Date(cs.next_review_at).getTime();
        if (dueAtMs > now) return null;
        return { concept_id: c.id, days_overdue: (now - dueAtMs) / 86_400_000, state: cs };
      }).filter((r): r is NonNullable<typeof r> => r !== null);

      const submissionRows = [...submissions.values()].filter((s) => s.mode === "submit" && s.row.status === "completed");
      const byBand = new Map<number, { solved_without_hints: number; solved_with_hints: number; attempts: number }>();
      for (const s of submissionRows) {
        const fixture = problemsById.get(s.problemVersionId);
        const band = fixture ? Math.floor(fixture.content.difficulty.rating / 200) * 200 : 0;
        const entry = byBand.get(band) ?? { solved_without_hints: 0, solved_with_hints: 0, attempts: 0 };
        entry.attempts += 1;
        if (s.row.verdict === "accepted") {
          const hinted = getProblemUserState(s.problemVersionId).hintsTaken.length > 0;
          if (hinted) entry.solved_with_hints += 1;
          else entry.solved_without_hints += 1;
        }
        byBand.set(band, entry);
      }
      const solveBands = [...byBand.entries()]
        .sort(([a], [b]) => a - b)
        .map(([band, entry]) => ({ band, ...entry }));

      const activeMsSamples = submissionRows.map((s) => s.activeMs).filter((n) => n > 0).sort((a, b) => a - b);
      const medianActiveMs = activeMsSamples.length
        ? activeMsSamples[Math.floor(activeMsSamples.length / 2)]!
        : 0;

      const errorCounts = new Map<string, number>();
      for (const cs of conceptState.values()) {
        for (const [k, v] of Object.entries(cs.error_counts)) errorCounts.set(k, (errorCounts.get(k) ?? 0) + v);
      }
      const errorCategories = [...errorCounts.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([kind, count]) => ({ kind, count }));

      const highestUnassisted = problemFixtures
        .filter((p) => getProblemUserState(p.problemVersionId).solved && getProblemUserState(p.problemVersionId).hintsTaken.length === 0)
        .sort((a, b) => b.content.difficulty.rating - a.content.difficulty.rating)[0];

      res.json({
        concepts,
        reviews_due: reviewsDue,
        stats: {
          solve_bands: solveBands,
          error_categories: errorCategories,
          median_active_ms: medianActiveMs,
        },
        records: {
          highest_unassisted_difficulty_solved: highestUnassisted?.content.difficulty.rating ?? null,
          best_comparable_time_improvement: null,
        },
        history: [...learningEvents].reverse().slice(0, 20),
      });
    }),
  );

  // --- GET /api/system/stats -----------------------------------------------------------------

  // Mirrors the real `GET /api/system/stats` shape (apps/api/src/routes/system.ts /
  // @leetmind/queue's `Queue.stats()`) — this used to be its own dialect entirely
  // (`queue.depth`/`by_kind`/`wait_p50_ms`, flat `verdicts`/`buffer_depth`/`generation_pass_rate`
  // maps, a single `model_runs` object) and every one of those shapes rendered garbage against the
  // real API (QA-PLAN.md §1.5): "0 / 0 / 0 ms", literal "window × 0" badges, "0% / by_stage".
  app.get(
    "/api/system/stats",
    handle((_req, res) => {
      const jitter = () => Math.round(Math.random() * 3);
      const verdictCounts = new Map<string, number>();
      for (const s of submissions.values()) {
        if (s.row.verdict) verdictCounts.set(s.row.verdict, (verdictCounts.get(s.row.verdict) ?? 0) + 1);
      }

      const bufferByBand = new Map<string, { concept_id: string; band: number; count: number }>();
      for (const p of problemFixtures) {
        const conceptId = p.content.concepts[0]!.id;
        const band = Math.floor(p.content.difficulty.rating / 200) * 200;
        const key = `${conceptId}:${band}`;
        const entry = bufferByBand.get(key) ?? { concept_id: conceptId, band, count: 0 };
        entry.count += 1;
        bufferByBand.set(key, entry);
      }

      res.json({
        queue: {
          kinds: [
            { kind: "judge", counts: { queued: jitter() }, oldest_queued_age_ms: jitter() * 1000 },
            { kind: "verify", counts: { queued: jitter() }, oldest_queued_age_ms: jitter() * 1000 },
            { kind: "generate", counts: { queued: jitter() }, oldest_queued_age_ms: jitter() * 1000 },
          ],
          wait_time_ms: { p50: 120 + jitter() * 10, p95: 480 + jitter() * 20 },
          dead_count: 0,
          recent_dead: [],
          lease_recovery: { recovered: 0, redead: 0 },
        },
        workers: [
          { worker_id: "judge-mock-1", kind: "judge", last_seen_at: new Date().toISOString(), stale: false },
          { worker_id: "content-mock-1", kind: "content", last_seen_at: new Date(Date.now() - 4000).toISOString(), stale: false },
        ],
        verdicts: { window: "24h", counts: [...verdictCounts.entries()].map(([verdict, count]) => ({ verdict, count })) },
        buffer_depth: { by_concept_band: [...bufferByBand.values()] },
        generation_pass_rate: {
          by_stage: [
            { stage: "schema", passed: 94, total: 100 },
            { stage: "compile", passed: 91, total: 100 },
            { stage: "differential", passed: 83, total: 100 },
            { stage: "boundary", passed: 78, total: 100 },
            { stage: "examples", passed: 98, total: 100 },
            { stage: "mutation", passed: 71, total: 100 },
          ],
        },
        model_runs: [{ kind: "generate", invoker: "claude", runs: 12, avg_duration_ms: 8200, avg_cost_usd: 0.043, total_cost_usd: 0.516 }],
        dead_jobs: [],
      });
    }),
  );
}
