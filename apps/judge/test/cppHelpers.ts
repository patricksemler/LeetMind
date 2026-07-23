// C++-specific test helpers for apps/judge — kept in a SEPARATE file from ./helpers.ts per the
// M4 file-boundary rule (helpers.ts is owned by the concurrent chaos/idempotency-suite agent).
// Reuses helpers.ts's problem-seeding/teardown/ctx machinery (import only, never edited) and adds
// the one thing it doesn't have: inserting a submission with `language: 'cpp'`.
import { insertSubmission, withTransaction, type SubmissionRow } from "@algolift/db";
import { newId } from "@algolift/shared";
import { TEST_USER_ID } from "./helpers.js";

export interface InsertCppSubmissionOpts {
  versionId: string;
  source: string;
  mode?: "run" | "submit";
  customInput?: unknown;
  activeMs?: number;
  correlationId?: string;
}

/** Same shape/defaults as helpers.ts's `insertTestSubmission`, except `language: 'cpp'` — see the
 * file header for why this can't just live there. */
export async function insertCppSubmission(opts: InsertCppSubmissionOpts): Promise<SubmissionRow> {
  const id = newId();
  return withTransaction((client) =>
    insertSubmission(client, {
      id,
      user_id: TEST_USER_ID,
      problem_version_id: opts.versionId,
      mode: opts.mode ?? "submit",
      language: "cpp",
      source: opts.source,
      source_hash: "test-fixture-cpp",
      status: "queued",
      custom_input: opts.customInput ?? null,
      active_ms: opts.activeMs ?? 0,
      correlation_id: opts.correlationId ?? null,
    }),
  );
}
