// Shared test fixtures. The content plane (Python) isn't ready yet, so tests seed
// `problems`/`problem_versions` rows directly, as instructed in the apps/api brief.
//
// Test database isolation (docs/CONTRACTS.md §13 — MANDATORY, added after a data-loss defect:
// tests were truncating shared tables against `DATABASE_URL`, the *development* database, and
// silently destroyed real practice history). Tests here never read `DATABASE_URL` directly; they
// read `TEST_DATABASE_URL` (defaulting to `postgres://algolift:algolift@localhost:5432/algolift_test`).
// `assertTestDatabase` is the guard that makes misconfiguration impossible: it fails loudly,
// naming the offending database, rather than ever truncating one.
//
// `testDatabaseUrl`/`assertTestDatabase` live in `@algolift/db` (docs/CONTRACTS.md §13: "TS:
// `assertTestDatabase(url)` exported from `@algolift/db`") — imported and reused here rather than
// duplicated.
//
// `process.env.DATABASE_URL` itself is set once, by `test/testSetup.ts` (a vitest `setupFile`,
// which runs — and completes — before this module or any test file is even imported), to a
// schema-scoped URL: docs/CONTRACTS.md §13's schema-per-process isolation, so this process's
// `algolift_test` usage never collides with another concurrently-running test process's. This
// module does NOT re-assign `process.env.DATABASE_URL` (a previous version of this file did,
// unconditionally, to the *unscoped* `TEST_DATABASE_URL` — which would silently undo testSetup.ts's
// schema scoping for every consumer of `@algolift/db` in this process, including the
// server-under-test's own `getPool()` singleton, the moment this module loaded). The assertion
// below is defense in depth only: re-checking whatever `DATABASE_URL` actually ended up as, so a
// future change that removes `testSetup.ts` from `vitest.config.ts`'s `setupFiles` fails loudly
// here instead of silently reaching a destructive fixture.
import { Client, Pool } from "pg";
import { assertTestDatabase, testDatabaseUrl } from "@algolift/db";
import { loadBaseConfig, newId, type ProblemVersion } from "@algolift/shared";

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? testDatabaseUrl();
assertTestDatabase(TEST_DATABASE_URL);

export async function isDatabaseReachable(): Promise<boolean> {
  const config = loadBaseConfig();
  const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

let sharedPool: Pool | null = null;

/** A pool independent of the app's own `getPool()` singleton, so tests can freely open/close
 * connections (e.g. raw cleanup queries) without touching the server-under-test's pool. Always the
 * test database (docs/CONTRACTS.md §13) — `loadBaseConfig()` reads the `DATABASE_URL` this module
 * already forced onto `TEST_DATABASE_URL` above. */
export function testPool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: loadBaseConfig().databaseUrl, max: 5 });
  }
  return sharedPool;
}

export async function closeTestPool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}

/**
 * Unique sentinel strings planted in every server-only field of a seeded problem. If any of
 * these ever appear in an HTTP JSON response, the leak test (test/security-sentinels.test.ts)
 * fails — these values have no legitimate reason to ever leave the server.
 */
export function freshSentinels() {
  const tag = newId().slice(-8);
  return {
    hiddenTestExpected: `SENTINEL-HIDDEN-EXPECTED-${tag}`,
    mutant: `SENTINEL-MUTANT-${tag}`,
    referenceSolution: `SENTINEL-REFERENCE-SOLUTION-${tag}`,
    bruteForce: `SENTINEL-BRUTE-FORCE-${tag}`,
    inputGenerator: `SENTINEL-INPUT-GENERATOR-${tag}`,
    checker: `SENTINEL-CHECKER-${tag}`,
    l3Text: `SENTINEL-L3-HINT-${tag}`,
    outlineText: `SENTINEL-OUTLINE-HINT-${tag}`,
    editorialText: `SENTINEL-EDITORIAL-HINT-${tag}`,
  };
}

