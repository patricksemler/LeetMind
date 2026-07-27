import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useConcepts } from "../hooks/useConcepts";
import { withConceptNames } from "../lib/conceptNames";
import { Badge, Button, Panel, QueryError, RouteLoading } from "../components/ui";
import { buttonClassName } from "../components/ui/Button";

/**
 * `/` — practice. One problem at a time, forever.
 *
 * There is no session to start, nothing to plan, and — as of the baseline's removal — nothing to
 * complete before the app will give you something to do. This route used to check `has_baseline`
 * and bounce a new user to an onboarding probe; now their first request returns a problem like
 * every other request does. Calibration still happens over the first few problems, but it is the
 * API's business, not a screen the user has to get through.
 *
 * Two answers to render, then: a problem, or `generating` — when the verified pool can't cover the
 * user's current edge, the API commissions a new problem and this page polls until it lands rather
 * than showing an empty state and a shrug.
 */

/** Generation runs `claude -p` and then a six-stage verification gate, so it is measured in tens
 * of seconds, not milliseconds. Two seconds is frequent enough to feel responsive without
 * hammering the API for the whole wait. */
const GENERATING_POLL_MS = 2000;

function GeneratingPanel({ conceptLabel, reason }: { conceptLabel: string; reason: string }) {
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
        Targeting <strong className="text-text-dim">{conceptLabel}</strong>. It's generated, then
        run through the verification gate — reference vs brute force on hundreds of inputs, boundary
        cases, and mutation testing — before you ever see it. That takes a minute or two.
      </p>
      <p className="mt-3 text-xs text-text-faint">This page updates itself when it's ready.</p>
    </Panel>
  );
}

export function Practice() {
  const queryClient = useQueryClient();
  const { namesById } = useConcepts();

  const nextQuery = useQuery({
    queryKey: ["practice", "next"],
    queryFn: api.nextPracticeProblem,
    // Only poll while something is actually being generated for us. A steady-state practice page
    // showing a ready problem must not re-fetch on a timer — it would swap the problem out from
    // under a user who is reading it.
    refetchInterval: (query) => (query.state.data?.generating ? GENERATING_POLL_MS : false),
  });

  if (nextQuery.isLoading) {
    return <RouteLoading />;
  }

  if (nextQuery.isError) {
    return (
      <QueryError
        message="Couldn't work out what's next."
        onRetry={() => void nextQuery.refetch()}
      />
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
          <p className="mt-2 text-sm text-text-dim">
            {data?.rationale ?? "No problem is available."}
          </p>
          <Button variant="secondary" className="mt-5" onClick={() => void nextQuery.refetch()}>
            Check again
          </Button>
        </Panel>
      </div>
    );
  }

  const evidence = data?.evidence as { concept?: string; cold_start?: boolean } | undefined;
  const conceptId = evidence?.concept;
  const conceptLabel = conceptId ? (namesById[conceptId] ?? conceptId) : null;
  const minutes = problem.expected_active_minutes;
  const teaching = data?.teaching ?? null;
  const followup = data?.followup ?? null;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="w-full max-w-lg p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* The lead badge names what KIND of problem this is, because the three kinds ask for
              different things from the user. A teaching problem is not something to attempt; a
              transfer problem is a check on something they were taught days ago. Rendering all of
              them as an undifferentiated "next up" was what made the follow-up pair feel like the
              model had simply forgotten what it had just shown them. */}
          {teaching ? (
            <Badge tone="warn">worked example</Badge>
          ) : followup ? (
            <Badge tone="accent">
              {followup.kind === "reinforce" ? "your turn" : "checking it stuck"}
            </Badge>
          ) : (
            <Badge tone="accent">next up</Badge>
          )}
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
          <Link
            to={`/problem/${problem.problem_version_id}`}
            className={buttonClassName({ variant: "primary" })}
          >
            {teaching ? "Work through it" : "Start"}
          </Link>
          {/* Hidden during a teaching episode and on a follow-up. Both exist precisely because the
              model decided THIS problem is the one that matters next, and an escape hatch beside
              them would let the user shuffle past the intervention that was chosen for them —
              which is the behaviour teaching mode exists to interrupt. */}
          {!teaching && !followup && (
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
          )}
        </div>

        <p className="mt-5 border-t border-border pt-4 text-xs text-text-faint">
          {teaching
            ? "You'll see the full solution for this one. Read it, then type it out yourself — that's the part that sticks. A similar problem comes next so you can use it."
            : evidence?.cold_start
              ? "Solve it, or give up — either way the next one is pitched closer to your level. The first few problems are finding your range."
              : "Solve it, skip it, or give up — all three teach the model something. Your ratings update either way, and the next problem is chosen from what they say."}
        </p>
      </Panel>
    </div>
  );
}
