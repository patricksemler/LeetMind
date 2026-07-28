import { CenteredPage } from "./CenteredPage";
import { Spinner } from "./Spinner";

/**
 * Shared full-screen route states: a loading placeholder and an error state with an optional retry
 * button. Extracted from the identical markup that `Concepts`, `Progress`, and `Practice` each had
 * inline — see those routes for the sites this replaced. Not every loading/error site in the app
 * matches this shape (`Problem`'s error state links back to practice instead of retrying, and
 * `Concepts`'s stale-mastery banner is an inline strip, not a full-screen state), so those are left
 * as they were rather than forced through this component.
 */
export function RouteLoading({ message = "Loading…" }: { message?: string }) {
  return (
    <CenteredPage role="status" aria-live="polite" className="gap-2 text-sm text-text-faint">
      <Spinner />
      <span>{message}</span>
    </CenteredPage>
  );
}

export function QueryError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <CenteredPage className="flex-col gap-3 text-center text-text-dim">
      <p>{message}</p>
      {onRetry && (
        <button className="text-accent underline" onClick={onRetry}>
          Retry
        </button>
      )}
    </CenteredPage>
  );
}
