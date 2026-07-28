import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GenerationJobStatus } from "@shared";
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
 * is neither, which only `POST /api/practice/replenish` can fix. This page calls `replenish` once
 * on mount (covers a brand-new user, who starts with nothing queued) and again whenever `next`
 * reports `stalled` (self-heal) — both idempotent, so calling one extra time costs nothing.
 */

const GENERATING_FALLBACK_POLL_MS = 4000;

const JOB_STAGES: GenerationJobStatus[] = ["queued", "planning", "building", "verifying"];

const STAGE_LABEL: Record<GenerationJobStatus, string> = {
  queued: "Queued",
  planning: "Planning",
  building: "Writing",
  verifying: "Verifying",
  ready: "Ready",
  failed: "Failed",
};

function GeneratingPanel({ status, repairCount }: { status: GenerationJobStatus; repairCount: number }) {
  const index = JOB_STAGES.indexOf(status);
  const total = JOB_STAGES.length;

  return (
    <Panel className="w-full max-w-md p-6 text-center">
      <span
        className="mb-3 inline-block h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
        aria-hidden="true"
      />
      <h1 className="font-display text-xl text-text">Writing you a new problem</h1>

      <div
        className="mt-5"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        {...(index >= 0 ? { "aria-valuenow": index + 1 } : {})}
        aria-valuetext={`${STAGE_LABEL[status]}, step ${index + 1} of ${total}`}
      >
        <div className="flex gap-1">
          {JOB_STAGES.map((stage, i) => {
            const done = index >= 0 && i < index;
            const active = i === index;
            return (
              <span
                key={stage}
                className={`h-1.5 flex-1 rounded-full ${
                  done
                    ? "bg-accent"
                    : active
                      ? "animate-pulse bg-accent motion-reduce:animate-none"
                      : "bg-border"
                }`}
              />
            );
          })}
        </div>

        <div className="mt-2.5 flex items-baseline justify-center gap-2 text-xs">
          <span className="text-text-dim">{STAGE_LABEL[status]}</span>
          {repairCount > 0 && (
            <span className="tabular-nums text-text-faint">retry {repairCount}</span>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function Practice() {
  const queryClient = useQueryClient();

  const nextQuery = useQuery({
    queryKey: ["practice", "next"],
    queryFn: api.practiceNext,
    // A safety net under the SSE invalidation below, not the primary mechanism: Postgres NOTIFY
    // has no replay, so a transition that fires before the SSE listener finishes attaching (or
    // during a reconnect) is simply lost — confirmed live, the UI otherwise sits on a stale stage
    // forever with nothing to nudge it. Slow enough that SSE (near-instant when it lands) is doing
    // the real work; this only bounds how long a missed event can strand someone.
    refetchInterval: (query) =>
      query.state.data?.state === "active" ? false : GENERATING_FALLBACK_POLL_MS,
    // React Query pauses `refetchInterval` while the tab is backgrounded by default — reasonable
    // for most polling, wrong for "tell me when my problem is ready": a user waiting on
    // generation is exactly the person likely to alt-tab away and back rather than stare at a
    // progress bar, and they still deserve an up-to-date answer the moment they return.
    refetchIntervalInBackground: true,
  });

  const replenishMutation = useMutation({
    mutationFn: api.practiceReplenish,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["practice", "next"] }),
  });

  // First load: bootstrap a brand-new user (nothing queued yet) and self-heal anyone who landed
  // here mid-outage. Idempotent server-side, so firing it unconditionally on mount is cheap.
  const replenishedOnMount = useRef(false);
  useEffect(() => {
    if (replenishedOnMount.current) return;
    replenishedOnMount.current = true;
    replenishMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = nextQuery.data?.state;

  // Self-heal: `next` found neither an active problem nor a live job.
  useEffect(() => {
    if (state === "stalled") replenishMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // While something is generating, watch the job-transition stream for a near-instant update — a
  // landed transition just invalidates the read above; the poll started with the query is only
  // the fallback for a transition SSE missed (see its comment).
  useGenerationEvents({
    enabled: state === "generating" || state === "stalled",
    onEvent: () => void queryClient.invalidateQueries({ queryKey: ["practice", "next"] }),
  });

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

  if (data?.state === "generating" && data.job) {
    return (
      <CenteredPage>
        <GeneratingPanel status={data.job.status} repairCount={data.job.repair_count} />
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
