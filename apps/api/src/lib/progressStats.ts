// Pure post-processing for `GET /api/progress` (routes/progress.ts). No I/O here — both functions
// are plain transforms of rows the route already fetched with SQL, split out so the shaping logic
// is testable without a database.

interface ComparableTimeRow {
  submission_id: string;
  problem_version_id: string;
  difficulty_rating: number;
  active_ms: number;
  prior_avg_active_ms: number | null;
}

interface BestImprovement {
  submission_id: string;
  problem_version_id: string;
  improvement_ms: number;
}

interface ConceptTrendRow {
  concept_id: string;
  recent_delta: number | null;
  event_count: number;
}

/**
 * "Best comparable-time improvement": among accepted submissions with a recorded active_ms, the
 * biggest drop versus the running average active_ms of prior accepted submissions in the same
 * 200-wide difficulty band.
 */
export function bestComparableTimeImprovement(rows: ComparableTimeRow[]): BestImprovement | null {
  let bestImprovement: BestImprovement | null = null;
  for (const row of rows) {
    if (row.prior_avg_active_ms === null) continue;
    const improvementMs = row.prior_avg_active_ms - row.active_ms;
    if (!bestImprovement || improvementMs > bestImprovement.improvement_ms) {
      bestImprovement = {
        submission_id: row.submission_id,
        problem_version_id: row.problem_version_id,
        improvement_ms: improvementMs,
      };
    }
  }
  return bestImprovement;
}

/** Merges each concept's row with its recent-trend row (if any), classifying the trend direction. */
export function mergeConceptTrends<T extends { concept_id: string }>(
  conceptRows: T[],
  trendRows: ConceptTrendRow[],
): (T & { trend: "up" | "down" | "flat"; trend_delta: number; trend_event_count: number })[] {
  const trendByConceptId = new Map(trendRows.map((r) => [r.concept_id, r]));
  return conceptRows.map((row) => {
    const trend = trendByConceptId.get(row.concept_id);
    const delta = trend?.recent_delta ?? 0;
    return {
      ...row,
      trend: delta > 5 ? "up" : delta < -5 ? "down" : "flat",
      trend_delta: delta,
      trend_event_count: trend?.event_count ?? 0,
    };
  });
}
