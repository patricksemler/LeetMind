import { ulid } from "ulid";

/** Generate a new ULID string. Used as the primary key type for every table in the schema. */
export function newId(): string {
  return ulid();
}

// Crockford's Base32 alphabet (excludes I, L, O, U to avoid ambiguity with 1/0), 26 chars fixed
// width — the `ulid` package (unlike some others) does not export a validator, so we check the
// format directly.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Returns true if `s` is a syntactically valid ULID string. */
export function isId(s: unknown): s is string {
  return typeof s === "string" && ULID_RE.test(s);
}
