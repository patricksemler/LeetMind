/**
 * Demo driver — makes `scripts/demo.sh` actually exercise the loop rather than narrate it.
 *
 * Seeds a real approved problem from the content plane's verified fixture, submits a correct and
 * an incorrect solution through the REAL API (which enqueues real judge jobs, executed in real
 * sandbox containers), waits for the streamed verdicts, and prints the resulting mastery change.
 *
 * Everything it creates is named `demo-*` so `demo.sh`'s cleanup can find it.
 *
 *   node --import tsx scripts/demo-drive.ts seed        # seed the pool, print the version id
 *   node --import tsx scripts/demo-drive.ts judge <id>  # submit correct + wrong, show verdicts
 *   node --import tsx scripts/demo-drive.ts mastery     # print the mastery delta + explanation
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, withTransaction } from "@leetmind/db";
import { newId } from "@leetmind/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const USER_ID = process.env.SINGLE_USER_ID ?? "00000000000000000000000001";
const API = `http://localhost:${process.env.API_PORT ?? 8099}`;

function fixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(ROOT, "content/tests/fixtures/sample_problem.json"), "utf8"),
  ) as Record<string, unknown>;
}

/** One approved problem, derived from the verified fixture but re-pointed at `conceptId` and
 * `rating`. Practice selection needs several candidates across concepts and difficulties before it
 * can fill warm-up / working / overload / recovery roles, so the demo seeds a small spread. */
async function seedOne(conceptId: string, rating: number, suffix: string): Promise<string> {
  const content = fixture();
  const problemId = newId();
  const versionId = newId();
  const internalName = `demo-${suffix}`;
  content.title = `${String(content.title)} (${conceptId} @${rating})`;
  content.concepts = [{ id: conceptId, role: "primary", weight: 1.0 }];
  (content.difficulty as Record<string, unknown>) = { rating, confidence: "verified" };

  content.problem_id = problemId;
  content.version = 1;
  content.state = "approved";
  content.internal_name = internalName;
  await insertVersion(problemId, versionId, internalName, content);
  return versionId;
}

/** Seeds problems + problem_versions(approved) + problem_concepts from the verified fixture. */
async function seed(): Promise<void> {
  const content = fixture();
  const problemId = newId();
  const versionId = newId();
  const internalName = `demo-${String(content.internal_name ?? "sample")}`;

  content.problem_id = problemId;
  content.version = 1;
  content.state = "approved";
  content.internal_name = internalName;

  await insertVersion(problemId, versionId, internalName, content);

  const hidden = (content.hidden_tests ?? []) as unknown[];
  process.stdout.write(
    `    seeded "${String(content.title)}" (${hidden.length} hidden tests, ` +
      `${(content.mutants_py as unknown[] | undefined)?.length ?? 0} mutants)\n`,
  );

  // A spread across concepts and ratings so practice selection has somewhere to widen into.
  const spread: [string, number, string][] = [
    ["arrays_hashing", 900, "warmup-arrays"],
    ["sliding_window", 1150, "working-window"],
    ["two_pointers", 1450, "overload-twoptr"],
    ["binary_search", 1050, "recovery-bsearch"],
  ];
  for (const [c, r, s] of spread) await seedOne(c, r, s);
  process.stdout.write(`    seeded ${spread.length} more across concepts 900–1450 for assembly\n`);
  process.stdout.write(`VERSION_ID=${versionId}\n`);
}

