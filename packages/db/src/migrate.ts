#!/usr/bin/env node
// Dependency-free migration runner (CONTRACTS.md §3). No migration framework:
// plain SQL files applied in lexical order, each in its own transaction, with
// an advisory lock guarding the whole run so concurrent process starts are
// safe. Pure helpers are exported for unit testing without a live database;
// `main()` only runs when this file is executed directly (`tsx src/migrate.ts`).

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger, loadBaseConfig } from "@leetmind/shared";

const logger = createLogger("db-migrate");

/** Arbitrary fixed key for `pg_advisory_lock` — guards the whole migration run. */
export const MIGRATION_ADVISORY_LOCK_KEY = 4711;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

export interface MigrationFile {
  version: string; // filename without the .sql extension — the schema_migrations PK
  filename: string;
  fullPath: string;
}

/** Reads `dir` and returns every `*.sql` file, sorted lexically by filename. */
export async function listMigrationFiles(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({
      version: filename.slice(0, -".sql".length),
      filename,
      fullPath: path.join(dir, filename),
    }));
}

/** Pure: files not yet present in `applied`, preserving the lexical order of `files`. */
export function pendingMigrations(
  files: MigrationFile[],
  applied: ReadonlySet<string>,
): MigrationFile[] {
  return files.filter((f) => !applied.has(f.version));
}

/** Pure: next zero-padded `NNN` sequence number given existing migration filenames. */
export function nextVersionNumber(files: MigrationFile[]): string {
  let max = 0;
  for (const f of files) {
    const match = /^(\d+)_/.exec(f.filename);
    if (match?.[1]) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return String(max + 1).padStart(3, "0");
}

/** Pure: turns a free-form name into a filesystem-safe, lowercase, underscore slug. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedVersions(client: Client): Promise<Set<string>> {
  const res = await client.query<{ version: string }>("select version from schema_migrations");
  return new Set(res.rows.map((r) => r.version));
}

async function withAdvisoryLock<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query("select pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
  }
}

async function connect(): Promise<Client> {
  const config = loadBaseConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  return client;
}

/** Applies every unapplied migration file in `dir`, each in its own transaction. */
export async function up(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<void> {
  const client = await connect();
  try {
    await ensureMigrationsTable(client);
    await withAdvisoryLock(client, async () => {
      const applied = await getAppliedVersions(client);
      const files = await listMigrationFiles(dir);
      const pending = pendingMigrations(files, applied);

      if (pending.length === 0) {
        logger.info({ applied_count: applied.size }, "no pending migrations");
        return;
      }

      for (const file of pending) {
        const sql = await readFile(file.fullPath, "utf8");
        logger.info({ version: file.version, file: file.filename }, "applying migration");
        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("insert into schema_migrations (version) values ($1)", [file.version]);
          await client.query("COMMIT");
          logger.info({ version: file.version }, "migration applied");
        } catch (err) {
          await client.query("ROLLBACK");
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { version: file.version, file: file.filename, error: message },
            "migration failed",
          );
          throw err;
        }
      }
    });
  } finally {
    await client.end();
  }
}

/** Prints applied/pending status for every migration file, plus a summary line. */
export async function status(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<void> {
  const client = await connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);
    const files = await listMigrationFiles(dir);

    for (const file of files) {
      logger.info(
        { version: file.version, file: file.filename, applied: applied.has(file.version) },
        "migration status",
      );
    }

    const pendingCount = pendingMigrations(files, applied).length;
    logger.info(
      { applied_count: applied.size, pending_count: pendingCount, total: files.length },
      "migration status summary",
    );
  } finally {
    await client.end();
  }
}

/** Writes a new, empty, correctly-numbered `NNN_<slug>.sql` stub into `dir`. */
export async function create(name: string, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string> {
  const slug = slugify(name);
  if (!slug) {
    throw new Error("migrate create requires a non-empty <name> argument");
  }
  await mkdir(dir, { recursive: true });
  const files = await listMigrationFiles(dir);
  const num = nextVersionNumber(files);
  const filename = `${num}_${slug}.sql`;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, `-- ${filename}\n-- Describe this migration.\n`, { flag: "wx" });
  logger.info({ file: filename }, "created migration stub");
  return filename;
}

async function main(): Promise<void> {
  const [, , cmd = "up", ...rest] = process.argv;

  switch (cmd) {
    case "up":
      await up();
      break;
    case "status":
      await status();
      break;
    case "create":
      await create(rest.join(" "));
      break;
    default:
      logger.error({ cmd }, "unknown migrate subcommand (expected: up | status | create)");
      process.exitCode = 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: message }, "migrate command failed");
    process.exitCode = 1;
  });
}
