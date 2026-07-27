import { Pool, type PoolClient, type QueryResultRow, types as pgTypes } from "pg";
import { createLogger, loadBaseConfig, logContext } from "@leetmind/shared";

const logger = createLogger("db");

// node-postgres returns int8/bigint as a *string* by default (to avoid silently losing precision
// above 2^53). Our row interfaces in ./types.ts declare those columns as `number`, so without this
// parser the declared type is a lie and TypeScript happily type-checks `row.total_active_ms + n`
// as addition while JavaScript performs string concatenation:
//
//     "240000" + 240000  ===  "240000240000"
//
// That is not hypothetical — it shipped. It silently corrupted `user_concept_state.total_active_ms`
// and then killed judge jobs with `value "240000240000240000240000" is out of range for type
// bigint`, three attempts each, straight to the dead-letter queue. Found by scripts/demo.sh.
//
// The only bigint column in the schema is `user_concept_state.total_active_ms` (accumulated active
// practice time in ms). Number.MAX_SAFE_INTEGER milliseconds is ~285,000 years, so parsing it as a
// JS number is lossless for any value this column can plausibly hold. If a genuinely large bigint
// column is ever added, give it a dedicated parser rather than widening this one.
pgTypes.setTypeParser(pgTypes.builtins.INT8, (value: string) => Number(value));

const SLOW_QUERY_THRESHOLD_MS = 250;

let pool: Pool | undefined;

/** Lazily creates (and memoizes) the singleton pg.Pool from DATABASE_URL / PGPOOL_MAX. */
export function getPool(): Pool {
  if (pool) return pool;

  const config = loadBaseConfig();
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
  });

  pool.on("error", (err) => {
    // Errors on idle clients (e.g. connection dropped) must not crash the process.
    logger.error({ err }, "postgres pool idle client error");
  });

  return pool;
}

/** Closes the singleton pool. Intended for graceful shutdown and test teardown. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = undefined;
  await p.end();
}

function truncateSql(sql: string, max = 300): string {
  return sql.length > max ? `${sql.slice(0, max)}…` : sql;
}

async function timedQuery<T extends QueryResultRow = QueryResultRow>(
  runner: { query: Pool["query"] },
  sql: string,
  params: readonly unknown[] | undefined,
): Promise<{ rows: T[]; rowCount: number }> {
  const startedAt = performance.now();
  const result =
    params === undefined
      ? await runner.query<T>(sql)
      : await runner.query<T>(sql, params as unknown[]);
  const durationMs = performance.now() - startedAt;

  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    logger.warn(
      {
        duration_ms: Math.round(durationMs),
        sql: truncateSql(sql),
        row_count: result.rowCount ?? 0,
      },
      "slow query",
    );
  }

  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

/** Runs a parameterized query against the pool and returns all rows. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
): Promise<T[]> {
  const { rows } = await timedQuery<T>(getPool(), sql, params);
  return rows;
}

/** Runs a parameterized query and returns the first row, or null if there were none. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Same as `query`, but against a specific client — for use inside `withTransaction`. */
export async function queryWith<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  sql: string,
  params?: readonly unknown[],
): Promise<T[]> {
  const { rows } = await timedQuery<T>(client, sql, params);
  return rows;
}

/** Same as `queryOne`, but against a specific client — for use inside `withTransaction`. */
export async function queryOneWith<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  sql: string,
  params?: readonly unknown[],
): Promise<T | null> {
  const rows = await queryWith<T>(client, sql, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a BEGIN/COMMIT transaction on a dedicated client. Rolls back and rethrows on
 * error; always releases the client back to the pool.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Reads the correlation id from the active shared log context, if any. */
export function currentCorrelationId(): string | undefined {
  return logContext.getStore()?.correlationId;
}
