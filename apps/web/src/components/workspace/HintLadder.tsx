/**
 * The hint ladder: four numbered rungs, orientation → outline (PLAN_BACKEND.md §4). Reveal takes
 * the rung immediately — there is no confirm step, and no scoring consequence narrated in this UI
 * (the server still applies the hint-penalty table, §6.1). Taken rungs stay visible with their
 * text. Rungs beyond the next one are locked — hints are meant to be climbed in order (§9: revealing
 * rung `n` requires `1..n-1` already revealed).
 *
 * `revealed_hints` (PLAN_BACKEND.md §9) already comes back ordered and complete on the problem
 * view itself — no separate hints fetch, and no reconstruction on reload. This component owns no
 * state of its own: the caller passes `revealedHints` down and gets `onRevealed(rung, text)` back
 * on a successful reveal, the same controlled shape as `GiveUpControl` — so a caller with its own
 * problem cache (`routes/Problem.tsx`) can patch that cache directly, and a test can just watch
 * the callback.
 *
 * Give-up is deliberately not offered here — it's the separate, visually distinct
 * `GiveUpControl`.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import type { HintResponse } from "@shared";
import { api } from "../../lib/api";
import { useEnterOnce } from "../../lib/useEnterOnce";
import { Button, LoadingSwap, Plate } from "../ui";
import { Markdown } from "./Markdown";

const MAX_RUNG = 4;
const RUNGS = Array.from({ length: MAX_RUNG }, (_, i) => i + 1);

/** Its own component so the once-only entrance gets a hook per rung — see `useEnterOnce`. The text
 * of a rung already taken is settled content, not something arriving, so it must not slide in again
 * every time the panel is shown. */
function HintText({ text }: { text: string }) {
  const enter = useEnterOnce("content-enter");

  return (
    <div className={`mt-1 ${enter.className}`} onAnimationEnd={enter.onAnimationEnd}>
      <Markdown className="text-xs">{text}</Markdown>
    </div>
  );
}

export function HintLadder({
  problemId,
  revealedHints,
  disabled = false,
  onRevealed,
  revealHint = (rung) => api.revealHint(problemId, rung),
  revealCoachMark,
}: {
  problemId: string;
  /** `ProblemDetail`'s `revealed_hints`/`hints` — ordered rung 1..n, complete through whatever
   * has been taken. */
  revealedHints: string[];
  disabled?: boolean;
  onRevealed: (rung: number, text: string) => void;
  /** A contract-shaped injection point for offline/static experiences. */
  revealHint?: (rung: number) => Promise<HintResponse>;
  /** Optional contextual guidance rendered beside the next available Reveal control. */
  revealCoachMark?: ReactNode;
}) {
  const [coachLeaving, setCoachLeaving] = useState(false);
  const takeMutation = useMutation({
    mutationFn: revealHint,
    onSuccess: (res) => {
      setCoachLeaving(false);
      onRevealed(res.rung, res.text);
    },
    onError: () => setCoachLeaving(false),
  });

  const nextRung = revealedHints.length + 1;

  function reveal(rung: number) {
    if (revealCoachMark) setCoachLeaving(true);
    takeMutation.mutate(rung);
  }

  return (
    <div className="space-y-2">
      {RUNGS.map((rung) => {
        const isTaken = rung <= revealedHints.length;
        const isNext = !disabled && rung === nextRung;
        const isLocked = !isTaken && !isNext;
        const pending = takeMutation.isPending && takeMutation.variables === rung;

        return (
          <div
            key={rung}
            className={`flex gap-3 rounded-md border p-3 transition-[background-color,border-color,opacity] duration-200 ease-out motion-reduce:transition-none ${
              isTaken
                ? "border-accent-dim bg-bg-inset"
                : isLocked
                  ? "border-border opacity-50"
                  : "border-border-strong"
            }`}
          >
            <div className="flex min-h-7 shrink-0 items-center">
              <Plate size="sm" tone={isTaken ? "accent" : "neutral"} filled={isTaken} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-h-7 items-center justify-between gap-2">
                <span className="text-sm font-medium text-text">Hint #{rung}</span>
                {isNext && (
                  <div
                    className={`relative shrink-0 ${revealCoachMark ? "z-30" : ""} ${
                      coachLeaving ? "coach-guide-leaving" : ""
                    }`}
                  >
                    <LoadingSwap
                      loading={pending}
                      label="Revealing…"
                      className="min-h-[30px]"
                      spinnerClassName="justify-self-end text-text-dim"
                    >
                      <Button
                        size="sm"
                        variant="secondary"
                        className={
                          revealCoachMark
                            ? "ring-2 ring-accent ring-offset-4 ring-offset-bg-inset"
                            : ""
                        }
                        onClick={() => reveal(rung)}
                        disabled={takeMutation.isPending}
                      >
                        Reveal
                      </Button>
                    </LoadingSwap>
                    {revealCoachMark}
                  </div>
                )}
              </div>
              {isTaken && <HintText text={revealedHints[rung - 1]!} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
