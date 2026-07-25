"""The six-stage verification gate (docs/CONTRACTS.md §10).

    stage_schema.py       — 1. schema:       pydantic parse, hint-ladder banned words, weights ~1.0
    stage_compile.py      — 2. compile:      reference/brute-force import + smoke-run in sandbox
    stage_differential.py — 3. differential:  reference vs brute-force over
                                              VERIFY_DIFFERENTIAL_CASES seeded inputs
    stage_boundary.py     — 4. boundary:     derived boundary cases + declared adversarial cases
    stage_examples.py     — 5. examples:     every public example reproduced by the reference
    stage_mutation.py     — 6. mutation:     every mutant in `mutants_py` must be killed

`runner.py` composes them into `verify_problem_version(version_id, *, content, correlation_id)`,
which writes a `verification_reports` row and updates `problem_versions`/`problem_concepts` per
CONTRACTS.md §10, transactionally and idempotently for an already-terminal version.

`worker.py` exports `handle_verify(job, ctx)`, ready to register as the `'verify'` job-kind
handler in `content/leetmind_content/workers/content_worker.py`'s `HANDLERS` dict:

    from leetmind_content.verification import handle_verify
    HANDLERS["verify"] = handle_verify

Execution of reference/brute-force/mutant code always goes through `leetmind_content.sandbox`
(never imported/exec'd in-process — PLAN.md §3). `leetmind_content.codegen` supplies source
normalization and seeded-input generation.
"""

from __future__ import annotations

from leetmind_content.verification.runner import verify_problem_version
from leetmind_content.verification.worker import handle_verify

__all__ = ["handle_verify", "verify_problem_version"]
