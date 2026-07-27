// Drives `profile.concurrentSessions` concurrent "virtual users", each submitting
// `profile.submissionsPerSession` times sequentially (submit -> wait for terminal verdict ->
// think-time -> repeat), picking language/outcome per the profile's mix each time. This is the
// actual load generation; stats.ts computes the numbers afterward from Postgres.
import { createSubmission, waitForTerminal } from "./client.js";
import type { LoadProfile } from "./config.js";
import { sourceFor, weightedPick, type LoadLanguage, type OutcomeKind } from "./sources.js";

export interface SessionSubmissionOutcome {
  submissionId: string;
  language: LoadLanguage;
  intendedOutcome: OutcomeKind;
  observedVerdict: string | null;
  error?: string;
}

function randomInRange([lo, hi]: [number, number]): number {
  return lo + Math.random() * (hi - lo);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSession(opts: {
  sessionIndex: number;
  apiBase: string;
  problemVersionId: string;
  profile: LoadProfile;
  onSubmissionDone: (o: SessionSubmissionOutcome) => void;
  onProgress: () => void;
}): Promise<void> {
  const { profile } = opts;
  // Per-verdict-kind wall-clock budget: timeouts always cost the full sandbox wall timeout, so
  // give the SSE wait a generous ceiling above it rather than a single fixed number.
  const waitTimeoutMs = profile.sandboxWallTimeoutMs + 15_000;

  for (let i = 0; i < profile.submissionsPerSession; i++) {
    const language = weightedPick<LoadLanguage>(profile.languageMix);
    const outcome = weightedPick<OutcomeKind>(profile.outcomeMix);
    const source = sourceFor(language, outcome, profile);

    try {
      const { submissionId } = await createSubmission({
        apiBase: opts.apiBase,
        problemVersionId: opts.problemVersionId,
        language,
        source,
      });
      const result = await waitForTerminal({
        apiBase: opts.apiBase,
        submissionId,
        timeoutMs: waitTimeoutMs,
      });
      opts.onSubmissionDone({
        submissionId,
        language,
        intendedOutcome: outcome,
        observedVerdict: result.verdict,
        error: result.error,
      });
    } catch (err) {
      opts.onSubmissionDone({
        submissionId: "(never created)",
        language,
        intendedOutcome: outcome,
        observedVerdict: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    opts.onProgress();

    if (i < profile.submissionsPerSession - 1) {
      await sleep(randomInRange(profile.thinkTimeMsRange));
    }
  }
}

export interface RunLoadResult {
  outcomes: SessionSubmissionOutcome[];
  wallClockMs: number;
}

export async function runLoad(opts: {
  apiBase: string;
  problemVersionId: string;
  profile: LoadProfile;
}): Promise<RunLoadResult> {
  const outcomes: SessionSubmissionOutcome[] = [];
  const total = opts.profile.concurrentSessions * opts.profile.submissionsPerSession;
  let done = 0;
  const startedAt = Date.now();

  const onProgress = (): void => {
    done++;
    if (done % 10 === 0 || done === total) {
      process.stdout.write(`\r  load: ${done}/${total} submissions completed`);
    }
  };

  const sessions = Array.from({ length: opts.profile.concurrentSessions }, (_, sessionIndex) =>
    runSession({
      sessionIndex,
      apiBase: opts.apiBase,
      problemVersionId: opts.problemVersionId,
      profile: opts.profile,
      onSubmissionDone: (o) => outcomes.push(o),
      onProgress,
    }),
  );
  await Promise.all(sessions);
  process.stdout.write("\n");

  return { outcomes, wallClockMs: Date.now() - startedAt };
}
