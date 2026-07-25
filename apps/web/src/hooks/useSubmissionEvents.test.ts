import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetSubmissionResponse } from "@leetmind/shared";
import { useSubmissionEvents } from "./useSubmissionEvents";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  removeEventListener() {
    /* not needed by the hook under test */
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data ?? {});
    for (const cb of this.listeners.get(type) ?? []) cb({ data: payload } as MessageEvent);
  }
}

function lastES(): FakeEventSource {
  const inst = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!inst) throw new Error("no FakeEventSource instance created yet");
  return inst;
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function makeCreateEventSource() {
  return (url: string) => new FakeEventSource(url) as unknown as EventSource;
}

describe("useSubmissionEvents", () => {
  it("parses each named SSE event into state", async () => {
    // `createEventSource`/`fetchSubmission` must be stable across re-renders (exactly as a real
    // caller would pass a stable function): the hook's effect depends on them, and a fresh
    // reference created inline in the renderHook callback would rebind — and since `connect()`
    // itself triggers a state update, that would re-run the effect on every render forever.
    const createEventSource = makeCreateEventSource();
    const fetchSubmission = vi.fn();

    const { result } = renderHook(() => useSubmissionEvents("sub_1", { createEventSource, fetchSubmission }));

    expect(FakeEventSource.instances).toHaveLength(1);
    const es = lastES();

    act(() => es.emit("open"));
    expect(result.current.connectionState).toBe("open");

    act(() => es.emit("status", { submission_id: "sub_1", status: "running", at: "2026-07-22T00:00:00.000Z" }));
    expect(result.current.status).toBe("running");

    act(() => es.emit("progress", { submission_id: "sub_1", passed: 2, total: 5 }));
    expect(result.current.progress).toEqual({ passed: 2, total: 5 });

    act(() => es.emit("ping", { at: "2026-07-22T00:00:05.000Z" }));
    expect(result.current.lastPingAt).toBe("2026-07-22T00:00:05.000Z");

    // Server order (mock/lifecycle.ts): verdict, then mastery right behind it.
    act(() =>
      es.emit("verdict", {
        submission_id: "sub_1",
        verdict: "accepted",
        passed_tests: 5,
        total_tests: 5,
        runtime_ms: 40,
        memory_kb: 14000,
      }),
    );
    expect(result.current.verdict?.verdict).toBe("accepted");
    expect(result.current.status).toBe("completed");
    // Does NOT close synchronously on verdict — a trailing `mastery` event for the same
    // submission must not be raced out by an immediate close() (see the hook's file-level doc).
    expect(es.closed).toBe(false);

    act(() =>
      es.emit("mastery", {
        submission_id: "sub_1",
        changes: [
          { concept_id: "arrays_hashing", before_rating: 1200, after_rating: 1215, before_uncertainty: 300, after_uncertainty: 290 },
        ],
        outcome: 1,
        explanation: "Solved cleanly.",
      }),
    );
    expect(result.current.mastery?.explanation).toBe("Solved cleanly.");
    // `mastery` is always the last event for a submission — safe to close now.
    expect(es.closed).toBe(true);
  });

  it("reconnects with exponential backoff after the stream drops", async () => {
    vi.useFakeTimers();
    const fetchSubmission = vi.fn().mockResolvedValue({
      submission: { id: "sub_2", status: "running", passed_tests: 0, total_tests: 4, verdict: null },
    } as unknown as GetSubmissionResponse);
    const createEventSource = makeCreateEventSource();

    const { result } = renderHook(() =>
      useSubmissionEvents("sub_2", { createEventSource, fetchSubmission, baseBackoffMs: 1000, maxBackoffMs: 8000 }),
    );

    expect(FakeEventSource.instances).toHaveLength(1);

    // first drop -> reconnect after 1000ms
    act(() => lastES().emit("error"));
    expect(result.current.connectionState).toBe("reconnecting");
    expect(fetchSubmission).toHaveBeenCalledWith("sub_2");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(FakeEventSource.instances).toHaveLength(1); // not yet
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeEventSource.instances).toHaveLength(2); // reconnected

    // second drop -> backoff doubles to 2000ms
    act(() => lastES().emit("error"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("reconciles a verdict that landed while disconnected, via GET /api/submissions/:id", async () => {
    const fetchSubmission = vi.fn().mockResolvedValue({
      submission: {
        id: "sub_3",
        status: "completed",
        verdict: "accepted",
        passed_tests: 3,
        total_tests: 3,
        runtime_ms: 12,
        memory_kb: 9000,
        failure: null,
      },
    } as unknown as GetSubmissionResponse);
    const createEventSource = makeCreateEventSource();

    const { result } = renderHook(() => useSubmissionEvents("sub_3", { createEventSource, fetchSubmission }));

    // stream drops before any verdict event ever arrived
    act(() => lastES().emit("error"));

    await waitFor(() => expect(result.current.verdict?.verdict).toBe("accepted"));
    expect(fetchSubmission).toHaveBeenCalledWith("sub_3");
    expect(result.current.status).toBe("completed");
  });

  it("closes the stream after a grace period if no mastery event follows a verdict (e.g. run mode)", async () => {
    vi.useFakeTimers();
    const createEventSource = makeCreateEventSource();

    const { result } = renderHook(() =>
      useSubmissionEvents("sub_4", { createEventSource, fetchSubmission: vi.fn(), postVerdictGraceMs: 500 }),
    );
    const es = lastES();

    act(() =>
      es.emit("verdict", {
        submission_id: "sub_4",
        verdict: "wrong_answer",
        passed_tests: 0,
        total_tests: 1,
        runtime_ms: 10,
        memory_kb: 8000,
      }),
    );
    expect(es.closed).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(es.closed).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(es.closed).toBe(true);
    expect(result.current.connectionState).toBe("closed");
  });
});
