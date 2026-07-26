// The submission state machine — CONTRACTS.md §4.5 / §6, PLAN.md §6.
//
// Drives `queued -> assigned -> compiling -> running -> completed`. (`created -> queued` already
// happened transactionally in apps/api's POST /api/submissions — see CONTRACTS.md §9 "writes the
// submission row AND enqueues the judge job in one transaction" — so by the time a judge job is
// claimed the submission is already `queued`; this handler owns everything from `assigned` on.)
// Every status transition updates `submissions.status` and `pg_notify`s the SSE `status` event in
// the SAME transaction (CONTRACTS §4.5).
import {
  completeSubmission,
  completeBaselineItem,
  getProblemVersion,
  getSubmission,
  hasGivenUp,
  insertExecutionAttempt,
  notify,
  queryWith,
  updateSubmissionStatus,
  withTransaction,
  type SubmissionRow,
} from "@leetmind/db";
import type { JobHandler, WorkerContext } from "@leetmind/queue";
import { failedPublicCase, newId, ProblemVersionSchema, type JudgeJobPayload, type SubmissionStatus } from "@leetmind/shared";
import type { JudgeDeps } from "./deps.js";
import {
  buildComparatorSpec,
  buildLimits,
  executeSubmission,
  failingTestDetail,
  publicResults,
  selectTests,
  summarizeTestOrigins,
} from "./execution.js";
import { applyMastery } from "./mastery.js";

/**
 * Writes `submissions.status = status` and the matching SSE `status` notify in one transaction.
 * Returns the updated row.
 */
async function transitionStatus(userId: string, submissionId: string, status: SubmissionStatus): Promise<SubmissionRow> {
  return withTransaction(async (client) => {
    const row = await updateSubmissionStatus(client, submissionId, status);
    await notify(client, {
      type: "status",
      submission_id: submissionId,
      user_id: userId,
      status,
      at: new Date().toISOString(),
    });
    return row;
  });
}

/**
 * Builds the `JobHandler<JudgeJobPayload>` for `runWorker`. A factory (rather than a bare
 * top-level function reaching for a module-level singleton) so tests can inject a `JudgeDeps`
 * pointing at whatever config/sandbox limits the test needs (e.g. a short wall timeout for the
 * timeout test) without touching process env.
 */
