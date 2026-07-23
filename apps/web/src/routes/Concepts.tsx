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

  const { concepts, edges } = conceptsQuery.data;
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const masteryById = new Map((progressQuery.data?.concepts ?? []).map((c) => [String(c.id), c]));

  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    childrenOf.set(e.parent_id, [...(childrenOf.get(e.parent_id) ?? []), e.child_id]);
    hasParent.add(e.child_id);
  }
  const roots = concepts.filter((c) => !hasParent.has(c.id));

  function toneFor(rating: number): "accepted" | "accent" | "neutral" | "warn" {
    if (rating >= 1400) return "accepted";
    if (rating >= 1250) return "accent";
    if (rating > 0) return "neutral";
    return "warn";
  }

  function Node({ id, depth }: { id: string; depth: number }) {
    const concept = byId.get(id);
    if (!concept) return null;
    const mastery = masteryById.get(id);
    const rating = mastery ? Number(mastery.rating ?? 1200) : 1200;
    const attempted = mastery ? Number(mastery.attempts ?? 0) > 0 : false;
    const kids = childrenOf.get(id) ?? [];

    return (
      <div>
        <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: depth * 24 }}>
          <Plate size="xs" tone={attempted ? toneFor(rating) : "neutral"} filled={attempted} />
          <span className="text-sm text-text">{concept.name}</span>
          {attempted && (
            <Badge tone={toneFor(rating)}>{Math.round(rating)}</Badge>
          )}
        </div>
        {kids.map((k) => (
          <Node key={`${id}>${k}`} id={k} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <h1 className="mb-4 font-display text-xl text-text">Concept taxonomy</h1>
      {roots.map((r) => (
        <Node key={r.id} id={r.id} depth={0} />
      ))}
    </div>
  );
}
