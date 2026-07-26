/**
 * Give-up is deliberately separated from the hint ladder, visually and behaviorally: it's a
 * single irreversible action (score floors at 0% server-side, docs/CONTRACTS.md §8) that reveals
 * the solution and the concept tags. Styled as a distinct, quieter "last resort" rather than
 * another rung on the ladder.
 *
 * One click reveals — no confirm dialog. The separation, the red, and the label carry the weight
 * instead: nobody clicks a full-width red "See Solution" by accident, and the dialog's text said
 * nothing the button didn't. It IS irreversible, so this trades a safety net for directness.
 *
 * The caller unmounts this entirely once the solution is up: a permanently disabled button offering
 * something the user is already looking at is just clutter under the thing it would have produced.
 *
 * The button says what the user gets ("See Solution"), not what the system records. The scoring
 * consequence still happens — it just isn't narrated in this UI.
 */
import { useMutation } from "@tanstack/react-query";
import type { GiveUpResponse } from "@leetmind/shared";
import { api } from "../../lib/api";
import { Button } from "../ui";

export function GiveUpControl({
  versionId,
  activeMs,
  onGaveUp,
}: {
  versionId: string;
  activeMs: number;
  onGaveUp: (result: GiveUpResponse) => void;
}) {
  const mutation = useMutation({
    mutationFn: () => api.giveUp(versionId, { active_ms: activeMs }),
    onSuccess: onGaveUp,
  });

  return (
    <div>
      {/* Full-width and red: the button itself is the warning, so it needs no explanatory line
          above it. The rule that separates it from the hints belongs to the column, not to this
          component — once the solution is up, the button is gone and the rule stays. */}
      <Button variant="danger" className="w-full" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending ? "Revealing…" : "See Solution"}
      </Button>

      {/* The failure has to land here now that there's no dialog to hold it — otherwise a give-up
          that errored out would look like a click that simply did nothing. */}
      {mutation.isError && (
        <p className="mt-2 text-sm text-verdict-error">
          {mutation.error instanceof Error ? mutation.error.message : "Couldn't give up on this problem."}
        </p>
      )}
    </div>
  );
}
