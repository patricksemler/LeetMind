// Plain row types mirroring packages/db/migrations/001_init.sql column-for-column.
// snake_case field names on purpose — these are raw DB rows, not API shapes.
// Nothing here is an ORM: it is the shared vocabulary the repository helpers
// in this package read and write.

export type Uuid = string; // ULID text, per CONTRACTS.md §1

export interface UserRow {
  id: Uuid;
  handle: string;
  /** Supabase Auth subject (JWT `sub`); null on the legacy pre-accounts row until claimed. */
  auth_user_id: string | null;
  email: string | null;
  created_at: Date;
  settings: Record<string, unknown>;
}

export interface ConceptRow {
  id: string;
  name: string;
  description: string;
  misconceptions: string[];
  min_rating: number;
  max_rating: number;
  sort_order: number;
}

export interface ConceptEdgeRow {
  parent_id: string;
  child_id: string;
}

export interface UserConceptStateRow {
  user_id: Uuid;
  concept_id: string;
  rating: number;
  uncertainty: number;
  attempts: number;
  solves: number;
  unassisted_solves: number;
  skips: number;
  current_streak: number;
  best_streak: number;
  total_active_ms: number;
  hint_counts: Record<string, number>;
  error_counts: Record<string, number>;
  last_practiced_at: Date | null;
  next_review_at: Date | null;
  review_interval_days: number;
  review_ease: number;
  review_reps: number;
  updated_at: Date;
}

export interface ProblemRow {
  id: Uuid;
  internal_name: string;
  created_at: Date;
  retired_at: Date | null;
}

export type ProblemVersionState = 'candidate' | 'verifying' | 'approved' | 'rejected' | 'retired';
export type DifficultyConfidence = 'generated' | 'verified' | 'calibrated';
export type Comparator = 'exact' | 'float_tol' | 'unordered' | 'checker_py';

export interface ProblemVersionRow {
  id: Uuid;
  problem_id: Uuid;
  version: number;
  state: ProblemVersionState;
  content: Record<string, unknown>; // full ProblemVersion JSON (@leetmind/shared)
  title: string;
  difficulty_rating: number;
  difficulty_confidence: DifficultyConfidence;
  expected_min_minutes: number | null;
  expected_max_minutes: number | null;
  comparator: Comparator;
  provenance: Record<string, unknown>;
  rejected_reason: string | null;
  created_at: Date;
  approved_at: Date | null;
}

export type ConceptRole = 'primary' | 'secondary';

export interface ProblemConceptRow {
  problem_version_id: Uuid;
  concept_id: string;
  role: ConceptRole;
  weight: number;
}

export interface VerificationReportRow {
  id: Uuid;
  problem_version_id: Uuid;
  passed: boolean;
  failed_stage: string | null;
  stages: unknown[];
  seeds: unknown[];
  counterexample: Record<string, unknown> | null;
  solution_hashes: Record<string, string>;
  duration_ms: number | null;
  correlation_id: string | null;
  created_at: Date;
}

export type BaselineSessionStatus = 'active' | 'completed' | 'abandoned';

export interface BaselineSessionRow {
  id: Uuid;
  user_id: Uuid;
  status: BaselineSessionStatus;
  rationale: Record<string, unknown>;
  created_at: Date;
  completed_at: Date | null;
}

export type BaselineItemState =
  | 'pending'
  | 'active'
  | 'solved'
  | 'skipped_inability'
  | 'skipped_preference'
  | 'gave_up';

export interface BaselineItemRow {
  id: Uuid;
  baseline_session_id: Uuid;
  position: number;
  problem_version_id: Uuid;
  rationale: string;
  selection_evidence: Record<string, unknown>;
  state: BaselineItemState;
  active_ms: number;
  started_at: Date | null;
  completed_at: Date | null;
}

export type SubmissionMode = 'run' | 'submit';
export type Language = 'python' | 'cpp';
export type SubmissionStatus =
  | 'created'
  | 'queued'
  | 'assigned'
  | 'compiling'
  | 'running'
  | 'completed'
  | 'cancelled';
