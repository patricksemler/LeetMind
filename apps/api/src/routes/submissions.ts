import type { FastifyInstance } from "fastify";
import {
  getApprovedProblemVersion,
  getLatestSubmission,
  getSubmission,
  hasSeenEditorial,
  insertSubmission,
  listSubmissionsForVersion,
  notify,
  withTransaction,
  type SubmissionRow,
} from "@leetmind/db";
import {
  badRequest,
  CreateSubmissionRequest,
  judgeJobKey,
  newId,
  notFound,
} from "@leetmind/shared";
import type { Deps } from "../deps.js";
import { sha256Hex } from "../lib/hash.js";
import {
  buildReveal,
  enrichSubmission,
  isPracticeSubmission,
  loadMasteryEventForSubmission,
  sanitizeFailure,
  toSafeSubmission,
  verdictEventPayload,
} from "../mappers/submission.js";
import { requireId } from "../server.js";
import { notifyBus } from "../sse.js";

/** How many past attempts this route returns. The tab renders the newest five JUDGED ones
 * (`HISTORY_SHOWN`, apps/web) — this is deliberately a few more, so in-flight attempts, which the
 * tab filters out, can't push judged ones out of those five. Rows carry the full submitted source,
 * so fetching a long tail nobody renders is pure weight on every tab open. */
const SUBMISSION_HISTORY_LIMIT = 10;

const MAX_SOURCE_BYTES = 256 * 1024;
const SUPPORTED_LANGUAGES = new Set(["python", "cpp"]);
const PING_INTERVAL_MS = 15_000;

export function registerSubmissionRoutes(fastify: FastifyInstance, deps: Deps): void {
  fastify.post("/api/submissions", async (request, reply) => {
    const userId = request.userId;
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

    // `transcribe` is the teaching-mode write-it-out step, and it is only meaningful once the
    // solution has actually been revealed. Rejecting it otherwise closes the obvious hole: without
    // this, a client could submit `transcribe` on any problem to get it judged with the hidden
    // tests but no mastery consequence — an unlimited free run against the real suite.
    if (body.mode === "transcribe") {
      const revealed = await hasSeenEditorial(userId, body.problem_version_id);
      if (!revealed) {
        throw badRequest(
          "transcribe mode requires the editorial to have been revealed for this problem",
          { problem_version_id: body.problem_version_id },
        );
      }
    }

    const sourceHash = sha256Hex(body.source);
    const correlationId = request.correlationId;

    const submission = await withTransaction(async (client) => {
      const inserted = await insertSubmission(client, {
        id: newId(),
        user_id: userId,
        problem_version_id: body.problem_version_id,
        baseline_item_id: null,
        mode: body.mode,
        paste_detected: body.mode === "transcribe" ? (body.paste_detected ?? false) : false,
        language: body.language,
        source: body.source,
        source_hash: sourceHash,
        status: "queued",
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
        at:
          inserted.created_at instanceof Date
            ? inserted.created_at.toISOString()
            : String(inserted.created_at),
      });

      return inserted;
    });

    reply.status(201).send({ submission_id: submission.id, status: submission.status });
  });

  fastify.get<{ Params: { id: string } }>("/api/submissions/:id", async (request, reply) => {
    const userId = request.userId;
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
      const userId = request.userId;
      const versionId = requireId(request.params.versionId, "versionId");
      const row = await getLatestSubmission(userId, versionId);
      reply.send({ submission: row ? await enrichSubmission(userId, row) : null });
    },
  );

  // GET /api/problems/:versionId/submissions — the attempt history behind the workspace's
  // Submissions tab. Submit-mode only (see `listSubmissionsForVersion`), newest first, capped:
  // the tab shows a history, not an audit log, and an unbounded list is a slow query waiting to
  // happen on a problem someone has hammered.
  fastify.get<{ Params: { versionId: string } }>(
    "/api/problems/:versionId/submissions",
    async (request, reply) => {
      const userId = request.userId;
      const versionId = requireId(request.params.versionId, "versionId");
      const rows = await listSubmissionsForVersion(userId, versionId, SUBMISSION_HISTORY_LIMIT);
      // `enrichSubmission` per row would re-run the reveal lookup once per submission; the reveal
      // is a property of the PROBLEM VERSION, not of an individual attempt, so it is resolved once
      // and attached to whichever rows earned it.
      const [reveal, practice] = await Promise.all([
        buildReveal(userId, versionId),
        Promise.all(rows.map((row) => isPracticeSubmission(userId, row))),
      ]);
      reply.send({
        submissions: rows.map((row, i) => ({
          ...toSafeSubmission(row),
          ...(reveal && row.verdict === "accepted" ? { reveal } : {}),
          ...(practice[i] ? { practice: true } : {}),
        })),
      });
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/submissions/:id/events", async (request, reply) => {
    const userId = request.userId;
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
      at:
        (submission.completed_at ?? submission.created_at) instanceof Date
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
            fastify.log.error(
              { err, submission_id: submission.id },
              "failed to build reveal for live verdict event",
            );
          }),
        )
        .then((eventPayload) => send(type, eventPayload))
        .catch((err) => {
          fastify.log.error(
            { err, submission_id: submission.id },
            "failed to build live verdict event; sending unenriched",
          );
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
            fastify.log.error(
              { err, submission_id: submission.id },
              "failed to build reveal for TOCTOU-recheck verdict event",
            );
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
