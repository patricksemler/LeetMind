import Editor, { type BeforeMount } from "@monaco-editor/react";
import type { Language } from "@algolift/shared";

const MONACO_LANGUAGE: Record<Language, string> = { python: "python", cpp: "cpp" };

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
};

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
  return (
    <Editor
      height="100%"
      language={MONACO_LANGUAGE[language]}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      beforeMount={defineTheme}
      theme="algolift-dark"
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
