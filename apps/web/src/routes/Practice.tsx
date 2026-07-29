import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GenerationEvent,
  GenerationFailureCode,
  GenerationPhase,
  JobStub,
  PracticeNextResponse,
} from "@shared";
import { api } from "../lib/api";
import { useGenerationEvents } from "../hooks/useGenerationEvents";
import { Button, CenteredPage, Panel, QueryError, RouteLoading } from "../components/ui";
import { buttonClassName } from "../components/ui/Button";
import { ReadyProblemPanel } from "../components/practice/ReadyProblemPanel";

/**
 * `/` — practice. One problem at a time, forever.
 *
 * `GET /api/practice/next` is a pure read (PLAN_BACKEND.md amendments 36, 41): a stub only, never
 * the statement — `{state: "active", problem_id}` once the workspace can open it, `{state:
 * "generating", job}` while the pipeline is still writing one, or `{state: "stalled"}` when there
 * is neither, which only `POST /api/practice/replenish` can fix. A `generation_failed` state is
 * deliberately terminal until the learner presses Retry, so an expensive failure cannot silently
 * enter another generation loop.
 */

const GENERATING_FALLBACK_POLL_MS = 4000;
const PRACTICE_NEXT_QUERY_KEY = ["practice", "next"] as const;

const TIMELINE: { phase: GenerationPhase; label: string }[] = [
  { phase: "waiting", label: "Waiting" },
  { phase: "selecting", label: "Selecting" },
  { phase: "drafting", label: "Drafting" },
  { phase: "independent_review", label: "Reviewing" },
  { phase: "checking_examples", label: "Examples" },
  { phase: "stress_testing", label: "Stress tests" },
  { phase: "finalizing", label: "Finalizing" },
];

const PHASE_MESSAGE: Record<GenerationPhase, string> = {
  waiting: "Your request is waiting for a generation worker.",
  selecting: "Choosing a concept and a compatible problem shape.",
  drafting: "Writing the statement, solution, hints, and tests.",
  independent_review: "A separate reviewer is checking quality and building an oracle.",
  checking_examples: "Running every authored example against two independent solutions.",
  stress_testing: "Comparing both solutions across 50 randomized cases.",
  repairing: "We caught a mismatch and are correcting it.",
  finalizing: "Saving your verified problem.",
  ready: "Your problem is ready.",
  failed: "Problem generation stopped safely.",
};

function activeTimelineIndex(phase: GenerationPhase): number {
  if (phase === "repairing") return 2;
  if (phase === "ready" || phase === "failed") return TIMELINE.length - 1;
  const index = TIMELINE.findIndex((step) => step.phase === phase);
  return Math.max(index, 0);
}

