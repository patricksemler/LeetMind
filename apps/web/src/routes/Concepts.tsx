import { useMe } from "../hooks/useMe";
import { formatRating } from "../lib/format";
import { Badge, Plate, QueryError, RouteLoading } from "../components/ui";

/**
 * `/concepts` — the taxonomy as a flat list (PLAN_BACKEND.md §5: 20 fixed types, no DAG any more)
 * with the user's Elo on each, colored by how far it sits from the 1200 baseline.
 *
 * This is the whole of what the app reports back about itself. The rating and the taxonomy arrive
 * in the same response (`GET /api/me`), so there's no second query to fall out of sync with.
 */
export function Concepts() {
  const meQuery = useMe();

  if (meQuery.isLoading || !meQuery.data) {
    return <RouteLoading />;
  }

  if (meQuery.isError) {
    return (
      <QueryError message="Couldn't load your ratings." onRetry={() => void meQuery.refetch()} />
    );
  }

  function toneFor(rating: number): "accepted" | "accent" | "neutral" | "warn" {
    if (rating >= 1400) return "accepted";
    if (rating >= 1250) return "accent";
    return "neutral";
  }

  return (
    <div className="h-full min-w-0 overflow-x-auto overflow-y-auto">
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="mb-1 font-display text-xl text-text">Concepts</h1>
        <p className="mb-4 text-sm text-text-dim">
          Your rating on each type you've been served a problem for. Types with no rating haven't
          come up yet.
        </p>
        <div className="space-y-0.5">
          {meQuery.data.types.map((t) => (
            <div key={t.slug} className="flex items-center gap-2 py-1.5">
              <Plate size="xs" tone={t.evidenced ? toneFor(t.rating) : "neutral"} filled={t.evidenced} />
              <span className="text-sm text-text">{t.name}</span>
              {t.evidenced && <Badge tone={toneFor(t.rating)}>{formatRating(t.rating)}</Badge>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
