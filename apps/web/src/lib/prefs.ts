/**
 * Small, best-effort store for UI preferences that should survive a reload — the split-pane width,
 * the editor language. Sibling of `draft.ts`, which does the same for in-progress source; kept
 * separate because a draft is per problem and per language, while these are one setting for the
 * whole app.
 *
 * Every access is wrapped: `localStorage` throws outright in some private-browsing modes and when
 * the origin's quota is full, and a preference is never worth taking the page down for.
 */
const PREFIX = "leetmind:pref:";

export function loadPref(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function savePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // best-effort — a preference that can't be stored just doesn't persist
  }
}

/** A stored number, or `fallback` when it's absent, unparseable, or out of the caller's range. */
export function loadNumberPref(key: string, fallback: number, min: number, max: number): number {
  const raw = loadPref(key);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}
