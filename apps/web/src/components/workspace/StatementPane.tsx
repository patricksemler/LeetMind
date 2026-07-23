import type { PublicProblem } from "@algolift/shared";
import { Badge } from "../ui";
import { Markdown } from "./Markdown";

function ExampleBlock({ index, args, expected, explanation }: { index: number; args: unknown[]; expected: unknown; explanation: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-inset p-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-text-faint">Example {index + 1}</div>
      <pre className="mb-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text">
        <span className="text-text-faint">input:</span> {args.map((a) => JSON.stringify(a)).join(", ")}
        {"\n"}
        <span className="text-text-faint">output:</span> {JSON.stringify(expected)}
      </pre>
      <p className="text-xs text-text-dim">{explanation}</p>
    </div>
  );
}

export function StatementPane({ problem }: { problem: PublicProblem }) {
  return (
    <div className="space-y-6 p-5">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge tone="accent">rating {problem.difficulty_rating}</Badge>
          <Badge tone="neutral">
            {problem.expected_active_minutes[0]}–{problem.expected_active_minutes[1]} min
          </Badge>
          <Badge tone="neutral">{problem.comparator}</Badge>
        </div>
        <h1 className="font-display text-xl text-text">{problem.title}</h1>
      </div>

      <Markdown>{problem.statement_md}</Markdown>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">Constraints</h3>
        <Markdown>{problem.constraints_md}</Markdown>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">Examples</h3>
        <div className="space-y-3">
          {problem.examples.map((ex, i) => (
            <ExampleBlock key={i} index={i} args={ex.args} expected={ex.expected} explanation={ex.explanation} />
          ))}
        </div>
      </section>
    </div>
  );
}
