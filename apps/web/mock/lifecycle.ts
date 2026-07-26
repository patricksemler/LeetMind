/**
 * Drives a created submission through the same state machine the real judge/API pair would
 * (docs/CONTRACTS.md §4.5): queued → assigned → [compiling] → running → progress* → verdict →
 * (submit-mode only) mastery. Mutates the submission row in `state.ts` as it goes so
 * `GET /api/submissions/:id` is always consistent with the last event published, and updates
 * concept mastery using the local `mastery.ts` reimplementation of CONTRACTS §8.
 */
import type { SubmissionStatus } from "@leetmind/shared";
import {
  bumpSubmissionCount,
  conceptState,
  getProblemUserState,
  learningEvents,
  problemsById,
  submissions,
} from "./state.js";
import { outcomeScore, scheduleReview, updateConcepts } from "./mastery.js";
import { buildMockReveal } from "./reveal.js";
import { publish } from "./sse.js";
import { gradeRun, gradeSubmit } from "./verdict.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(submissionId: string, status: SubmissionStatus): void {
  const sub = submissions.get(submissionId);
  if (!sub) return;
  sub.row.status = status;
  publish(submissionId, "status", { submission_id: submissionId, status, at: new Date().toISOString() });
}

export async function runLifecycle(submissionId: string): Promise<void> {
  const sub = submissions.get(submissionId);
  if (!sub) return;
  const problem = problemsById.get(sub.problemVersionId);
  if (!problem) return;

  await sleep(250);
  setStatus(submissionId, "queued");

  await sleep(350);
  setStatus(submissionId, "assigned");

  if (sub.language === "cpp") {
    await sleep(300);
    setStatus(submissionId, "compiling");
  }

  await sleep(300);
  setStatus(submissionId, "running");

  // `transcribe` grades like `submit`, not like `run` — it runs the FULL hidden suite so the user
  // sees their typed-out solution genuinely pass. Only its MASTERY consequence differs (there is
  // none). Mirrors `selectTests` in apps/judge, which special-cases `run` alone.
  const grade =
    sub.mode === "run"
      ? gradeRun(problem, sub.language, sub.source)
      : gradeSubmit(problem, sub.language, sub.source);

  const total = grade.totalTests;
  const steps = Math.max(1, Math.min(total, 5));
  for (let i = 1; i <= steps; i++) {
    await sleep(180);
    const passedSoFar = Math.min(grade.passedTests, Math.round((i / steps) * total));
    publish(submissionId, "progress", { submission_id: submissionId, passed: passedSoFar, total });
  }
  publish(submissionId, "progress", { submission_id: submissionId, passed: grade.passedTests, total });

  await sleep(200);

  sub.row.status = "completed";
  sub.row.verdict = grade.verdict;
  sub.row.passed_tests = grade.passedTests;
  sub.row.total_tests = grade.totalTests;
  sub.row.runtime_ms = grade.runtimeMs;
  sub.row.memory_kb = grade.memoryKb;
  sub.row.failure = grade.failure ?? null;
  sub.row.public_results = grade.publicResults ?? null;
  sub.row.completed_at = new Date().toISOString();

  const justEarnedReveal = sub.mode === "submit" && grade.verdict === "accepted";
  const reveal = buildMockReveal(problem, justEarnedReveal || undefined);
  sub.row.reveal = reveal;

  // A recorded give-up gates mastery entirely, not just this submission's field on the row —
  // every later submit-mode submission on this version is practice (mirrors apps/api/apps/judge;
  // see QA-PLAN.md §1.3, the confirmed-live "give-up poisons all later scoring" bug).
  const gaveUpAlready = sub.mode === "submit" && getProblemUserState(sub.problemVersionId).gaveUp;
  sub.row.practice = gaveUpAlready || undefined;

  publish(submissionId, "verdict", {
    submission_id: submissionId,
    verdict: grade.verdict,
    passed_tests: grade.passedTests,
    total_tests: grade.totalTests,
    runtime_ms: grade.runtimeMs,
    memory_kb: grade.memoryKb,
    failure: grade.failure,
    ...(grade.publicResults ? { public_results: grade.publicResults } : {}),
    ...(reveal ? { reveal } : {}),
    ...(gaveUpAlready ? { practice: true } : {}),
  });

  // An accepted transcription closes the teaching episode: practice stops re-serving this problem
  // and the workspace's onward link comes back. Recorded before the mastery gate below, because a
  // transcription deliberately has no mastery consequence at all.
  if (sub.mode === "transcribe" && grade.verdict === "accepted") {
    getProblemUserState(sub.problemVersionId).transcribed = true;
  }

  // Run mode never touches mastery (CONTRACTS.md §12 / PLAN.md §8). Neither does a `transcribe`
  // (the reveal was already scored — copying it out must not hand that back), nor a submission
  // that follows a give-up on this version — all judged and streamed, but no mastery consequence.
  if (sub.mode !== "submit" || gaveUpAlready) return;

  const userState = getProblemUserState(sub.problemVersionId);
  const substantive = bumpSubmissionCount(sub.problemVersionId);
  const highestHint = userState.hintsTaken.length > 0 ? userState.hintsTaken[userState.hintsTaken.length - 1]! : null;

  const { outcome, evidenceWeight } = outcomeScore({
    verdict: grade.verdict,
    gaveUp: false,
    skipped: null,
    highestHint,
    activeMs: sub.activeMs,
    expectedMinutes: problem.content.expected_active_minutes,
    substantiveSubmissions: substantive,
  });

  const states: Record<string, { rating: number; uncertainty: number }> = {};
  for (const c of problem.content.concepts) {
    const cs = conceptState.get(c.id);
    if (cs) states[c.id] = { rating: cs.rating, uncertainty: cs.uncertainty };
  }

  const { changes, explanation, newStates } = updateConcepts({
    states,
    weights: problem.content.concepts.map((c) => ({ id: c.id, weight: c.weight })),
    problemRating: problem.content.difficulty.rating,
    outcome,
    evidenceWeight,
  });

  for (const c of problem.content.concepts) {
    const cs = conceptState.get(c.id);
    const next = newStates[c.id];
    if (!cs || !next) continue;

    cs.rating = next.rating;
    cs.uncertainty = next.uncertainty;
    cs.attempts += 1;
    cs.last_practiced_at = new Date().toISOString();
    cs.total_active_ms += sub.activeMs;

    if (grade.verdict === "accepted") {
      cs.solves += 1;
      cs.current_streak += 1;
      cs.best_streak = Math.max(cs.best_streak, cs.current_streak);
      if (highestHint === null) cs.unassisted_solves += 1;
      const review = scheduleReview(cs, outcome, new Date());
      cs.next_review_at = review.next_review_at;
      cs.review_interval_days = review.review_interval_days;
      cs.review_ease = review.review_ease;
      cs.review_reps = review.review_reps;
    } else {
      cs.current_streak = 0;
      cs.error_counts[grade.verdict] = (cs.error_counts[grade.verdict] ?? 0) + 1;
    }
    if (highestHint) {
      cs.hint_counts[highestHint] = (cs.hint_counts[highestHint] ?? 0) + 1;
    }
  }

  if (grade.verdict === "accepted") userState.solved = true;

  learningEvents.push({
    id: `le_${submissionId}`,
    kind: "submission",
    problem_version_id: sub.problemVersionId,
    verdict: grade.verdict,
    outcome,
    hints_used: [...userState.hintsTaken],
    active_ms: sub.activeMs,
    difficulty_rating: problem.content.difficulty.rating,
    created_at: new Date().toISOString(),
  });

  publish(submissionId, "mastery", { submission_id: submissionId, changes, outcome, explanation });
}
