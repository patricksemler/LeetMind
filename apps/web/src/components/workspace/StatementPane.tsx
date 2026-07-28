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

      {/* Examples have one canonical source: `public_tests`. The generated statement is validated
          to contain only the concise problem description, so this section never duplicates it. */}
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

      {problem.constraints.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">
            Constraints
          </h3>
          <ul className="space-y-1.5">
            {problem.constraints.map((constraint, i) => (
              <li key={i}>
                <code className="rounded border border-border bg-bg-inset px-1.5 py-0.5 font-mono text-xs text-text">
                  {constraint}
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