export function createJudgeHandler(deps: JudgeDeps): JobHandler<JudgeJobPayload> {
  return async function handleJudgeJob(job, ctx: WorkerContext): Promise<void> {
    const payload = job.payload;
    const { submission_id: submissionId, mode, user_id: userId } = payload;
    const logger = ctx.logger;

    const submission = await getSubmission(submissionId);
    if (!submission) {
      throw new Error(`handleJudgeJob: submission ${submissionId} not found`);
    }

    // Duplicate-delivery guard (CONTRACTS §7 "no duplicate LearningEvent" / M4 idempotency
    // suite): if a previous delivery already drove this submission to completion, ack and return
    // immediately without touching anything else.
    if (submission.status === "completed") {
      logger.info({ submission_id: submissionId }, "submission already completed; duplicate delivery, ack only");
      return;
    }

    if (ctx.signal.aborted) {
      logger.warn({ submission_id: submissionId }, "lease already lost before starting; aborting without a verdict");
      return;
    }

    const versionRow = await getProblemVersion(submission.problem_version_id);
    if (!versionRow) {
      throw new Error(`handleJudgeJob: problem_version ${submission.problem_version_id} not found`);
    }
    const content = ProblemVersionSchema.parse(versionRow.content);

    await transitionStatus(userId, submissionId, "assigned");
    if (ctx.signal.aborted) {
      logger.warn({ submission_id: submissionId }, "lease lost after 'assigned'; aborting without a verdict");
      return;
    }

    const { tests, revealInputs } = selectTests(content, mode);

    // CONTRACTS §6 Judge flow, step 3: the harness returns per-test results in one shot, so we
    // can only ever emit a true `{passed, total}` at the very start (0/n) and at completion — no
    // faked intermediate progress.
    await withTransaction((client) =>
      notify(client, { type: "progress", submission_id: submissionId, user_id: userId, passed: 0, total: tests.length }),
    );

    await transitionStatus(userId, submissionId, "compiling");
    if (ctx.signal.aborted) {
      logger.warn({ submission_id: submissionId }, "lease lost after 'compiling'; aborting without a verdict");
      return;
    }

    await transitionStatus(userId, submissionId, "running");
    if (ctx.signal.aborted) {
      logger.warn({ submission_id: submissionId }, "lease lost after 'running'; aborting without a verdict");
      return;
    }

    // Extend the lease explicitly before the long-running sandbox execution (rather than relying
    // solely on the background heartbeat timer) and bail out immediately if it's already gone.
    const heartbeatOk = await ctx.heartbeat();
    if (!heartbeatOk) {
      logger.warn({ submission_id: submissionId }, "lease lost before sandbox execution; aborting without a verdict");
      return;
    }

    const limits = buildLimits(deps.sandbox);
    const { result: executionResult, languageVersion, flags } = await executeSubmission({
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
      correlationId: submission.correlation_id ?? undefined,
    });

    // The lease may have been stolen by the reaper while the sandbox executor was running (the
    // sandbox call itself isn't cancellable mid-flight — CONTRACTS §6 wall-timeout enforcement is
    // host-side, not tied to our AbortSignal). Check ONE more time, right before the terminal
    // write, so a lease-lost worker never writes a verdict another worker may already own.
    if (ctx.signal.aborted) {
      logger.warn(
        { submission_id: submissionId },
        "lease lost during sandbox execution; discarding result, not writing a verdict",
      );
      return;
    }

    const { verdict, passedTests, totalTests, runtimeMs, memoryKb, perTest, raw, compile } = executionResult;

    // The public/hidden split rides along on `failure` rather than in its own column: it is only
    // ever needed when something failed, and `submissions.failure` is already a jsonb the API
    // projects (and sanitizes) on the way out.
    // `failing_test` rides along for the same reason as the origin split: it is only meaningful
    // when something failed. It carries the one case that ended the run — public or hidden — so the
    // Submissions view can render it exactly like a public case instead of naming a bare index.
    const failure = executionResult.failure
      ? {
          ...executionResult.failure,
          tests: summarizeTestOrigins(tests, perTest),
          ...(() => {
            const detail = failingTestDetail(tests, perTest, executionResult.failure.first_failing_test_index);
            return detail ? { failing_test: detail } : {};
          })(),
        }
      : executionResult.failure;

    // Every public test's outcome, so the workspace can colour the whole case list rather than
    // naming only the first failure. Built for accepted submissions too — a green case list is
    // exactly as useful as a red one.
    const publicTestResults = publicResults(tests, perTest);

    await withTransaction(async (client) => {
      // `ctx.signal.aborted` (checked above) is an in-memory flag on THIS process — by the time
      // it's read, it's already potentially stale, and the real gap that matters is the one
      // between reading it and this transaction actually committing: opening the connection,
      // `begin`, every query below all take real wall-clock time the reaper's 5s tick can land in.
      // `for update` here makes this transaction and the reaper's own `for update skip locked`
      // reap query mutually exclusive on this exact row for as long as this transaction is open —
      // not just an earlier snapshot of "did I still hold the lease", but the DB itself refusing
      // the write once ownership has actually moved.
      const lease = await queryWith<{ ok: boolean }>(
        client,
        "select (status = 'leased' and leased_by = $2) as ok from jobs where id = $1 for update",
        [job.id, deps.config.judgeWorkerId],
      );
      if (!lease[0]?.ok) {
        logger.warn(
          { submission_id: submissionId, job_id: job.id },
          "lease no longer held at write time (reaper reassigned it); discarding result, not writing a verdict",
        );
        return;
      }

      const priorAttempts = await queryWith<{ n: number }>(
        client,
        "select count(*)::int as n from execution_attempts where submission_id = $1",
        [submissionId],
      );
      const attempt = (priorAttempts[0]?.n ?? 0) + 1;

      await insertExecutionAttempt(client, {
        id: newId(),
        submission_id: submissionId,
        attempt,
        worker_id: deps.config.judgeWorkerId,
        image_digest: raw.sandbox.imageDigest,
        language_version: languageVersion,
        flags,
        limits: { ...limits },
        usage: {
          ...raw.sandbox.usage,
          max_test_memory_kb: memoryKb ?? undefined,
          // C++ only (CONTRACTS §7: "record both durations") — the compile sandbox invocation's
          // own wall time and image digest, distinct from the run step's (already `image_digest`
          // above and folded into `runtimeMs`).
          ...(compile ? { compile_ok: compile.ok, compile_duration_ms: compile.durationMs, compile_image_digest: compile.imageDigest } : {}),
        },
        per_test: perTest,
        exit_code: raw.sandbox.exitCode,
        finished_at: new Date(),
      });

      await completeSubmission(client, submissionId, {
        verdict,
        passed_tests: passedTests,
        total_tests: totalTests,
        runtime_ms: runtimeMs != null ? Math.round(runtimeMs) : null,
        memory_kb: memoryKb,
        failure: failure ?? null,
        public_results: publicTestResults,
      });

      // A recorded give-up on this problem version means every later submission is practice —
      // judged and streamed like any other, but never a mastery consequence (confirmed live: a
      // give-up used to poison ALL later scoring, applying a fresh negative delta on every
      // subsequent resubmission, even a fully correct one). Checked once here and reused for both
      // the mastery gate below and the `practice` flag the client uses to label the result.
      const gaveUpAlready = mode === "submit" && (await hasGivenUp(userId, submission.problem_version_id, client));

      const completedAt = new Date().toISOString();
      await notify(client, { type: "status", submission_id: submissionId, user_id: userId, status: "completed", at: completedAt });
      await notify(client, { type: "progress", submission_id: submissionId, user_id: userId, passed: passedTests, total: totalTests });
      await notify(client, {
        type: "verdict",
        submission_id: submissionId,
        user_id: userId,
        verdict,
        passed_tests: passedTests,
        total_tests: totalTests,
        runtime_ms: runtimeMs != null ? Math.round(runtimeMs) : null,
        memory_kb: memoryKb,
        ...(failure ? { failure } : {}),
        ...(gaveUpAlready ? { practice: true } : {}),
      });

      // `run` mode never affects mastery (CONTRACTS §8 / this package's brief); only `submit`
      // does, and it happens in this SAME transaction so a verdict is never observably applied
      // without its mastery consequence (or vice versa) — except when `gaveUpAlready`, which is
      // gated out entirely rather than merely floored/penalized.
      //
      // A submit that died on a PUBLIC example is gated out for the same reason: the case is
      // printed on the problem page and `Run` executes it for free, so failing it says nothing
      // about the user's grasp of a concept — it's the same class of non-evidence as the
      // compile-only failures §8 already exempts. Such an attempt is treated as a run throughout
      // (it stays out of the attempt history too — see `listSubmissionsForVersion`).
      if (mode === "submit" && !gaveUpAlready && !failedPublicCase(failure)) {
        await applyMastery({ client, submission, content, verdict, now: new Date() });
      }

      // No submission/acceptance ever transitioned a baseline item (confirmed live,
      // docs/QA-PLAN.md §1.2): items stayed pending forever, so the baseline never advanced past
      // its first probe. `completeBaselineItem` no-ops once the item is already terminal (its own
      // guard), so this is safe against a stale/duplicate delivery too.
      if (mode === "submit" && verdict === "accepted" && submission.baseline_item_id) {
        await completeBaselineItem(client, submission.baseline_item_id, {
          state: "solved",
          active_ms: submission.active_ms ?? null,
        });
      }
    });

    logger.info({ submission_id: submissionId, verdict, passed_tests: passedTests, total_tests: totalTests }, "judge job complete");
  };
}
