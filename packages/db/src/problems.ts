import type { PoolClient } from "pg";
import { query, queryOne, queryOneWith } from "./pool.js";
import type {
  Comparator,
  ConceptRole,
  DifficultyConfidence,
  ProblemShape,
  ProblemVersionRow,
  ProblemVersionState,
} from "./types.js";

/**
 * Insert payload for a new problem_version row. Callers own id generation (`newId()` from
 * `@leetmind/shared`) and must ensure the parent `problems` row already exists — this package does
 * not create `problems` rows, since problem authorship lives entirely in the Python content plane.
 */
export interface NewProblemVersionInput {
  id: string;
  problem_id: string;
  version: number;
  state?: ProblemVersionState;
  content: Record<string, unknown>;
  title: string;
  difficulty_rating: number;
  difficulty_confidence?: DifficultyConfidence;
  expected_min_minutes?: number | null;
  expected_max_minutes?: number | null;
  comparator?: Comparator;
  /** Migration 007. Null when the generator did not classify one — selection degrades, see
   * `ListApprovedUnattemptedFilter.shape`. */
  shape?: ProblemShape | null;
  provenance?: Record<string, unknown>;
}

export async function insertProblemVersion(
  client: PoolClient,
  row: NewProblemVersionInput,
): Promise<ProblemVersionRow> {
  const sql = `
    insert into problem_versions (
      id, problem_id, version, state, content, title, difficulty_rating,
      difficulty_confidence, expected_min_minutes, expected_max_minutes, comparator, shape,
      provenance
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
    returning *
  `;
  const inserted = await queryOneWith<ProblemVersionRow>(client, sql, [
    row.id,
    row.problem_id,
    row.version,
    row.state ?? "candidate",
    JSON.stringify(row.content),
    row.title,
    row.difficulty_rating,
    row.difficulty_confidence ?? "generated",
    row.expected_min_minutes ?? null,
    row.expected_max_minutes ?? null,
    row.comparator ?? "exact",
    row.shape ?? null,
    JSON.stringify(row.provenance ?? {}),
  ]);
  if (!inserted) {
    throw new Error(`insertProblemVersion: insert of ${row.id} returned no row`);
  }
  return inserted;
}

export async function getProblemVersion(id: string): Promise<ProblemVersionRow | null> {
  return queryOne<ProblemVersionRow>("select * from problem_versions where id = $1", [id]);
}

export async function getApprovedProblemVersion(id: string): Promise<ProblemVersionRow | null> {
  return queryOne<ProblemVersionRow>(
    "select * from problem_versions where id = $1 and state = 'approved'",
    [id],
  );
}

export interface SetProblemVersionStateOpts {
  rejectedReason?: string | null;
}

/**
 * Transitions a problem_version's state. Sets `approved_at = now()` when transitioning to
 * `approved`, and stores `rejected_reason` (or clears it) as given — this is exactly the write the
 * six-stage verification gate makes at the end of a run.
 */
export async function setProblemVersionState(
  client: PoolClient,
  id: string,
  state: ProblemVersionState,
  opts: SetProblemVersionStateOpts = {},
): Promise<ProblemVersionRow> {
  const sql = `
    update problem_versions
    set state = $2,
        rejected_reason = $3,
        approved_at = case when $2 = 'approved' then now() else approved_at end
    where id = $1
    returning *
  `;
  const row = await queryOneWith<ProblemVersionRow>(client, sql, [id, state, opts.rejectedReason ?? null]);
  if (!row) {
    throw new Error(`setProblemVersionState: no problem_version with id ${id}`);
  }
  return row;
}

export interface ListApprovedUnattemptedFilter {
  conceptId?: string;
  minRating?: number;
  maxRating?: number;
  limit?: number;
  /**
   * Restrict to (`matchShape: 'same'`) or exclude (`'different'`) `shape`. Used only by follow-up
   * selection (migration 007): a reinforce problem must be the same form as the one just taught, a
   * transfer problem must not be.
   *
   * Rows with a null `shape` — everything approved before 007 — are treated as *eligible under
   * either mode* rather than excluded. A stricter reading ("unknown shape can't be proven
   * different") would make transfer problems unservable on any pre-007 pool, which is every
   * existing install; a follow-up that silently never arrives is a worse failure than one whose
   * shape guarantee is best-effort. Callers that need the distinction can check `row.shape`.
   */
  shape?: ProblemShape | null;
  matchShape?: 'same' | 'different';
}

