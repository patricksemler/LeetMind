/**
 * Teaching mode and its follow-ups. Pure: no I/O, no clock reads except the injected `now`.
 *
 * The problem this solves: when someone is stuck on a concept, serving them another problem of the
 * same difficulty is the one response guaranteed not to help. The rating model handles it
 * correctly on its own terms — two failures drop the rating, the next problem is easier — but
 * "easier" is not "taught". Someone who has never seen the sliding-window invariant does not need
 * a smaller sliding-window problem; they need to be shown the technique once.
 *
 * So teaching mode stops asking and starts showing: the hint ladder opens all the way to the
 * editorial, and the user types the reference solution out themselves before moving on. Typing it
 * is the point. Reading a solution produces the feeling of understanding without the motor
 * memory or the encounter with the details — the off-by-one in the loop bound, the order of the
 * two pointer moves — that writing it forces you through.
 *
 * Then two follow-ups, because transcription on its own proves nothing:
 *
 *   reinforce — immediately, an easier problem of the **same shape**. This is where they apply
 *               what they just typed, while it is still in working memory. Deliberately below the
 *               revealed problem's rating: the goal is a win that consolidates, not a retest.
 *   transfer  — days later, a similar-rated problem of a **different shape** on the same concept.
 *               This is the one that actually measures whether anything was learned. Same-shape
 *               reinforce can be passed by pattern-matching against the solution you just copied;
 *               different-shape, days later, cannot.
 *
 * The pairing matters more than either half. Reinforce alone teaches recall of one solution.
 * Transfer alone, with nothing in between, is just another failure a week later.
 */

/** One resolved attempt, as `shouldTeach` needs to see it. */
export interface TeachingAttempt {
  concept_id: string;
  /** The judge returned `accepted`. */
  solved: boolean;
  /** The editorial was revealed (via give-up) during this attempt. */
  usedEditorial: boolean;
}

export type TeachingTrigger = "editorial_revealed" | "consecutive_failures";

export interface TeachingDecision {
  teach: boolean;
  trigger: TeachingTrigger | null;
  /** Addressed to the learner — this is shown, not logged. */
  reason: string;
}

/** Consecutive non-solves on one concept before teaching mode takes over. Two, not three: three
 * failures in a row on the same concept is long past the point where another problem helps. */
export const TEACHING_FAILURE_STREAK = 2;

/**
 * Whether the next problem on this concept should be taught rather than tested.
 *
 * `recent` is this concept's resolved attempts, **newest first**. Only the most recent few matter;
 * the caller need not pass more than a handful.
 */
export function shouldTeach(recent: TeachingAttempt[]): TeachingDecision {
  const last = recent[0];

  // Reading the editorial is itself the trigger — there is no reason to wait for a second failure
  // once someone has already been handed the answer. This is also the path give-up takes, so
  // "I give up" leads into being taught rather than into an identical problem.
  if (last?.usedEditorial) {
    return {
      teach: true,
      trigger: "editorial_revealed",
      reason: "You needed the full solution for that one — let's work through it properly.",
    };
  }

  const streak = recent.slice(0, TEACHING_FAILURE_STREAK);
  if (streak.length === TEACHING_FAILURE_STREAK && streak.every((a) => !a.solved)) {
    return {
      teach: true,
      trigger: "consecutive_failures",
      reason: `That's ${TEACHING_FAILURE_STREAK} in a row on ${streak[0]!.concept_id} — another problem at this level won't help. Let's go through one together.`,
    };
  }

  return { teach: false, trigger: null, reason: "" };
}

// --- follow-ups ---------------------------------------------------------------------------------

export type FollowUpKind = "reinforce" | "transfer";

/** How far below the taught problem the reinforce problem sits. Large enough that the win is
 * genuinely likely — a reinforce problem they also fail teaches the opposite lesson. */
export const REINFORCE_RATING_DROP = 150;

/** Days before the transfer problem comes due. Long enough that recall of the specific solution
 * has faded and only the concept remains, short enough to still be actionable. */
export const TRANSFER_DELAY_DAYS = 3;

export interface FollowUpPlan {
  kind: FollowUpKind;
  concept_id: string;
  target_rating: number;
  /** When this follow-up becomes eligible to be served. */
  due_at: Date;
  /** `same` — must match the origin problem's shape; `different` — must not. See the module
   * doc comment for why the pair needs one of each. */
  shape_match: "same" | "different";
  /** Persisted and shown when the follow-up is served, so the user knows why they got it. */
  rationale: string;
}

/**
 * The two follow-ups owed after a teaching episode on `origin_rating`-rated problem.
 *
 * Both are planned at once, at the moment of the reveal, rather than the transfer being scheduled
 * later when the reinforce resolves. If it were deferred, a user who abandoned the reinforce would
 * silently never get the transfer — and the transfer is the half that measures learning, so it is
 * exactly the half that must not be skippable by dropping off.
 */
export function planFollowUps(input: {
  conceptId: string;
  originRating: number;
  now: Date;
}): FollowUpPlan[] {
  const { conceptId, originRating, now } = input;

  const transferDue = new Date(now.getTime() + TRANSFER_DELAY_DAYS * 24 * 60 * 60 * 1000);

  return [
    {
      kind: "reinforce",
      concept_id: conceptId,
      target_rating: Math.round(originRating - REINFORCE_RATING_DROP),
      due_at: now,
      shape_match: "same",
      rationale:
        "Same idea as the one you just worked through, a step easier — write it yourself this time.",
    },
    {
      kind: "transfer",
      concept_id: conceptId,
      target_rating: Math.round(originRating),
      due_at: transferDue,
      shape_match: "different",
      rationale:
        "Same concept as the one you were taught, in a form you haven't seen — this is the one that shows it stuck.",
    },
  ];
}
