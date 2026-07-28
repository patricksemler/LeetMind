import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Read through a ref, not a dependency — `onClose` is an inline arrow function at every call
  // site (`() => setOpen(false)`), so it gets a new identity on every parent re-render. Depending
  // on it directly would re-run this effect (recapturing "previously focused", re-stealing focus)
  // on every keystroke/mutation-state change while the dialog is open, not just on open/close.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Focus trap + focus restoration (previously absent): Tab could escape to background page
    // elements while the dialog was open, and closing it (Esc, the X button, backdrop click, or a
    // confirm action) left focus on `<body>` instead of back where the user was before opening.
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    ref.current?.focus();

    function getFocusable(): HTMLElement[] {
      const root = ref.current;
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      // Always take control of Tab explicitly (rather than only intervening at the first/last
      // boundary and otherwise trusting default browser tab order) — the dialog's own root sits
      // in the DOM between focusable elements with `tabIndex={-1}`, and relying on native
      // navigation to correctly skip it is exactly the kind of thing that only "mostly" works.
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        ref.current?.focus();
        return;
      }
      const active = document.activeElement;
      const currentIndex = active instanceof Node ? focusable.indexOf(active as HTMLElement) : -1;
      const delta = e.shiftKey ? -1 : 1;
      const nextIndex =
        currentIndex === -1 ? 0 : (currentIndex + delta + focusable.length) % focusable.length;
      e.preventDefault();
      focusable[nextIndex]!.focus();
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="dialog-panel-enter w-full max-w-lg rounded-lg border border-border-strong bg-bg-overlay shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-display text-base text-text">{title}</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-text-faint transition-colors duration-150 hover:bg-bg-raised hover:text-text motion-reduce:transition-none"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
