// Per-process test-database isolation (docs/CONTRACTS.md §13 — NORMATIVE).
//
// `assertTestDatabase` (testDb.ts) stops destructive fixtures from ever touching the
// *development* database. It does nothing, on its own, to stop two concurrently-running test
// PROCESSES sharing that one `algolift_test` database from colliding with each other: two
// `pnpm --filter <pkg> test` invocations are separate OS processes with no shared coordinator, so
// `apps/judge`'s chaos suite enqueuing `'generate'`-kind jobs while another process's suite does
// the same collides on the real, unnamespaced `jobs` table (this was observed directly —
// `assertNoStrayJobs()` in apps/judge/test/chaos/chaos-helpers.ts fired for real during
// development, per §13).
//
// The fix composes with the guard rather than replacing it: every connection this process's
// `DATABASE_URL` resolves to is additionally pinned, via the connection string's `options`
// parameter (`-c search_path=<schema>,public`), to a schema unique to this process. Postgres
// schemas are namespaces within one database — cheap to create, and every existing
// `TEST_DATABASE_URL` / CI secret / `assertTestDatabase` name-pattern check keeps working
// unchanged, since the database name itself never changes, only the search_path.
import { Client } from "pg";
import { assertTestDatabase, testDatabaseUrl } from "./testDb.js";
import { up } from "./migrate.js";

/**
 * Derives this OS process's schema name. Vitest has no `pytest-xdist`-style env var that
 * identifies a worker across separate `pnpm --filter <pkg> test` invocations (each is a wholly
 * separate process; `VITEST_POOL_ID` only distinguishes worker threads/processes *within one*
 * `vitest` invocation, which `fileParallelism: false` already serializes for these suites) — so
 * this combines it with `process.pid`, which is what actually varies between two concurrently
 * running `pnpm --filter @algolift/api test` / `pnpm --filter @algolift/judge test` processes,
 * the collision docs/CONTRACTS.md §13 documents. `TEST_WORKER_ID`, if set, wins outright — the
 * convention §13 anticipates CI setting per parallel job, so a CI run gets a stable,
 * human-readable schema name instead of a PID that's meaningless across machines/runs.
 */
export function testWorkerSchema(): string {
  const raw = process.env.TEST_WORKER_ID ?? `${process.env.VITEST_POOL_ID ?? "p"}-${process.pid}`;
  return `vitest_${raw.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

/** Returns `url` with an `options=-c search_path=<schema>,public` query parameter set (added or
 * replaced), so every connection opened against the resulting connection string — by `pg.Pool`,
 * a one-off `pg.Client`, or a wholly separate process that merely inherits this string via
 * `DATABASE_URL` in its environment (e.g. apps/judge's chaos suite spawns real child OS
 * processes, docs/CONTRACTS.md §13) — lands on `schema` without any of those call sites needing
 * their own `configure=`/`SET search_path` logic. */
export function withSchemaSearchPath(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

/** Best-effort `DROP SCHEMA ... CASCADE`, e.g. from a `setupFiles` module's `afterAll`, so a
 * throwaway per-process/per-file schema doesn't linger in `algolift_test` forever. Never throws —
 * a teardown hiccup (Postgres already gone, connection refused) must never turn a green test run
 * red; a leftover schema is harmless (the next run's `CREATE SCHEMA IF NOT EXISTS` plus its
 * already-applied-versions check in `ensureTestSchemaIsolation` is self-healing, docs/
 * CONTRACTS.md §13 rule 5), just untidy. `baseUrl` must be the UNSCOPED connection string (no
 * search_path `options`) — dropping a schema is itself schema-agnostic DDL. */
export async function dropTestSchema(schema: string, baseUrl: string): Promise<void> {
  try {
    const client = new Client({ connectionString: baseUrl });
    await client.connect();
    try {
      await client.query(`drop schema if exists "${schema.replace(/"/g, '""')}" cascade`);
    } finally {
      await client.end();
    }
  } catch {
    // best-effort — see doc comment above.
  }
}

let readyPromise: Promise<string> | null = null;

/**
 * Idempotent, memoized-per-process entry point: computes this process's schema (docs/CONTRACTS.md
 * §13), asserts `TEST_DATABASE_URL` is unambiguously a test database (defense in depth — the
 * schema split is *in addition to* that guard, never a replacement for it: a worker-scoped schema
 * inside the *development* database would still be a data-loss bug waiting to happen), creates
 * the schema if missing, applies the SAME migrations (`packages/db/migrations/*.sql`, via this
 * package's own `up()` runner — not a reimplementation) into it, and points
 * `process.env.DATABASE_URL` at a schema-scoped connection string for the rest of this process's
 * lifetime.
 *
 * Safe to call from more than one module (a vitest `setupFiles` entry AND a test package's own
 * `helpers.ts`, say) — the actual work happens once; every call after the first resolves the same
 * cached, already-resolved schema-scoped URL immediately.
 */
export async function ensureTestSchemaIsolation(): Promise<string> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const baseUrl = testDatabaseUrl();
      assertTestDatabase(baseUrl);
      const schema = testWorkerSchema();
      const scopedUrl = withSchemaSearchPath(baseUrl, schema);

      const client = new Client({ connectionString: baseUrl });
      await client.connect();
      try {
        await client.query(`create schema if not exists "${schema.replace(/"/g, '""')}"`);
      } finally {
        await client.end();
      }

      // migrate.ts's up() reads DATABASE_URL from the environment at call time (loadBaseConfig),
      // so setting it first is what scopes the migration run to the new schema.
      process.env.DATABASE_URL = scopedUrl;
      await up();

      return scopedUrl;
    })();
  }
  return readyPromise;
}
