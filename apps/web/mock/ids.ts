/**
 * Deterministic pseudo-ULIDs for fixture data, so problem/version/workout ids are stable across
 * mock-server restarts (handy for manual testing and screenshots). Runtime-created rows
 * (submissions, hint events, ...) use the real `newId()` from `@algolift/shared` instead.
 */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function fixedId(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  let x = h || 1;
  let out = "";
  for (let i = 0; i < 26; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += CROCKFORD_ALPHABET[x % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/** Matches `.env.example` / docs/CONTRACTS.md §1 single-user default. */
export const SINGLE_USER_ID = "00000000000000000000000001";
