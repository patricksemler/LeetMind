/**
 * The Supabase Auth client — the only place in the web app that holds credentials, and the only
 * place that talks to anything other than the LeetMind API.
 *
 * Auth is *optional at build time on purpose*: `pnpm dev:mock` and the component test suite run
 * against a mock API with no Supabase project, and forcing them to stand one up would make the
 * fast feedback loop depend on a network service. When the env vars are absent `supabase` is
 * `null` and `authConfigured` is false; `AuthProvider` then runs in single-user mode, exactly
 * matching an API booted with `AUTH_REQUIRED=false`.
 */
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const authConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = authConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        // Survive a reload, and refresh the access token before the API starts 401ing on it.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
