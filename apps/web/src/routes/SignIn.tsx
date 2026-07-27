import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button, Panel } from "../components/ui";

/**
 * `/login` and `/signup` — the same form with two modes, because they differ only in which
 * Supabase call they make and what happens next. Keeping them as one component keeps the two
 * screens from drifting apart in validation, error handling, and layout.
 *
 * Credentials go straight to Supabase Auth from the browser; the LeetMind API never sees them.
 */
export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const { session, ready, authRequired, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checkInbox, setCheckInbox] = useState(false);

  // Nothing to sign into: this build talks to a single-user API. Send them to the app rather than
  // showing a form that cannot work.
  if (!authRequired) return <Navigate to="/" replace />;
  if (ready && session) {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  const isSignUp = mode === "signup";

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (isSignUp && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setPending(true);
    try {
      if (isSignUp) {
        const { needsEmailConfirmation } = await signUp(email.trim(), password);
        if (needsEmailConfirmation) {
          setCheckInbox(true);
          return;
        }
      } else {
        await signIn(email.trim(), password);
      }
      navigate((location.state as { from?: string } | null)?.from ?? "/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (checkInbox) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Panel className="max-w-sm p-6 text-center">
          <h1 className="font-display text-xl text-text">Check your inbox</h1>
          <p className="mt-2 text-sm text-text-dim">
            We sent a confirmation link to <strong className="text-text">{email}</strong>. Open it
            to finish creating your account.
          </p>
          <Link to="/login" className="mt-4 inline-block text-sm text-accent underline">
            Back to sign in
          </Link>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel className="w-full max-w-sm p-6">
        <h1 className="font-display text-xl text-text">
          {isSignUp ? "Create your account" : "Sign in"}
        </h1>
        <p className="mt-1 text-sm text-text-dim">
          {isSignUp
            ? "Your practice history, ratings, and generated problems are tied to this account."
            : "Welcome back."}
        </p>

        <form className="mt-5 space-y-3" onSubmit={onSubmit}>
          <div>
            <label htmlFor="email" className="mb-1 block text-xs text-text-faint">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border border-border bg-bg-overlay px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-xs text-text-faint">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={isSignUp ? 8 : undefined}
              autoComplete={isSignUp ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border border-border bg-bg-overlay px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            {isSignUp && <p className="mt-1 text-xs text-text-faint">At least 8 characters.</p>}
          </div>

          {error && (
            <p role="alert" className="text-sm text-verdict-error">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" className="w-full" disabled={pending}>
            {pending
              ? isSignUp
                ? "Creating…"
                : "Signing in…"
              : isSignUp
                ? "Create account"
                : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-text-faint">
          {isSignUp ? (
            <>
              Already have an account?{" "}
              <Link to="/login" className="text-accent underline">
                Sign in
              </Link>
            </>
          ) : (
            <>
              No account yet?{" "}
              <Link to="/signup" className="text-accent underline">
                Create one
              </Link>
            </>
          )}
        </p>
      </Panel>
    </div>
  );
}

export function SignIn() {
  return <AuthForm mode="signin" />;
}

export function SignUp() {
  return <AuthForm mode="signup" />;
}
