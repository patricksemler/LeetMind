/**
 * Session state for the whole app.
 *
 * Two responsibilities, deliberately kept together because they must not disagree:
 *  1. Expose the current session to React (`useAuth`).
 *  2. Publish the access token to the non-React `api` client (`setAccessTokenGetter`), which
 *     attaches it to every request. Routing that through a module-level getter rather than React
 *     context means `api` stays a plain module usable from tests, loaders, and the SSE hook —
 *     none of which sit under a provider.
 *
 * `signOut` also clears the react-query cache. Without that, the next account to sign in on the
 * same tab paints the previous account's problems and mastery numbers from cache before their own
 * data arrives — a genuine cross-account leak in the UI even though every API response was
 * correctly scoped.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { authConfigured, supabase } from "./supabase";
import { setAccessTokenGetter } from "./api";

export interface AuthState {
  /** False until the initial session lookup resolves — render nothing decisive before then, or a
   * returning user sees a flash of the signed-out UI on every reload. */
  ready: boolean;
  /** Null when signed out, or always null when auth isn't configured (single-user mode). */
  session: Session | null;
  email: string | null;
  /** True when the app requires a session at all. False for the mock/single-user stack. */
  authRequired: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function requireClient() {
  if (!supabase) throw new Error("Authentication is not configured for this build.");
  return supabase;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!authConfigured);

  // Read by the api client on every request. It asks the Supabase client directly rather than
  // reading React state: `getSession()` is the authoritative source, it resolves the persisted
  // session on a cold load, and it refreshes an access token that is about to expire. Reading
  // React state here instead produced 401s in two real windows — immediately after signup (before
  // `onAuthStateChange` had been processed) and on first paint after a reload.
  useEffect(() => {
    setAccessTokenGetter(async () => {
      if (!supabase) return null;
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    });
    return () => setAccessTokenGetter(null);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setReady(true);
    });

    // Fires on sign-in, sign-out, and every silent token refresh — the refresh case is why this
    // subscription matters even for a user who never touches the auth UI.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      session,
      email: session?.user.email ?? null,
      authRequired: authConfigured,
      async signIn(email, password) {
        const { error } = await requireClient().auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
      },
      async signUp(email, password) {
        const { data, error } = await requireClient().auth.signUp({ email, password });
        if (error) throw new Error(error.message);
        // A project with email confirmation enabled returns a user but no session; the caller has
        // to tell the user to check their inbox instead of navigating them into the app.
        return { needsEmailConfirmation: data.session === null };
      },
      async signOut() {
        await requireClient().auth.signOut();
        setSession(null);
        queryClient.clear();
      },
    }),
    [ready, session, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
