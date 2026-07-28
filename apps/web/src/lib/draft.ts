/**
 * Per-problem draft persistence so a reload never loses in-progress work. Keyed by problem id
 * alone — v1 is Python-only (PLAN_BACKEND.md decision 14), so there's no language dimension to
 * key on any more.
 */
const PREFIX = "leetmind:draft:";

export function draftKey(problemId: string): string {
  return `${PREFIX}${problemId}`;
}

export function loadDraft(problemId: string): string | null {
  try {
    return window.localStorage.getItem(draftKey(problemId));
  } catch {
    return null;
  }
}

export function saveDraft(problemId: string, source: string): void {
  try {
    window.localStorage.setItem(draftKey(problemId), source);
  } catch {
    // best-effort — private browsing / quota exceeded shouldn't crash the editor
  }
}
