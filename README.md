# LeetMind

**Progressive overload for problem solving.** LeetMind serves you one original, verified algorithm
problem at a time, chosen for the edge of your ability, and folds every solve and give-up into a
per-concept mastery rating that picks the next one.

This is a pnpm workspace with two apps: `apps/web` (the React workspace, the practice loop, the
concept tree, and the typed client for the API) and `apps/server` (FastAPI — generation, judging,
and the learner model). [`PLAN_BACKEND.md`](PLAN_BACKEND.md) is the normative spec for the server
and the wire contract between the two.

## Running the frontend

`apps/server` isn't listening yet by default — point `VITE_API_BASE` at wherever it runs. The dev
server proxies `/api` and `/health` there, so the browser sees a same-origin app.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

With nothing listening at `VITE_API_BASE` the app still boots and renders, but every query fails
and practice never produces a problem. That is the expected failure mode, not a bug in the app.

| Script           | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | Vite dev server on `WEB_PORT` (default 5173)             |
| `pnpm build`     | typecheck, then production bundle to `dist/`             |
| `pnpm preview`   | serve the built bundle                                   |
| `pnpm test`      | Vitest component + unit suite (jsdom)                    |
| `pnpm e2e`       | Playwright smoke — needs a running app **and** a backend |
| `pnpm typecheck` | `tsc --noEmit`                                           |
| `pnpm lint`      | ESLint                                                   |
| `pnpm format`    | Prettier                                                 |

## How it works

One surface. You open the app and you get a problem.

`GET /api/practice/next` answers "what should I do right now?" and it always has an answer: either
a verified, unattempted problem at the edge of your weakest evidenced concept, or a `generating`
state when nothing is left in that band — in which case the wait is shown, with live stage
progress over SSE, rather than hidden behind an empty state.

There is no session to start, nothing to plan, and no onboarding to finish. The learner state _is_
the plan, re-read on every request, so the next problem reflects the solve you just finished.

The workspace is Monaco, Python and C++, with a four-rung hint ladder (orientation → conceptual →
structural → outline). Taking a hint caps the outcome score for that attempt; giving up floors it
and reveals the solution. Run executes the public examples only; Submit runs the hidden suite, and
a submit that dies on a public example is treated as a run — it doesn't enter the attempt history
and carries no mastery consequence.

## Layout

| Path                        | Purpose                                                               |
| --------------------------- | ---------------------------------------------------------------------- |
| `apps/web/src/routes/`      | Practice, Problem, Concepts, auth screens                            |
| `apps/web/src/components/`  | workspace (editor, hints, test cases, submissions) and UI primitives |
| `apps/web/src/hooks/`       | SSE subscription, hint state, active-time tracking                   |
| `apps/web/src/lib/`         | typed API client, auth, drafts, formatting                           |
| `apps/web/src/shared/`      | the API wire contract — see below                                    |
| `apps/web/e2e/`             | Playwright smoke against a real backend                              |
| `apps/server/`              | FastAPI backend — generation, judging, learner model                 |

### `apps/web/src/shared/` is the contract, not a utility folder

Every response is parsed through the schemas in `apps/web/src/shared/` before it reaches a
component (see [`apps/web/src/lib/api.ts`](apps/web/src/lib/api.ts)). Nothing under `apps/web/src/`
redeclares an API shape by hand — if the backend's contract changes, it changes in one place here
and the typechecker finds every consumer. Once `apps/server`'s OpenAPI codegen lands (Phase 5 of
[`PLAN_BACKEND.md`](PLAN_BACKEND.md)), this hand-written contract is replaced by generated types.

## Accounts

Authentication is **Supabase Auth** (email + password), spoken directly from the browser — the API
never sees a credential, only a verified token. **Auth is mandatory** (PLAN_BACKEND.md §9): there
is no single-user/no-auth mode any more. The backend requires `SUPABASE_URL`; without it every
authed route returns 401. The frontend requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`;
without them every route past `/login` redirects back to it.

Token verification defaults to asymmetric (ES256/RS256) against the project's published JWKS at
`SUPABASE_URL/auth/v1/.well-known/jwks.json` — this covers both local `supabase start` (ES256) and
current hosted projects. Set `SUPABASE_JWT_SECRET` only for a legacy project that still signs
HS256; leave it empty otherwise.

## Running the stack locally

```bash
supabase start                # local Supabase (auth) at http://127.0.0.1:54321
docker compose up postgres    # the database (port 5432)
docker compose build judge    # the leetmind-judge sandbox image — required for Run/Submit
pnpm dev:server               # API on http://localhost:8080 (uv run python -m leetmind)
```

`apps/server/.env` (see `.env.example`) points `SUPABASE_URL` at the local Supabase stack. Run the
web app via the `web-auth` launch configuration in `.claude/launch.json`, which supplies
`VITE_API_BASE` plus the local `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` — or export those
yourself and `pnpm dev`.

Judging launches one throwaway `leetmind-judge` container per execution, so that image must exist
on the host's Docker daemon (the compose build above, or
`docker build ./apps/server/judge -t leetmind-judge`).

Problem generation shells out to an already-logged-in `claude` (or `codex`) CLI. For development
without an LLM, set `LLM_CLI=fixture` in `apps/server/.env` — canned responses, no subprocess, no
login. `docker compose up` can run the whole backend too, but the image ships no LLM CLI, so
compose forces fixture mode; real generation means running the server on the host
(`pnpm dev:server`).

## Tests

```bash
pnpm test          # Vitest, jsdom, no backend needed
pnpm e2e           # Playwright, needs a running app and backend
```

The Vitest suite stubs the API client and runs entirely offline. The Playwright smoke deliberately
does not — it exists to cross the seams a component test cannot (real wire shapes, the SSE stream,
the router), so it needs a real backend. Point it with `E2E_BASE_URL`, and use a scratch database
if the backend you point at has one: the run submits real solutions and moves real ratings.
