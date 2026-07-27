// GET /api/progress — "metrics as SQL over existing tables" (docs/CONTRACTS.md decision, PLAN.md
// §8 "Progress"). Every figure here is computed with plain SQL against tables @leetmind/db
// already owns, plus `reviewsDue` from @leetmind/learner reused as instructed rather than
// reimplemented.
import type { FastifyInstance } from "fastify";
import { listConceptStates, listLearningEvents, query, queryOne } from "@leetmind/db";
import { reviewsDue, type ConceptState } from "@leetmind/learner";
import type { Deps } from "../deps.js";
import { bestComparableTimeImprovement, mergeConceptTrends } from "../lib/progressStats.js";

interface ConceptTrendRow {
  concept_id: string;
  recent_delta: number | null;
  event_count: number;
}

interface SolveBandRow {
  band: number;
  solved_without_hints: number;
  solved_with_hints: number;
  attempts: number;
}

interface ErrorCategoryRow {
  kind: string;
  count: number;
}

export function registerProgressRoutes(fastify: FastifyInstance, _deps: Deps): void {
  fastify.get("/api/progress", async (request, reply) => {
    const userId = request.userId;
    const [conceptRows, trendRows, solveBandRows, errorRows, medianRow, bestUnassistedRow, historyRows] =
      await Promise.all([
        query<{
          concept_id: string;
          name: string;
          rating: number;
          uncertainty: number;
          attempts: number;
          solves: number;
          unassisted_solves: number;
          skips: number;
          current_streak: number;
          best_streak: number;
          last_practiced_at: Date | null;
          next_review_at: Date | null;
          mastered_at: Date | null;
        }>(
          `select c.id as concept_id, c.name, ucs.rating, ucs.uncertainty, ucs.attempts, ucs.solves,
                  ucs.unassisted_solves, ucs.skips, ucs.current_streak, ucs.best_streak,
                  ucs.last_practiced_at, ucs.next_review_at, ucs.mastered_at
             from concepts c
             join user_concept_state ucs on ucs.concept_id = c.id and ucs.user_id = $1
            order by c.sort_order asc`,
          [userId],
        ),
        // Trend: sum of per-concept rating deltas across this user's last 200 learning_events
        // (evidence.changes[] is the array `updateConcepts` returned at write time).
        query<ConceptTrendRow>(
          `select ch->>'concept_id' as concept_id,
                  sum((ch->>'delta')::float) as recent_delta,
                  count(*)::int as event_count
             from (select * from learning_events where user_id = $1 order by created_at desc limit 200) le
             cross join lateral jsonb_array_elements(coalesce(le.evidence->'changes', '[]'::jsonb)) as ch
            group by ch->>'concept_id'`,
          [userId],
        ),
        query<SolveBandRow>(
          `select (floor(pv.difficulty_rating / 200.0) * 200)::int as band,
                  count(*) filter (
                    where s.verdict = 'accepted'
                      and not exists (
                        select 1 from hint_events he
                         where he.user_id = s.user_id and he.problem_version_id = s.problem_version_id
                      )
                  )::int as solved_without_hints,
                  count(*) filter (
                    where s.verdict = 'accepted'
                      and exists (
                        select 1 from hint_events he
                         where he.user_id = s.user_id and he.problem_version_id = s.problem_version_id
                      )
                  )::int as solved_with_hints,
                  count(*)::int as attempts
             from submissions s
             join problem_versions pv on pv.id = s.problem_version_id
            where s.user_id = $1 and s.mode = 'submit'
            group by band
            order by band`,
          [userId],
        ),
        query<ErrorCategoryRow>(
          `select failure->>'kind' as kind, count(*)::int as count
             from submissions
            where user_id = $1 and failure is not null and failure->>'kind' is not null
            group by failure->>'kind'
            order by count desc`,
          [userId],
        ),
        queryOne<{ median_active_ms: number | null }>(
          `select percentile_cont(0.5) within group (order by active_ms) as median_active_ms
             from submissions
            where user_id = $1 and mode = 'submit' and active_ms is not null`,
          [userId],
        ),
        queryOne<{ max_rating: number | null }>(
          `select max(pv.difficulty_rating) as max_rating
             from submissions s
             join problem_versions pv on pv.id = s.problem_version_id
            where s.user_id = $1 and s.verdict = 'accepted'
              and not exists (
                select 1 from hint_events he
                 where he.user_id = s.user_id and he.problem_version_id = s.problem_version_id
              )`,
          [userId],
        ),
        // Recent workout history: real `workouts` rows are M3. Until then, recent learning_events
        // (append-only, already the "what happened and when" ledger) is the closest honest proxy.
        listLearningEvents(userId, 20),
      ]);

    // "Best comparable-time improvement": among accepted submissions with a recorded active_ms,
    // the biggest drop versus the running average active_ms of prior accepted submissions in the
    // same 200-wide difficulty band.
    const comparableTimeRows = await query<{
      submission_id: string;
      problem_version_id: string;
      difficulty_rating: number;
      active_ms: number;
      prior_avg_active_ms: number | null;
    }>(
      `select s.id as submission_id, s.problem_version_id, pv.difficulty_rating, s.active_ms,
              avg(s.active_ms) over (
                partition by (floor(pv.difficulty_rating / 200.0) * 200)::int
                order by s.completed_at
                rows between unbounded preceding and 1 preceding
              ) as prior_avg_active_ms
         from submissions s
         join problem_versions pv on pv.id = s.problem_version_id
        where s.user_id = $1 and s.verdict = 'accepted' and s.active_ms is not null
        order by s.completed_at asc`,
      [userId],
    );

    const bestImprovement = bestComparableTimeImprovement(comparableTimeRows);

    const concepts = mergeConceptTrends(conceptRows, trendRows);

    // Reuse the learner's pure `reviewsDue` rather than reimplementing the SM-2 due-check in SQL.
    const stateForReview = await listConceptStates(userId);
    const stateMap: Record<string, ConceptState> = {};
    for (const s of stateForReview) stateMap[s.concept_id] = s;
    const due = reviewsDue(stateMap, new Date());

    reply.send({
      concepts,
      reviews_due: due,
      stats: {
        solve_bands: solveBandRows,
        error_categories: errorRows,
        median_active_ms: medianRow?.median_active_ms ?? null,
      },
      records: {
        highest_unassisted_difficulty_solved: bestUnassistedRow?.max_rating ?? null,
        best_comparable_time_improvement: bestImprovement,
      },
      history: historyRows,
    });
  });
}
