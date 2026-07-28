import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveTime } from "./useActiveTime";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useActiveTime", () => {
  it("accumulates time while visible and focused", () => {
    const { result } = renderHook(() => useActiveTime());

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.running).toBe(true);
    expect(result.current.activeMs).toBeGreaterThanOrEqual(900);
    expect(result.current.activeMs).toBeLessThanOrEqual(1100);
  });

  it("pauses on blur and resumes on focus, never counting the blurred interval", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { result } = renderHook(() => useActiveTime());

    act(() => vi.advanceTimersByTime(500));
    const beforeBlur = result.current.activeMs;
    expect(beforeBlur).toBeGreaterThan(0);

    act(() => {
      hasFocus.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current.running).toBe(false);

    act(() => vi.advanceTimersByTime(2000));
    // no time should have accumulated while blurred
    expect(result.current.activeMs).toBe(beforeBlur);

    act(() => {
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current.running).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.activeMs).toBeGreaterThan(beforeBlur);
  });

  it("pauses when the tab is hidden and never counts hidden time", () => {
    const { result } = renderHook(() => useActiveTime());

    // land exactly on a tick boundary so there's no partial-tick residue for pause() to flush
    act(() => vi.advanceTimersByTime(250));
    const beforeHide = result.current.activeMs;

    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.running).toBe(false);

    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.activeMs).toBe(beforeHide);

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.running).toBe(true);
  });

  it("pauses after the idle timeout with no keystroke/mouse activity, and resumes on activity", () => {
    const { result } = renderHook(() => useActiveTime({ idleTimeoutMs: 2000 }));

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.running).toBe(true);
    const beforeIdle = result.current.activeMs;

    // no activity for the remainder of the idle window
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current.running).toBe(false);
    const idleMs = result.current.activeMs;
    expect(idleMs).toBeGreaterThan(beforeIdle); // it kept running until the timeout fired

    // still idle — no further accumulation
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.activeMs).toBe(idleMs);

    // activity resumes tracking (still visible + focused)
    act(() => {
      window.dispatchEvent(new Event("mousemove"));
    });
    expect(result.current.running).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.activeMs).toBeGreaterThan(idleMs);
  });

  it("reset() zeroes the accumulated time without stopping measurement", () => {
    const { result } = renderHook(() => useActiveTime());

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.activeMs).toBeGreaterThan(0);

    act(() => result.current.reset());
    expect(result.current.activeMs).toBe(0);

    act(() => vi.advanceTimersByTime(300));
    expect(result.current.activeMs).toBeGreaterThan(0);
  });
});
