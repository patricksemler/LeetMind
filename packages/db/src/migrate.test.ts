import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMigrationFiles, nextVersionNumber, pendingMigrations, slugify } from "./migrate.js";

describe("migrate runner (pure helpers, no DB required)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "leetmind-migrations-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists .sql files sorted lexically by filename, ignoring non-.sql files", async () => {
    await writeFile(path.join(dir, "003_third.sql"), "-- third\n");
    await writeFile(path.join(dir, "001_first.sql"), "-- first\n");
    await writeFile(path.join(dir, "002_second.sql"), "-- second\n");
    await writeFile(path.join(dir, "README.md"), "not a migration\n");

    const files = await listMigrationFiles(dir);

    expect(files.map((f) => f.filename)).toEqual([
      "001_first.sql",
      "002_second.sql",
      "003_third.sql",
    ]);
    expect(files.map((f) => f.version)).toEqual(["001_first", "002_second", "003_third"]);
  });

  it("computes pending migrations as the set difference against applied versions, preserving order", async () => {
    await writeFile(path.join(dir, "001_init.sql"), "-- init\n");
    await writeFile(path.join(dir, "002_seed.sql"), "-- seed\n");
    await writeFile(path.join(dir, "003_more.sql"), "-- more\n");

    const files = await listMigrationFiles(dir);

    // Nothing applied yet: everything is pending, in lexical order.
    expect(pendingMigrations(files, new Set()).map((f) => f.version)).toEqual([
      "001_init",
      "002_seed",
      "003_more",
    ]);

    // First migration already applied: only the rest are pending (idempotency-under-partial-apply).
    expect(pendingMigrations(files, new Set(["001_init"])).map((f) => f.version)).toEqual([
      "002_seed",
      "003_more",
    ]);

    // Everything applied: re-running is a no-op.
    expect(
      pendingMigrations(files, new Set(["001_init", "002_seed", "003_more"])).map((f) => f.version),
    ).toEqual([]);
  });

  it("computes the next NNN version number from existing filenames", async () => {
    await writeFile(path.join(dir, "001_init.sql"), "-- init\n");
    await writeFile(path.join(dir, "002_seed.sql"), "-- seed\n");

    const files = await listMigrationFiles(dir);
    expect(nextVersionNumber(files)).toBe("003");
  });

  it("starts numbering at 001 for an empty migrations directory", async () => {
    expect(nextVersionNumber([])).toBe("001");
  });

  it("slugifies free-form migration names", () => {
    expect(slugify("Add Workouts Table")).toBe("add_workouts_table");
    expect(slugify("  leading/trailing spaces  ")).toBe("leading_trailing_spaces");
    expect(slugify("weird!!chars??here")).toBe("weird_chars_here");
  });
});
