/**
 * Server-composed prose refers to concepts by their taxonomy slug (`arrays_hashing`), because the
 * code that writes it — `@leetmind/learner`, and the practice route's target selection — has no
 * access to the concept table. The web app does, so it substitutes display names before rendering.
 *
 * Without this, one panel shows "arrays_hashing is your weakest concept" directly above a badge
 * reading "Arrays & Hashing", which reads like two different things.
 */
export function withConceptNames(
  text: string,
  conceptIds: readonly string[],
  names?: Record<string, string>,
): string {
  if (!names || !text) return text;
  let out = text;
  // Longest first: a shorter slug can be a substring of a longer one (`dp_1d` inside `dp_1d_2d`),
  // and replacing the short one first would corrupt the long one.
  for (const id of [...conceptIds].sort((a, b) => b.length - a.length)) {
    const name = names[id];
    if (!name || name === id) continue;
    out = out.split(id).join(name);
  }
  return out;
}
