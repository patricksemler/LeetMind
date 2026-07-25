// Test database isolation guard (docs/CONTRACTS.md §13 — NORMATIVE).
//
// A data-loss defect was found in this repo: several test suites ran `truncate table jobs,
// model_runs, verification_reports, ...` against `DATABASE_URL`, which defaults to the
// **development** database. Since LeetMind is a tool its author uses daily, that silently
// destroyed real practice history.
//
// The fix is defence in depth: destructive test fixtures must never touch a database whose name
// doesn't unambiguously mark it as a test database. `assertTestDatabase` is that check — call it
// before any truncate/drop, and let it throw rather than continuing.

/** Default `TEST_DATABASE_URL` per docs/CONTRACTS.md §13 — same instance as `DATABASE_URL`, but
 * the `leetmind_test` database instead of `leetmind`. */
export const DEFAULT_TEST_DATABASE_URL = "postgres://leetmind:leetmind@localhost:5432/leetmind_test";

/** Returns `TEST_DATABASE_URL`, or the documented default. Tests should call this instead of
 * reading `DATABASE_URL` (which defaults to the development database) directly. */
export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
}

/** Extracts the database name (path component, leading slash stripped) from a Postgres
 * connection string. Returns `undefined` if the string can't be parsed as a URL at all. */
function extractDatabaseName(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return parsed.pathname.replace(/^\//, "");
}

const TEST_DB_NAME_PATTERN = /(^|_)test$/;

/**
 * Throws unless `url`'s database name is exactly `test` or ends in `_test`. This is the guard
 * that makes misconfiguration impossible: an operator who exports the wrong `TEST_DATABASE_URL`
 * gets a loud, failed test run instead of a wiped database. Call this before any destructive
 * fixture (truncate/drop) runs — never after.
 */
export function assertTestDatabase(url: string): void {
  const dbName = extractDatabaseName(url);

  if (dbName === undefined) {
    throw new Error(
      `assertTestDatabase: malformed database connection string ("${url}") — could not parse a ` +
        `database name out of it. Destructive test fixtures refuse to run without a connection ` +
        `string that clearly names a test database (name ending in "_test", e.g. "leetmind_test").`,
    );
  }

  if (!dbName) {
    throw new Error(
      `assertTestDatabase: connection string ("${url}") has no database name. Destructive test ` +
        `fixtures refuse to run without a database name ending in "_test" (or exactly "test"). ` +
        `Set TEST_DATABASE_URL to e.g. "postgres://leetmind:leetmind@localhost:5432/leetmind_test".`,
    );
  }

  if (!TEST_DB_NAME_PATTERN.test(dbName)) {
    throw new Error(
      `assertTestDatabase: refusing to run destructive test fixtures against database "${dbName}" ` +
        `— its name does not end in "_test" (or equal "test"). This guard exists because a prior ` +
        `data-loss incident truncated real practice history when tests ran against the ` +
        `development database (docs/CONTRACTS.md §13). Point TEST_DATABASE_URL at a database ` +
        `whose name ends in "_test", e.g. "postgres://leetmind:leetmind@localhost:5432/leetmind_test".`,
    );
  }
}
