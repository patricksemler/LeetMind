// @leetmind/db — pg pool, migration runner, and a thin parameterized-SQL repository layer.
// No ORM: every function here is a hand-written query. Row types (snake_case, mirroring the DB
// columns exactly) live in ./types.ts.

export * from "./types.js";

export {
  getPool,
  closePool,
  withTransaction,
  query,
  queryOne,
  queryWith,
  queryOneWith,
  currentCorrelationId,
} from "./pool.js";

export * from "./users.js";
export * from "./concepts.js";
export * from "./problems.js";
export * from "./submissions.js";
export * from "./events.js";
export * from "./verification.js";
export * from "./modelRuns.js";
export * from "./notify.js";
export * from "./workouts.js";
export * from "./testDb.js";
export * from "./testSchema.js";

// Migration runner (docs/CONTRACTS.md §13's schema-per-process test isolation invokes `up()`
// programmatically from testSchema.ts, so it needs to be reachable as `@leetmind/db`, not just
// `packages/db`'s own `pnpm migrate` CLI script).
export { up as runMigrations, DEFAULT_MIGRATIONS_DIR } from "./migrate.js";