async function insertVersion(
  problemId: string,
  versionId: string,
  internalName: string,
  content: Record<string, unknown>,
): Promise<void> {
  const concepts = (content.concepts ?? []) as { id: string; role: string; weight: number }[];
  const difficulty = (content.difficulty ?? {}) as { rating?: number };
  const minutes = (content.expected_active_minutes ?? [10, 25]) as [number, number];

  await withTransaction(async (client) => {
    await client.query(`insert into problems (id, internal_name) values ($1, $2)`, [
      problemId,
      internalName,
    ]);
    await client.query(
      `insert into problem_versions
         (id, problem_id, version, state, content, title, difficulty_rating,
          difficulty_confidence, expected_min_minutes, expected_max_minutes, comparator,
          provenance, approved_at)
       values ($1,$2,1,'approved',$3,$4,$5,'verified',$6,$7,$8,$9, now())`,
      [
        versionId,
        problemId,
        JSON.stringify(content),
        String(content.title ?? "Demo problem"),
        difficulty.rating ?? 1200,
        minutes[0],
        minutes[1],
        String(content.comparator ?? "exact"),
        JSON.stringify(content.provenance ?? {}),
      ],
    );
    for (const c of concepts) {
      await client.query(
        `insert into problem_concepts (problem_version_id, concept_id, role, weight)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [versionId, c.id, c.role, c.weight],
      );
    }
  });
}

interface SubmissionView {
  status: string;
  verdict: string | null;
  passed_tests: number;
  total_tests: number;
  runtime_ms: number | null;
}

async function submitAndWait(
  versionId: string,
  source: string,
  label: string,
): Promise<SubmissionView | null> {
  const created = await fetch(`${API}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      problem_version_id: versionId,
      language: "python",
      source,
      mode: "submit",
      active_ms: 240_000,
    }),
  });
  if (!created.ok) {
    process.stdout.write(`    ${label}: submission rejected (${created.status})\n`);
    return null;
  }
  const { submission_id: id } = (await created.json()) as { submission_id: string };
  process.stdout.write(`    ${label}: queued as ${id} — awaiting verdict…\n`);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/api/submissions/${id}`);
    if (res.ok) {
      const body = (await res.json()) as { submission: SubmissionView };
      const s = body.submission;
      if (s.status === "completed") {
        process.stdout.write(
          `    ${label}: ${String(s.verdict).toUpperCase()} ` +
            `(${s.passed_tests}/${s.total_tests} tests, ${s.runtime_ms ?? "?"}ms)\n`,
        );
        return s;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write(`    ${label}: timed out waiting for a verdict\n`);
  return null;
}

async function judge(versionId: string): Promise<void> {
  const content = fixture();
  const correct = String(content.reference_solution_py ?? "");
  const sig = (content.signature ?? {}) as { name?: string; params?: { name: string }[] };
  const params = (sig.params ?? []).map((p) => p.name).join(", ");
  const wrong = `def ${sig.name ?? "solve"}(${params}):\n    return None\n`;

  await submitAndWait(versionId, correct, "correct solution");
  await submitAndWait(versionId, wrong, "deliberately wrong ");
}

async function mastery(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `select concept_id, round(rating::numeric, 1) as rating, round(uncertainty::numeric, 1) as rd,
            attempts, solves
     from user_concept_state
     where user_id = $1 and attempts > 0
     order by concept_id`,
    [USER_ID],
  );
  if (rows.length === 0) {
    process.stdout.write("    (no concept has evidence yet)\n");
    return;
  }
  for (const r of rows) {
    process.stdout.write(
      `    ${String(r.concept_id).padEnd(20)} rating=${r.rating}  ±${r.rd}  ` +
        `attempts=${r.attempts} solves=${r.solves}\n`,
    );
  }
  const ev = await pool.query(
    `select kind, round(outcome::numeric, 2) as outcome, evidence->>'explanation' as explanation
     from learning_events where user_id = $1 order by created_at desc limit 3`,
    [USER_ID],
  );
  for (const e of ev.rows) {
    process.stdout.write(`    [${e.kind} outcome=${e.outcome}] ${e.explanation ?? ""}\n`);
  }
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "seed") await seed();
  else if (cmd === "judge") await judge(arg!);
  else if (cmd === "mastery") await mastery();
  else {
    process.stderr.write("usage: demo-drive.ts seed | judge <versionId> | mastery\n");
    process.exitCode = 2;
  }
} finally {
  await getPool()
    .end()
    .catch(() => undefined);
}
