import type { FastifyInstance } from "fastify";
import {
  getApprovedProblemVersion,
  getLatestSubmission,
  getSubmission,
  getWorkoutItem,
  insertSubmission,
  listHintEvents,
  notify,
  queryOne,
  withTransaction,
  type LearningEventRow,
  type SubmissionRow,
} from "@algolift/db";
import { badRequest, CreateSubmissionRequest, judgeJobKey, newId, notFound } from "@algolift/shared";
import type { Deps } from "../deps.js";
import { sha256Hex } from "../lib/hash.js";
import { buildReveal, sanitizeFailure, toSafeSubmission } from "../mappers/submission.js";
import { requireId } from "../server.js";
import { notifyBus } from "../sse.js";

/** `practice` labels submit-mode submissions created AFTER a recorded give-up on the version.
 * The ordering check matters: a give-up must not retroactively relabel earlier submissions that
 * were fully scored (the 409 in-flight guard means a give-up event is always either wholly before
 * a submission's creation or after its terminal verdict, so `created_at` ordering is exact). The
 * judge's own mastery gate (`hasGivenUp` in the handler) stays existence-based — at judge time,
 * any recorded give-up necessarily predates the submission it is gating. */
async function isPracticeSubmission(userId: string, row: SubmissionRow): Promise<boolean> {
  if (row.mode !== "submit") return false;
  const events = await listHintEvents(userId, row.problem_version_id);
  return events.some((h) => h.level === "editorial" && new Date(h.created_at).getTime() < new Date(row.created_at).getTime());
}

/** Full client-facing submission projection: safe fields + reveal (if earned) + practice flag (if
 * this submit-mode submission followed a recorded give-up on the same version). Shared by
 * `GET /api/submissions/:id` and `GET /api/problems/:versionId/submissions/latest`. */
async function enrichSubmission(userId: string, row: SubmissionRow) {
  const [reveal, practice] = await Promise.all([
    buildReveal(userId, row.problem_version_id),
    isPracticeSubmission(userId, row),
  ]);
  return { ...toSafeSubmission(row), ...(reveal ? { reveal } : {}), ...(practice ? { practice: true } : {}) };
}

const MAX_SOURCE_BYTES = 256 * 1024;
const SUPPORTED_LANGUAGES = new Set(["python", "cpp"]);
const PING_INTERVAL_MS = 15_000;

interface MasteryEventData {
  submission_id: string;
  changes: unknown[];
  outcome: number;
  explanation: string;
}

async function loadMasteryEventForSubmission(submissionId: string): Promise<MasteryEventData | null> {
  const row = await queryOne<LearningEventRow>(
    `select * from learning_events where submission_id = $1 and kind = 'submission' order by created_at desc limit 1`,
    [submissionId],
  );
  if (!row) return null;
  const evidence = row.evidence as { changes?: unknown[]; explanation?: string };
  return {
    submission_id: submissionId,
    changes: Array.isArray(evidence?.changes) ? evidence.changes : [],
    outcome: row.outcome,
    explanation: typeof evidence?.explanation === "string" ? evidence.explanation : "",
  };
}

function baseVerdictEventPayload(row: SubmissionRow) {
  return {
    submission_id: row.id,
    verdict: row.verdict,
    passed_tests: row.passed_tests,
    total_tests: row.total_tests,
    runtime_ms: row.runtime_ms,
    memory_kb: row.memory_kb,
    ...(row.failure ? { failure: sanitizeFailure(row.failure, row.mode) } : {}),
  };
}

/**
 * Builds the full `verdict` SSE/`GET` payload (sanitized failure + reveal). `reveal` is fetched
 * separately from the always-safe base fields so a `buildReveal` failure (e.g. a bad content
 * blob) never takes the verdict itself down with it — callers get the base payload back instead
 * of losing the verdict entirely (docs/CONTRACTS.md §4.5, and the root cause of the P0 "live
 * verdict never reaches the client" bug: the old call site chained `.then` with no `.catch`).
 */
async function verdictEventPayload(
  userId: string,
  row: SubmissionRow,
  onRevealError?: (err: unknown) => void,
) {
  const base = baseVerdictEventPayload(row);
  try {
    const [reveal, practice] = await Promise.all([
      buildReveal(userId, row.problem_version_id),
      isPracticeSubmission(userId, row),
    ]);
    return { ...base, ...(reveal ? { reveal } : {}), ...(practice ? { practice: true } : {}) };
  } catch (err) {
    onRevealError?.(err);
    return base;
  }
}