export interface SeededProblem {
  problemId: string;
  problemVersionId: string;
  content: ProblemVersion;
  sentinels: ReturnType<typeof freshSentinels>;
}

export interface SeedProblemOpts {
  state?: "candidate" | "verifying" | "approved" | "rejected" | "retired";
  difficultyRating?: number;
  conceptId?: string;
  conceptWeight?: number;
  title?: string;
}

/** Inserts a `problems` + `problem_versions` (+ `problem_concepts`) row with realistic content,
 * every server-only field carrying a unique sentinel. Returns everything a test needs to both
 * exercise the API and assert on cleanup. */
export async function seedApprovedProblem(pool: Pool, opts: SeedProblemOpts = {}): Promise<SeededProblem> {
  const sentinels = freshSentinels();
  const problemId = newId();
  const problemVersionId = newId();
  const conceptId = opts.conceptId ?? "arrays_hashing";
  const difficultyRating = opts.difficultyRating ?? 1200;

  const content: ProblemVersion = {
    problem_id: problemId,
    version: 1,
    title: opts.title ?? "Two Sum Variant",
    internal_name: `test-problem-${problemVersionId}`,
    statement_md: "Given an array of integers `nums` and a target, return indices of two numbers that add to target.",
    constraints_md: "2 <= nums.length <= 1000\n-1000 <= nums[i] <= 1000",
    signature: {
      name: "twoSum",
      params: [
        { name: "nums", type: "list[int]" },
        { name: "target", type: "int" },
      ],
      returns: "list[int]",
    },
    examples: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1], explanation: "nums[0] + nums[1] == 9" }],
    concepts: [{ id: conceptId, role: "primary", weight: opts.conceptWeight ?? 1 }],
    difficulty: { rating: difficultyRating, confidence: "generated" },
    expected_active_minutes: [5, 15],
    target_complexity: { time: "O(n)", space: "O(n)" },
    reference_solution_py: `# ${sentinels.referenceSolution}\ndef twoSum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n`,
    brute_force_py: `# ${sentinels.bruteForce}\ndef twoSum(nums, target):\n    for i in range(len(nums)):\n        for j in range(i + 1, len(nums)):\n            if nums[i] + nums[j] == target:\n                return [i, j]\n`,
    input_generator_py: `# ${sentinels.inputGenerator}\ndef generate(seed):\n    return []\n`,
    comparator: "unordered",
    checker_py: `# ${sentinels.checker}\n`,
    hidden_tests: [
      { args: [[3, 3], 6], expected: sentinels.hiddenTestExpected, origin: "adversarial", seed: 1 },
    ],
    mutants_py: [`# ${sentinels.mutant}\ndef twoSum(nums, target):\n    return []\n`],
    hints: {
      l1_orientation: "Think about what information you need to remember as you scan the array once.",
      l2_conceptual: "A lookup structure can tell you in O(1) whether the complement you need has already appeared.",
      l3_structural: `${sentinels.l3Text}: use a hash map from value to index, checking target-minus-current before inserting.`,
      outline: `${sentinels.outlineText}: 1) init empty map, 2) for each index/value, check complement in map, 3) else insert value->index.`,
      editorial_md: `${sentinels.editorialText}\n\nFull walkthrough of the one-pass hash map solution.`,
    },
    provenance: { mode: "novel", model: "test-fixture", prompt_version: "v1", generated_at: new Date().toISOString() },
    state: opts.state ?? "approved",
  };

  await pool.query("insert into problems (id, internal_name) values ($1, $2)", [problemId, content.internal_name]);
  await pool.query(
    `insert into problem_versions (
       id, problem_id, version, state, content, title, difficulty_rating,
       difficulty_confidence, expected_min_minutes, expected_max_minutes, comparator, provenance
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      problemVersionId,
      problemId,
      1,
      content.state,
      JSON.stringify(content),
      content.title,
      difficultyRating,
      "generated",
      content.expected_active_minutes[0],
      content.expected_active_minutes[1],
      content.comparator,
      JSON.stringify(content.provenance),
    ],
  );
  await pool.query(
    `insert into problem_concepts (problem_version_id, concept_id, role, weight) values ($1,$2,$3,$4)`,
    [problemVersionId, conceptId, "primary", opts.conceptWeight ?? 1],
  );

  return { problemId, problemVersionId, content, sentinels };
}

export interface CleanupScope {
  problemIds?: string[];
  problemVersionIds?: string[];
  submissionIds?: string[];
  /** `workouts` rows a test created — deleting these cascades to their `workout_items`
   * (`on delete cascade`, docs/CONTRACTS.md §3), so no separate workout-item cleanup is needed. */
  workoutIds?: string[];
  userId?: string;
  conceptIds?: string[];
}

/** Deletes everything a test created, in FK-safe order, and — if `userId`/`conceptIds` are given
 * — resets any touched `user_concept_state` rows back to the seed defaults so tests never leak
 * mastery-state pollution into the single shared local user. */
export async function cleanup(pool: Pool, scope: CleanupScope): Promise<void> {
  const submissionIds = scope.submissionIds ?? [];
  const problemVersionIds = scope.problemVersionIds ?? [];
  const problemIds = scope.problemIds ?? [];
  const workoutIds = scope.workoutIds ?? [];

  if (workoutIds.length > 0) {
    // Submissions may reference a workout_item without `on delete cascade` — null the FK first so
    // the cascade delete below never trips it (none of this suite's tests create such a
    // submission, but this keeps the helper correct if a future one does).
    await pool.query("update submissions set workout_item_id = null where workout_item_id in (select id from workout_items where workout_id = any($1))", [workoutIds]);
    await pool.query("delete from workouts where id = any($1)", [workoutIds]);
  }

  if (submissionIds.length > 0) {
    await pool.query("delete from execution_attempts where submission_id = any($1)", [submissionIds]);
    await pool.query("delete from learning_events where submission_id = any($1)", [submissionIds]);
    await pool.query(
      "delete from jobs where kind = 'judge' and payload->>'submission_id' = any($1::text[])",
      [submissionIds],
    );
    await pool.query("delete from submissions where id = any($1)", [submissionIds]);
  }

  if (problemVersionIds.length > 0) {
    await pool.query("delete from hint_events where problem_version_id = any($1)", [problemVersionIds]);
    await pool.query("delete from learning_events where problem_version_id = any($1)", [problemVersionIds]);
    await pool.query("delete from submissions where problem_version_id = any($1)", [problemVersionIds]);
    await pool.query("delete from verification_reports where problem_version_id = any($1)", [problemVersionIds]);
    await pool.query("delete from problem_concepts where problem_version_id = any($1)", [problemVersionIds]);
    await pool.query("delete from problem_versions where id = any($1)", [problemVersionIds]);
  }

  if (problemIds.length > 0) {
    await pool.query("delete from problems where id = any($1)", [problemIds]);
  }

  if (scope.userId && scope.conceptIds && scope.conceptIds.length > 0) {
    await pool.query(
      `update user_concept_state
          set rating = 1200, uncertainty = 350, attempts = 0, solves = 0, unassisted_solves = 0,
              skips = 0, current_streak = 0, best_streak = 0, total_active_ms = 0,
              hint_counts = '{}', error_counts = '{}', last_practiced_at = null,
              next_review_at = null, review_interval_days = 1, review_ease = 2.5, review_reps = 0,
              updated_at = now()
        where user_id = $1 and concept_id = any($2)`,
      [scope.userId, scope.conceptIds],
    );
  }
}

/** Recursively collects every string value in an arbitrary JSON-ish structure, for sentinel
 * leak-scanning a full HTTP response body. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

/** Recursively collects every object key present anywhere in an arbitrary JSON-ish structure. */
export function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}
