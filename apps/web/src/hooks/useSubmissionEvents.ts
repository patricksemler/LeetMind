/**
 * Subscribes to `GET /api/submissions/:id/events` (docs/CONTRACTS.md §4.5) and exposes the live
 * lifecycle of a submission: status, per-test progress, verdict, and the mastery explanation.
 *
 * The browser's native `EventSource` already retries on drop, but only using the server's `retry:`
 * hint and with no visibility into "did we miss anything". Instead we close and reopen ourselves
 * with an exponential backoff (capped), and on every drop we re-fetch `GET /api/submissions/:id`
 * so a verdict that landed while we were disconnected is never lost — this is called out
 * explicitly in the brief and is exercised by `useSubmissionEvents.test.ts`.
 *
 * `verdict` does not close the stream immediately: the mastery-update event for an accepted (or
 * partially-credited) submission is published right after the verdict, and closing synchronously
 * inside the `verdict` handler can race it out if both arrive in the same chunk — the browser may
 * never dispatch an already-buffered `mastery` event once `close()` has been called. Instead we
 * arm a short grace period after `verdict` and close on whichever comes first: `mastery` arriving,
 * or the grace timer elapsing (covers `run` mode, which never sends `mastery`).
 *
 * The effect below intentionally depends on nothing but `submissionId`/`enabled`. Every other
 * option (`createEventSource`, `fetchSubmission`, the backoff bounds) is read through a ref that's
 * refreshed on every render, not through the effect's dependency array. Default parameter
 * expressions like `createEventSource = (url) => new EventSource(url)` produce a *new* function
 * every render — if that (or an un-memoized value a caller passes) were a dependency, the effect
 * would re-subscribe on every render, and since connecting itself triggers a state update, that
 * becomes an infinite reconnect loop. This isn't hypothetical: it's exactly the shape of bug that
 * showed up as a runaway-memory failure in this hook's own test suite during development.
 */
import { useEffect, useRef, useState } from "react";
import {
  type GetSubmissionResponse,
  type MasteryEvent,
  MasteryEventSchema,
  PingEventSchema,
  type SubmissionStatus,
  ProgressEventSchema,
  StatusEventSchema,
  type VerdictEvent,
  VerdictEventSchema,
} from "@leetmind/shared";
import { api, submissionEventsUrlWithAuth } from "../lib/api";

export type SSEConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface UseSubmissionEventsResult {
  status: SubmissionStatus | null;
  progress: { passed: number; total: number } | null;
  verdict: VerdictEvent | null;
  mastery: MasteryEvent | null;
  connectionState: SSEConnectionState;
  lastPingAt: string | null;
  reconnectAttempts: number;
}

export interface UseSubmissionEventsOptions {
  enabled?: boolean;
  /** Injectable for tests; defaults to the browser's `EventSource`. */
  createEventSource?: (url: string) => EventSource;
  /** Injectable for tests; defaults to `api.getSubmission`. */
  fetchSubmission?: (id: string) => Promise<GetSubmissionResponse>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long to keep the stream open after `verdict`, waiting for a trailing `mastery` event. */
  postVerdictGraceMs?: number;
}

function initialState(): UseSubmissionEventsResult {
  return {
    status: null,
    progress: null,
    verdict: null,
    mastery: null,
    connectionState: "idle",
    lastPingAt: null,
    reconnectAttempts: 0,
  };
}

const defaultCreateEventSource = (url: string) => new EventSource(url);

