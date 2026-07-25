"""Problem generation: the `claude -p` (or codex/stub) invoker, prompt builders, the delimited
envelope wire format, the build-prompt/invoke/validate/retry pipeline, and the `'generate'` job
handler (docs/CONTRACTS.md §11).

Layout:

    envelope.py     — the LEETMIND envelope wire format: `parse_envelope(text) -> dict`,
                       `render_envelope(data) -> str`, `EnvelopeError`, `build_envelope_spec()`.
                       See that module's docstring for the format and why it replaced a single
                       JSON object (a real `claude -p` call broke on JSON-escaping a multi-line
                       Python program mid-response).
    invoker.py      — `Invoker` protocol + `InvokeResult`, `ClaudeInvoker`, `CodexInvoker`,
                       `StubInvoker`, and the `get_invoker(settings)` factory
                       (selected by `GENERATOR_INVOKER`).
    prompts/v1.py   — `PROMPT_VERSION = "v1"`, the original single-JSON-object prompt. Kept
                       importable (never deleted) for provenance of already-generated rows; no
                       longer used by `generator.py`.
    prompts/v2.py   — `PROMPT_VERSION = "v2"` (the default), the LEETMIND-envelope prompt.
                       `build_generation_prompt(request)` and
                       `build_repair_prompt(request, previous_output, errors)`.
    generator.py    — `generate_problem(request, *, correlation_id) -> GeneratedCandidate`: the
                       full build-prompt -> invoke -> parse (envelope, then ProblemVersion) ->
                       (retry) -> persist+enqueue pipeline, and `GenerationSchemaExhausted` (the
                       terminal-failure signal).
    handler.py      — `handle_generate(job, ctx)`, the `'generate'` job handler. Import path for
                       wiring into `workers/content_worker.py`'s `HANDLERS` registry:
                       `leetmind_content.generation.handler.handle_generate`.

Every model invocation (success, schema failure, or invoker/infrastructure failure) writes an
`leetmind_content.models.ModelRun` row — this powers the cost-per-approved-problem metric and
must never be skipped, including on paths that ultimately raise.
"""

from leetmind_content.generation.envelope import (
    EnvelopeError,
    EnvelopeSpec,
    build_envelope_spec,
    parse_envelope,
    render_envelope,
)
from leetmind_content.generation.generator import (
    GeneratedCandidate,
    GenerationSchemaExhausted,
    generate_problem,
)
from leetmind_content.generation.handler import handle_generate
from leetmind_content.generation.invoker import (
    ClaudeInvoker,
    CodexInvoker,
    Invoker,
    InvokerError,
    InvokeResult,
    StubInvoker,
    get_invoker,
)
from leetmind_content.generation.prompts.v2 import (
    PROMPT_VERSION,
    build_generation_prompt,
    build_repair_prompt,
)

__all__ = [
    "PROMPT_VERSION",
    "ClaudeInvoker",
    "CodexInvoker",
    "EnvelopeError",
    "EnvelopeSpec",
    "GeneratedCandidate",
    "GenerationSchemaExhausted",
    "InvokeResult",
    "Invoker",
    "InvokerError",
    "StubInvoker",
    "build_envelope_spec",
    "build_generation_prompt",
    "build_repair_prompt",
    "generate_problem",
    "get_invoker",
    "handle_generate",
    "parse_envelope",
    "render_envelope",
]
