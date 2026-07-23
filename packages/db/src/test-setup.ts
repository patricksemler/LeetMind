// Vitest setupFile (see ../vitest.config.ts) — runs before any test file in this package. Per
// docs/CONTRACTS.md §13, tests never read `DATABASE_URL` (which defaults to the development
// database); they read `TEST_DATABASE_URL`. `@algolift/shared`'s `loadBaseConfig` (used by
// `getPool()` / `migrate.ts` / this package's own tests) only knows about `DATABASE_URL`, so this
// setup file is the redirection point: resolve `TEST_DATABASE_URL`, assert it is unambiguously a
// test database, and only then point `DATABASE_URL` at it for the lifetime of this test process.
// If the guard throws, the whole test run fails loudly here, before any test (and therefore
// before any destructive fixture) gets a chance to run.
import { assertTestDatabase, testDatabaseUrl } from "./testDb.js";

const url = testDatabaseUrl();
assertTestDatabase(url);
process.env.DATABASE_URL = url;
