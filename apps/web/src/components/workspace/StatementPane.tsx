import type { PublicProblem } from "@leetmind/shared";
import { Markdown } from "./Markdown";

function ExampleBlock({
  args,
  expected,
  explanation,
}: {
  args: unknown[];
  expected: unknown;
  explanation: string;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-inset p-3">
      <pre className="mb-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text">
        <span className="text-text-faint">input:</span>{" "}
        {args.map((a) => JSON.stringify(a)).join(", ")}
        {"\n"}
        <span className="text-text-faint">output:</span> {JSON.stringify(expected)}
      </pre>
      <p className="text-xs text-text-dim">{explanation}</p>
    </div>
  );
}

/**
 * The statement's sections only — no outer padding. The padding belongs to the caller's column, so
 * that what follows the statement there (the hint ladder) sits one section-gap below the last
 * section rather than a gap plus two paddings.
 */
export function StatementPane({ problem }: { problem: PublicProblem }) {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-xl text-text">{problem.title}</h1>

      <Markdown>{problem.statement_md}</Markdown>

      {/* Examples before constraints: the worked cases are what makes the statement concrete, and
          reading them is how you check you understood it. Constraints are reference material you
          come back to once you're already picking an approach — hence they sit next to the
          complexity target they determine. */}
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">
          Examples
        </h3>
        <div className="space-y-3">
          {problem.examples.map((ex, i) => (
            <ExampleBlock
              key={i}
              args={ex.args}
              expected={ex.expected}
              explanation={ex.explanation}
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">
          Constraints
        </h3>
        <Markdown>{problem.constraints_md}</Markdown>
      </section>

      {/* The bar to aim for, not a hint: it says how good a solution has to be without saying what
          shape gets you there. Kept under the constraints because it's read against them. */}
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">
          Target complexity
        </h3>
        {/* Label and value on one line, the two stacked: the pair reads as two short statements,
            which is how you'd say them out loud. Side-by-side columns made the labels look like a
            table header over a table that wasn't there. */}
        <dl className="space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-text-dim">Time:</dt>
            <dd className="font-mono text-text">{problem.target_complexity.time}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-text-dim">Space:</dt>
            <dd className="font-mono text-text">{problem.target_complexity.space}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
