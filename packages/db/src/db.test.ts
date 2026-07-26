import { Client } from "pg";
import { loadBaseConfig } from "@leetmind/shared";
import { describe, expect, it } from "vitest";
import { up } from "./migrate.js";

const EXPECTED_TABLES = [
  "baseline_items",
  "baseline_sessions",
  "concept_edges",
  "concepts",
  "execution_attempts",
  "hint_events",
  "jobs",
  "learning_events",
  "model_runs",
  "problem_concepts",
  "problem_versions",
  "problems",
  "schema_migrations",
  "submissions",
  "user_concept_state",
  "users",
  "verification_reports",
  "worker_heartbeats",
];

async function isDatabaseReachable(): Promise<boolean> {
  const config = loadBaseConfig();
  const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 1000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

// Tests in this file need a live Postgres. Skipped automatically (rather than failing) when
// DATABASE_URL is unreachable, per this package's test policy.
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)("live database: migrations + seed", () => {
  it("applies all migrations end-to-end and creates every expected table", async () => {
    await up();

    const client = new Client({ connectionString: loadBaseConfig().databaseUrl });
    await client.connect();
    try {
      const res = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
      );
      const tables = res.rows.map((r) => r.table_name);
      for (const expected of EXPECTED_TABLES) {
        expect(tables, `expected table "${expected}" to exist`).toContain(expected);
      }
    } finally {
      await client.end();
    }
  });

  it("is idempotent: re-running the full migration set twice is a safe no-op", async () => {
    await up();
    await up();

    const client = new Client({ connectionString: loadBaseConfig().databaseUrl });
    await client.connect();
    try {
      const concepts = await client.query<{ count: number }>("select count(*)::int as count from concepts");
      expect(concepts.rows[0]?.count).toBe(20);

      const edges = await client.query<{ count: number }>("select count(*)::int as count from concept_edges");
      expect(edges.rows[0]?.count).toBe(20);

      const users = await client.query<{ count: number }>(
        "select count(*)::int as count from users where id = '00000000000000000000000001'",
      );
      expect(users.rows[0]?.count).toBe(1);

      const states = await client.query<{ count: number }>(
        "select count(*)::int as count from user_concept_state where user_id = '00000000000000000000000001'",
      );
      expect(states.rows[0]?.count).toBe(20);

      const migrations = await client.query<{ version: string }>(
        "select version from schema_migrations order by version",
      );
      // Asserted as a prefix-free exact list on purpose: a migration that ran but wasn't
      // recorded (or vice versa) is exactly the failure this catches.
      expect(migrations.rows.map((r) => r.version)).toEqual([
        "001_init",
        "002_seed_taxonomy",
        "003_baseline_replaces_workouts",
        "004_accounts",
        "005_rename_baseline_constraints",
      ]);
    } finally {
      await client.end();
    }
  });

  it("enforces the state check constraint on problem_versions", async () => {
    const client = new Client({ connectionString: loadBaseConfig().databaseUrl });
    await client.connect();
    try {
      await client.query(
        "insert into problems (id, internal_name) values ('01J0TESTPROBLEM0000000001', 'test-problem') on conflict do nothing",
      );
      await expect(
        client.query(
          `insert into problem_versions (id, problem_id, version, state, content, title, difficulty_rating)
           values ('01J0TESTVERSION000000001', '01J0TESTPROBLEM0000000001', 1, 'not_a_real_state', '{}', 'Test', 1200)`,
        ),
      ).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
