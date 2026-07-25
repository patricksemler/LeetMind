/**
 * The hint ladder: l1_orientation → l2_conceptual → l3_structural → outline. Each unlocked rung
 * shows its penalty cap *before* it's taken and requires an explicit confirm (docs/CONTRACTS.md
 * §8, §12). Taken rungs stay visible with their text. Rungs beyond the next one are locked —
 * hints are meant to be climbed in order.
 *
 * `editorial` is deliberately not offered here — it's only reachable through the separate,
 * visually distinct give-up flow (`GiveUpControl`).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HINT_PENALTY_CAPS, type HintLevel } from "@leetmind/shared";
import { api } from "../../lib/api";
import { formatPercent } from "../../lib/format";
import { Badge, Button, Dialog, Plate } from "../ui";
import { Markdown } from "./Markdown";

const LADDER: HintLevel[] = ["l1_orientation", "l2_conceptual", "l3_structural", "outline"];
const LABELS: Record<HintLevel, string> = {
  l1_orientation: "L1 — Orientation",
  l2_conceptual: "L2 — Conceptual",
  l3_structural: "L3 — Structural",
  outline: "Outline",
  editorial: "Editorial",
};

export function HintLadder({ versionId, disabled = false }: { versionId: string; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const [hintTexts, setHintTexts] = useState<Partial<Record<HintLevel, string>>>({});
  const [confirmLevel, setConfirmLevel] = useState<HintLevel | null>(null);

  const hintsQuery = useQuery({
    queryKey: ["hints", versionId],
    queryFn: () => api.getHints(versionId),
  });

  const takeMutation = useMutation({
    mutationFn: (level: HintLevel) => api.takeHint({ problem_version_id: versionId, level }),
    onSuccess: (res) => {
      setHintTexts((prev) => ({ ...prev, [res.level]: res.text }));
      void queryClient.invalidateQueries({ queryKey: ["hints", versionId] });
      void queryClient.invalidateQueries({ queryKey: ["problem", versionId] });
    },
  });

  const taken = hintsQuery.data?.taken.filter((l): l is HintLevel => LADDER.includes(l)) ?? [];

  // Reconstruct hint text for rungs already taken in an earlier session (idempotent re-fetch —
  // the server records a hint at most once per level, so this never re-applies the penalty).
  useEffect(() => {
    for (const level of taken) {
      if (!(level in hintTexts) && !takeMutation.isPending) {
        api
          .takeHint({ problem_version_id: versionId, level })
          .then((res) => setHintTexts((prev) => ({ ...prev, [res.level]: res.text })))
          .catch(() => {
            /* best-effort reconstruction */
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taken.join(","), versionId]);

  const nextLevelIndex = LADDER.findIndex((l) => !taken.includes(l));

  return (
    <div className="space-y-2">
      {LADDER.map((level, i) => {
        const isTaken = taken.includes(level);
        const isNext = i === nextLevelIndex && !disabled;
        const isLocked = !isTaken && !isNext;
        const cap = HINT_PENALTY_CAPS[level];

        return (
          <div
            key={level}
            className={`flex gap-3 rounded-md border p-3 ${
              isTaken ? "border-accent-dim bg-bg-inset" : isLocked ? "border-border opacity-50" : "border-border-strong"
            }`}
          >
            <Plate size="sm" tone={isTaken ? "accent" : "neutral"} filled={isTaken} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-text">{LABELS[level]}</span>
                {!isTaken && <Badge tone="warn">caps score at {formatPercent(cap)}</Badge>}
              </div>
              {isTaken && hintTexts[level] && <Markdown className="text-xs">{hintTexts[level]!}</Markdown>}
              {isTaken && !hintTexts[level] && <p className="text-xs text-text-faint">Loading…</p>}
              {isNext && (
                <Button size="sm" variant="secondary" onClick={() => setConfirmLevel(level)} disabled={takeMutation.isPending}>
                  {takeMutation.isPending ? "Revealing…" : "Reveal this hint"}
                </Button>
              )}
              {isLocked && <p className="text-xs text-text-faint">Take the hint above first.</p>}
            </div>
          </div>
        );
      })}

      <Dialog open={confirmLevel !== null} onClose={() => setConfirmLevel(null)} title="Take this hint?">
        {confirmLevel && (
          <div className="space-y-3 text-sm text-text-dim">
            <p>
              Taking <strong className="text-text">{LABELS[confirmLevel]}</strong> caps your maximum score on this
              problem at <strong className="text-verdict-warn">{formatPercent(HINT_PENALTY_CAPS[confirmLevel])}</strong>.
              This can't be undone.
            </p>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmLevel(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (confirmLevel) takeMutation.mutate(confirmLevel);
              setConfirmLevel(null);
            }}
          >
            Take hint
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
