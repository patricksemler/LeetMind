# Refactor & Cleanup Plan

Branch: `refactor/cleanup-pass`, forked from `2a09f43`.

## Baseline (recorded before any change)

| Check            | Result                                        |
| ---------------- | --------------------------------------------- |
| `pnpm typecheck` | **PASS** (exit 0, 9 projects)                 |
| `pnpm build`     | **PASS** (exit 0)                             |
| `pnpm test`      | **PASS** — 474 tests / 64 files, exit 0       |
| `pnpm lint`      | **VACUOUS PASS** — see below                  |
| `content` pytest | **PASS** — 199 tests                          |
| `content` ruff   | **FAIL (pre-existing)** — 41 × E501           |
| `content` mypy   | **FAIL (pre-existing)** — 7 errors in 3 files |

Nothing in this pass may regress the four green rows. The two Python failures are
pre-existing, are not run by `pnpm test`, and are **not** fixed here.

### `pnpm lint` is a no-op — flagged, not resolved

No package defines a `lint` script, and there is no ESLint, Prettier, Biome, or
`.editorconfig` anywhere in the repo. `pnpm lint` exits 0 because it matches nothing.

Consequently the brief's "run the project's formatter and linter with autofix at the
end" **cannot be executed**, and "find dead code with `eslint --report-unused-disable-directives`"
is unavailable. Adding ESLint + Prettier now would reformat all 239 TypeScript files
and impose a style the codebase never chose — the opposite of "match what the majority
of the codebase already does." **Deliberately not done.** Recommended as a separate,
single-purpose PR so the reformat diff is reviewable on its own.

Side effect worth knowing: the `// eslint-disable-next-line` comments at
`packages/sandbox/src/cli.ts:47` and `apps/web/e2e/smoke.spec.ts:68` are inert. They
are left in place as intent markers for the day a linter is added.

### Tooling actually used for dead-code detection

`knip` (ran clean), `depcheck`, `tsc --noUnusedLocals --noUnusedParameters`, plus
hand-verification of **every** hit. Knip produced a high false-positive rate on this
repo — see "Rejected findings" at the bottom.

---

## Standing constraint

The comments in this codebase are unusually good: they explain _why_, cite
`CONTRACTS.md` sections, and record deliberate deviations. **No comment is deleted for
being long.** Only genuinely stale comments (referring to removed code) are touched.
The brief's "delete comments that restate the code" finds almost nothing here.

---

## A. Dead code — deletions

| #   | Change                                                                         | Justification                                                                                                                          |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Delete `apps/web/src/components/workspace/MasteryDelta.tsx` (72 lines)         | Zero importers repo-wide; only self-reference is its own `export function`.                                                            |
| A2  | Delete `Meter` from `apps/web/src/components/ui/Meter.tsx`, keep `RatingMeter` | `Meter` has no call site; `RatingMeter` in the same file is used at `Progress.tsx:115`. Barrel re-export keeps `RatingMeter` exported. |
| A3  | Delete `parseContent` from `apps/api/src/lib/candidatePool.ts:118`             | Genuinely unreachable — no call site in `src` or `test`.                                                                               |
| A4  | Un-export (keep private) `NotifyBus` class in `apps/api/src/sse.ts:17`         | Only the `notifyBus` singleton is imported anywhere; the class export is surface with no consumer. Logic untouched.                    |
| A5  | Wire up `formatRating`, then keep it                                           | See C3 — it is currently dead only because 3 call sites reimplement it inline.                                                         |
| A6  | Delete `formatPercent` from `apps/web/src/lib/format.ts:12`                    | No call site, and no inline reimplementation to wire up.                                                                               |

**Public-export deletions flagged per the brief:** A2 (`Meter`) and A6 (`formatPercent`)
remove exports from `apps/web`, a private application bundle with no external consumers —
low risk, but called out here rather than removed silently.

## B. Modularity — splits

No file is split for line count alone; each split follows a seam that already exists.

