/**
 * Tracks "active" time on the workspace: milliseconds accumulated only while the tab is visible
 * AND the window is focused, paused immediately on `visibilitychange`/`blur`, and paused after
 * `idleTimeoutMs` (default 90s) with no keystroke or mouse activity. This is the number sent as
 * `active_ms` on submissions, skips, and give-ups (docs/CONTRACTS.md §8 uses it for the time
 * modifier and expected-minutes comparison) — it must never include time the user wasn't actually
 * looking at the problem.
 *
 * The returned `activeMs` can be hidden in the UI without affecting measurement (PLAN.md §8) —
 * that's purely a rendering choice made by the caller; this hook keeps counting regardless.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const TICK_MS = 250;

export interface UseActiveTimeOptions {
  idleTimeoutMs?: number;
  /** Start already paused (e.g. while a dialog blocks interaction). Defaults to false. */
  initiallyPaused?: boolean;
}

export interface UseActiveTimeResult {
  activeMs: number;
  running: boolean;
  /** Reset the accumulated time to zero (e.g. when navigating to a new problem). */
  reset: () => void;
}

export function useActiveTime(options: UseActiveTimeOptions = {}): UseActiveTimeResult {
  const { idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, initiallyPaused = false } = options;

  const [activeMs, setActiveMs] = useState(0);
  const [running, setRunning] = useState(false);

  const runningRef = useRef(false);
  const lastTickRef = useRef<number | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleRef = useRef(false);
  const disabledRef = useRef(initiallyPaused);

  const eligible = useCallback(() => {
    if (typeof document === "undefined") return false;
    return document.visibilityState === "visible" && document.hasFocus() && !idleRef.current && !disabledRef.current;
  }, []);

  const setRunningState = useCallback((next: boolean) => {
    if (runningRef.current === next) return;
    runningRef.current = next;
    setRunning(next);
  }, []);

  const start = useCallback(() => {
    if (runningRef.current) return;
    lastTickRef.current = Date.now();
    setRunningState(true);
  }, [setRunningState]);

  const flush = useCallback(() => {
    if (lastTickRef.current !== null) {
      const now = Date.now();
      const delta = now - lastTickRef.current;
      if (delta > 0) setActiveMs((ms) => ms + delta);
      lastTickRef.current = now;
    }
  }, []);

  const pause = useCallback(() => {
    if (!runningRef.current) return;
    flush();
    lastTickRef.current = null;
    setRunningState(false);
  }, [flush, setRunningState]);

  const evaluate = useCallback(() => {
    if (eligible()) start();
    else pause();
  }, [eligible, pause, start]);

  const armIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleRef.current = true;
      pause();
    }, idleTimeoutMs);
  }, [idleTimeoutMs, pause]);

  const onActivity = useCallback(() => {
    const wasIdle = idleRef.current;
    idleRef.current = false;
    armIdleTimer();
    if (wasIdle) evaluate();
  }, [armIdleTimer, evaluate]);

  const reset = useCallback(() => {
    setActiveMs(0);
    lastTickRef.current = runningRef.current ? Date.now() : null;
  }, []);

  useEffect(() => {
    disabledRef.current = initiallyPaused;
    evaluate();
    armIdleTimer();

    const onVisibility = () => evaluate();
    const onFocus = () => evaluate();
    const onBlur = () => evaluate();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("mousemove", onActivity);
    window.addEventListener("mousedown", onActivity);
    window.addEventListener("wheel", onActivity);

    const tick = setInterval(() => {
      if (runningRef.current) flush();
    }, TICK_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("mousedown", onActivity);
      window.removeEventListener("wheel", onActivity);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      clearInterval(tick);
      pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setup runs once; internals via refs
  }, []);

  return { activeMs, running, reset };
}
