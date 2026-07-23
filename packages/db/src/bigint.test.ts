import { afterAll, describe, expect, it } from "vitest";
import { getPool } from "./pool.js";

// Regression: node-postgres returns int8/bigint as a *string* by default, while our row
// interfaces declare `total_active_ms` as `number`. That mismatch made `row.total_active_ms + n`
// type-check as addition while executing as string concatenation ("240000" + 240000 =
// "240000240000"), corrupting the column and dead-lettering judge jobs. pool.ts registers an INT8
// parser to make the declared types honest; this test is what stops it being removed.
describe("bigint columns are parsed as numbers, not strings", () => {
  afterAll(async () => {
    await getPool().end().catch(() => undefined);
  });

  it("returns int8 as a JS number", async () => {
    const { rows } = await getPool().query<{ v: number }>("select 240000::bigint as v");
    expect(typeof rows[0]!.v).toBe("number");
    expect(rows[0]!.v).toBe(240000);
  });

  it("makes + behave as addition, not concatenation", async () => {
    const { rows } = await getPool().query<{ v: number }>("select 240000::bigint as v");
    expect(rows[0]!.v + 240000).toBe(480000);
    expect(String(rows[0]!.v + 240000)).not.toBe("240000240000");
  });

  it("reads user_concept_state.total_active_ms as a number", async () => {
    const { rows } = await getPool().query<{ total_active_ms: number | null }>(
      "select total_active_ms from user_concept_state limit 1",
    );
    if (rows.length > 0 && rows[0]!.total_active_ms !== null) {
      expect(typeof rows[0]!.total_active_ms).toBe("number");
    }
  });
});
