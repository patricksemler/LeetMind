/**
 * Regression tests for SSE frame parsing (PLAN_BACKEND.md §9). The server side is sse-starlette,
 * whose default line separator is `\r\n` — so real frames terminate `\r\n\r\n`, a byte sequence
 * the old `indexOf("\n\n")` boundary scan never matched (no event ever fired and the buffer grew
 * without bound). The parser must accept any spec-legal blank-line boundary, and must hold a
 * frame whose separator is split across two network chunks until the closing bytes arrive.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeFrames, useGenerationEvents } from "./useGenerationEvents";

vi.mock("../lib/api", () => ({
  currentAccessToken: vi.fn(async () => "test-token"),
  eventsUrl: () => "http://localhost/api/events",
}));

function collect() {
  const frames: Array<{ event: string; data: string }> = [];
  const onFrame = (event: string, data: string) => void frames.push({ event, data });
  return { frames, onFrame };
}

describe("consumeFrames", () => {
  it("parses a CRLF-terminated frame (sse-starlette's framing)", () => {
    const { frames, onFrame } = collect();
    const rest = consumeFrames('event: generation\r\ndata: {"jobId":"j1"}\r\n\r\n', onFrame);
    expect(frames).toEqual([{ event: "generation", data: '{"jobId":"j1"}' }]);
    expect(rest).toBe("");
  });

  it("parses an LF-terminated frame", () => {
    const { frames, onFrame } = collect();
    const rest = consumeFrames('event: generation\ndata: {"jobId":"j2"}\n\n', onFrame);
    expect(frames).toEqual([{ event: "generation", data: '{"jobId":"j2"}' }]);
    expect(rest).toBe("");
  });

  it("holds a frame split mid-separator across chunks until it completes", () => {
    const { frames, onFrame } = collect();
    // First chunk ends one byte into the `\r\n\r\n` boundary's second line ending.
    let buffer = consumeFrames('data: {"jobId":"j3"}\r\n\r', onFrame);
    expect(frames).toEqual([]);
    expect(buffer).toBe('data: {"jobId":"j3"}\r\n\r');
    // The closing `\n` arrives in the next chunk; the frame parses exactly once.
    buffer = consumeFrames(buffer + "\n", onFrame);
    expect(frames).toEqual([{ event: "message", data: '{"jobId":"j3"}' }]);
    expect(buffer).toBe("");
  });

  it("ignores comment (ping) frames", () => {
    const { frames, onFrame } = collect();
    const rest = consumeFrames(": ping\r\n\r\n", onFrame);
    expect(frames).toEqual([]);
    expect(rest).toBe("");
  });

  it("parses multiple frames with mixed separators from one buffer", () => {
    const { frames, onFrame } = collect();
    const rest = consumeFrames(
      'event: generation\r\ndata: {"n":1}\r\n\r\n: ping\r\n\r\nevent: generation\ndata: {"n":2}\n\ndata: tail',
      onFrame,
    );
    expect(frames).toEqual([
      { event: "generation", data: '{"n":1}' },
      { event: "generation", data: '{"n":2}' },
    ]);
    expect(rest).toBe("data: tail");
  });
});

describe("useGenerationEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires onEvent with the JSON payload for CRLF-framed generation events", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(": ping\r\n\r\n"),
      // Frame split mid-payload across network chunks — must buffer, then fire once.
      encoder.encode('event: generation\r\ndata: {"jobId":"j1","status":"succeeded"'),
      encoder.encode("}\r\n\r\nevent: other\r\ndata: {}\r\n\r\n"),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        // Left open on purpose: closing would exercise the reconnect path, not parsing.
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, body: stream })) as unknown as typeof fetch,
    );

    const events: unknown[] = [];
    const { result, unmount } = renderHook(() =>
      useGenerationEvents({ onEvent: (event) => void events.push(event) }),
    );

    await waitFor(() => expect(events).toEqual([{ jobId: "j1", status: "succeeded" }]));
    expect(result.current.connectionState).toBe("open");
    unmount();
  });
});
