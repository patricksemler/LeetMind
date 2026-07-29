import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setAccessTokenGetter } from "./api";

afterEach(() => {
  setAccessTokenGetter(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("practice API reads", () => {
  it("aborts a hung practice read after ten seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const rejection = expect(api.practiceNext()).rejects.toMatchObject({
      status: 408,
      code: "request_timeout",
    } satisfies Partial<ApiError>);
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("forwards React Query cancellation to fetch", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const rejection = expect(api.practiceNext(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();

    await rejection;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
