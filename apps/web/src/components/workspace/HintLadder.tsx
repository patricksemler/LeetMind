/**
 * The hint ladder: l1_orientation → l2_conceptual → l3_structural → outline. Reveal takes the rung
 * immediately — there is no confirm step. The confirm dialog that used to sit in front of every
 * rung asked "are you sure?" about something the button already said plainly, on a ladder where
 * only one rung is ever reachable at a time; the cost is a scoring cap the UI doesn't narrate
 * anyway, so the dialog was friction without information. Taken rungs stay visible with their
 * text. Rungs beyond the next one are locked — hints are meant to be climbed in order.
 *
 * Rungs are numbered rather than named for their internal level: the label shouldn't preview how
 * specific the hint is about to get. The scoring consequence of taking one isn't surfaced here
 * either — the server still applies `HINT_PENALTY_CAPS`, the UI just doesn't narrate it.
 *
 * `editorial` is deliberately not offered here — it's only reachable through the separate,
 * visually distinct give-up flow (`GiveUpControl`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HintLevel } from "@leetmind/shared";
import { api } from "../../lib/api";
import { useHints } from "../../hooks/useHints";
import { Button, Plate } from "../ui";
import { Markdown } from "./Markdown";

const LADDER: HintLevel[] = ["l1_orientation", "l2_conceptual", "l3_structural", "outline"];

function labelFor(level: HintLevel): string {
  const i = LADDER.indexOf(level);
  return i === -1 ? "Hint" : `Hint #${i + 1}`;
}

export function HintLadder({ versionId, disabled = false }: { versionId: string; disabled?: boolean }) {
  const queryClient = useQueryClient();
  /** Rungs revealed in THIS session, tagged with the problem they belong to — see `takenSet` below
   * for why they're held at all. Tagged because the ladder is not remounted when the route moves to
   * another problem: untagged, hint text revealed on the previous problem stayed in state and was
   * drawn against the new one's rungs. */
  const [revealed, setRevealed] = useState<{ versionId: string; texts: Partial<Record<HintLevel, string>> }>({
    versionId,
    texts: {},
  });
  const hintsQuery = useHints(versionId);

  const rememberText = useCallback((forVersion: string, level: HintLevel, text: string) => {
    setRevealed((prev) =>
      prev.versionId === forVersion
        ? { versionId: forVersion, texts: { ...prev.texts, [level]: text } }
        : { versionId: forVersion, texts: { [level]: text } },
    );
  }, []);

  const takeMutation = useMutation({
    mutationFn: (level: HintLevel) => api.takeHint({ problem_version_id: versionId, level }),
    onSuccess: (res) => {
      rememberText(versionId, res.level, res.text);
      void queryClient.invalidateQueries({ queryKey: ["hints", versionId] });
      void queryClient.invalidateQueries({ queryKey: ["problem", versionId] });
    },
  });

  const taken = hintsQuery.data?.taken.filter((l): l is HintLevel => LADDER.includes(l)) ?? [];

  // Text for rungs taken in an earlier session comes back on the ladder's own GET, so the whole
  // ladder draws in one pass. It used to be reconstructed by re-POSTing /api/hints once per taken
  // rung after mount, which meant every revisit rendered "Loading…" placeholders and filled them in
  // a round trip later.
  const revealedTexts = revealed.versionId === versionId ? revealed.texts : {};
  const hintTexts: Partial<Record<HintLevel, string>> = { ...hintsQuery.data?.texts, ...revealedTexts };

  // Fallback for a rung the server reports as taken but sends no text for — an API older than the
  // `texts` field, or any gap in it. `POST /api/hints` is idempotent (the server records a level at
  // most once, so this never re-applies the penalty), and it's the only way to get that text back.
  // Without it the rung sits on "Loading…" forever, which is worse than the extra round trip it
  // costs: the point of `texts` is that this path is never normally taken.
  const refetchedRef = useRef<{ versionId: string; levels: Set<HintLevel> }>({ versionId, levels: new Set() });
  useEffect(() => {
    if (!hintsQuery.data) return;
    if (refetchedRef.current.versionId !== versionId) refetchedRef.current = { versionId, levels: new Set() };
    for (const level of taken) {
      if (hintTexts[level] || refetchedRef.current.levels.has(level)) continue;
      refetchedRef.current.levels.add(level);
      api
        .takeHint({ problem_version_id: versionId, level })
        .then((res) => rememberText(versionId, res.level, res.text))
        .catch(() => {
          /* best-effort reconstruction */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintsQuery.data, versionId]);

  // Server truth PLUS the rungs revealed in this session, whose text is already in hand. Keyed on
  // `taken` alone the rung fell back to an un-taken "Reveal" for the length of the `hints` refetch:
  // `onSuccess` has the text immediately, but it only invalidates that query, and until the refetch
  // lands the server still says the rung isn't taken. So the row went "Revealing…" → "Reveal" →
  // hint text, reading as a flicker of the click not registering (confirmed live). The text we hold
  // is proof the rung was taken — the refetch only ever confirms it.
  const takenSet = new Set<HintLevel>([...taken, ...(Object.keys(hintTexts) as HintLevel[])]);
  const nextLevelIndex = LADDER.findIndex((l) => !takenSet.has(l));

  // Until the first fetch lands, which rungs are taken is unknown — and "unknown" rendered as
  // "none taken", so a problem with hints already taken drew rung 1 with a live Reveal button and
  // then swapped it for hint text. No action is offered until there's an answer; the rows
  // themselves are laid out either way, so nothing jumps when it arrives.
  const ladderKnown = !hintsQuery.isPending;

  return (
    <div className="space-y-2" aria-busy={!ladderKnown}>
      {LADDER.map((level, i) => {
        const isTaken = takenSet.has(level);
        const isNext = ladderKnown && i === nextLevelIndex && !disabled;
        const isLocked = !isTaken && !isNext;

        return (
          <div
            key={level}
            className={`flex gap-3 rounded-md border p-3 ${
              isTaken ? "border-accent-dim bg-bg-inset" : isLocked ? "border-border opacity-50" : "border-border-strong"
            }`}
          >
            {/* Plate and title row share one height (`min-h-7`, the height of the reveal button) and
                both center within it. Without that the plate was pinned near the top of the row: a
                rung carrying a button was taller than one without, so the same nudge that centered
                it on a plain rung left it sitting high on the one rung that had an action. */}
            <div className="flex min-h-7 shrink-0 items-center">
              <Plate size="sm" tone={isTaken ? "accent" : "neutral"} filled={isTaken} />
            </div>
            <div className="min-w-0 flex-1">
              {/* Title row: label left, reveal action hard right. A locked rung carries no
                  explanatory line — the dimmed row and the absent button already say it isn't
                  reachable yet. */}
              <div className="flex min-h-7 items-center justify-between gap-2">
                <span className="text-sm font-medium text-text">{labelFor(level)}</span>
                {isNext && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => takeMutation.mutate(level)}
                    disabled={takeMutation.isPending}
                  >
                    {takeMutation.isPending ? "Revealing…" : "Reveal"}
                  </Button>
                )}
              </div>
              {isTaken && hintTexts[level] && <Markdown className="mt-1 text-xs">{hintTexts[level]!}</Markdown>}
              {isTaken && !hintTexts[level] && <p className="mt-1 text-xs text-text-faint">Loading…</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
