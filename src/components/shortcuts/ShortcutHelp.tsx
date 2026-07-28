import { Dialog } from "../ui";

const SHORTCUTS: Array<{ combo: string; description: string }> = [
  { combo: "Cmd/Ctrl + Enter", description: "Submit the current solution" },
  { combo: "Cmd/Ctrl + '", description: "Run against custom input (does not affect mastery)" },
  { combo: "?", description: "Show this shortcut list" },
  { combo: "Esc", description: "Close a dialog" },
];

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <dl className="space-y-3">
        {SHORTCUTS.map((s) => (
          <div key={s.combo} className="flex items-center justify-between gap-4">
            <dt className="font-mono text-xs text-text-dim">{s.combo}</dt>
            <dd className="text-right text-sm text-text">{s.description}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
