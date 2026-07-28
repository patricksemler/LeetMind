# LeetMind — web frontend

**Progressive overload for problem solving.** LeetMind serves you one original, verified algorithm
problem at a time, chosen for the edge of your ability, and folds every solve and give-up into a
per-concept mastery rating that picks the next one.

This repository holds **the frontend only** — the React workspace, the practice loop, the concept
tree, and the typed client for the API. The backend that generates problems, judges submissions,
and keeps the learner model lives elsewhere; this app talks to it over HTTP and SSE and has no
other source of data.

## Running it

You need a backend serving the LeetMind API. Point `VITE_API_BASE` at it — the dev server proxies
`/api` and `/health` there, so the browser sees a same-origin app.

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

| Path              | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `src/routes/`     | Practice, Problem, Concepts, auth screens                            |
| `src/components/` | workspace (editor, hints, test cases, submissions) and UI primitives |
| `src/hooks/`      | SSE subscription, hint state, active-time tracking                   |
| `src/lib/`        | typed API client, auth, drafts, formatting                           |
| `src/shared/`     | the API wire contract as zod schemas — see below                     |
| `e2e/`            | Playwright smoke against a real backend                              |

### `src/shared/` is the contract, not a utility folder

Every response is parsed through the zod schemas in `src/shared/` before it reaches a component
(see [`src/lib/api.ts`](src/lib/api.ts)). Nothing under `src/` redeclares an API shape by hand — if
the backend's contract changes, it changes in one place here and the typechecker finds every
consumer. [`docs/CONTRACTS.md`](docs/CONTRACTS.md) is the normative spec these schemas track.

## Accounts

Authentication is **Supabase Auth** (email + password), spoken directly from the browser — the API
never sees a credential, only a verified token.

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to enable sign-in. Leave both unset to build
the single-user app with no sign-in; the backend must agree, and is single-user whenever
`SUPABASE_URL` is absent from _its_ environment. A mismatch here means the app either asks for a
session the API ignores, or skips one the API requires.

## Tests

```bash
pnpm test          # Vitest, jsdom, no backend needed
pnpm e2e           # Playwright, needs a running app and backend
```

The Vitest suite stubs the API client and runs entirely offline. The Playwright smoke deliberately
does not — it exists to cross the seams a component test cannot (real wire shapes, the SSE stream,
the router), so it needs a real backend. Point it with `E2E_BASE_URL`, and use a scratch database
if the backend you point at has one: the run submits real solutions and moves real ratings.
