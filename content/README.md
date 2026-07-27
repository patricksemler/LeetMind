# leetmind-content

The LeetMind content plane: problem generation (`claude -p`) and the six-stage verification
gate. Python, managed by [`uv`](https://docs.astral.sh/uv/). See `docs/CONTRACTS.md` §10/§11 for
the normative spec and `PLAN.md` §5 for the narrative overview.

## Setup

```sh
cd content
uv sync
```

## Running

```sh
uv run python -m leetmind_content.workers.content_worker
```

**Run this ON THE HOST, not in Docker, when `GENERATOR_INVOKER=claude`** (the default). The
worker shells out to the `claude` CLI to generate problems, and it needs your _host_ machine's
authenticated `claude` login — running it inside a container means either bind-mounting your
`~/.claude` credentials in (works, but is the secondary path; see `docker-compose.yml`'s
`content` service comment) or not being able to generate at all. `GENERATOR_INVOKER=stub` (a
deterministic fixture invoker, for tests / offline dev) and `GENERATOR_INVOKER=codex` don't have
this constraint.

## Tests

```sh
uv run pytest -v
```

Tests that need a live Postgres or a working sandbox (`node`, `docker`, the runner image) skip
automatically when those aren't available — see `tests/test_queue.py` and `tests/test_sandbox.py`.

## Lint / typecheck

```sh
uv run ruff check .
uv run mypy leetmind_content
```

## Layout

```
leetmind_content/
  config.py       Settings (pydantic-settings), CONTRACTS.md §2
  logging.py      structlog JSON logging + correlation-id context, CONTRACTS.md §1
  db.py           psycopg 3 pool + query helpers
  queue.py        Python mirror of @leetmind/queue, CONTRACTS.md §5
  models.py       pydantic mirror of @leetmind/shared's zod schemas, CONTRACTS.md §4
  sandbox.py      the sandbox CLI bridge, CONTRACTS.md §6.1
  codegen.py      solution/generator source normalization + seeded-input generation
  workers/        worker entrypoints (content_worker.py is the generate/verify worker)
  verification/   the six-stage gate (seam only — implemented by a follow-up agent)
  generation/     claude -p invoker + prompts (seam only — implemented by a follow-up agent)
```

## The `generate(rng)` generator contract

Every problem's `input_generator_py` must define exactly one top-level function:

```python
def generate(rng: random.Random) -> list:
    ...
    return [arg0, arg1, ...]   # positional args for ONE test case, same order as signature.params
```

Rules, load-bearing for verification and for the generation prompt alike:

- `generate` is driven by the **seeded `random.Random` instance passed in** — it must never
  reseed or draw from Python's global `random` module. The seed is the whole point: the same
  seed must always reproduce the same case, so counterexamples found during differential/mutation
  testing can be recorded (`verification_reports.seeds`) and replayed later.
- It returns the argument list for **one** case per call. `leetmind_content.codegen.seeded_inputs`
  drives it inside a single sandbox invocation, calling it `count` times with
  `random.Random(seed_start)`, `random.Random(seed_start + 1)`, ... — batching matters, since one
  container per case would be far too slow for a `VERIFY_DIFFERENTIAL_CASES`-sized suite (default
  200).
- `input_generator_py` is executed **only inside the sandbox** (`leetmind_content.sandbox`),
  never imported or exec'd in the worker process — generated code is untrusted (PLAN.md §3).

This exact contract is also documented as a docstring on
`leetmind_content.codegen.render_generator_module` / `seeded_inputs` — the generation prompt
(owned by a follow-up agent, `leetmind_content/generation/prompts/v1.py`) must teach the model to
emit code matching this shape precisely.
