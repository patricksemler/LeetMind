// M4 seam (CONTRACTS.md apps/judge brief): re-run a historical submission against its ORIGINALLY
// PINNED `problem_version_id` and record a new `execution_attempts` row, WITHOUT re-applying
// mastery (a rejudge is a reproducibility check, not a new learning event), then compare the new
// verdict to the one already stored on the submission. Loudly reports any mismatch.
//
// Language-agnostic: dispatches through `executeSubmission` (src/execution.ts) on the ORIGINAL
// submission's `language` column, so a C++ submission rejudges through the same compile-then-run
// path (and gets its own `compile` duration recorded) that judged it the first time — never
// silently re-run as Python.
import {
  closePool,
  getProblemVersion,
  getSubmission,
  insertExecutionAttempt,
  queryWith,
  withTransaction,
} from "@leetmind/db";
import { newId, ProblemVersionSchema } from "@leetmind/shared";
import { buildJudgeDeps, type JudgeDeps } from "./deps.js";
import { buildComparatorSpec, buildLimits, executeSubmission, selectTests } from "./execution.js";

export interface RejudgeResult {
  submissionId: string;
  problemVersionId: string;
  originalVerdict: string | null;
  newVerdict: string;
  matched: boolean;
  executionAttemptId: string;
}

export async function rejudgeSubmission(
  submissionId: string,
  deps: JudgeDeps,
): Promise<RejudgeResult> {
  const submission = await getSubmission(submissionId);
  if (!submission) {
    throw new Error(`rejudgeSubmission: submission ${submissionId} not found`);
  }

  // "against its ORIGINAL pinned problem_version_id" — problem_versions are immutable (content
  // never mutates after a version row is written), so re-fetching by the submission's own
  // `problem_version_id` IS re-fetching the exact pinned content; no separate pin/version-lock
  // table is needed for that immutability guarantee.
  const versionRow = await getProblemVersion(submission.problem_version_id);
  if (!versionRow) {
    throw new Error(
      `rejudgeSubmission: problem_version ${submission.problem_version_id} not found`,
    );
  }
  const content = ProblemVersionSchema.parse(versionRow.content);

  const { tests, revealInputs } = selectTests(content, submission.mode);
  const limits = buildLimits(deps.sandbox);

  const {
    result: executionResult,
    languageVersion,
    flags,
  } = await executeSubmission({
    language: submission.language,
    signature: content.signature,
    tests,
    comparator: buildComparatorSpec(content),
    source: submission.source,
    limits,
    pythonImage: deps.config.sandboxPythonImage,
    cppImage: deps.config.sandboxCppImage,
    checkerSource: content.checker_py,
    revealInputs,
  });

  const attemptId = newId();

  await withTransaction(async (client) => {
    const priorAttempts = await queryWith<{ n: number }>(
      client,
      "select count(*)::int as n from execution_attempts where submission_id = $1",
      [submissionId],
    );
    const attempt = (priorAttempts[0]?.n ?? 0) + 1;

    await insertExecutionAttempt(client, {
      id: attemptId,
      submission_id: submissionId,
      attempt,
      worker_id: `rejudge-${deps.config.judgeWorkerId}`,
      image_digest: executionResult.raw.sandbox.imageDigest,
      language_version: languageVersion,
      flags,
      limits: { ...limits },
      usage: {
        ...executionResult.raw.sandbox.usage,
        max_test_memory_kb: executionResult.memoryKb ?? undefined,
        ...(executionResult.compile
          ? {
              compile_ok: executionResult.compile.ok,
              compile_duration_ms: executionResult.compile.durationMs,
              compile_image_digest: executionResult.compile.imageDigest,
            }
          : {}),
      },
      per_test: executionResult.perTest,
      exit_code: executionResult.raw.sandbox.exitCode,
      finished_at: new Date(),
    });
    // Deliberately NOT calling applyMastery / completeSubmission / notify here: a rejudge
    // reproduces a verdict for comparison, it does not re-litigate the stored submission or
    // touch mastery — CONTRACTS.md's rejudge brief is explicit that mastery is not re-applied.
  });

  const matched = executionResult.verdict === submission.verdict;

  return {
    submissionId,
    problemVersionId: submission.problem_version_id,
    originalVerdict: submission.verdict,
    newVerdict: executionResult.verdict,
    matched,
    executionAttemptId: attemptId,
  };
}

async function main(): Promise<void> {
  const submissionId = process.argv[2];
  if (!submissionId) {
    console.error("usage: tsx src/rejudge.ts <submission_id>");
    process.exitCode = 1;
    return;
  }

  const deps = buildJudgeDeps();
  try {
    const result = await rejudgeSubmission(submissionId, deps);
    console.log(JSON.stringify(result, null, 2));
    if (!result.matched) {
      // Loudly report any verdict mismatch, per this package's brief.
      console.error(
        `REJUDGE MISMATCH: submission ${result.submissionId} was originally "${result.originalVerdict}" ` +
          `but rejudging now produces "${result.newVerdict}".`,
      );
      process.exitCode = 1;
    } else {
      console.error(`rejudge OK: verdict "${result.newVerdict}" reproduced.`);
    }
  } finally {
    await closePool();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