/** Approved problem versions this user has never submitted against, optionally filtered by concept/rating band. */
export async function listApprovedUnattempted(
  userId: string,
  filter: ListApprovedUnattemptedFilter = {},
): Promise<ProblemVersionRow[]> {
  const conditions: string[] = [
    "pv.state = 'approved'",
    "not exists (select 1 from submissions s where s.problem_version_id = pv.id and s.user_id = $1)",
  ];
  const params: unknown[] = [userId];
  let idx = 2;
  let joinConcept = "";

  if (filter.conceptId !== undefined) {
    joinConcept = "join problem_concepts pc on pc.problem_version_id = pv.id";
    conditions.push(`pc.concept_id = $${idx}`);
    params.push(filter.conceptId);
    idx += 1;
  }
  if (filter.minRating !== undefined) {
    conditions.push(`pv.difficulty_rating >= $${idx}`);
    params.push(filter.minRating);
    idx += 1;
  }
  if (filter.maxRating !== undefined) {
    conditions.push(`pv.difficulty_rating <= $${idx}`);
    params.push(filter.maxRating);
    idx += 1;
  }
  if (filter.shape && filter.matchShape) {
    // `pv.shape is null or ...` — see ListApprovedUnattemptedFilter.shape for why unknown shapes
    // stay eligible in both directions.
    const op = filter.matchShape === 'same' ? '=' : '<>';
    conditions.push(`(pv.shape is null or pv.shape ${op} $${idx})`);
    params.push(filter.shape);
    idx += 1;
  }

  const limit = filter.limit ?? 20;
  params.push(limit);

  const sql = `
    select distinct pv.* from problem_versions pv
    ${joinConcept}
    where ${conditions.join(" and ")}
    order by pv.difficulty_rating asc
    limit $${idx}
  `;

  return query<ProblemVersionRow>(sql, params);
}

export interface ApprovedUnattemptedBandCount {
  concept_id: string;
  band: number;
  count: number;
}

/** Approved-and-unattempted problem counts per concept x 200-wide rating band, for the replenishment worker's watermark check. */
export async function countApprovedUnattemptedByBand(userId: string): Promise<ApprovedUnattemptedBandCount[]> {
  const sql = `
    select
      pc.concept_id as concept_id,
      (floor(pv.difficulty_rating / 200.0) * 200)::int as band,
      count(distinct pv.id)::int as count
    from problem_versions pv
    join problem_concepts pc on pc.problem_version_id = pv.id
    where pv.state = 'approved'
      and not exists (select 1 from submissions s where s.problem_version_id = pv.id and s.user_id = $1)
    group by pc.concept_id, band
    order by pc.concept_id asc, band asc
  `;
  return query<ApprovedUnattemptedBandCount>(sql, [userId]);
}

export interface ProblemConceptInput {
  id: string;
  role: ConceptRole;
  weight: number;
}

/** Bulk-inserts (problem_version_id, concept_id, role, weight) rows, upserting on conflict. */
export async function insertProblemConcepts(
  client: PoolClient,
  versionId: string,
  concepts: ProblemConceptInput[],
): Promise<void> {
  if (concepts.length === 0) return;

  const valuePlaceholders: string[] = [];
  const params: unknown[] = [];
  concepts.forEach((concept, i) => {
    const base = i * 4;
    valuePlaceholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    params.push(versionId, concept.id, concept.role, concept.weight);
  });

  const sql = `
    insert into problem_concepts (problem_version_id, concept_id, role, weight)
    values ${valuePlaceholders.join(", ")}
    on conflict (problem_version_id, concept_id) do update set
      role = excluded.role,
      weight = excluded.weight
  `;
  await client.query(sql, params);
}