| #   | Change                                                                                                                                                                                                                                                                              | Justification                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `packages/shared/src/types/submission.ts` (629) → split by route family into `progress.ts`, `system.ts`, `practice.ts`, `hints.ts`, `misc.ts`, leaving submission-domain types in place                                                                                             | The file holds ~6 unrelated DTO families (progress dashboard, ops stats, practice loop, hints, health/me/generate/concepts) that only share a filename. `index.ts` re-exports, so **no import site anywhere changes**. |
| B2  | `apps/api/src/routes/practice.ts` (696) → extract `lib/practiceSelection.ts` (pure: `chooseTarget`, `bandOf`, `primaryConceptOf`) and `lib/practiceQueries.ts` (`seenInBaseline`, `coldStartHistory`, `recentTitles`, `findInFlightGeneration`, `attemptCount`, `ensureGeneration`) | Three helpers are pure and currently untestable without booting Fastify. The route keeps the 4-tier resolution logic and its excellent header comment.                                                                 |
| B3  | `apps/api/src/routes/submissions.ts` (376) → move `isPracticeSubmission`, `enrichSubmission`, `loadMasteryEventForSubmission`, `baseVerdictEventPayload`, `verdictEventPayload` to `mappers/submission.ts`                                                                          | Five DB-dependent view-shaping helpers sitting in a route file, already calling into `mappers/submission.ts`.                                                                                                          |
| B4  | `apps/api/src/routes/hints.ts` (341) → extract the give-up transaction body to `lib/giveUp.ts`                                                                                                                                                                                      | A ~160-line handler inlines an entire row-locked mastery-update transaction.                                                                                                                                           |
| B5  | `apps/api/src/routes/progress.ts` (191) → extract `computeBestImprovement` + trend merge to `lib/progressStats.ts`                                                                                                                                                                  | Pure post-processing with zero I/O, trapped in a handler closure.                                                                                                                                                      |
| B6  | `packages/sandbox/src/cpp/codegen.ts` (677) → move `STATIC_PRELUDE`/`STATIC_HARNESS` to `cpp/harness-template.ts`                                                                                                                                                                   | ~520 of 677 lines are an embedded C++ program stored as template strings. `codegen.ts` drops to ~110 lines of actual TypeScript.                                                                                       |
| B7  | `packages/sandbox/src/run.ts` (433) → extract `oom-watcher.ts` (`looksLikeOomFallback`, `watchForOomEvent`) and `docker-args.ts` (`resolveWorkDir`, `resolveDockerBin`, `buildDockerArgs`)                                                                                          | The OOM subsystem is the trickiest logic in the file and is self-contained; `buildDockerArgs` is already pure and snapshot-tested.                                                                                     |
| B8  | `apps/web/mock/server.ts` (716) → split into `mock/routes/{problems,submissions,hints,progress,misc}.ts`                                                                                                                                                                            | Pure Express route registration, already grouped by resource with section comments.                                                                                                                                    |
| B9  | **`apps/web/src/routes/Problem.tsx` (527) → extract `hooks/useProblemWorkspace.ts` + column components**                                                                                                                                                                            | **Gated on B9a — see "Test coverage" below.**                                                                                                                                                                          |
| B9a | Add characterization tests for `Problem.tsx` **before** B9                                                                                                                                                                                                                          | This file has **zero tests** and owns the submission-lifecycle state machine. Restructuring it blind is unsafe.                                                                                                        |

**Not split, deliberately:** `packages/queue/src/queue.ts` (421) is one cohesive `Queue`
class — splitting it would fight the class boundary. `packages/db/src/types.ts` (365) is
declaration-only and already organized to mirror the repository modules; relocating row
types is churn across every import for no correctness gain. `apps/judge/src/handler.ts`
(288) is the deliberate single orchestrator for the submission state machine and says so
in its header.

## C. Deduplication — only genuine 3+ repetitions

The brief's rule (two is fine, three is a signal) is applied strictly.

