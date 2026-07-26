/**
 * Give-up is deliberately separated from the hint ladder, visually and behaviorally: it's a
 * single irreversible action (score floors at 0% server-side, docs/CONTRACTS.md §8) that reveals
 * the solution and the concept tags. Confirm-gated like every hint rung, but styled as a distinct,
 * quieter "last resort" rather than another rung on the ladder.
 *
 * The button says what the user gets ("See Solution"), not what the system records. The scoring
 * consequence still happens — it just isn't narrated in this UI.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { GiveUpResponse } from "@leetmind/shared";
import { api } from "../../lib/api";
import { Button, Dialog } from "../ui";

export function GiveUpControl({
  versionId,
  activeMs,
  baselineItemId,
  disabled,
  onGaveUp,
}: {
  versionId: string;
  activeMs: number;
  baselineItemId?: string;
  disabled?: boolean;
  onGaveUp: (result: GiveUpResponse) => void;
}) {
  const [open, setOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.giveUp(versionId, { baseline_item_id: baselineItemId, active_ms: activeMs }),
    onSuccess: (res) => {
      setOpen(false);
      onGaveUp(res);
    },
  });

  return (
    <div className="border-t border-border pt-4">
      {/* Full-width and red: the button itself is the warning, so it needs no explanatory line
          above it. The confirm dialog is still where the consequence gets spelled out. */}
      <Button variant="danger" className="w-full" onClick={() => setOpen(true)} disabled={disabled}>
        See Solution
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="See the solution?">
        <div className="space-y-3 text-sm text-text-dim">
          <p>
            This ends the attempt and reveals the <strong className="text-text">solution</strong> and the{" "}
            <strong className="text-text">concept tags</strong>. There's no undo.
          </p>
        </div>
        {mutation.isError && (
          <p className="mt-3 text-sm text-verdict-error">
            {mutation.error instanceof Error ? mutation.error.message : "Couldn't give up on this problem."}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Keep trying
          </Button>
          <Button variant="danger" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Revealing…" : "See Solution"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