function formatElapsed(startedAt: string, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

function GeneratingPanel({ job }: { job: JobStub }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const index = activeTimelineIndex(job.phase);
  const infrastructureRetry = job.recovery_reason === "verification_infrastructure";
  const message = infrastructureRetry
    ? "The checker had a temporary issue. We’re retrying verification."
    : PHASE_MESSAGE[job.phase];

  return (
    <Panel className="w-full max-w-3xl p-6 text-center">
      <span
        className="mb-3 inline-block h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
        aria-hidden="true"
      />
      <h1 className="font-display text-xl text-text">Writing you a new problem</h1>

      <div
        className="mt-5"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={TIMELINE.length}
        aria-valuenow={index + 1}
        aria-valuetext={`${TIMELINE[index]?.label ?? "Waiting"}, step ${index + 1} of ${TIMELINE.length}`}
      >
        <ol className="grid grid-cols-7 gap-1" aria-label="Generation progress">
          {TIMELINE.map((step, i) => {
            const done = index >= 0 && i < index;
            const active = i === index;
            return (
              <li key={step.phase} className="min-w-0">
                <span
                  className={`block h-1.5 rounded-full ${
                    done
                      ? "bg-accent"
                      : active
                        ? "animate-pulse bg-accent motion-reduce:animate-none"
                        : "bg-border"
                  }`}
                  aria-hidden="true"
                />
                <span
                  className={`mt-2 block truncate text-[0.65rem] ${
                    active ? "text-text" : done ? "text-text-dim" : "text-text-faint"
                  }`}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="mt-5 text-sm text-text-dim" aria-live="polite">
          {message}
        </p>
        <div className="mt-2 flex items-baseline justify-center gap-3 text-xs tabular-nums text-text-faint">
          <span>Elapsed {formatElapsed(job.started_at, now)}</span>
          <span>
            Attempt {job.attempt} of {job.max_attempts}
          </span>
        </div>
      </div>
    </Panel>
  );
}

const FAILURE_MESSAGE: Record<GenerationFailureCode, string> = {
  provider_unavailable: "The generation provider is temporarily unavailable.",
  generation_invalid: "The draft could not be validated safely.",
  quality_mismatch: "The independent review found a quality issue that could not be repaired.",
  verification_failed: "The solutions disagreed during verification.",
  verification_unavailable: "The verification service was temporarily unavailable.",
  deadline_exceeded: "Generation reached its two-minute safety deadline.",
};

function applyGenerationEvent(
  current: PracticeNextResponse | undefined,
  event: GenerationEvent,
): PracticeNextResponse | undefined {
  // An active problem wins over transitions from the reserve job being generated behind it.
  if (current?.state === "active") return current;

  if (event.status === "ready" && event.problem_id) {
    return {
      state: "active",
      problem_id: event.problem_id,
      opened: false,
      job: null,
    };
  }

  if (current?.state === "generating" && current.job?.job_id !== event.job_id) {
    // The API will decide which of multiple buffered jobs is learner-facing.
    return undefined;
  }

  const { problem_id: _problemId, ...job } = event;
  if (event.status === "failed") {
    return {
      state: "generation_failed",
      problem_id: null,
      opened: false,
      job,
    };
  }

  return {
    state: "generating",
    problem_id: null,
    opened: false,
    job,
  };
}

export function Practice() {
  const queryClient = useQueryClient();

  const nextQuery = useQuery({
    queryKey: PRACTICE_NEXT_QUERY_KEY,
    queryFn: ({ signal }) => api.practiceNext(signal),
    // This route deliberately refuses to render a cached active problem until the server confirms
    // it. Force that confirmation even inside the global ten-second stale window; otherwise
    // `isFetchedAfterMount` can remain false forever because no request was scheduled.
    refetchOnMount: "always",
    // A timed-out read is recovered by the fixed poll below. Multiplying automatic retries would
    // only keep one hung query in flight longer and prevent the next reconciliation attempt.
    retry: false,
    // A safety net under the SSE invalidation below, not the primary mechanism: Postgres NOTIFY
    // has no replay, so a transition that fires before the SSE listener finishes attaching (or
    // during a reconnect) is simply lost — confirmed live, the UI otherwise sits on a stale stage
    // forever with nothing to nudge it. Slow enough that SSE (near-instant when it lands) is doing
    // the real work; this only bounds how long a missed event can strand someone.
    refetchInterval: (query) =>
      query.state.data?.state === "active" || query.state.data?.state === "generation_failed"
        ? false
        : GENERATING_FALLBACK_POLL_MS,
    // React Query pauses `refetchInterval` while the tab is backgrounded by default — reasonable
    // for most polling, wrong for "tell me when my problem is ready": a user waiting on
    // generation is exactly the person likely to alt-tab away and back rather than stare at a
    // progress bar, and they still deserve an up-to-date answer the moment they return.
    refetchIntervalInBackground: true,
  });

  const replenishMutation = useMutation({
    mutationFn: api.practiceReplenish,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PRACTICE_NEXT_QUERY_KEY }),
  });

  const state = nextQuery.data?.state;

  // Self-heal: `next` found neither an active problem nor a live job.
  useEffect(() => {
    if (state === "stalled") replenishMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Apply a landed transition directly so progress cannot be held hostage by another HTTP
  // round-trip. The fixed poll remains the reconciliation path for a transition missed during
  // connect/reconnect.
  useGenerationEvents({
    enabled: state === "generating" || state === "stalled",
    onEvent: (event) => {
      // Stop an older poll response from arriving after this transition and moving the timeline
      // backwards. `practiceNext` propagates React Query's AbortSignal all the way to fetch.
      void queryClient.cancelQueries({ queryKey: PRACTICE_NEXT_QUERY_KEY, exact: true });

      let applied = false;
      queryClient.setQueryData<PracticeNextResponse>(PRACTICE_NEXT_QUERY_KEY, (current) => {
        const updated = applyGenerationEvent(current, event);
        applied = updated !== undefined;
        return updated ?? current;
      });
      if (!applied) {
        void queryClient.invalidateQueries({ queryKey: PRACTICE_NEXT_QUERY_KEY });
      }
    },
  });

  if (!nextQuery.isFetchedAfterMount) {
    return <RouteLoading />;
  }

  if (nextQuery.isError && !nextQuery.data) {
    return (
      <QueryError
        message="Couldn't work out what's next."
        onRetry={() => void nextQuery.refetch()}
      />
    );
  }

  const data = nextQuery.data;

  if (data?.state === "generating" && data.job) {
    return (
      <CenteredPage>
        <GeneratingPanel job={data.job} />
      </CenteredPage>
    );
  }

  if (data?.state === "generation_failed" && data.job) {
    const message = data.job.failure_code
      ? FAILURE_MESSAGE[data.job.failure_code]
      : "We couldn't generate a verified problem this time.";
    return (
      <CenteredPage>
        <Panel className="w-full max-w-md p-6 text-center">
          <h1 className="font-display text-xl text-text">Problem generation stopped</h1>
          <p className="mt-2 text-sm text-text-dim">{message}</p>
          <Button
            variant="primary"
            className="mt-5"
            loading={replenishMutation.isPending}
            loadingLabel="Retrying generation"
            onClick={() => replenishMutation.mutate()}
          >
            Retry generation
          </Button>
        </Panel>
      </CenteredPage>
    );
  }

  if (data?.state === "active" && data.problem_id) {
    return (
      <CenteredPage>
        <ReadyProblemPanel
          action={
            <Link
              to={`/problem/${data.problem_id}`}
              className={buttonClassName({ variant: "primary" })}
            >
              {data.opened ? "Continue" : "Start"}
            </Link>
          }
        />
      </CenteredPage>
    );
  }

  return (
    <CenteredPage>
      <Panel className="max-w-md p-6 text-center">
        <h1 className="font-display text-xl text-text">Getting a problem ready</h1>
        <p className="mt-2 text-sm text-text-dim">This shouldn't take long.</p>
        <Button variant="secondary" className="mt-5" onClick={() => void nextQuery.refetch()}>
          Check again
        </Button>
      </Panel>
    </CenteredPage>
  );
}