| #   | Change                                                                                           | Sites                                                                                        | Justification                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Consolidate `defaultConceptState`                                                                | `lib/candidatePool.ts:17`, `routes/problems.ts:22`, `routes/hints.ts:49`                     | **3 sites**, all re-declaring rating 1200 / uncertainty 350. Two projections (learner-state view, DB-row view) over one definition. |
| C2  | Shared `<RouteLoading />` and `<QueryError />`                                                   | 4 loading sites, 5 error+retry sites across `Problem/Progress/Concepts/Practice.tsx`         | **4–5 sites** of near-identical markup with drifting classNames.                                                                    |
| C3  | Use existing `formatRating`                                                                      | `MasteryDelta.tsx:43` (deleted by A1), `Concepts.tsx:87`, `Progress.tsx:109`, `Meter.tsx:78` | **3 surviving sites** reimplement `Math.round(r).toString()` inline while the helper sits unused. Behaviour-identical.              |
| C4  | Shared verdict-tone helper                                                                       | 6 sites across `CaseDetail.tsx`, `SubmissionsPanel.tsx`                                      | **6 sites** independently encoding the same pass/fail → Tailwind-class ternary.                                                     |
| C5  | `routes/problems.ts:35` `toCandidateProblem` → reuse `lib/candidatePool.ts:57` `toPoolCandidate` | 2 sites                                                                                      | Only 2 sites, but it is the _same_ JSON parser with one a strict subset of the other — "same logic", not "similar-looking".         |

**Rejected as premature:** `JobKind`/`JobStatus` are declared in three places
(`shared/types/jobs.ts:8`, `db/types.ts:331`, `queue/types.ts:17`). Unifying them means
`db` and `queue` taking a type dependency direction they currently avoid. Noted as a
risk below rather than changed — it is an architecture decision, not a cleanup.

## D. Consistency

| #   | Change                                                                       | Justification                                                                                                              |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1  | Normalize 8 inline `{ type X }` imports to separate `import type` statements | Majority convention is 25 separate `import type` vs 8 inline. Matches the existing majority.                               |
| D2  | Convert 4 `.then()` chains to `async`/`await`                                | `Problem.tsx:137`, `HintLadder.tsx:81`, `NavBar.tsx:53`, `auth.tsx:66`. Majority style is `async`/`await` everywhere else. |

Export style needs no work — zero default exports repo-wide, already consistent.
Import ordering already follows external → relative everywhere.

## E. Correctness

| #   | Change                                                                      | Justification                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Leave the single `as any` at `packages/sandbox/src/cli.ts:48` **unchanged** | It is a documented, justified escape hatch around `process.stderr.write`'s non-unifying overloads, with a 6-line comment explaining why. Replacing it would require inventing a type that isn't verifiable. |

The codebase is otherwise `any`-free, has no `console.log` debug leftovers (every
`console.*` is legitimate CLI output), no commented-out code, and zero TODO/FIXME
markers. Categories the brief anticipated that simply do not apply here.

---

## Bugs found — NOT fixed

Behaviour is left exactly as-is. Each of these deserves its own PR.

1. **`PROMPT_VERSION` drift (TS ↔ Python).** `apps/api/src/routes/generate.ts:20` and
   `apps/api/src/routes/practice.ts:80` both hardcode `"v1"` with a comment claiming they
   track the Python side. The Python generator switched to v2:
   `content/leetmind_content/generation/generator.py:31` imports from `prompts/v2.py`
   (`PROMPT_VERSION = "v2"`, `v2.py:61`). Every `GenerationRequest` the API builds is
   therefore tagged `v1` while `model_runs.prompt_version` records `v2`.
2. **Same drift on the Python side.** `content/leetmind_content/workers/replenish.py:29`
   imports `PROMPT_VERSION` from `prompts/v1.py` and stamps it at `replenish.py:254`.
   The field is never read by either prompt builder — dead on arrival and inconsistent
   with what `generator.py` records. No test asserts on it.
3. **`AppError` leaks into an HTTP-agnostic package.** `packages/db/src/notify.ts:21`
   throws `AppError(..., 500, ...)`. The other 16 invariant violations in `packages/db`
   throw plain `Error`. `apps/judge` consumes `db` and never handles `AppError`.
   Changing the thrown type would change the API's error envelope, so it is a behaviour
   change, not a refactor.
