/**
 * Subscribes to `GET /api/events` (PLAN_BACKEND.md §9): generation job transitions for the
 * authenticated user. Consumed over `fetch`-based streaming rather than the native `EventSource`
 * API, which cannot send an `Authorization` header (§9, §11) — this endpoint is a plain
 * authenticated GET that happens to stream `text/event-stream` frames.
 *
 * On a drop (network blip, server restart) we reconnect with capped exponential backoff, same
 * shape as the old submission-events hook this replaces. There's no reconciliation fetch on
 * reconnect the way that hook had one: the only thing anyone does with an event here is treat it
 * as "something changed, go re-read `/api/practice/next`" (a pure, idempotent read), so a missed
 * event during a drop self-heals on the next poll of that read rather than needing its own replay.
 *
 * The effect depends on nothing but `enabled` — `onEvent` is read through a ref refreshed every
 * render, so callers can pass an inline closure without retriggering the subscribe/reconnect
 * dance on every render (see `useSubmissionEvents`'s file-level comment for why that matters: a
 * dependency on a fresh-every-render function is a reconnect-loop bug, not a hypothetical one).
 */
import { useEffect, useRef, useState } from "react";
import type { GenerationEvent } from "@shared";
import { currentAccessToken, eventsUrl } from "../lib/api";

export type SSEConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface UseGenerationEventsOptions {
  enabled?: boolean;
  onEvent?: (event: GenerationEvent) => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Parses complete SSE frames out of a growing text buffer, returning the still-incomplete
 * remainder to keep accumulating. A frame ends at a blank line, and the SSE spec lets each line
 * end with `\r\n`, `\n`, or `\r` — sse-starlette (our server) emits `\r\n`, so the boundary on
 * the wire is `\r\n\r\n` and a bare `indexOf("\n\n")` scan would never find it. Searching the
 * accumulated buffer (rather than normalizing chunk-by-chunk) also means a separator split
 * across two network chunks simply stays pending until the closing bytes arrive. Only
 * `event:`/`data:` fields are used; `:` comment lines (sse-starlette's heartbeat ping) and any
 * other field are ignored. Exported for unit tests; the hook below is the real consumer. */
export function consumeFrames(
  buffer: string,
  onFrame: (event: string, data: string) => void,
): string {
  const boundary = /\r?\n\r?\n/g;
  let start = 0;
  while (true) {
    const match = boundary.exec(buffer);
    if (match === null) break;
    const frame = buffer.slice(start, match.index);
    start = boundary.lastIndex;

    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) onFrame(event, dataLines.join("\n"));
  }
  return buffer.slice(start);
}

export function useGenerationEvents(options: UseGenerationEventsOptions = {}): {
  connectionState: SSEConnectionState;
} {
  const { enabled = true, baseBackoffMs = 1000, maxBackoffMs = 16000 } = options;

  const [connectionState, setConnectionState] = useState<SSEConnectionState>("idle");

  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;
  const baseBackoffRef = useRef(baseBackoffMs);
  baseBackoffRef.current = baseBackoffMs;
  const maxBackoffRef = useRef(maxBackoffMs);
  maxBackoffRef.current = maxBackoffMs;

  useEffect(() => {
    if (!enabled) {
      setConnectionState("idle");
      return;
    }

    let stopped = false;
    let attempt = 0;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function scheduleReconnect() {
      if (stopped) return;
      const delay = Math.min(maxBackoffRef.current, baseBackoffRef.current * 2 ** attempt);
      attempt += 1;
      setConnectionState("reconnecting");
      timer = setTimeout(() => void connect(), delay);
    }

    async function connect() {
      if (stopped) return;
      setConnectionState(attempt === 0 ? "connecting" : "reconnecting");

      const token = await currentAccessToken();
      if (stopped) return;

      controller = new AbortController();
      try {
        const res = await fetch(eventsUrl(), {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events stream: HTTP ${res.status}`);

        attempt = 0;
        setConnectionState("open");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = consumeFrames(buffer, (event, data) => {
            if (event !== "generation") return;
            try {
              onEventRef.current?.(JSON.parse(data) as GenerationEvent);
            } catch {
              // malformed frame — ignore, the next one is still trustworthy
            }
          });
        }
        if (stopped) return;
        scheduleReconnect();
      } catch {
        if (stopped) return;
        scheduleReconnect();
      }
    }

    void connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      setConnectionState("closed");
    };
  }, [enabled]);

  return { connectionState };
}
