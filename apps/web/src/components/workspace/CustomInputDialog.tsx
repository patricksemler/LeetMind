import { useEffect, useState } from "react";
import { Button, Dialog } from "../ui";

/** Run's custom-input affordance — prefilled from example 1, editable, never touches mastery. */
export function CustomInputDialog({
  open,
  onClose,
  initialArgs,
  onRun,
}: {
  open: boolean;
  onClose: () => void;
  initialArgs: unknown[];
  onRun: (args: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(initialArgs, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText(JSON.stringify(initialArgs, null, 2));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleRun() {
    try {
      const parsed: unknown = JSON.parse(text);
      setError(null);
      onRun(parsed);
    } catch {
      setError("That isn't valid JSON — fix it and try again.");
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Run against custom input">
      <p className="mb-2 text-xs text-text-faint">
        Prefilled from Example 1. Edit the arguments as a JSON array, then run. This does not affect mastery.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        spellCheck={false}
        className="w-full resize-y rounded-md border border-border bg-bg-inset p-2.5 font-mono text-xs text-text outline-none focus:border-accent"
      />
      {error && <p className="mt-1.5 text-xs text-verdict-error">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleRun}>
          Run
        </Button>
      </div>
    </Dialog>
  );
}
