import { useEffect } from "react";

export interface HotkeyBinding {
  /** `KeyboardEvent.key`, compared case-insensitively (e.g. "Enter", "'", "?"). */
  key: string;
  /** Require Cmd (mac) or Ctrl (elsewhere). */
  meta?: boolean;
  handler: (e: KeyboardEvent) => void;
  /** Fire even while focus is in an input/textarea/contentEditable. Off by default. */
  allowInInputs?: boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function matches(e: KeyboardEvent, binding: HotkeyBinding): boolean {
  if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;
  const modifierHeld = e.metaKey || e.ctrlKey;
  if (binding.meta && !modifierHeld) return false;
  if (!binding.meta && modifierHeld) return false;
  return true;
}

/** Registers global keyboard shortcuts (window-level). Re-binds whenever `deps` change. */
export function useHotkeys(bindings: HotkeyBinding[], deps: unknown[] = []): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const editable = isEditableTarget(e.target);
      for (const binding of bindings) {
        if (editable && !binding.allowInInputs) continue;
        if (matches(e, binding)) {
          e.preventDefault();
          binding.handler(e);
          return;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller controls rebind via deps
  }, deps);
}
