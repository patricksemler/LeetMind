import type { Express } from "express";
import { CreateSubmissionRequest, failedPublicCase, newId, type Submission } from "@leetmind/shared";
import { runLifecycle } from "../lifecycle.js";
import { subscribe } from "../sse.js";
import { getProblemUserState, problemsById, submissions, USER_ID } from "../state.js";
import { badRequest, handle, notFound, pparam } from "./helpers.js";

export function registerSubmissionRoutes(app: Express): void {
  // --- POST /api/submissions -------------------------------------------------------------------

  app.post(
    "/api/submissions",
    handle((req, res) => {
      const parsed = CreateSubmissionRequest.safeParse(req.body);
      if (!parsed.success) return badRequest(res, "invalid submission body", parsed.error.flatten());
      const body = parsed.data;

      const fixture = problemsById.get(body.problem_version_id);
      if (!fixture) return notFound(res, `no problem version ${body.problem_version_id}`);

      // Mirrors the real API's guard: `transcribe` runs the full hidden suite but writes no mastery
      // consequence, so allowing it before the solution has been revealed would be an unlimited free
      // run against the real tests.
      if (body.mode === "transcribe" && !getProblemUserState(body.problem_version_id).gaveUp) {
        return badRequest(res, "transcribe mode requires the editorial to have been revealed for this problem");
      }

      const id = newId();
      const row: Submission = {
        id,
        user_id: USER_ID,
        problem_version_id: body.problem_version_id,
        baseline_item_id: null,
        mode: body.mode,
        language: body.language,
        source: body.source,
        status: "created",
        verdict: null,
        passed_tests: 0,
        total_tests: 0,
        runtime_ms: null,
        memory_kb: null,
        failure: null,
        active_ms: body.active_ms ?? null,
        correlation_id: (res.getHeader("x-correlation-id") as string) ?? null,
        created_at: new Date().toISOString(),
        completed_at: null,
      };

      submissions.set(id, {
        row,
        problemVersionId: body.problem_version_id,
        mode: body.mode,
        language: body.language,
        source: body.source,
        activeMs: body.active_ms ?? 0,
      });

      res.status(201).json({ submission_id: id, status: "created" });

      // Never block the response on the verdict (CONTRACTS.md §9) — the job runs after we've responded.
      void runLifecycle(id);
    }),
  );

  // --- GET /api/submissions/:id -----------------------------------------------------------------

  app.get(
    "/api/submissions/:id",
    handle((req, res) => {
      const sub = submissions.get(pparam(req.params.id));
      if (!sub) return notFound(res, `no submission ${pparam(req.params.id)}`);
      res.json({ submission: sub.row });
    }),
  );

  // --- GET /api/problems/:versionId/submissions/latest ---------------------------------------

  app.get(
    "/api/problems/:versionId/submissions/latest",
    handle((req, res) => {
      const versionId = pparam(req.params.versionId);
      const latest = [...submissions.values()]
        .filter((s) => s.problemVersionId === versionId)
        .sort((a, b) => new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime())[0];
      res.json({ submission: latest?.row ?? null });
    }),
  );

  // --- GET /api/problems/:versionId/submissions ---------------------------------------------------

  // Mirrors the real route (apps/api/src/routes/submissions.ts): submit-mode only, newest first,
  // capped at the same `SUBMISSION_HISTORY_LIMIT` — the tab renders five judged attempts out of it,
  // so an uncapped mock would hide a paging bug behind a list that always happens to be short enough.
  const SUBMISSION_HISTORY_LIMIT = 10;

  app.get(
    "/api/problems/:versionId/submissions",
    handle((req, res) => {
      const versionId = pparam(req.params.versionId);
      const rows = [...submissions.values()]
        // Same two exclusions as the real query: runs, and submits that died on a public example
        // (those are treated as runs throughout — see `failedPublicCase` in @leetmind/shared).
        .filter((s) => s.problemVersionId === versionId && s.row.mode === "submit" && !failedPublicCase(s.row.failure))
        .sort((a, b) => new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime())
        .slice(0, SUBMISSION_HISTORY_LIMIT)
        .map((s) => s.row);
      res.json({ submissions: rows });
    }),
  );

  // --- GET /api/submissions/:id/events -----------------------------------------------------------

  app.get("/api/submissions/:id/events", (req, res) => {
    const sub = submissions.get(pparam(req.params.id));
    if (!sub) return notFound(res, `no submission ${pparam(req.params.id)}`);
    subscribe(pparam(req.params.id), res);
  });
}
