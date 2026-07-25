# QA Implementation Plan — 2026-07-23

Product-wide QA sweep: four code-review agents (web, api+contracts, judge/queue/sandbox,
learner/db/content) plus three live browser-testing agents driving a fully isolated stack
(`leetmind_qa` DB cloned from dev, api on :8081, its own judge worker, web on :5174 — see
[Reproducing the QA environment](#reproducing-the-qa-environment)).

**Baseline: every automated check is green** — `pnpm -w typecheck`, all 549 TS tests, all 194
Python tests. Everything below is therefore a gap the suites don't cover.

## The headline

The frontend was developed against the mock server, and the mock's response shapes drifted from
the real API. The result: **large parts of the product silently render empty, zero, or wrong
against the real backend** while looking perfect in mock-mode dev and in unit tests. Compounding
that, the workout/diagnostic item lifecycle was never wired end-to-end, and the live verdict SSE
event never reaches the client. The individual fixes below matter, but the class-level fix
(§ [Prevent recurrence](#prevent-recurrence)) matters more: nothing currently forces the mock, the
frontend's field reads, and the real API to agree.

Severity: **P0** = core product broken · **P1** = major defect · **P2** = real but bounded ·
**P3** = polish.

---

## Phase 1 — P0: the product is visibly broken (fix first)

### 1.1 Live verdict never reaches the client
The single worst bug. Instrumented live SSE for a completed submission delivers
`status → progress → mastery` but **never `verdict`**; the verdict badge, runtime/memory, failure
detail, and inline editorial never render live (verified across ~10 submissions of every verdict
type). Catch-up after reconnect *does* deliver it, which is why nobody noticed.

Cluster of causes, all on the same path (`apps/api/src/routes/submissions.ts:197-206`):
- The live send is chained behind `void buildReveal(...).then(...)` with **no `.catch`** — a
  rejection both drops the verdict silently and is an unhandled-rejection process-crash risk
  (no global handler exists). Root-cause why it never fires and fix with instrumentation, not guesswork.
- The live path also skips `sanitizeFailure` (the catch-up branch at :183 and
  `GET /submissions/:id` both sanitize) — a verdict-leak hole once the path works.
- `VerdictEventSchema` (`packages/shared/src/types/events.ts:24-33`) has no `reveal` field and no
  passthrough, so the client would strip the reveal payload anyway (`useSubmissionEvents.ts:196`).
- `ResultsPanel.tsx:163` reads `verdict.failure.editorial_md` — a **mock-only shape**
  (`mock/verdict.ts` admits stuffing reveal into `failure` in its own comment). Real API puts it
  in a sibling `reveal` field per CONTRACTS §4.5.

Fix: route the live path through the same `verdictEventPayload()` helper as catch-up (sanitization
included), with `.catch` fallback that still sends the verdict without the reveal; add `reveal` to
`VerdictEventSchema` and the client types; read `verdict.reveal` in `ResultsPanel`/`Problem.tsx`.
Acceptance: a live submission shows the verdict badge without reload; an SSE integration test
asserts a live `verdict` event with sanitized failure + reveal on accept; concept tags reveal live
(currently only after reload).

### 1.2 Workout & diagnostic item lifecycle is unwired
Confirmed live: no submission, acceptance, or give-up ever transitions a workout item. Everything
downstream is dead: items show "NOT STARTED"/"Start" forever, the Today ladder never completes,
the "workout exhausted → Start workout" screen and the diagnostic's "Baseline set" panel are
unreachable, and **the diagnostic flow is a functional dead end** — solving or giving up never
advances it; only "Skip — don't know this yet" does.

- `startWorkoutItem` exists in `apps/web/src/lib/api.ts:119` but is **never called**; the mock
  flips items to `active` as a submission side effect, the real API doesn't (`mock/server.ts:201-207`).
- Give-up parses `workout_item_id` and ignores it (`apps/api/src/routes/hints.ts` — zero uses), so
  the item never reaches `gave_up`, and `advanceDiagnosticIfNeeded`'s pending-items guard
  (`workouts.ts:240`) can never pass → diagnostic stalls permanently. Confirmed live.
- Accepted submissions likewise never complete the item (judge writes the verdict; nothing marks
  the item `solved`).
- `completeWorkoutItem` (`packages/db/src/workouts.ts:129-144`) has **no terminal-state guard**
  (its siblings do): confirmed live that re-skipping a terminal item silently rewrites
  `skipped_inability → skipped_preference` and `completed_at`.
- `Diagnostic.tsx` requires `status === "active"` to render the flow, but the server flips to
  `completed` in the same request that finishes it → user sees the "Start diagnostic" card again
  with zero acknowledgment.
- Bonus: `POST /api/diagnostic/start` **silently abandons** any active standard workout — needs a
  confirm.

Fix (one coherent change): on mount with `?item=`, call `startWorkoutItem`; on terminal verdict,
complete the item (`solved`) in the judge's transaction (or an API-side event handler); on
give-up, complete the item (`gave_up`) in the give-up transaction; add
`and state in ('pending','active')` to `completeWorkoutItem`; render the completed-diagnostic
panel when the just-fetched workout is `completed`; add a confirm dialog before abandoning an
active workout. Acceptance: an e2e pass where solve/skip/give-up each advance ladder + diagnostic
and both completion screens are reachable.

### 1.3 Give-up poisons all later scoring on the problem
Confirmed live: after give-up, a fully correct, judge-verified resubmission reports *"scored 0
after the editorial hint"* and applies **another negative delta — every time**. Observed:
solve +7.4 (1150→1157) → give-up −12.6 (→1144) → correct C++ resubmit −11.8 (→1133). Related:
give-up doesn't check for an in-flight judge job (double mastery, opposite direction), the hint
ladder stays clickable after give-up (`Problem.tsx:153` never passes `disabled` though
`HintLadder` supports it), and `GiveUpControl` is never disabled once the problem is already solved.

Decide the semantics explicitly (recommended: after a recorded give-up, further submissions on
that version are *practice* — judged, streamed, but no mastery event, labeled "practice — not
scored" in the results panel; and a give-up is rejected with 409 while a judge job is in flight).
Then: gate mastery in the judge on an existing give-up event, disable `HintLadder` + `GiveUpControl`
appropriately, and use the existing `learningEventKey({kind:"give_up"})` helper instead of the
hand-rolled key with its stale comment (`hints.ts:159-164`).

### 1.4 Progress page reads mock-only field names — page is dead against the real API
Every section affected (`apps/web/src/routes/Progress.tsx` vs `apps/api/src/routes/progress.ts:159-190`):
`solves_by_difficulty` vs real `solve_bands`; `error_category_recurrences` vs `error_categories`;
`records.highest_unassisted_difficulty`+`_title` vs `highest_unassisted_difficulty_solved` (no
title exists); history rows expect `status`/`items_completed`/`items_total` but get raw
`learning_events` → "undefined · 0 / 0 items"; concept keys use `c.id` but real rows send
`concept_id` → every React key is `""` (the recurring "duplicate key" console error seen on every
load); reviews-due reads `r.due_at`/`r.name` which `reviewsDue()` never returns → "due —" always.
Confirmed live: "No submissions yet" rendered beside a real non-zero median active time.

Fix: rewrite the page against the real `ProgressResponse`, then fix the mock to match (§ Prevent
recurrence). Add `down: "↓"` to `TREND_ICON` (API emits `"down"`; declining concepts currently
render like flat ones — confirmed live).

### 1.5 System page reads mock-only shapes — dashboard shows garbage
Confirmed live with real data present: queue depth/wait always `0 / 0 / 0 ms` (reads flat
`wait_p50_ms` etc. vs real `wait_time_ms.{p50,p95}`; no p99 exists); verdict mix renders literal
**"window × 0" / "counts × 0"** badges (`Object.entries` over `{window, counts}`); generation
pass-rate renders "0% / by_stage"; buffer depth renders one bogus "by_concept_band" row;
model-runs is an array but read as an object → "0 / 0 ms · $0.000/run". Rewrite
`System.tsx` against the real `SystemStatsResponse` (`apps/api/src/routes/system.ts:61-70`).

### 1.6 Concepts page shows every concept as "unseen"
`Concepts.tsx:18` keys mastery by `c.id`; API sends `concept_id` → the mastery join misses 100% of
rows (confirmed live: attempted concepts with real ratings render identical to untouched ones).
One-line fix plus a regression test that fails when the join produces zero matches on non-empty data.

---

## Phase 2 — P1: major defects

| # | Defect | Where | Fix sketch |
|---|--------|-------|-----------|
| 2.1 | Double-submit unguarded: hotkey ignores `isPending`, two clicks in one tick both fire; two 201s confirmed live | `Problem.tsx:96`, `ActionBar.tsx:36-39` | Gate hotkey + Run button on pending; ignore stale `onSuccess` by submission id |
| 2.2 | Concurrent mastery lost-update race — confirmed live via 2.1: both events computed from the same `before_rating`, one delta lost, counters double-incremented; audit trail disagrees with state | `apps/judge/src/mastery.ts:204-291`, `db/concepts.ts` | `SELECT … FOR UPDATE` (or per-user advisory xact lock) before read-modify-write |
| 2.3 | Submission stranded non-terminal forever when its job exhausts retries (no `failed` status, `completeSubmission` never called on that path) — user sees "running" forever | `apps/judge/src/handler.ts`, `queue.ts:154-202` | On job death write terminal `internal_error` verdict + notifies |
| 2.4 | Refresh mid-submission loses the verdict with no recovery — confirmed live (blank placeholder; backend has the verdict) | `Problem.tsx` (`activeSubmissionId` state only) | On mount, fetch latest submission for the version and hydrate the results panel |
| 2.5 | Query-error states: Today falls back to the **"Start diagnostic" onboarding screen** on any fetch failure; Progress/System/Concepts/Diagnostic hang on "Loading…" forever (`isLoading \|\| !data`) | `Today.tsx:34-48` + four routes | Branch on `isError` with a retry action (Problem.tsx already does this right) |
| 2.6 | Submit/give-up mutation failures are fully silent (no `onError` anywhere) | `Problem.tsx:74-89`, `GiveUpControl.tsx:28-34` | Surface `mutation.error` inline/toast |
| 2.7 | Custom-input Run never shows the program's output — the one thing it's for; shows pseudo-verdict "ACCEPTED 0/0 passed" | run-mode API + `ResultsPanel` | Return + render the return value (and stdout) for run mode; replace verdict badge with "ran" |
| 2.8 | No catch-all route: unknown URLs render a blank main | `App.tsx` | `<Route path="*">` → 404 panel |
| 2.9 | Verdict chosen by category priority, not first failing test in index order — early WA masked by later TLE, `first_failing_test_index` misleading | `packages/sandbox/src/execute.ts:232-263` | Scan `harness.tests` in index order |
| 2.10 | Banned-word gate misses hyphenated forms (`two-pointer`, `sliding-window`, `union-find`) and inflections (`backtracking`, `memoization`, `heaps`) | `content/.../banned_words.py:41-43` | `[\s-]+` separators + suffix tolerance |
| 2.11 | Replenish buffer can plateau below watermark forever: schema-exhausted slot jobs terminate `done`, fixed idempotency keys block retry | `workers/replenish.py:268-277`, `generation/handler.py:42-50` | Epoch/attempt-suffixed keys or slot re-derivation |
| 2.12 | Light-theme verdict foreground colors never overridden → measured 1.34–2.26:1 contrast (AA needs 4.5) on badges, hint-ladder caps, give-up button, mastery delta — across app | `apps/web/src/index.css:33-85` | Add light-theme `--color-verdict-*` (text) overrides alongside the existing `-dim` ones |

## Phase 3 — P2: correctness & robustness

- **SSE snapshot→subscribe TOCTOU** (`submissions.ts:136-210`): NOTIFY dispatched between the
  snapshot SELECT and `subscribe()` is dropped and never re-checked. Re-fetch once after subscribe.
- **Reaper vs. active worker**: terminal submission writes gated only by an app-level
  `signal.aborted` check; make them conditional in SQL on lease ownership (`jobs.leased_by`).
- **`sanitizeFailure` misses `actual_preview`** (`mappers/submission.ts:10-14`) — contra its own
  doc comment and CONTRACTS §4.5.
- **WA debugging detail**: submit-mode failures carry only `first_failing_test_index`; CONTRACTS
  says example-derived tests may carry previews — verify the judge populates them and render them.
  Also: 0/5 shows "outcome 0.25" with no explanation — explain partial credit in the mastery
  panel or floor the copy.
- **C++ parity**: `exact` comparator coerces int64 through `double` (>2^53 collide — Python
  compares exactly); `signature.name` spliced unvalidated into generated C++ (LLM-generated =
  untrusted; validate against an identifier regex, fail loudly); OOM heuristic requires stderr
  text a cgroup SIGKILL never leaves → `memory_limit` effectively unreachable (read Docker's
  `OOMKilled` flag instead).
- **Content gate soundness**: differential stage lacks the both-sides-errored exclusion that
  boundary + shrink already have (good problems rejected); three stages pass vacuously on zero
  mutants/scenarios/cases (enforce `MIN_MUTANTS`, surface 0-case passes distinctly); CONTRACTS
  §10 promises "declared adversarial cases" but no channel exists (`origin: "adversarial"` never
  constructed) — implement or amend the contract.
- **Judge mastery explanation rounding** (`learner/update.ts:125-130`): delta rounded
  independently of before/after → "+0 (1500→1501)". Derive displayed delta from rounded endpoints.
- **Dialog a11y**: no focus trap (Tab escapes to background; confirmed live), Esc returns focus to
  `<body>` not the trigger. One fix in `ui/Dialog.tsx` covers all dialogs.
- **Mobile**: workspace `SplitPane` never stacks below tablet width (433px content in a 375px
  viewport clips editor + Submit); Concepts tree overflows horizontally and drags the navbar
  off-screen. Add breakpoints.
- **System page rendering**: workers table overlaps kind badge with "last seen" on every row;
  `formatDate` drops time-of-day so nine workers spanning 2h all read "Jul 23", and the API's
  `stale` flag is never rendered — liveness signal lost.
- **Concepts taxonomy**: multi-parent `trees_bst` renders its 9-concept subtree twice (29 rows for
  20 concepts) with no "also under…" marker.
- **Validation**: bad `workout_item_id` on submit surfaces as a raw FK 500 instead of 400.

## Phase 4 — P3: polish

Today's workout rationale is machine register ("no warm-up candidate reached the high-confidence
P(success) bar; role omitted…", lowercase sentence starts, "~9 min" twice, WORKING SET +
SKIPPED badges reading contradictory) — rewrite as human copy with internals behind a disclosure.
NavBar logo isn't a link home. No favicon. Long concept names wrap misaligned on Progress. Dead
code: `ui/Tooltip.tsx` unused; `mock/sse.ts` `dropAllConnections` unwired; duplicate
`GET /api/problems/:id` on the not-found path (StrictMode-ish; verify). SSE close shows
`net::ERR_ABORTED` in devtools (confirm intentional). Cmd+' for Run is a nonstandard binding.
TS zod schema doesn't mirror Python's concept-weight/primary invariants.

---

## Prevent recurrence

1. **One source of truth for response shapes.** Define zod response schemas for every endpoint in
   `@leetmind/shared`; the web app parses responses through them (not blind casts), the mock
   server's fixtures are validated against the *same* schemas in its tests, and API integration
   tests assert real responses parse. This retires the entire Phase-1 §1.4–1.6 class permanently.
   The catastrophic-drift trio (Progress/System/Concepts) all shipped green because nothing
   compared the three parties.
2. **One real-stack e2e smoke** (Playwright against docker-compose): diagnostic → workout → solve
   → live verdict visible → ladder completes → progress reflects it. Half the P0s above are
   exactly the seams a single such test crosses.
3. **Slow-judge dev mode** (env-injected sandbox delay): pending/running verdict UI states are
   currently untestable — every judge run finishes in ~150-300 ms; nobody has ever seen the
   intermediate states this UI implements.

## Verified working — don't spend time here

Draft persistence (per-problem, per-language, survives reload — thorough live pass), hint-ladder
gating/copy/confirm dialogs, give-up confirm honesty, statement rendering, language switcher
boilerplate, shortcut suppression inside Monaco, mastery explanation sentence (when not poisoned),
diagnostic adaptive stepping math, /system 5s polling hygiene, dark-theme contrast, tablet layout,
problem-not-found error page, queue/judge chaos suite behavior under test.

## Reproducing the QA environment

```bash
# QA database (clone of dev, disposable):
docker exec leetmind-db-1 bash -c "createdb -U leetmind leetmind_qa && pg_dump -U leetmind leetmind | psql -q -U leetmind -d leetmind_qa"
# Stack (dev DB untouched; ports avoid the user's 5173 vite and whatever holds 8080):
DATABASE_URL=postgres://leetmind:leetmind@localhost:5432/leetmind_qa API_PORT=8081 pnpm dev:api
DATABASE_URL=postgres://leetmind:leetmind@localhost:5432/leetmind_qa pnpm dev:judge
WEB_PORT=5174 VITE_API_BASE=http://localhost:8081 pnpm dev:web   # or .claude/launch.json "web-qa"
```

Note for local dev generally: with no `.env`, the web proxy targets `:8080` — on this machine an
unrelated OpenProject container owns 8080, so a default `pnpm dev:web` against `dev:api` silently
talks to the wrong backend. Worth a loud startup check or a documented port change.
