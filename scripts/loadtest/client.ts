// Minimal HTTP + SSE client driving the real `/api/submissions` + `/api/submissions/:id/events`
// endpoints (docs/CONTRACTS.md §9, §4.5). No `eventsource` dependency: Node's global `fetch`
// exposes the response body as a `ReadableStream`, and the SSE wire format is simple enough
// (`event: X\ndata: Y\n\n` blocks) that a ~20-line parser is less risk than a new dependency.
//
// This client is deliberately "dumb" about timing: it only waits for a submission to reach a
// terminal state (so the load-generating session loop knows when to move on) and returns the
// verdict it saw. All PRECISE latency numbers (queue wait, end-to-end, judge execution time) are
// computed after the run from Postgres directly (stats.ts) — server-authoritative `created_at` /
// `completed_at` / `lease_expires_at` timestamps, not client-observed ones, and the same wait-time
// approximation `@leetmind/queue`'s `Queue.stats()` already uses (see stats.ts's doc comment) —
// avoiding both clock-skew and the SSE catch-up race (a submission that completes between POST
// returning and the SSE connection opening delivers its terminal event immediately with no
// 'assigned' event in between, which would silently bias a client-side-timed sample).

export interface CreateSubmissionResult {
  submissionId: string;
  language: "python" | "cpp";
}

export async function createSubmission(opts: {
  apiBase: string;
  problemVersionId: string;
  language: "python" | "cpp";
  source: string;
}): Promise<CreateSubmissionResult> {
  const res = await fetch(`${opts.apiBase}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      problem_version_id: opts.problemVersionId,
      language: opts.language,
      source: opts.source,
      mode: "submit",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable body>");
    throw new Error(`POST /api/submissions failed: ${res.status} ${res.statusText} — ${body}`);
  }
  const json = (await res.json()) as { submission_id: string; status: string };
  return { submissionId: json.submission_id, language: opts.language };
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** Parses one `\n\n`-delimited SSE block. Ignores comment lines (`: ...`). */
function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: dataLines.join("\n") };
  }
}

export interface WaitResult {
  verdict: string | null;
  timedOutWaiting: boolean;
  sawRunning: boolean;
  error?: string;
}

/** Streams `/api/submissions/:id/events` and resolves once a `verdict` event (or the SSE stream's
 * own catch-up-then-close terminal path, docs/CONTRACTS.md §4.5) is observed, or `timeoutMs`
 * elapses. Also reports whether a `status: running` transition was ever seen — used by the
 * lease-recovery scenario to know when it's safe to SIGKILL the worker holding the victim job. */
export async function waitForTerminal(opts: {
  apiBase: string;
  submissionId: string;
  timeoutMs: number;
  onRunning?: () => void;
}): Promise<WaitResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  let sawRunning = false;
  try {
    const res = await fetch(`${opts.apiBase}/api/submissions/${opts.submissionId}/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      return {
        verdict: null,
        timedOutWaiting: false,
        sawRunning,
        error: `SSE connect failed: ${res.status}`,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const parsed = parseSseBlock(block);
        if (!parsed) continue;

        if (parsed.event === "status") {
          const data = parsed.data as { status?: string };
          if (data.status === "running") {
            sawRunning = true;
            opts.onRunning?.();
          }
        }
        if (parsed.event === "verdict") {
          const data = parsed.data as { verdict?: string };
          clearTimeout(timeout);
          await reader.cancel().catch(() => {});
          return { verdict: data.verdict ?? null, timedOutWaiting: false, sawRunning };
        }
      }
    }
    return {
      verdict: null,
      timedOutWaiting: false,
      sawRunning,
      error: "SSE stream closed without a verdict event",
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      verdict: null,
      timedOutWaiting: aborted,
      sawRunning,
      error: aborted ? undefined : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
