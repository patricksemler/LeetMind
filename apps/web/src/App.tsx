import { lazy, Suspense, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./components/auth/RequireAuth";
import { NavBar } from "./components/layout/NavBar";
import { ShortcutHelp } from "./components/shortcuts/ShortcutHelp";
import { CenteredPage, RouteLoading } from "./components/ui";
import { useHotkeys } from "./hooks/useHotkeys";
import { AuthProvider } from "./lib/auth";
import { Concepts } from "./routes/Concepts";
import { Practice } from "./routes/Practice";
import { SignIn, SignUp } from "./routes/SignIn";

const DemoExperience = lazy(() =>
  import("./demo/DemoExperience").then(({ DemoExperience }) => ({ default: DemoExperience })),
);
const Problem = lazy(() =>
  import("./routes/Problem").then(({ Problem }) => ({ default: Problem })),
);

function NotFound() {
  return (
    <CenteredPage className="flex-col gap-3 text-center text-text-dim">
      <p>Nothing here.</p>
      <Link to="/" className="text-accent underline">
        Back to practice
      </Link>
    </CenteredPage>
  );
}

export function App() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useHotkeys([{ key: "?", handler: () => setShortcutsOpen(true) }], []);

  return (
    <AuthProvider>
      <div className="flex h-screen flex-col bg-bg text-text">
        <a
          href="#main-content"
          className="fixed left-4 top-2 z-[60] -translate-y-16 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg transition-transform duration-150 focus-visible:translate-y-0 motion-reduce:transition-none"
        >
          Skip to main content
        </a>
        <NavBar />
        <main id="main-content" className="min-h-0 min-w-0 flex-1">
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              {/* The only two routes reachable without a session. */}
              <Route path="/login" element={<SignIn />} />
              <Route path="/signup" element={<SignUp />} />
              <Route path="/demo" element={<DemoExperience />} />

              <Route
                path="/"
                element={
                  <RequireAuth>
                    <Practice />
                  </RequireAuth>
                }
              />
              <Route
                path="/problem/:problemId"
                element={
                  <RequireAuth>
                    <Problem />
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
          </Suspense>
        </main>
        <ShortcutHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </div>
    </AuthProvider>
  );
}
