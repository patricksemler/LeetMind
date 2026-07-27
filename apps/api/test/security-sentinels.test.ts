// The single most important test in this service (apps/api brief): no response may contain
// `hidden_tests`, `mutants_py`, `reference_solution_py`, `brute_force_py`, `input_generator_py`,
// `checker_py`, or an untaken hint's text.
//
// Per the coordinator's explicit correction: assert on KEYS and SECRET VALUES, never on
// substrings of English prose — a blunt `.not.toContain("expected")` false-positives on messages
// like "did not match the expected result" (exactly the bug already hit and fixed in
// packages/sandbox). So every sentinel here is an opaque random token embedded directly into the
// secret field's content (`SENTINEL-...-<random>`), and hint text sentinels are baked into the
// hint's own copy — checking for the token substring can never collide with ordinary prose.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadApiConfig, newId } from "@leetmind/shared";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { notifyBus } from "../src/sse.js";
import {
  cleanup,
  collectKeys,
  isDatabaseReachable,
  seedApprovedProblem,
  testPool,
} from "./helpers.js";

const dbReachable = await isDatabaseReachable();

const FORBIDDEN_KEYS = [
  "hidden_tests",
  "mutants_py",
  "reference_solution_py",
  "brute_force_py",
  "input_generator_py",
  "checker_py",
];