export function registerSubmissionRoutes(fastify: FastifyInstance, deps: Deps): void {
  const userId = deps.config.singleUserId;

  fastify.post("/api/submissions", async (request, reply) => {
    const body = CreateSubmissionRequest.parse(request.body);

    if (!SUPPORTED_LANGUAGES.has(body.language)) {
      throw badRequest(`Unknown language "${body.language}"`, { language: body.language });
    }

    const sourceBytes = Buffer.byteLength(body.source, "utf8");
    if (sourceBytes > MAX_SOURCE_BYTES) {
      throw badRequest(`source exceeds the ${MAX_SOURCE_BYTES}-byte limit`, {
        size_bytes: sourceBytes,
        max_bytes: MAX_SOURCE_BYTES,
      });
    }

    const versionRow = await getApprovedProblemVersion(body.problem_version_id);
    if (!versionRow) throw notFound("Problem version not found or not approved");

    // Validated up front rather than left to the DB's foreign key — an unknown/bogus
    // `workout_item_id` used to surface as a raw FK-violation 500 (confirmed live), not the 400 a
    // client-supplied bad id should produce.
    if (body.workout_item_id) {
      const item = await getWorkoutItem(body.workout_item_id);
      if (!item) throw badRequest("Unknown workout_item_id", { workout_item_id: body.workout_item_id });
    }

    const sourceHash = sha256Hex(body.source);
    const correlationId = request.correlationId;

    const submission = await withTransaction(async (client) => {
      const inserted = await insertSubmission(client, {
        id: newId(),
        user_id: userId,
        problem_version_id: body.problem_version_id,
        workout_item_id: body.workout_item_id ?? null,
        mode: body.mode,
        language: body.language,
        source: body.source,
        source_hash: sourceHash,
        status: "queued",
        custom_input: body.custom_input ?? null,
        active_ms: body.active_ms ?? null,
        correlation_id: correlationId,
      });

      // Transactional heart (docs/CONTRACTS.md §9): the submission row and the judge job are
      // written atomically, and the SSE-triggering notify rides the same commit.
      await deps.queue.enqueue(client, {
        kind: "judge",
        payload: {
          submission_id: inserted.id,
          mode: inserted.mode,
          language: inserted.language,
          problem_version_id: inserted.problem_version_id,
          user_id: inserted.user_id,
        },
        idempotencyKey: judgeJobKey(inserted.id),
        correlationId,
      });

      await notify(client, {
        type: "status",
        submission_id: inserted.id,
        user_id: inserted.user_id,
        status: inserted.status,
        at: inserted.created_at instanceof Date ? inserted.created_at.toISOString() : String(inserted.created_at),
      });

      return inserted;
    });

    reply.status(201).send({ submission_id: submission.id, status: submission.status });
  });

  fastify.get<{ Params: { id: string } }>("/api/submissions/:id", async (request, reply) => {
    const id = requireId(request.params.id);
    const row = await getSubmission(id);
    if (!row || row.user_id !== userId) throw notFound("Submission not found");
    reply.send({ submission: await enrichSubmission(userId, row) });
  });

  // GET /api/problems/:versionId/submissions/latest — hydrates the workspace on mount/reload.
  // Without this, refreshing mid-submission (or reopening a problem you already have a result
  // for) loses the verdict with no recovery: the backend has it, but the client only ever tracked
  // the active submission id in local, non-persisted React state (confirmed live).
  fastify.get<{ Params: { versionId: string } }>(
    "/api/problems/:versionId/submissions/latest",
    async (request, reply) => {
      const versionId = requireId(request.params.versionId, "versionId");
      const row = await getLatestSubmission(userId, versionId);
      reply.send({ submission: row ? await enrichSubmission(userId, row) : null });
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/submissions/:id/events", async (request, reply) => {
    const id = requireId(request.params.id);
    const submission = await getSubmission(id);
    if (!submission || submission.user_id !== userId) throw notFound("Submission not found");

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Comment line: flushes headers promptly through some intermediary proxies/buffers.
    reply.raw.write(": connected\n\n");

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let pingTimer: NodeJS.Timeout | null = null;

    const send = (event: string, data: unknown): void => {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (unsubscribe) unsubscribe();
      request.raw.off("close", cleanup);
      reply.raw.end();
    };
    request.raw.on("close", cleanup);

    // Late-subscriber correctness (docs/CONTRACTS.md §4.5): send the CURRENT DB state first, and
    // if the submission is already terminal, deliver the verdict (+mastery, if present) and close
    // — without this, a verdict that landed between POST and EventSource-open would be lost
    // forever, since the live NOTIFY that announced it already fired before we subscribed.
    send("status", {
      submission_id: submission.id,
      status: submission.status,
      at: (submission.completed_at ?? submission.created_at) instanceof Date
        ? (submission.completed_at ?? submission.created_at).toISOString()
        : String(submission.completed_at ?? submission.created_at),
    });

    if (submission.status === "completed") {
      send("verdict", await verdictEventPayload(userId, submission));
      const mastery = await loadMasteryEventForSubmission(submission.id);
      if (mastery) send("mastery", mastery);
      cleanup();
      return;
    }

    // Only now — after the DB-backed catch-up above — attach the live listener for future events.
    // `reveal` (docs/CONTRACTS.md §4.5) is deliberately computed HERE, server-side in apps/api, and
    // not carried in judge's NOTIFY payload: the payload has a hard 7900-byte budget (too tight for
    // an editorial write-up) and apps/judge is out of this agent's scope to edit regardless — the
    // live `verdict` notification from judge only ever carries the verdict/test-count fields; this
    // callback enriches it with `reveal` (same earned-ness rule as the catch-up path above) before
    // forwarding to the connected client.
    //
    // The live `verdict` event is routed through the SAME `verdictEventPayload()` helper as the
    // catch-up path above (sanitized failure included — the live path used to skip this, a
    // verdict-leak hole) by re-reading the now-completed submission row. If that (or reveal-
    // building) fails, `.catch` still sends the verdict — sanitized from the notify payload itself
    // — rather than silently dropping it, which was the root cause of the P0 "live verdict never
    // reaches the client" bug (a rejected, uncaught `.then` chain).
    // Guards against delivering the verdict twice — the TOCTOU re-check below and the live
    // listener race exactly once, at subscribe time (see the re-check's own comment).
    let verdictDelivered = false;

    unsubscribe = notifyBus.subscribe(submission.id, (type, payload) => {
      const { type: _t, user_id: _u, submission_id: _s, ...rest } = payload;
      if (type !== "verdict") {
        send(type, { submission_id: submission.id, ...rest });
        return;
      }
      if (verdictDelivered) return;
      verdictDelivered = true;
      getSubmission(submission.id)
        .then((fresh) =>
          verdictEventPayload(userId, fresh ?? submission, (err) => {
            fastify.log.error({ err, submission_id: submission.id }, "failed to build reveal for live verdict event");
          }),
        )
        .then((eventPayload) => send(type, eventPayload))
        .catch((err) => {
          fastify.log.error({ err, submission_id: submission.id }, "failed to build live verdict event; sending unenriched");
          const rawFailure = (rest as { failure?: SubmissionRow["failure"] }).failure;
          send(type, {
            ...rest,
            submission_id: submission.id,
            ...(rawFailure ? { failure: sanitizeFailure(rawFailure, submission.mode) } : {}),
          });
        });
    });

    // TOCTOU guard: the snapshot SELECT at the top of this handler could have caught the
    // submission still non-terminal, and the judge could complete (and NOTIFY) in the gap between
    // that snapshot and the `subscribe()` call just above — a NOTIFY dispatched in that window is
    // gone forever, since notifyBus only fans out to subscribers already attached when it fires.
    // Without this, the connection would sit open waiting for a live event that already happened,
    // and (being otherwise indistinguishable from "still running") would never resolve. Re-check
    // once, now that we're guaranteed not to miss anything from this point forward, and if the
    // submission turned out to already be terminal, deliver it exactly like the catch-up branch
    // above does.
    if (!verdictDelivered) {
      const recheck = await getSubmission(submission.id);
      if (recheck && recheck.status === "completed" && !verdictDelivered) {
        verdictDelivered = true;
        send(
          "verdict",
          await verdictEventPayload(userId, recheck, (err) => {
            fastify.log.error({ err, submission_id: submission.id }, "failed to build reveal for TOCTOU-recheck verdict event");
          }),
        );
        const mastery = await loadMasteryEventForSubmission(submission.id);
        if (mastery) send("mastery", mastery);
        cleanup();
        return;
      }
    }

    pingTimer = setInterval(() => send("ping", { at: new Date().toISOString() }), PING_INTERVAL_MS);
    pingTimer.unref?.();
  });
}
