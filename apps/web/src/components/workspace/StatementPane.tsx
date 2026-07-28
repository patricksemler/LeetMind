import type { ProblemDetail } from "@shared";
import { Markdown } from "./Markdown";

function ExampleBlock({ args, expected }: { args: unknown[]; expected: unknown }) {
  return (
    <div className="rounded-md border border-border bg-bg-inset p-3">
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text">
        <span className="text-text-faint">input:</span>{" "}
        {args.map((a) => JSON.stringify(a)).join(", ")}
        {"\n"}
        <span className="text-text-faint">output:</span> {JSON.stringify(expected)}
      </pre>
    </div>
  );
}

/**
 * The statement's sections only — no outer padding. The padding belongs to the caller's column, so
 * that what follows the statement there (the hint ladder) sits one section-gap below the last
 * section rather than a gap plus two paddings.
 */
export function StatementPane({ problem }: { problem: ProblemDetail }) {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-xl text-text">{problem.title}</h1>

      {/* `statement_md` already walks through worked examples in prose (PLAN_BACKEND.md §4); the
          block below is the same public tests rendered as raw input/output, for a quick glance
          without re-reading the paragraph they came from. */}
      <Markdown>{problem.statement_md}</Markdown>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">
          Examples
        </h3>
        <div className="space-y-3">
          {problem.public_tests.map((ex, i) => (
            <ExampleBlock key={i} args={ex.args} expected={ex.expected} />
          ))}
        </div>
      </section>

      {/* The bar to aim for, not a hint: it says how good a solution has to be without saying what
          shape gets you there. */}
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">
          Target complexity
        </h3>
        <dl className="space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-text-dim">Time:</dt>
            <dd className="font-mono text-text">{problem.complexity.time}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-text-dim">Space:</dt>
            <dd className="font-mono text-text">{problem.complexity.space}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
