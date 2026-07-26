import { useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./components/auth/RequireAuth";
import { NavBar } from "./components/layout/NavBar";
import { ShortcutHelp } from "./components/shortcuts/ShortcutHelp";
import { useHotkeys } from "./hooks/useHotkeys";
import { AuthProvider } from "./lib/auth";
import { Concepts } from "./routes/Concepts";
import { Practice } from "./routes/Practice";
import { Problem } from "./routes/Problem";
import { Progress } from "./routes/Progress";
import { SignIn, SignUp } from "./routes/SignIn";

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
      <p>Nothing here.</p>
      <Link to="/" className="text-accent underline">
        Back to practice
      </Link>
    </div>
  );
}

export function App() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useHotkeys([{ key: "?", handler: () => setShortcutsOpen(true) }], []);

  return (
    <AuthProvider>
      <div className="flex h-screen flex-col bg-bg text-text">
        <NavBar />
        <main className="min-h-0 min-w-0 flex-1">
          <Routes>
            {/* The only two routes reachable without a session. */}
            <Route path="/login" element={<SignIn />} />
            <Route path="/signup" element={<SignUp />} />

            <Route
              path="/"
              element={
                <RequireAuth>
                  <Practice />
                </RequireAuth>
              }
            />
            <Route
              path="/problem/:versionId"
              element={
                <RequireAuth>
                  <Problem />
                </RequireAuth>
              }
            />
            <Route
              path="/progress"
              element={
                <RequireAuth>
                  <Progress />
                </RequireAuth>
              }
            />
            <Route
              path="/concepts"
              element={
                <RequireAuth>
                  <Concepts />
                </RequireAuth>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        <ShortcutHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </div>
    </AuthProvider>
  );
}