4. **`apps/web/e2e/smoke.spec.ts` is stale and cannot pass.** It navigates to `/baseline`
   (lines 44, 85) and clicks "Start baseline" (line 48) — a route and flow deleted in
   `2a09f43`. It also asserts on `[data-testid="verdict-panel"]`, which exists nowhere in
   `src`. Playwright is not part of `pnpm test`, so this has been failing invisibly.
   Rewriting it needs a live stack and product decisions about what the flow now is —
   **needs your eyes.**
5. **Python `mypy` failures (7).** Includes two _unused_ `# type: ignore` comments
   (`queue.py:157`, `codegen.py:190`) where `queue.py:157` still has a live
   `call-overload` error the stale ignore doesn't cover.

## Rejected findings — tooling false positives

Verified by hand and **kept**:

- `scripts/demo-drive.ts` — knip "unused file"; invoked by `scripts/demo.sh:194,225,235`.
- `apps/judge/test/chaos/worker-process.ts` — knip "unused file"; spawned as a subprocess.
- `hast-util-sanitize` — knip "unused dependency"; `rehype-sanitize` re-exports
  `defaultSchema` from it (`Markdown.tsx:11`), and declaring it directly is _correct_
  under pnpm's strict isolation.
- `pino-pretty` — knip "unused dependency"; referenced as a dynamic transport target
  string at `packages/shared/src/logger.ts:65`. Removing it breaks pretty logging at runtime.
- `requestToken`, `createTokenVerifier`, `recentAttemptsForConcept`,
  `PYTHON_LANGUAGE_VERSION`, `CPP_LANGUAGE_VERSION`, `CPP_COMPILE_FLAGS`,
  `TEST_DATABASE_URL`, `SCHEMA_SQL`, `draftKey`, `currentAccessToken`,
  `submissionEventsUrl`, `makeTestQueryClient`, `AuthForm` — all live, all called within
  their own module. Knip flags "exported but not imported elsewhere", which is a
  different claim from "unused".
- `apps/judge/src/mastery.ts` vs `packages/learner/src/mastery.ts` — **not** duplicates.
  The learner file is the pure predicate (`isMastered`); the judge file is its only
  caller plus DB/locking concerns. Correct separation, verified by grep for a second
  implementation (none exists).

## Test coverage gap

