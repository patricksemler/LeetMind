import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatRating } from "../lib/format";
import { Badge, Plate, QueryError, RouteLoading } from "../components/ui";

/**
 * `/concepts` — the taxonomy as a readable tree (docs/CONTRACTS.md §3's DAG collapses to a
 * single-root tree here; a concept with more than one parent is shown once under each), with the
 * user's Elo on each node, colored by how far it sits from the 1200 baseline.
 *
 * This is the whole of what the app reports back about itself. The rating and the taxonomy arrive
 * in the same response, so there is no longer a second query to fall out of sync with — the
 * "mastery data failed to load" banner that used to sit above the tree is gone with it, because a
 * failure now takes the taxonomy down too and is already handled below.
 */
export function Concepts() {
  const conceptsQuery = useQuery({ queryKey: ["concepts"], queryFn: api.concepts });

  if (conceptsQuery.isLoading || !conceptsQuery.data) {
    return <RouteLoading />;
  }

  if (conceptsQuery.isError) {
    return (
      <QueryError
        message="Couldn't load the concept taxonomy."
        onRetry={() => conceptsQuery.refetch()}
      />
    );
  }

  const { concepts, edges, ratings } = conceptsQuery.data;
  const byId = new Map(concepts.map((c) => [c.id, c]));
  // Keyed by `concept_id`, which is what the API sends — keying by `id` here once made the join
  // miss 100% of rows and every attempted concept rendered identical to an untouched one.
  const ratingById = new Map(ratings.map((r) => [r.concept_id, r]));

  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    childrenOf.set(e.parent_id, [...(childrenOf.get(e.parent_id) ?? []), e.child_id]);
    parentsOf.set(e.child_id, [...(parentsOf.get(e.child_id) ?? []), e.parent_id]);
    hasParent.add(e.child_id);
  }
  const roots = concepts.filter((c) => !hasParent.has(c.id));

  function toneFor(rating: number): "accepted" | "accent" | "neutral" | "warn" {
    if (rating >= 1400) return "accepted";
    if (rating >= 1250) return "accent";
    if (rating > 0) return "neutral";
    return "warn";
  }

  // A concept with more than one parent (the taxonomy is a DAG, not a tree — CONTRACTS.md §3)
  // was rendered in full, subtree and all, under EVERY parent (a 9-concept subtree shared by two
  // parents rendered twice: 29 rows for 20 concepts, confirmed live) with no indication it was
  // the same node reappearing rather than a genuinely distinct branch. Only the first parent
  // (deterministic root-order DFS) expands the subtree; every later parent gets a compact
  // cross-reference instead. Computed as a pure pre-pass, NOT by mutating a Set inside `Node`
  // during render — that broke under StrictMode's double-invoke (each occurrence saw the other's
  // write and collapsed both, dropping the subtree from the page entirely in dev).
  const canonicalParentOf = new Map<string, string>();
  const visited = new Set<string>();
  function visit(id: string, parentId: string | null) {
    if (parentId !== null && !canonicalParentOf.has(id)) canonicalParentOf.set(id, parentId);
    if (visited.has(id)) return;
    visited.add(id);
    for (const k of childrenOf.get(id) ?? []) visit(k, id);
  }
  for (const r of roots) visit(r.id, null);

  function Node({ id, parentId, depth }: { id: string; parentId: string | null; depth: number }) {
    const concept = byId.get(id);
    if (!concept) return null;
    const entry = ratingById.get(id);
    const rating = entry ? entry.rating : 1200;
    const attempted = entry ? entry.attempts > 0 : false;
    const kids = childrenOf.get(id) ?? [];
    const parents = parentsOf.get(id) ?? [];
    const isRepeatOfMultiParent = parents.length > 1 && canonicalParentOf.get(id) !== parentId;

    return (
      <div>
        <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: depth * 24 }}>
          <Plate size="xs" tone={attempted ? toneFor(rating) : "neutral"} filled={attempted} />
          <span className="text-sm text-text">{concept.name}</span>
          {attempted && <Badge tone={toneFor(rating)}>{formatRating(rating)}</Badge>}
          {isRepeatOfMultiParent && (
            <span className="text-xs italic text-text-faint">
              also under {parents.map((p) => byId.get(p)?.name ?? p).join(", ")}
            </span>
          )}
        </div>
        {!isRepeatOfMultiParent &&
          kids.map((k) => <Node key={`${id}>${k}`} id={k} parentId={id} depth={depth + 1} />)}
      </div>
    );
  }

  return (
    // `min-w-0` + `overflow-x-auto` on the SCROLLING container, not just `overflow-y-auto`: deep
    // subtrees' `paddingLeft: depth * 24` indentation could otherwise force this flex child wider
    // than the viewport, overflowing the whole page horizontally and dragging the navbar
    // off-screen with it (confirmed live on mobile) instead of scrolling within this panel.
    <div className="h-full min-w-0 overflow-x-auto overflow-y-auto">
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="mb-1 font-display text-xl text-text">Concept taxonomy</h1>
        <p className="mb-4 text-sm text-text-dim">
          Your rating on each concept you've been served a problem for. Concepts with no rating
          haven't come up yet.
        </p>
        {roots.map((r) => (
          <Node key={r.id} id={r.id} parentId={null} depth={0} />
        ))}
      </div>
    </div>
  );
}
