// Local test-only fixture: DDL for `jobs` + `worker_heartbeats` mirroring
// docs/CONTRACTS.md §3, kept independent of packages/db's migrations (owned
// by another agent) per task instructions.
import { Pool } from "pg";
import { assertTestDatabase } from "@leetmind/db";

export const TEST_DATABASE_URL =
  process.env.QUEUE_TEST_DATABASE_URL ??
  "postgres://leetmind:leetmind@localhost:55433/leetmind_queue_test";

// docs/CONTRACTS.md §13 rule 4: this suite already spins up its own throwaway container and
// never touches DATABASE_URL, so it's safe by construction — but the guard still applies (an
// operator could repoint QUEUE_TEST_DATABASE_URL at a real database), so assert it here too, at
// module load time, before any test in this package can run.
assertTestDatabase(TEST_DATABASE_URL);

export const SCHEMA_SQL = `
create table if not exists jobs (
  id text primary key,
  kind text not null,
  priority int not null default 100,
  payload jsonb not null,
  status text not null default 'queued',
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  leased_by text,
  last_error text,
  idempotency_key text unique,
  correlation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jobs_status_kind_priority_run_at_idx
  on jobs(status, kind, priority, run_at);
create index if not exists jobs_status_lease_expires_at_idx
  on jobs(status, lease_expires_at);

create table if not exists worker_heartbeats (
  worker_id text primary key,
  kind text not null,
  last_seen_at timestamptz not null,
  meta jsonb not null default '{}'
);
`;

/** Attempts to connect to the test database. Returns null (rather than
 * throwing) when unreachable, so callers can `describe.skipIf`. */
export async function tryConnect(): Promise<Pool | null> {
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 2000,
    max: 10,
  });
  try {
    await pool.query("select 1");
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

export async function setupSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query("truncate table jobs, worker_heartbeats;");
}

/** Raw insert bypassing Queue.enqueue(), for tests that need full control
 * over created_at (to make claim-ordering deterministic).
 *
 * `run_at` is deliberately NOT derived from `createdAt`: the test host's
 * clock and the (dockerized) Postgres server's clock can drift by tens of
 * milliseconds, which is enough to make a client-supplied `run_at` land in
 * the server's future and fail the `run_at <= now()` claim filter. Instead
 * `run_at` always defaults to a fixed point far in the past, computed
 * server-side, so claimability never depends on clock skew -- only the
 * (client-controlled, relative-only) `created_at` ordering does. */
export async function insertJobRaw(
  pool: Pool,
  job: {
    id: string;
    kind: string;
    priority: number;
    payload?: unknown;
    createdAt: Date;
    maxAttempts?: number;
    idempotencyKey?: string | null;
  },
): Promise<void> {
  await pool.query(
    `insert into jobs (id, kind, priority, payload, max_attempts, run_at, created_at, updated_at, idempotency_key)
     values ($1,$2,$3,$4,$5, now() - interval '1 day', $6,$6,$7);`,
    [
      job.id,
      job.kind,
      job.priority,
      job.payload ?? {},
      job.maxAttempts ?? 3,
      job.createdAt,
      job.idempotencyKey ?? null,
    ],
  );
}