export type Verdict =
  | 'accepted'
  | 'wrong_answer'
  | 'compilation_error'
  | 'runtime_error'
  | 'time_limit'
  | 'memory_limit'
  | 'output_limit'
  | 'internal_error'
  | 'cancelled';

export interface SubmissionFailure {
  kind: string;
  message: string;
  first_failing_test_index?: number;
  /** Pass counts split by whether the user can see the test (written by the judge). */
  tests?: { public_passed: number; public_total: number; hidden_passed: number; hidden_total: number };
  stderr_tail?: string;
  input_preview?: unknown;
  expected_preview?: unknown;
  actual_preview?: unknown;
}

/** One public test's outcome, as stored on `submissions.public_results` (migration 006). Safe to
 * serve verbatim — the input and expected value are printed in the problem statement. */
export interface PublicTestResult {
  index: number;
  status: string;
  passed: boolean;
  actual?: unknown;
}

export interface SubmissionRow {
  id: Uuid;
  user_id: Uuid;
  problem_version_id: Uuid;
  baseline_item_id: Uuid | null;
  mode: SubmissionMode;
  language: Language;
  source: string;
  source_hash: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  passed_tests: number;
  total_tests: number;
  runtime_ms: number | null;
  memory_kb: number | null;
  failure: SubmissionFailure | null;
  active_ms: number | null;
  custom_input: unknown | null;
  public_results: PublicTestResult[] | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface ExecutionAttemptRow {
  id: Uuid;
  submission_id: Uuid;
  attempt: number;
  worker_id: string;
  image_digest: string | null;
  language_version: string | null;
  flags: string | null;
  limits: Record<string, unknown>;
  usage: Record<string, unknown> | null;
  per_test: unknown[] | null;
  exit_code: number | null;
  started_at: Date;
  finished_at: Date | null;
}

export type HintLevel = 'l1_orientation' | 'l2_conceptual' | 'l3_structural' | 'outline' | 'editorial';

export interface HintEventRow {
  id: Uuid;
  user_id: Uuid;
  problem_version_id: Uuid;
  level: HintLevel;
  created_at: Date;
}

export type LearningEventKind = 'submission' | 'skip' | 'give_up' | 'diagnostic' | 'review' | 'decay';

export interface LearningEventRow {
  id: Uuid;
  user_id: Uuid;
  problem_version_id: Uuid | null;
  submission_id: Uuid | null;
  kind: LearningEventKind;
  outcome: number;
  evidence: Record<string, unknown>;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  idempotency_key: string | null;
  correlation_id: string | null;
  created_at: Date;
}

export type ModelRunKind = 'generate' | 'repair';
export type ModelRunStatus = 'ok' | 'schema_error' | 'invoke_error';

export interface ModelRunRow {
  id: Uuid;
  kind: ModelRunKind;
  invoker: string;
  model: string | null;
  prompt_version: string;
  request: Record<string, unknown>;
  duration_ms: number | null;
  output_hash: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  problem_version_id: Uuid | null;
  status: ModelRunStatus;
  error: string | null;
  correlation_id: string | null;
  created_at: Date;
}

export type JobKind = 'judge' | 'verify' | 'generate';
export type JobStatus = 'queued' | 'leased' | 'done' | 'failed' | 'dead' | 'cancelled';

export interface JobRow {
  id: Uuid;
  kind: JobKind;
  priority: number;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  lease_expires_at: Date | null;
  leased_by: string | null;
  last_error: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkerHeartbeatRow {
  worker_id: string;
  kind: string;
  last_seen_at: Date;
  meta: Record<string, unknown>;
}

/** Notify payload shape sent over `pg_notify('leetmind_events', ...)` (CONTRACTS.md §4.5). */
export interface NotifyPayload {
  type: string;
  submission_id?: string;
  user_id?: string;
  [key: string]: unknown;
}
