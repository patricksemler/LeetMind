import { z } from "zod";
import { HintLevel } from "./concepts.js";
import { SolutionsSchema } from "./submission.js";

// Hints DTOs — POST /api/hints and GET /api/hints/:versionId. Split out of submission.ts; see
// submission.ts for the actual submission-domain vocabulary. NOTE: TeachingModeSchema is NOT
// here — it stays in submission.ts. See the comment above its declaration there for why (it
// would otherwise create a submission.ts <-> hints.ts import cycle).

// --- POST /api/hints -----------------------------------------------------------------------

export const TakeHintRequest = z.object({
  problem_version_id: z.string(),
  level: HintLevel,
});
export type TakeHintRequest = z.infer<typeof TakeHintRequest>;

export const TakeHintResponse = z.object({
  level: HintLevel,
  text: z.string(),
  penalty_cap: z.number(),
  next_level_penalty: z.number().nullable(),
});
export type TakeHintResponse = z.infer<typeof TakeHintResponse>;

// --- GET /api/hints/:versionId ---------------------------------------------------------------

/**
 * `texts` carries the text of the ladder rungs already in `taken`, so a client that is only
 * re-displaying hints it has already paid for doesn't have to re-POST `/api/hints` once per rung to
 * get it back. That reconstruction was what made a revisited problem render its taken hints a beat
 * after everything else, and it put N writes on the wire for a read.
 *
 * Only the four ladder rungs ever appear in `texts` — never `editorial`. The editorial reaches the
 * client through `editorial_md`/`solutions` below, and *only* once it has genuinely been revealed
 * (give-up, or practice opening a teaching episode). The hard rule that un-taken hint text never
 * appears in a payload is unchanged: both fields are null until `taken` contains `editorial`.
 */
export const GetHintsResponse = z
  .object({
    taken: z.array(HintLevel),
    available: z.array(HintLevel),
    penalties: z.record(z.string(), z.number()).default({}),
    texts: z.record(z.string(), z.string()).default({}),
    /** Non-null only once `taken` includes `editorial`. Serving it here (and not solely in the
     * give-up response body) is what lets a reload mid-teaching-episode still show the user the
     * solution they have been asked to transcribe. */
    editorial_md: z.string().nullable().default(null),
    solutions: SolutionsSchema.nullable().default(null),
    /** Whether an accepted `transcribe` submission exists for this problem. Server-authoritative:
     * the client uses it to decide whether the write-it-out step is still owed, so a reload cannot
     * skip past it. */
    transcribed: z.boolean().default(false),
  })
  .passthrough();
export type GetHintsResponse = z.infer<typeof GetHintsResponse>;
