// The ONLY place apps/api builds a client-facing problem payload. Delegates the actual
// whitelist-projection to `toPublicProblem` (the single exclusive constructor per
// docs/CONTRACTS.md §4.2) and then does exactly one extra thing that's this app's job, not
// shared's: hydrating `concepts_revealed` refs (`{id, role, weight}`) with concept names by
// joining the `concepts` table, since `toPublicProblem` intentionally has no DB access.
import { queryOne, query, listHintEvents, type ProblemVersionRow, type ConceptRow } from "@algolift/db";
import { ProblemVersionSchema, toPublicProblem, type PublicProblem } from "@algolift/shared";

export interface RevealedConcept {
  id: string;
  name: string;
  role: "primary" | "secondary";
  weight: number;
}

export type PublicProblemWithNames = Omit<PublicProblem, "concepts_revealed"> & {
  concepts_revealed: RevealedConcept[] | null;
};

/**
 * True iff `userId` has an accepted `submit`-mode submission against `problemVersionId`.
 * Not exported from `@algolift/db` (no existing helper covers this exact predicate), so it's a
 * small ad hoc query here rather than a new package export — this app may only ever *read* via
 * `@algolift/db`'s generic `query`/`queryOne`, not add methods to that package.
 */
async function hasAcceptedSubmission(userId: string, problemVersionId: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `select exists(
       select 1 from submissions
       where user_id = $1 and problem_version_id = $2 and mode = 'submit' and verdict = 'accepted'
     ) as exists`,
    [userId, problemVersionId],
  );
  return row?.exists ?? false;
}

/**
 * True iff `userId` has "earned" this problem version's server-only reveal fields — an accepted
 * `submit` submission, or a recorded give-up (the `editorial` hint event `POST
 * /api/problems/:versionId/give-up` writes). Exported so `mappers/submission.ts` can apply the
 * identical rule to the post-solve `reveal` field (docs/CONTRACTS.md §4.5) without duplicating it —
 * `concepts_revealed` on `PublicProblem` and `reveal` on a submission are the same earned-ness
 * check applied to two different response shapes.
 */
export async function hasEarnedReveal(userId: string, problemVersionId: string): Promise<boolean> {
  const [hintEvents, accepted] = await Promise.all([
    listHintEvents(userId, problemVersionId),
    hasAcceptedSubmission(userId, problemVersionId),
  ]);
  const gaveUp = hintEvents.some((h) => h.level === "editorial");
  return accepted || gaveUp;
}

/**
 * Builds the full `PublicProblem` (with concept names hydrated) for `versionRow`, computing
 * `hintsTaken` from `hint_events` and `revealConcepts` from "has an accepted submission OR has
 * taken the editorial (gave up)" — exactly the rule in the apps/api brief.
 */
export async function buildPublicProblem(
  versionRow: ProblemVersionRow,
  userId: string,
): Promise<PublicProblemWithNames> {
  const content = ProblemVersionSchema.parse(versionRow.content);

  const [hintEvents, revealConcepts] = await Promise.all([
    listHintEvents(userId, versionRow.id),
    hasEarnedReveal(userId, versionRow.id),
  ]);
  const hintsTaken = hintEvents.map((h) => h.level);

  const pub = toPublicProblem({
    problemVersionId: versionRow.id,
    content,
    hintsTaken,
    revealConcepts,
  });

  return hydrateConceptsRevealed(pub);
}

async function hydrateConceptsRevealed(pub: PublicProblem): Promise<PublicProblemWithNames> {
  if (!pub.concepts_revealed || pub.concepts_revealed.length === 0) {
    return { ...pub, concepts_revealed: pub.concepts_revealed ? [] : null };
  }

  const ids = pub.concepts_revealed.map((c) => c.id);
  const rows = await query<ConceptRow>("select id, name from concepts where id = any($1)", [ids]);
  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  return {
    ...pub,
    concepts_revealed: pub.concepts_revealed.map((c) => ({
      id: c.id,
      name: nameById.get(c.id) ?? c.id,
      role: c.role,
      weight: c.weight,
    })),
  };
}
