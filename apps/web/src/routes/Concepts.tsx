import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Plate } from "../components/ui";

/** `/concepts` — the taxonomy as a readable tree (docs/CONTRACTS.md §3's DAG collapses to a
 * single-root tree here; a concept with more than one parent is shown once under each). Each node
 * carries its current mastery rating, colored by how far it sits from the 1200 baseline. */
export function Concepts() {
  const conceptsQuery = useQuery({ queryKey: ["concepts"], queryFn: api.concepts });
  const progressQuery = useQuery({ queryKey: ["progress"], queryFn: api.progress });

  if (conceptsQuery.isLoading || progressQuery.isLoading || !conceptsQuery.data) {
    return <div className="flex h-full items-center justify-center text-text-faint">Loading…</div>;
  }

  if (conceptsQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <p>Couldn't load the concept taxonomy.</p>
        <button className="text-accent underline" onClick={() => conceptsQuery.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const { concepts, edges } = conceptsQuery.data;
  const byId = new Map(concepts.map((c) => [c.id, c]));
  // The mastery source (`GET /api/progress`'s `concepts` array) keys each row by `concept_id`, not
  // `id` — keying by `id` here made the join miss 100% of rows against the real API: every
  // attempted concept rendered identical to an untouched one (confirmed live).
  const masteryById = new Map((progressQuery.data?.concepts ?? []).map((c) => [String(c.concept_id), c]));

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
  // the same node reappearing rather than a genuinely distinct branch. Tracked across the whole
  // traversal — Node closes over this — so only the first occurrence expands; every later one is
  // a compact cross-reference instead of a second full copy of its subtree.
  const renderedFully = new Set<string>();

  function Node({ id, depth }: { id: string; depth: number }) {
    const concept = byId.get(id);
    if (!concept) return null;
    const mastery = masteryById.get(id);
    const rating = mastery ? Number(mastery.rating ?? 1200) : 1200;
    const attempted = mastery ? Number(mastery.attempts ?? 0) > 0 : false;
    const kids = childrenOf.get(id) ?? [];
    const parents = parentsOf.get(id) ?? [];
    const isRepeatOfMultiParent = parents.length > 1 && renderedFully.has(id);
    if (!isRepeatOfMultiParent) renderedFully.add(id);

    return (
      <div>
        <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: depth * 24 }}>
          <Plate size="xs" tone={attempted ? toneFor(rating) : "neutral"} filled={attempted} />
          <span className="text-sm text-text">{concept.name}</span>
          {attempted && (
            <Badge tone={toneFor(rating)}>{Math.round(rating)}</Badge>
          )}
          {isRepeatOfMultiParent && (
            <span className="text-xs italic text-text-faint">
              also under {parents.map((p) => byId.get(p)?.name ?? p).join(", ")}
            </span>
          )}
        </div>
        {!isRepeatOfMultiParent &&
          kids.map((k) => <Node key={`${id}>${k}`} id={k} depth={depth + 1} />)}
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
        <h1 className="mb-4 font-display text-xl text-text">Concept taxonomy</h1>
        {roots.map((r) => (
          <Node key={r.id} id={r.id} depth={0} />
        ))}
      </div>
    </div>
  );
}
