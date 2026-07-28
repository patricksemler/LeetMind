import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GENERATION_STAGES, type GenerationProgress } from "@shared";
import { api } from "../lib/api";
import { Button, Panel, QueryError, RouteLoading } from "../components/ui";
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

/** `mm:ss` since `startedAt`, or null if there is no usable start time. */
function elapsedLabel(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The wait screen: a badge, a heading, and a bar showing which stage the problem is at.
 *
 * It used to also name the target concept and print two paragraphs explaining the verification
 * gate and promising "a minute or two". That promise was measurably false — real generations ran
 * 96-518s — and the explanation was a wall of text nobody re-reads on their second wait.
 *
 * **Why elapsed time sits next to the bar.** `writing` (the model call) is almost the entire wait;
 * the six gate stages after it total ~10-19s. So the bar genuinely does sit on segment 1 for most
 * of the wait and then sweep. Without a second signal that looks identical to being stuck, and the
 * honest fix is to show time passing rather than to fake sub-stages the CLI never reports.
 */
function GeneratingPanel({
  progress,
  startedAt,
}: {
  progress: GenerationProgress | null;
  startedAt: string | null;
}) {
  // Ticks once a second purely so the elapsed clock advances between the 2s poll intervals.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = elapsedLabel(startedAt, now);
  // index 0 (or absent progress) means "nothing has reported yet" — queued behind other work, not
  // stage 1. Rendered as an indeterminate bar with no stage name, because claiming "Writing" for a
  // job that has not been picked up would be a guess.
  const index = progress?.index ?? 0;
  const current = GENERATION_STAGES.find((s) => s.key === progress?.stage);
  const total = GENERATION_STAGES.length;

  return (
    <Panel className="w-full max-w-md p-6 text-center">
      {/* The heading already says a problem is being written; a "generating" badge above it said
          the same thing a second time. The pulsing dot carries the in-progress signal on its own,
          and the stage bar below carries the detail. */}
      <span
        className="mb-3 inline-block h-2 w-2 animate-pulse rounded-full bg-accent"
        aria-hidden="true"
      />
      <h1 className="font-display text-xl text-text">Writing you a new problem</h1>

      <div
        className="mt-5"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        {...(index > 0 ? { "aria-valuenow": index } : {})}
        aria-valuetext={current ? `${current.label}, step ${index} of ${total}` : "Queued"}
      >
        <div className="flex gap-1">
          {GENERATION_STAGES.map((stage, i) => {
            const done = index > 0 && i + 1 < index;
            const active = index > 0 && i + 1 === index;
            return (
              <span
                key={stage.key}
                className={`h-1.5 flex-1 rounded-full ${
                  done
                    ? "bg-accent"
                    : active
                      ? "animate-pulse bg-accent"
                      : index === 0
                        ? "animate-pulse bg-border"
                        : "bg-border"
                }`}
              />
            );
          })}
        </div>

        <div className="mt-2.5 flex items-baseline justify-center gap-2 text-xs">
          <span className="text-text-dim">{current ? current.label : "Queued"}</span>
          {elapsed && <span className="tabular-nums text-text-faint">{elapsed}</span>}
        </div>
      </div>
    </Panel>
  );
}

export function Practice() {
  const nextQuery = useQuery({
    queryKey: ["practice", "next"],
    queryFn: api.nextPracticeProblem,
    // Only poll while something is actually being generated for us. A steady-state practice page
    // showing a ready problem must not re-fetch on a timer — it would swap the problem out from
    // under a user who is reading it.
    refetchInterval: (query) => (query.state.data?.generating ? GENERATING_POLL_MS : false),
  });

  // `isFetchedAfterMount`, not `isLoading` — this visit renders only what this visit fetched.
  //
  // React Query serves cached data on mount and refetches behind it, and `isLoading` is only true
  // when there is nothing cached at all. "Next problem" on the workspace links back here, so the
  // user finished a problem, landed on `/`, and was handed straight back the problem they had just
  // finished — Start button and all — until the refetch landed a round trip later and it silently
  // flipped to the real answer (usually `generating`, once the small approved pool is exhausted).
  // Invalidating the query from the workspace doesn't fix that: invalidation marks the entry stale
  // and refetches, but leaves the stale VALUE in place to be rendered meanwhile. Not rendering it
  // is the fix.
  //
  // Note what this is NOT in tension with: the `refetchInterval` rule above is about a MOUNTED page
  // not swapping a problem out from under someone mid-read. This governs only what a fresh mount
  // shows before its own answer arrives, when nobody is reading anything yet. A brief loading state
  // on arrival is the honest answer to "what should this person do right now?" — a question whose
  // answer changed the moment they finished the last one.
  //
  // An error still gets through: a failed fetch counts as fetched-after-mount, so the error branch
  // below is reachable rather than being masked by a permanent spinner.
  if (!nextQuery.isFetchedAfterMount) {
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
    return (
      <div className="flex h-full items-center justify-center p-6">
        <GeneratingPanel
          progress={data.generating.progress ?? null}
          startedAt={data.generating.started_at ?? null}
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

  // The card is deliberately three things: the badge, the title, and the way in.
  //
  // It used to also carry the concept tag, the expected-minutes range, the selector's `rationale`
  // ("deprioritized: Sliding Window was already practiced today.") and a standing footer about how
  // scoring works. All four were true and none were load-bearing: the rationale is the model
  // explaining ITSELF, which is only interesting if you are debugging the selector, and the tag and
  // minutes pre-empt a judgement the statement makes better ten seconds later. The footer said the
  // same sentence on every problem forever, which is the definition of something a user stops
  // reading. Anything genuinely needed to attempt the problem lives on the workspace.
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="w-full max-w-lg p-6">
        <h1 className="font-display text-xl text-text">{problem.title}</h1>

        {/* One control. There is deliberately no way to ask for a different problem: the pick is
            the model's answer to "what should this person do right now?", and a re-roll beside it
            turned that answer into a suggestion. It also cost nothing to use — re-asking wrote no
            event, so a user could shop for an easier problem and the ratings would never know they
            had. Give-up, on the workspace, remains the way out of a problem that isn't going
            anywhere, and unlike a re-roll it is scored. */}
        <div className="mt-5">
          <Link
            to={`/problem/${problem.problem_version_id}`}
            className={buttonClassName({ variant: "primary" })}
          >
            Start
          </Link>
        </div>
      </Panel>
    </div>
  );
}