`apps/web/src/routes/Problem.tsx` (527 lines, the app's largest and most stateful file)
has **no tests**, and its only nominal coverage — `e2e/smoke.spec.ts` — is broken
(bug #4). It owns: three queries, one mutation, a hand-rolled hydration fetch with race
cancellation, derived `judging`/`submitBusy`/`runBusy`/`solved`/`mustTranscribe` state,
and five `useEffect`s doing cache invalidation and tab switching.

Per the brief, **characterization tests come first (B9a)**. If they cannot be made to
pass reliably against the real component, B9 is abandoned and `Problem.tsx` is left
alone — an untested 527-line state machine is worth more intact than restructured on
faith.

## Execution order

Each numbered item is one commit. After every commit: `pnpm typecheck && pnpm build && pnpm test`.

1. A1–A6 (dead code) — mechanical
2. C1, C5 (API dedup) — mechanical
3. C2, C3, C4 (web dedup)
4. D1, D2 (consistency) — mechanical
5. B1 (shared types split)
6. B2–B5 (API route splits)
7. B6, B7 (sandbox splits)
8. B8 (mock server split)
9. B9a → B9 (Problem.tsx, gated)

---

# Results

13 commits on `refactor/cleanup-pass`. Verification after each: `tsc --noEmit`
plus the affected package's test suite; full `pnpm typecheck && pnpm build &&
pnpm test` at the end.

## Completed

| Item   | Outcome                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1–A6  | Done. `MasteryDelta.tsx` deleted; `Meter`/`MeterProps`/`MeterTone`/`fillTone` deleted (`RatingMeter` kept); `formatPercent` deleted; `parseContent` deleted; `NotifyBus` + `NotifySubscriber` made module-private.                                                                                                                               |
| C1     | Done. Defaults now live once in `lib/candidatePool.ts` with two named projections (`defaultConceptState`, `defaultConceptStateRow`) — the shapes differ genuinely, so they stayed two functions over one pair of constants.                                                                                                                      |
| C2     | Partial by design. `RouteLoading`/`QueryError` extracted and applied to Concepts, Progress, Practice, and Problem's loading state. **Left alone:** Problem's error state (links to practice, no retry) and Concepts' stale-mastery banner (inline strip, not full-screen) — forcing them through the shared component would change what renders. |
| C3     | Done. `formatRating` adopted at 3 sites.                                                                                                                                                                                                                                                                                                         |
| C4     | **Not done — correctly.** Of the 5 candidate sites, only 2 shared a byte-identical mapping; the rest differ in input shape (boolean vs tri-state) or output (border+bg vs text-only). Below the 3-site threshold, so nothing was extracted.                                                                                                      |
| C5     | Done. `toCandidateProblem` replaced by `toPoolCandidate`; verified the extra fields are never serialized by the caller.                                                                                                                                                                                                                          |
| D1, D2 | Done. 8 type imports split out; 4 `.then` chains converted, cancellation flags preserved.                                                                                                                                                                                                                                                        |
| B1     | Done. `submission.ts` 629 → 309. Five new per-route modules. **Resolved a real ESM cycle:** `TeachingModeSchema` had to stay in `submission.ts`, since `GetHintsResponse` needs `SolutionsSchema` and `GiveUpResponse` needs `TeachingModeSchema` — splitting them would have thrown at module-init.                                             |
| B2     | Done. `practice.ts` 696 → 451.                                                                                                                                                                                                                                                                                                                   |
| B3     | Done. `submissions.ts` 376 → 297.                                                                                                                                                                                                                                                                                                                |
| B4     | Done. `hints.ts` 341 → 225. Same single transaction, same sorted-id lock ordering.                                                                                                                                                                                                                                                               |
| B5     | Done. `progress.ts` 191 → 170.                                                                                                                                                                                                                                                                                                                   |
| B6     | Done. `codegen.ts` 677 → 148; C++ text byte-identical, all 34 snapshots pass unmodified.                                                                                                                                                                                                                                                         |
| B7     | Done. `run.ts` 433 → 260.                                                                                                                                                                                                                                                                                                                        |
| B8     | Done. `mock/server.ts` 716 → 63, split into 5 route modules + `helpers.ts`.                                                                                                                                                                                                                                                                      |

## NOT completed

**B9a / B9 — `apps/web/src/routes/Problem.tsx` is untouched, still 527 lines.**

The characterization-test step was interrupted before it ran, so the safety net
described above does not exist. Per the gate in this plan, B9 was therefore not
attempted. This is the single largest remaining modularity item and the one that
most needs doing — but it needs B9a first, and B9a needs a decision about how much
mocking (Monaco, the SSE hook, the API module) is acceptable in a route-level test.

## Notes discovered during execution

- **Three different rating-widening schedules exist**, and they are not
  interchangeable: `WIDEN_STEPS` in `apps/api/src/routes/practice.ts` is
  `[0,150,300,600]`, in `apps/api/src/routes/problems.ts` `[0,200,400,800]`, and in
  `apps/api/src/lib/candidatePool.ts` `[0,150,300,600,1200]`. Left exactly as found —
  they may be deliberate per-call-site tuning, but nothing documents that.
- **The sandbox Docker integration tests are load-flaky.** One test failed once
  during a full parallel `pnpm test` and passed on isolated re-run and on every
  subsequent full run. Several take 10–20s wall-clock; under an 8-package parallel
  run they can exceed their timeout. Not caused by this pass — worth a longer timeout
  or serialized execution.
- `packages/shared/src/types/submission.ts` retained four submission route DTOs
  (`CreateSubmissionRequest/Response`, `GetSubmissionResponse`,
  `GetLatestSubmissionResponse`, `ListSubmissionsResponse`) that the plan did not
  assign anywhere — they belong to the submission family and stayed by elimination.
