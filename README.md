# LeetMind

**Adaptive algorithm practice.** LeetMind writes its own problems. Every problem you see was
generated for you, machine-verified against an independent oracle, and picked at the edge of your
current ability — the concept you're weakest at, at a difficulty you have roughly even odds of
solving. Solving, hinting, and giving up all move a per-concept rating, and that rating chooses
what comes next.

Live demo: **[leetmind.patricksemler.dev](https://leetmind.patricksemler.dev)** — the real problem
workspace running against a deterministic in-browser executor.

## What it does

- **One problem at a time.** `GET /api/practice/next` returns a verified, unattempted problem in
  your band. When the band is empty it returns a `generating` state and streams the generation
  pipeline's stage progress over SSE, so the wait is visible.
- **A real workspace.** Monaco editor, Python and C++, persisted drafts. **Run** executes the
  public examples; **Submit** runs the hidden suite and records the attempt.
- **A four-rung hint ladder** — orientation, conceptual, structural, outline. Each rung taken caps
  the score for that attempt; giving up floors it and reveals the reference solution.
- **A learner model per concept.** Elo across 20 problem types, with K decaying as evidence
  accumulates and penalties for hints, failed submits, extra runs, and time over par. The
  `/concepts` view shows the whole tree and where you stand on each node.
- **Sandboxed judging.** Submissions run in a throwaway Docker container with no network and no
  knowledge of expected outputs — the container executes, the server decides the verdict.

## How generation works

Two background workers can process independent users while advisory locking, leases, and fencing
tokens preserve per-user serialization. Each job has a 120-second enqueue-to-terminal deadline:

1. **Select** — deterministic adaptive scoring picks the highest-scored concept, its target-band
   midpoint, up to two eligible support concepts, and the least-recently-used compatible activity
   shape. Recent problems are supplied as anti-repetition context; planning makes no LLM call.
2. **Draft** — one low-effort structured-output call writes the concise statement, three public
   tests, eight private tests, four hints, the reference solution, and a batched input generator.
3. **Independent review** — one separate call sees only the public contract and activity plan. It
   checks curriculum fit and authors the brute-force oracle without seeing the proposed solution
   or authored tests.
4. **Verify** — reference and oracle run the authored suite concurrently, then agree on 50 seeded
   randomized inputs. All seeds are generated in one sandbox process with a repeated-seed purity
   check.
5. **Recover** — transport/schema errors get at most one bounded retry; content disagreements get
   at most one targeted repair; judge infrastructure retries verification without redrafting.
   Only problems that clear every gate reach a user.

## Stack

| Layer     | What                                                                           |
| --------- | ------------------------------------------------------------------------------ |
| Frontend  | React 19, TypeScript, Vite, Tailwind 4, TanStack Query, React Router 7, Monaco |
| Backend   | FastAPI, Python 3.12, asyncpg, Pydantic, SSE (`sse-starlette`), strict mypy    |
| Data      | Postgres 16, SQL migrations                                                    |
| Auth      | Supabase Auth (email + password), JWT verified against the project's JWKS      |
| Execution | Docker — one throwaway container per run, two-process isolation inside it      |
| Testing   | Vitest + Testing Library (jsdom), Playwright, pytest                           |

## Layout

pnpm workspace, two apps.

| Path                       | What                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `apps/web/src/routes/`     | Practice, Problem, Concepts, auth                               |
| `apps/web/src/components/` | editor, hints, test cases, submissions, UI primitives           |
| `apps/web/src/hooks/`      | SSE subscription, hint state, active-time tracking              |
| `apps/web/src/lib/`        | typed API client, auth, drafts, formatting                      |
| `apps/web/src/shared/`     | the API wire contract — every response is parsed through it     |
| `apps/web/src/demo/`       | the deterministic executor behind the public demo               |
| `apps/web/e2e/`            | Playwright smoke against a real backend                         |
| `apps/server/src/leetmind` | routes, generation pipeline, learner model, judge orchestration |
| `apps/server/judge/`       | the sandbox image and its in-container runner                   |
| `apps/server/migrations/`  | schema                                                          |
| `apps/server/queries/`     | generation latency and reliability reports                     |
| `apps/server/scripts/`     | live generation benchmark                                      |

The schemas in `apps/web/src/shared/` are the single source of truth for the wire format: every
response is parsed through them before it reaches a component, so a contract change lands in one
place and the typechecker finds every consumer.

## Running it

The web app on its own, against an API you point it at:

```bash
pnpm install
cp .env.example .env    # VITE_API_BASE, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
pnpm dev
```

The full stack locally:

```bash
supabase start                # auth, http://127.0.0.1:54321
docker compose up postgres    # database, port 5432
docker compose build judge    # the leetmind-judge sandbox image, used by Run/Submit
pnpm dev:server               # API on http://localhost:8080
```

Server configuration lives in `apps/server/.env` (see `apps/server/.env.example`). Generation
shells out to a logged-in `claude` or `codex` CLI; `LLM_CLI=fixture` swaps that for canned
responses, which is what `docker compose up` uses since the server image ships no LLM CLI.

Run the live eight-concept SLO benchmark with:

```bash
cd apps/server
uv run python scripts/benchmark_generation.py --output ../../benchmark-results/generation.json
```

The demo needs none of the above — `pnpm dev:demo` runs the workspace against the in-browser
executor.

## Scripts

| Script            | What                                               |
| ----------------- | -------------------------------------------------- |
| `pnpm dev`        | Vite dev server on `WEB_PORT` (default 5173)       |
| `pnpm dev:demo`   | dev server in demo mode                            |
| `pnpm dev:server` | FastAPI on :8080                                   |
| `pnpm build`      | typecheck, then bundle to `dist/`                  |
| `pnpm build:demo` | static demo bundle                                 |
| `pnpm preview`    | serve the built bundle                             |
| `pnpm test`       | Vitest, jsdom, API client stubbed — runs offline   |
| `pnpm e2e`        | Playwright smoke — needs a running app and backend |
| `pnpm typecheck`  | `tsc --noEmit`                                     |
| `pnpm lint`       | ESLint                                             |
| `pnpm format`     | Prettier                                           |

`pnpm e2e` crosses the seams a component test can't — real wire shapes, the SSE stream, the router
— so point it at a real stack with `E2E_BASE_URL`, and use a scratch database: the run submits real
solutions and moves real ratings.
