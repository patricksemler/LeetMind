import { useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { NavBar } from "./components/layout/NavBar";
import { ShortcutHelp } from "./components/shortcuts/ShortcutHelp";
import { useHotkeys } from "./hooks/useHotkeys";
import { Today } from "./routes/Today";
import { Problem } from "./routes/Problem";
import { Progress } from "./routes/Progress";
import { Diagnostic } from "./routes/Diagnostic";
import { Concepts } from "./routes/Concepts";

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
      <p>Nothing here.</p>
      <Link to="/" className="text-accent underline">
        Back to Today
      </Link>
    </div>
  );
}

export function App() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useHotkeys(
    [{ key: "?", handler: () => setShortcutsOpen(true) }],
    [],
  );

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <NavBar onShowShortcuts={() => setShortcutsOpen(true)} />
      <main className="min-h-0 min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/problem/:versionId" element={<Problem />} />
          <Route path="/progress" element={<Progress />} />
          <Route path="/diagnostic" element={<Diagnostic />} />
          <Route path="/concepts" element={<Concepts />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <ShortcutHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