describe.skipIf(!dbReachable)("security: server-only fields never leak", () => {
  let deps: Deps;
  let server: FastifyInstance;
  const pool = testPool();
  const created = {
    problemIds: [] as string[],
    problemVersionIds: [] as string[],
    submissionIds: [] as string[],
  };

  beforeAll(async () => {
    deps = buildDeps(loadApiConfig());
    server = buildServer(deps);
    await notifyBus.start();
  });

  afterAll(async () => {
    await cleanup(pool, {
      ...created,
      userId: deps.config.singleUserId,
      conceptIds: ["arrays_hashing"],
    });
    await notifyBus.stop();
    await server.close();
  });

  it("never leaks hidden_tests/mutants_py/reference_solution_py/brute_force_py/input_generator_py/checker_py keys or values, nor untaken hint text", async () => {
    const userId = deps.config.singleUserId;
    const seeded = await seedApprovedProblem(pool, {
      conceptId: "arrays_hashing",
      difficultyRating: 1200,
    });
    created.problemIds.push(seeded.problemId);
    created.problemVersionIds.push(seeded.problemVersionId);

    // Take only the first hint rung, so l2/l3/outline/editorial text must never appear anywhere.
    const takeHint = await server.inject({
      method: "POST",
      url: "/api/hints",
      payload: { problem_version_id: seeded.problemVersionId, level: "l1_orientation" },
    });
    expect(takeHint.statusCode).toBe(200);

    // A completed (accepted) submission, written directly (no judge exists yet) so the SSE
    // catch-up path and GET /api/submissions/:id both have real data to serve.
    const submissionId = newId();
    await pool.query(
      `insert into submissions (id, user_id, problem_version_id, mode, language, source, source_hash, status, verdict, passed_tests, total_tests, completed_at)
       values ($1, $2, $3, 'submit', 'python', 'def twoSum(nums, target):\n    return []\n', 'x', 'completed', 'accepted', 1, 1, now())`,
      [submissionId, userId, seeded.problemVersionId],
    );
    created.submissionIds.push(submissionId);

    const responses: Array<{ route: string; body: string }> = [];

    const capture = async (method: "GET" | "POST", url: string, payload?: unknown) => {
      const res = await server.inject({ method, url, payload });
      responses.push({ route: `${method} ${url}`, body: res.body });
      return res;
    };

    await capture("GET", "/api/concepts");
    await capture("GET", `/api/problems/${seeded.problemVersionId}`);
    await capture("GET", `/api/problems/next?concept=arrays_hashing&rating=1200`);
    await capture("GET", `/api/submissions/${submissionId}`);
    await capture("GET", `/api/submissions/${submissionId}/events`); // already terminal -> self-closes
    await capture("GET", `/api/hints/${seeded.problemVersionId}`);
    await capture("GET", "/api/progress");
    await capture("GET", "/api/system/stats");
    await capture("GET", "/api/baseline/current"); // no active baseline, must stay clean
    await capture("GET", "/api/practice/next"); // the practice loop serves a full public problem

    // Most sentinels must NEVER appear anywhere, on any route: l3/outline hint text, hidden-test
    // expected values, brute-force/generator/checker/mutant code.
    //
    // `editorialText` and `referenceSolution` are the two exceptions: this fixture's submission is
    // `verdict: 'accepted'`, which legitimately EARNS the post-solve `reveal` (docs/CONTRACTS.md
    // §4.5) on the submission routes — the solution write-up AND the reference implementation the
    // user is shown are both part of that reveal, so their presence there is correct behaviour, not
    // a leak. Both must still never appear on any OTHER route, and even on the submission routes
    // only inside `reveal.editorial_md` / `reveal.solutions`, built through the single allowlisted
    // constructor (`buildReveal` in mappers/submission.ts) — never spread loose. Note the
    // FORBIDDEN_KEYS check above still applies unchanged: the reveal exposes the code under
    // `solutions.python`, never under a `reference_solution_py` key.
    const { editorialText, referenceSolution, referenceSolutionCpp, ...neverRevealedSentinels } =
      seeded.sentinels;
    const earnedSentinels = {
      editorial_md: editorialText,
      "solutions.python": referenceSolution,
      "solutions.cpp": referenceSolutionCpp,
    };
    const REVEAL_EARNED_ROUTES = new Set([
      `GET /api/submissions/${submissionId}`,
      `GET /api/submissions/${submissionId}/events`,
    ]);

    for (const { route, body } of responses) {
      let parsedForKeys: unknown = null;
      try {
        parsedForKeys = JSON.parse(body);
      } catch {
        // SSE responses aren't a single JSON document; key-scan each `data: {...}` line instead.
        for (const line of body.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            parsedForKeys = JSON.parse(line.slice("data: ".length));
          } catch {
            continue;
          }
          const keys = collectKeys(parsedForKeys);
          for (const forbidden of FORBIDDEN_KEYS) {
            expect(keys.has(forbidden), `${route}: forbidden key "${forbidden}" present`).toBe(
              false,
            );
          }
        }
      }

      if (parsedForKeys && typeof parsedForKeys === "object") {
        const keys = collectKeys(parsedForKeys);
        for (const forbidden of FORBIDDEN_KEYS) {
          expect(keys.has(forbidden), `${route}: forbidden key "${forbidden}" present`).toBe(false);
        }
      }

      // Secret-VALUE check: every sentinel is an opaque random token unique to this test run, so
      // a substring match can only mean the actual secret leaked — never a prose collision.
      for (const sentinel of Object.values(neverRevealedSentinels)) {
        expect(body.includes(sentinel), `${route}: leaked sentinel value "${sentinel}"`).toBe(
          false,
        );
      }

      if (!REVEAL_EARNED_ROUTES.has(route)) {
        for (const [field, sentinel] of Object.entries(earnedSentinels)) {
          expect(
            body.includes(sentinel),
            `${route}: leaked ${field} sentinel outside an earned reveal`,
          ).toBe(false);
        }
        continue;
      }

      // On the reveal-earned routes, `editorial_md` and `solutions` legitimately appear — but ONLY
      // there. Blank those fields out and confirm both sentinels are gone from everything else in
      // the response (guards against `buildReveal` — or anything else — accidentally spreading raw
      // content instead of the explicit allowlist).
      const withoutReveal = stripRevealFields(body);
      for (const [field, sentinel] of Object.entries(earnedSentinels)) {
        expect(
          withoutReveal.includes(sentinel),
          `${route}: ${field} sentinel leaked outside reveal.${field}`,
        ).toBe(false);
      }
    }
  });
});

/** Blanks exactly `reveal.editorial_md` and `reveal.solutions` in a raw JSON/SSE response body
 * (handles both the plain-JSON `GET /api/submissions/:id` shape and the `data: {...}` SSE line), so
 * the remainder can be checked for those sentinels leaking anywhere else. */
function stripRevealFields(body: string): string {
  const replaceIn = (obj: unknown): unknown => {
    if (Array.isArray(obj)) return obj.map(replaceIn);
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      if ("reveal" in rec && rec.reveal && typeof rec.reveal === "object") {
        return {
          ...rec,
          reveal: { ...(rec.reveal as Record<string, unknown>), editorial_md: "", solutions: {} },
        };
      }
      return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, replaceIn(v)]));
    }
    return obj;
  };

  try {
    return JSON.stringify(replaceIn(JSON.parse(body)));
  } catch {
    // SSE: strip per `data: {...}` line, leave everything else untouched.
    return body
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data: ")) return line;
        try {
          return `data: ${JSON.stringify(replaceIn(JSON.parse(line.slice("data: ".length))))}`;
        } catch {
          return line;
        }
      })
      .join("\n");
  }
}
