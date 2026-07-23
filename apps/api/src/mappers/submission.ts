// Safe projection of a `submissions` row for `GET /api/submissions/:id` and the SSE `verdict`
// event. Defence in depth: the judge is expected to already scrub hidden-expected-value preview
// fields for `submit`-mode failures, but this app must never trust that and re-strips them here
// too (docs/CONTRACTS.md §4.5, apps/api brief).
import { getProblemVersion, query, type ConceptRow, type SubmissionFailure, type SubmissionMode, type SubmissionRow } from "@algolift/db";
import { ProblemVersionSchema, type Submission } from "@algolift/shared";
import { hasEarnedReveal } from "./publicProblem.js";

/** Strips `expected_preview`/`input_preview`/`actual_preview` from a failure object when
 * `mode === 'submit'` — CONTRACTS.md §4.5 lists all three as populated "only for `run` mode and
 * for example-derived tests"; `actual_preview` was previously left in place, contra this file's
 * own doc comment above. */
export function sanitizeFailure(failure: SubmissionFailure, mode: SubmissionMode): SubmissionFailure {
  if (mode !== "submit") return failure;
  const { expected_preview: _expectedPreview, input_preview: _inputPreview, actual_preview: _actualPreview, ...rest } = failure;
  return rest;
}

/** Full safe projection of a submission row, ready to serialize as `GET /api/submissions/:id`. */
export function toSafeSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    user_id: row.user_id,
    problem_version_id: row.problem_version_id,
    workout_item_id: row.workout_item_id,
    mode: row.mode,
    language: row.language,
    source: row.source,
    status: row.status,
    verdict: row.verdict,
    passed_tests: row.passed_tests,
    total_tests: row.total_tests,
    runtime_ms: row.runtime_ms,
    memory_kb: row.memory_kb,
    // Cast: `SubmissionFailure` (plain @algolift/db interface) vs. the zod-`.passthrough()`-
    // inferred `Submission['failure']` (which additionally carries an index signature) are
    // structurally identical in every field that matters; only the index signature differs.
    failure: (row.failure ? sanitizeFailure(row.failure, row.mode) : null) as Submission["failure"],
    active_ms: row.active_ms,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

/** The post-solve reveal shape, docs/CONTRACTS.md §4.5. */
export interface Reveal {
  editorial_md: string;
  target_complexity: { time: string; space: string };
  concepts: { id: string; name: string; role: string; weight: number }[];
}

/**
 * Builds `reveal` in exactly ONE place, from an explicit allowlist — never spreads the raw
 * `content` object (docs/CONTRACTS.md §4.5, same discipline as `toPublicProblem`). Returns
 * `undefined` (never partial/empty data) unless `userId` has earned it for this problem version:
 * an accepted `submit` submission, or a recorded give-up (`hasEarnedReveal`, shared with
 * `PublicProblem.concepts_revealed`'s identical rule).
 */
export async function buildReveal(userId: string, problemVersionId: string): Promise<Reveal | undefined> {
  const earned = await hasEarnedReveal(userId, problemVersionId);
  if (!earned) return undefined;

  const versionRow = await getProblemVersion(problemVersionId);
  if (!versionRow) return undefined;
  const content = ProblemVersionSchema.parse(versionRow.content);

  const ids = content.concepts.map((c) => c.id);
  const rows = ids.length > 0 ? await query<ConceptRow>("select id, name from concepts where id = any($1)", [ids]) : [];
  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  return {
    editorial_md: content.hints.editorial_md,
    target_complexity: content.target_complexity,
    concepts: content.concepts.map((c) => ({
      id: c.id,
      name: nameById.get(c.id) ?? c.id,
      role: c.role,
      weight: c.weight,
    })),
  };
}
