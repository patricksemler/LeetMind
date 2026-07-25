import { useEffect, useState } from "react";
import Editor, { type BeforeMount } from "@monaco-editor/react";
import type { Language } from "@algolift/shared";

const MONACO_LANGUAGE: Record<Language, string> = { python: "python", cpp: "cpp" };

type MonacoThemeName = "algolift-dark" | "algolift-light";

const defineTheme: BeforeMount = (monaco) => {
  monaco.editor.defineTheme("algolift-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#090b0d",
      "editor.lineHighlightBackground": "#14171b",
      "editorLineNumber.foreground": "#3a4048",
      "editorLineNumber.activeForeground": "#9aa2ab",
      "editorCursor.foreground": "#5ea1ff",
      "editor.selectionBackground": "#2c4a7a80",
    },
  });
  // Same mapping as "algolift-dark", against the light-theme token values in index.css's
  // `:root[data-theme="light"]` block: bg-inset for the base surface, bg-raised (brighter, same
  // relationship as dark's inset→raised step) for the active line, border-strong for gutter
  // digits, text-dim for the active one, accent for the caret.
  monaco.editor.defineTheme("algolift-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ecebe6",
      "editor.lineHighlightBackground": "#ffffff",
      "editorLineNumber.foreground": "#c3beb3",
      "editorLineNumber.activeForeground": "#57585c",
      "editorCursor.foreground": "#2563eb",
      "editor.selectionBackground": "#dbe6fd",
    },
  });
};

function resolveMonacoTheme(): MonacoThemeName {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light") return "algolift-light";
  if (explicit === "dark") return "algolift-dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "algolift-light" : "algolift-dark";
}

/** Tracks which Monaco theme should be active, mirroring index.css's own precedence: an explicit
 * `data-theme` wins outright, otherwise it follows the OS light/dark preference live. No app code
 * sets `data-theme` today, so in practice this just follows the media query — but resolving it the
 * same way index.css does means a future theme toggle needs no change here. */
function useMonacoTheme(): MonacoThemeName {
  const [theme, setTheme] = useState<MonacoThemeName>(resolveMonacoTheme);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const update = () => setTheme(resolveMonacoTheme());
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return theme;
}

/**
 * Monaco pane. `Cmd/Ctrl+Enter` (submit) and `Cmd/Ctrl+'` (run) are deliberately NOT bound here
 * via `editor.addCommand` — neither combo has a default Monaco binding, so the raw keydown bubbles
 * untouched to the single global listener in `useHotkeys` (wired in `routes/Problem.tsx` with
 * `allowInInputs: true`). That keeps shortcut handling in one place instead of two competing
 * sources that could double-fire a submission.
 */
export function EditorPane({
  language,
  value,
  onChange,
}: {
  language: Language;
  value: string;
  onChange: (v: string) => void;
}) {
  const theme = useMonacoTheme();

  return (
    <Editor
      height="100%"
      language={MONACO_LANGUAGE[language]}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      beforeMount={defineTheme}
      theme={theme}
      options={{
        fontSize: 13,
        fontFamily: "var(--font-mono)",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        padding: { top: 14 },
        renderLineHighlight: "line",
        smoothScrolling: true,
      }}
    />
  );
}
