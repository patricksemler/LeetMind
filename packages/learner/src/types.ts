/**
 * Types for `@leetmind/learner`.
 *
 * `Verdict`, `HintLevel`, and `HINT_PENALTY_CAPS` are imported for real from `@leetmind/shared`
 * (its `src/index.ts` now exports them with field names/enum values matching CONTRACTS.md
 * §4.3/§8 exactly) — no reason to duplicate plain enums/consts.
 *
 * `ConceptState` here is DELIBERATELY a local, minimal structural type rather than
 * `z.infer<typeof ConceptStateSchema>` from `@leetmind/shared`. `ConceptStateSchema` is the full
 * `user_concept_state` DB row (user_id, attempts, solves, streaks, hint/error count maps,
 * updated_at, ...); this package's pure functions only ever read/write the rating/uncertainty/
 * review fields below. Keeping the local type to exactly that (interface segregation) means:
 *   (a) any real `ConceptState` row from `@leetmind/shared` satisfies this interface structurally
 *       and can be passed in as-is (extra fields are simply ignored), so callers pay no adapter
 *       cost, and
 *   (b) test fixtures and other pure callers aren't forced to fabricate DB bookkeeping fields
 *       (attempts, solves, hint_counts, ...) that have nothing to do with the math being tested.
 * `last_practiced_at`/`next_review_at` accept `string | Date` (shared's `ConceptState` types them
 * as a union since they round-trip through JSON/pg) — `src/review.ts` and `src/select.ts`
 * normalize with `new Date(...)` before use.
 */

import type { HintLevel, Verdict } from "@leetmind/shared";
import { HINT_PENALTY_CAPS } from "@leetmind/shared";

export type { Verdict, HintLevel };
export { HINT_PENALTY_CAPS };

/**
 * Structural mirror of the rating/review-relevant fields of `user_concept_state`
 * (CONTRACTS.md §3). See the file-level doc comment for why this is a deliberate subset of
 * `@leetmind/shared`'s full `ConceptState`, not that type itself.
 */
export interface ConceptState {
  concept_id: string;
  rating: number;
  uncertainty: number;
  last_practiced_at?: string | Date | null;
  next_review_at?: string | Date | null;
  review_interval_days: number;
  review_ease: number;
  review_reps: number;
}

/** A concept weight as attached to a problem (CONTRACTS.md §4.2 `ProblemVersion.concepts`). */
export interface ConceptWeight {
  id: string;
  weight: number;
}

/** One concept's before/after ledger entry, returned by `updateConcepts`. */
export interface ConceptChange {
  concept_id: string;
  before_rating: number;
  after_rating: number;
  before_uncertainty: number;
  after_uncertainty: number;
  delta: number;
  k: number;
  weight: number;
}

/** Minimal structural shape of a candidate problem, as needed by `src/select.ts`. */
export interface CandidateProblem {
  problem_version_id: string;
  difficulty_rating: number;
  concepts: ConceptWeight[];
}
