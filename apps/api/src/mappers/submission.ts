// Safe projection of a `submissions` row for `GET /api/submissions/:id` and the SSE `verdict`
// event. Defence in depth: the judge is expected to already scrub hidden-expected-value preview
// fields for `submit`-mode failures, but this app must never trust that and re-strips them here
// too (docs/CONTRACTS.md §4.5, apps/api brief).
import { getProblemVersion, query, type ConceptRow, type SubmissionFailure, type SubmissionMode, type SubmissionRow } from "@leetmind/db";
import { ProblemVersionSchema, type Submission } from "@leetmind/shared";
import { hasEarnedReveal } from "./publicProblem.js";

/**
 * Strips `input_preview` / `expected_preview` / `actual_preview` when the failing test is one the
 * user is not allowed to see.
 *
 * CONTRACTS.md §4.5 populates previews "only for `run` mode and for example-derived tests". The
 * second clause matters and this function used to ignore it, blanket-stripping every submit-mode
 * preview: failing public example #2 on a submit told you only "failed test 2", with the values
 * withheld as though they were secret — while sitting in plain text on the same page.
 *
 * The rule is about the TEST, not the mode. `failure.tests` carries the public/hidden split and
 * `selectTests` (apps/judge) always orders public tests first, so an index below `public_total` is
 * a public case and keeps its previews; anything else is hidden and loses them. With no split
 * recorded (older rows, or a failure with no test index at all) this falls back to the old
 * strip-everything-on-submit behaviour, because guessing wrong in that direction leaks.
 *
 * `failing_test` is EXEMPT from that strip and passes through for hidden failures too. That is a
 * deliberate narrowing of §4.5, not an oversight — see `FailingTestSchema` in @leetmind/shared for
 * the reasoning and the bound (one case per submission, never the suite). The `*_preview` strip
 * above still stands: those fields predate `failing_test` and have no such bound.
 */
export function sanitizeFailure(failure: SubmissionFailure, mode: SubmissionMode): SubmissionFailure {
  if (mode !== "submit") return failure;

  const split = (failure as { tests?: { public_total?: number } }).tests;
  const index = failure.first_failing_test_index;
  const isPublicFailure =
    typeof index === "number" && typeof split?.public_total === "number" && index < split.public_total;
  if (isPublicFailure) return failure;

  const { expected_preview: _expectedPreview, input_preview: _inputPreview, actual_preview: _actualPreview, ...rest } = failure;
  return rest;
}

/** Full safe projection of a submission row, ready to serialize as `GET /api/submissions/:id`. */
export function toSafeSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    user_id: row.user_id,
    problem_version_id: row.problem_version_id,
    baseline_item_id: row.baseline_item_id,
    mode: row.mode,
    language: row.language,
    source: row.source,
    status: row.status,
    verdict: row.verdict,
    passed_tests: row.passed_tests,
    total_tests: row.total_tests,
    runtime_ms: row.runtime_ms,
    memory_kb: row.memory_kb,
    // Cast: `SubmissionFailure` (plain @leetmind/db interface) vs. the zod-`.passthrough()`-
    // inferred `Submission['failure']` (which additionally carries an index signature) are
    // structurally identical in every field that matters; only the index signature differs.
    failure: (row.failure ? sanitizeFailure(row.failure, row.mode) : null) as Submission["failure"],
    // No sanitization: `public_results` covers PUBLIC tests only, by construction in the judge
    // (`publicResults` filters on test origin). There is nothing here that isn't already printed
    // on the problem page, plus the user's own output.
    // Cast for the same reason as `failure` above: the zod-`.passthrough()`-inferred type carries
    // an index signature the plain @leetmind/db interface doesn't.
    public_results: row.public_results as Submission["public_results"],
    active_ms: row.active_ms,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

/** The post-solve reveal shape, docs/CONTRACTS.md §4.5. */
export interface Reveal {
  editorial_md: string;
  solutions: { python: string; cpp?: string };
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
    // Named fields, not a spread of `content` — the reference solutions sit next to `hidden_tests`
    // and `mutants_py` in the same object, and only these two may cross the wire.
    solutions: { python: content.reference_solution_py, cpp: content.reference_solution_cpp },
    target_complexity: content.target_complexity,
    concepts: content.concepts.map((c) => ({
      id: c.id,
      name: nameById.get(c.id) ?? c.id,
      role: c.role,
      weight: c.weight,
    })),
  };
}
