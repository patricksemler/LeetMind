/**
 * Per-problem draft persistence, keyed by `versionId+language` (CONTRACTS.md §12 workspace
 * requirements) so a reload never loses in-progress work.
 */
const PREFIX = "leetmind:draft:";

export function draftKey(versionId: string, language: string): string {
  return `${PREFIX}${versionId}:${language}`;
}

export function loadDraft(versionId: string, language: string): string | null {
  try {
    return window.localStorage.getItem(draftKey(versionId, language));
  } catch {
    return null;
  }
}

export function saveDraft(versionId: string, language: string, source: string): void {
  try {
    window.localStorage.setItem(draftKey(versionId, language), source);
  } catch {
    // best-effort — private browsing / quota exceeded shouldn't crash the editor
  }
}
