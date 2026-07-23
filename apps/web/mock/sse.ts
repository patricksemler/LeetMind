/**
 * Minimal SSE fan-out. Stands in for the API's dedicated LISTEN/NOTIFY client
 * (docs/CONTRACTS.md §4.5) — here events are just published in-process instead of coming off
 * Postgres NOTIFY, but the wire format (named SSE events, JSON data) is the same contract the
 * real API must serve.
 */
import type { Response } from "express";

const subscribers = new Map<string, Set<Response>>();
const pingTimers = new Map<Response, ReturnType<typeof setInterval>>();

export function subscribe(submissionId: string, res: Response): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  let set = subscribers.get(submissionId);
  if (!set) {
    set = new Set();
    subscribers.set(submissionId, set);
  }
  set.add(res);

  const ping = setInterval(() => sendEvent(res, "ping", { at: new Date().toISOString() }), 15_000);
  pingTimers.set(res, ping);

  res.on("close", () => {
    clearInterval(ping);
    pingTimers.delete(res);
    subscribers.get(submissionId)?.delete(res);
  });
}

function sendEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function publish(submissionId: string, event: string, data: unknown): void {
  const set = subscribers.get(submissionId);
  if (!set) return;
  for (const res of set) sendEvent(res, event, data);
}
