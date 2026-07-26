import { describe, expect, it } from "vitest";
import {
  planFollowUps,
  REINFORCE_RATING_DROP,
  shouldTeach,
  TEACHING_FAILURE_STREAK,
  TRANSFER_DELAY_DAYS,
  type TeachingAttempt,
} from "./teaching.js";

function attempt(over: Partial<TeachingAttempt> = {}): TeachingAttempt {
  return { concept_id: "sliding_window", solved: false, usedEditorial: false, ...over };
}

describe("shouldTeach", () => {
  it("does not teach on a first failure — one bad problem is not a pattern", () => {
    expect(shouldTeach([attempt()]).teach).toBe(false);
  });

  it("teaches after two consecutive non-solves", () => {
    const decision = shouldTeach([attempt(), attempt()]);
    expect(decision.teach).toBe(true);
    expect(decision.trigger).toBe("consecutive_failures");
    expect(decision.reason).toContain("sliding_window");
  });

  it("teaches immediately when the editorial was revealed, without waiting for a second failure", () => {
    const decision = shouldTeach([attempt({ usedEditorial: true })]);
    expect(decision.teach).toBe(true);
    expect(decision.trigger).toBe("editorial_revealed");
  });

  it("teaches on an editorial reveal even though that attempt was ultimately solved", () => {
    // Solving after reading the full solution is not evidence of knowing the concept, so the
    // reveal — not the verdict — is what decides.
    const decision = shouldTeach([attempt({ solved: true, usedEditorial: true })]);
    expect(decision.teach).toBe(true);
    expect(decision.trigger).toBe("editorial_revealed");
  });

  it("does not teach when the streak is broken by a solve", () => {
    expect(shouldTeach([attempt({ solved: true }), attempt(), attempt()]).teach).toBe(false);
  });

  it("only looks at the most recent TEACHING_FAILURE_STREAK attempts", () => {
    const ancient = Array.from({ length: 5 }, () => attempt());
    expect(shouldTeach([attempt({ solved: true }), ...ancient]).teach).toBe(false);
    expect(TEACHING_FAILURE_STREAK).toBe(2);
  });

  it("does not teach on an empty history", () => {
    expect(shouldTeach([]).teach).toBe(false);
  });
});

describe("planFollowUps", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");
  const plans = planFollowUps({ conceptId: "sliding_window", originRating: 1400, now });

  it("plans exactly one reinforce and one transfer", () => {
    expect(plans.map((p) => p.kind)).toEqual(["reinforce", "transfer"]);
  });

  it("makes the reinforce easier, immediate, and the same shape", () => {
    const reinforce = plans[0]!;
    expect(reinforce.target_rating).toBe(1400 - REINFORCE_RATING_DROP);
    expect(reinforce.due_at.getTime()).toBe(now.getTime());
    expect(reinforce.shape_match).toBe("same");
  });

  it("makes the transfer same-difficulty, delayed, and a different shape", () => {
    const transfer = plans[1]!;
    expect(transfer.target_rating).toBe(1400);
    expect(transfer.shape_match).toBe("different");
    const expectedDue = now.getTime() + TRANSFER_DELAY_DAYS * 24 * 60 * 60 * 1000;
    expect(transfer.due_at.getTime()).toBe(expectedDue);
  });

  it("plans the transfer up front, so dropping the reinforce cannot skip it", () => {
    // The transfer is the half that measures whether teaching worked. Scheduling it only once the
    // reinforce resolved would let a user who abandoned the reinforce silently never be retested.
    expect(plans.some((p) => p.kind === "transfer")).toBe(true);
  });

  it("carries the concept onto both follow-ups", () => {
    expect(plans.every((p) => p.concept_id === "sliding_window")).toBe(true);
  });
});
