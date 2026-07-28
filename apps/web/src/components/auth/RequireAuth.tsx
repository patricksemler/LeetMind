import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { RouteLoading } from "../ui";

/**
 * Gate for every route that reads user data.
 *
 * `ready` matters as much as `session`: Supabase restores a persisted session asynchronously, so
 * redirecting on `!session` before the restore resolves bounces a signed-in user to /login on
 * every reload. Rendering nothing decisive until `ready` is what avoids that.
 *
 * The current path is passed along in router state so signing in returns the user to where they
 * were rather than dumping them on the home page.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, session } = useAuth();
  const location = useLocation();

  if (!ready) {
    return <RouteLoading />;
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}
