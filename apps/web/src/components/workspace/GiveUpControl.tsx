/**
 * Give-up is deliberately separated from the hint ladder, visually and behaviorally: it's a
 * single irreversible action (score floors at 0%, docs/CONTRACTS.md §8) that reveals the
 * editorial and the concept tags. Confirm-gated like every hint rung, but styled as a distinct,
 * quieter "last resort" rather than another rung on the ladder.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { GiveUpResponse } from "@algolift/shared";
import { api } from "../../lib/api";
import { Button, Dialog } from "../ui";

export function GiveUpControl({
  versionId,
  activeMs,
  workoutItemId,
  disabled,
  onGaveUp,
}: {
  versionId: string;
  activeMs: number;
  workoutItemId?: string;
  disabled?: boolean;
  onGaveUp: (result: GiveUpResponse) => void;
}) {
  const [open, setOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.giveUp(versionId, { workout_item_id: workoutItemId, active_ms: activeMs }),
    onSuccess: (res) => {
      setOpen(false);
      onGaveUp(res);
    },
  });

  return (
    <div className="border-t border-border pt-4">
      <p className="mb-2 text-xs text-text-faint">Completely stuck? This ends the attempt and shows the solution.</p>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)} disabled={disabled}>
        Give up &amp; show editorial
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Give up on this problem?">
        <div className="space-y-3 text-sm text-text-dim">
          <p>
            This reveals the <strong className="text-text">editorial</strong> and the{" "}
            <strong className="text-text">concept tags</strong>, and permanently scores this attempt at{" "}
            <strong className="text-verdict-error">0%</strong>. There's no undo.
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Keep trying
          </Button>
          <Button variant="danger" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Giving up…" : "Give up"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
