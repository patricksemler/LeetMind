import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useConcepts } from "../hooks/useConcepts";
import { withConceptNames } from "../lib/conceptNames";
import { Badge, Button, Panel } from "../components/ui";
import { buttonClassName } from "../components/ui/Button";

/**
 * `/` — practice. One problem at a time, forever.
 *
 * There is no session to start and nothing to plan: the API answers "what now?" and this route
 * renders whichever of the three answers came back. The interesting one is `generating` — when the
 * verified pool can't cover the user's current edge, the API commissions a new problem and this
 * page polls until it lands, rather than showing an empty state and a shrug.
 */

/** Generation runs `claude -p` and then a six-stage verification gate, so it is measured in tens
 * of seconds, not milliseconds. Two seconds is frequent enough to feel responsive without
 * hammering the API for the whole wait. */
const GENERATING_POLL_MS = 2000;

function GeneratingPanel({
  conceptLabel,
  reason,
}: {
  conceptLabel: string;
  reason: string;
}) {
  return (
    <Panel className="max-w-md p-6 text-center">
      <div className="mb-3 flex items-center justify-center gap-2">
        <span
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent"
          aria-hidden="true"
        />
        <Badge tone="accent">generating</Badge>
      </div>
      <h1 className="font-display text-xl text-text">Writing you a new problem</h1>
      <p className="mt-2 text-sm text-text-dim">{reason}</p>
      <p className="mt-3 text-xs text-text-faint">
        Targeting <strong className="text-text-dim">{conceptLabel}</strong>. It's generated, then run through the
        verification gate — reference vs brute force on hundreds of inputs, boundary cases, and mutation testing —
        before you ever see it. That takes a minute or two.
      </p>
      <p className="mt-3 text-xs text-text-faint">This page updates itself when it's ready.</p>
    </Panel>
  );
}

export function Practice() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { namesById } = useConcepts();

  const meQuery = useQuery({ queryKey: ["me"], queryFn: api.me });

  const nextQuery = useQuery({
    queryKey: ["practice", "next"],
    queryFn: api.nextPracticeProblem,
    // Only poll while something is actually being generated for us. A steady-state practice page
    // showing a ready problem must not re-fetch on a timer — it would swap the problem out from
    // under a user who is reading it.
    refetchInterval: (query) => (query.state.data?.generating ? GENERATING_POLL_MS : false),
  });

  const needsBaseline = nextQuery.data?.needs_baseline || meQuery.data?.has_baseline === false;

  useEffect(() => {
    if (needsBaseline) navigate("/baseline", { replace: true });
  }, [needsBaseline, navigate]);

  if (meQuery.isLoading || nextQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  if (nextQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't work out what's next.</p>
        <button className="text-accent underline" onClick={() => void nextQuery.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  if (needsBaseline) {
    // The effect above is already navigating; render the reason rather than a blank frame.
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Panel className="max-w-md p-6 text-center">
          <p className="text-sm text-text-dim">Taking you to the baseline first…</p>
        </Panel>
      </div>
    );
  }

  const data = nextQuery.data;

  if (data?.generating) {
    const conceptLabel = namesById[data.generating.concept_id] ?? data.generating.concept_id;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <GeneratingPanel
          conceptLabel={conceptLabel}
          reason={withConceptNames(data.generating.reason, [data.generating.concept_id], namesById)}
        />
      </div>
    );
  }

  const problem = data?.problem;

  if (!problem) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Panel className="max-w-md p-6 text-center">
          <h1 className="font-display text-xl text-text">Nothing to practise right now</h1>
          <p className="mt-2 text-sm text-text-dim">{data?.rationale ?? "No problem is available."}</p>
          <Button variant="secondary" className="mt-5" onClick={() => void nextQuery.refetch()}>
            Check again
          </Button>
        </Panel>
      </div>
    );
  }

  const conceptId = (data?.evidence as { concept?: string } | undefined)?.concept;
  const conceptLabel = conceptId ? (namesById[conceptId] ?? conceptId) : null;
  const minutes = problem.expected_active_minutes;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="w-full max-w-lg p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone="accent">next up</Badge>
          {conceptLabel && <Badge tone="neutral">{conceptLabel}</Badge>}
          {minutes && (
            <span className="text-xs text-text-faint">
              {minutes[0]}–{minutes[1]} min
            </span>
          )}
        </div>

        <h1 className="font-display text-xl text-text">{problem.title}</h1>
        <p className="mt-2 text-sm text-text-dim">
          {withConceptNames(data?.rationale ?? "", conceptId ? [conceptId] : [], namesById)}
        </p>

        <div className="mt-5 flex items-center gap-2">
          <Link to={`/problem/${problem.problem_version_id}`} className={buttonClassName({ variant: "primary" })}>
            Start
          </Link>
          <Button
            variant="ghost"
            onClick={() => {
              // "Something else" is not a mastery signal — it must not write a skip event. Simply
              // re-asking gets a different pick, because `selectNext`'s scoring is over a live
              // pool that this request re-reads.
              void queryClient.invalidateQueries({ queryKey: ["practice", "next"] });
            }}
          >
            Something else
          </Button>
        </div>

        <p className="mt-5 border-t border-border pt-4 text-xs text-text-faint">
          Solve it, skip it, or give up — all three teach the model something. Your ratings update either way, and
          the next problem is chosen from what they say.
        </p>
      </Panel>
    </div>
  );
}