export function useSubmissionEvents(
  submissionId: string | null | undefined,
  options: UseSubmissionEventsOptions = {},
): UseSubmissionEventsResult {
  const {
    enabled = true,
    createEventSource = defaultCreateEventSource,
    fetchSubmission = api.getSubmission,
    baseBackoffMs = 1000,
    maxBackoffMs = 16000,
    postVerdictGraceMs = 3000,
  } = options;

  const [state, setState] = useState<UseSubmissionEventsResult>(initialState);

  // "Always latest" refs — updated every render (a plain assignment during render is safe here;
  // nothing reads them until an effect or event callback runs after commit). This is what lets
  // the effect below depend on only `submissionId`/`enabled` without going stale.
  const createEventSourceRef = useRef(createEventSource);
  createEventSourceRef.current = createEventSource;
  const fetchSubmissionRef = useRef(fetchSubmission);
  fetchSubmissionRef.current = fetchSubmission;
  const baseBackoffRef = useRef(baseBackoffMs);
  baseBackoffRef.current = baseBackoffMs;
  const maxBackoffRef = useRef(maxBackoffMs);
  maxBackoffRef.current = maxBackoffMs;
  const graceMsRef = useRef(postVerdictGraceMs);
  graceMsRef.current = postVerdictGraceMs;

  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);
  const terminalRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    terminalRef.current = false;
    attemptRef.current = 0;
    setState(initialState());

    if (!submissionId || !enabled) return;

    async function reconcile(id: string) {
      try {
        const { submission } = await fetchSubmissionRef.current(id);
        setState((prev) => {
          const next: UseSubmissionEventsResult = { ...prev, status: submission.status };
          if (submission.verdict && !prev.verdict) {
            next.verdict = {
              submission_id: submission.id,
              verdict: submission.verdict,
              passed_tests: submission.passed_tests,
              total_tests: submission.total_tests,
              runtime_ms: submission.runtime_ms ?? null,
              memory_kb: submission.memory_kb ?? null,
              failure: submission.failure ?? undefined,
              reveal: submission.reveal ?? undefined,
              practice: submission.practice ?? undefined,
            };
          }
          return next;
        });
      } catch {
        // Best-effort reconciliation — if this fails, the (re)established SSE stream is still
        // the source of truth going forward.
      }
    }

    function stopStream() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
    }

    function scheduleReconnect(id: string) {
      if (stoppedRef.current || terminalRef.current) return;
      void reconcile(id);
      const attempt = attemptRef.current;
      attemptRef.current += 1;
      const delay = Math.min(maxBackoffRef.current, baseBackoffRef.current * 2 ** attempt);
      setState((prev) => ({ ...prev, connectionState: "reconnecting", reconnectAttempts: attempt + 1 }));
      timerRef.current = setTimeout(() => void connect(id), delay);
    }

    async function connect(id: string) {
      if (stoppedRef.current || terminalRef.current) return;
      setState((prev) => ({
        ...prev,
        connectionState: attemptRef.current === 0 ? "connecting" : "reconnecting",
      }));

      // Awaited because the access token is resolved from the Supabase client, which may still be
      // restoring a persisted session. Re-check the stop flags afterwards: the component can unmount
      // (or the verdict can land) during that await, and opening a stream after teardown leaks it.
      const url = await submissionEventsUrlWithAuth(id);
      if (stoppedRef.current || terminalRef.current) return;

      const es = createEventSourceRef.current(url);
      esRef.current = es;

      es.addEventListener("open", () => {
        attemptRef.current = 0;
        setState((prev) => ({ ...prev, connectionState: "open" }));
      });

      es.addEventListener("status", (ev) => {
        const data = StatusEventSchema.parse(JSON.parse((ev as MessageEvent).data));
        setState((prev) => ({ ...prev, status: data.status }));
      });

      es.addEventListener("progress", (ev) => {
        const data = ProgressEventSchema.parse(JSON.parse((ev as MessageEvent).data));
        setState((prev) => ({ ...prev, progress: { passed: data.passed, total: data.total } }));
      });

      es.addEventListener("verdict", (ev) => {
        const data = VerdictEventSchema.parse(JSON.parse((ev as MessageEvent).data));
        terminalRef.current = true;
        setState((prev) => ({ ...prev, verdict: data, status: "completed" }));
        // Don't close synchronously — give a trailing `mastery` event a chance to arrive (see the
        // file-level comment). `mastery` (below) closes immediately once it lands; this timer is
        // the fallback for verdicts that never get one (e.g. `run` mode, or a non-accepted verdict
        // below the outcome threshold).
        if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
        graceTimerRef.current = setTimeout(() => {
          graceTimerRef.current = null;
          stopStream();
          setState((prev) => ({ ...prev, connectionState: "closed" }));
        }, graceMsRef.current);
      });

      es.addEventListener("mastery", (ev) => {
        const data = MasteryEventSchema.parse(JSON.parse((ev as MessageEvent).data));
        setState((prev) => ({ ...prev, mastery: data, connectionState: "closed" }));
        stopStream();
      });

      es.addEventListener("ping", (ev) => {
        const data = PingEventSchema.parse(JSON.parse((ev as MessageEvent).data));
        setState((prev) => ({ ...prev, lastPingAt: data.at }));
      });

      es.addEventListener("error", () => {
        es.close();
        if (esRef.current === es) esRef.current = null;
        scheduleReconnect(id);
      });
    }

    void connect(submissionId);

    return () => {
      stoppedRef.current = true;
      stopStream();
    };
     
  }, [submissionId, enabled]);

  return state;
}
