-- 001_init.sql — AlgoLift core schema (CONTRACTS.md §3)
--
-- Tables are created in an order that satisfies every foreign key without
-- forward references (workouts/workout_items are created before submissions
-- because submissions.workout_item_id points at workout_items, even though
-- CONTRACTS.md lists submissions earlier in prose).

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table users (
  id         text primary key,
  handle     text not null unique,
  created_at timestamptz not null default now(),
  settings   jsonb not null default '{}'
);

-- ---------------------------------------------------------------------------
-- concepts / concept_edges
-- ---------------------------------------------------------------------------
create table concepts (
  id             text primary key,
  name           text not null,
  description    text not null default '',
  misconceptions jsonb not null default '[]',
  min_rating     int not null default 800,
  max_rating     int not null default 2400,
  sort_order     int not null default 0
);

create table concept_edges (
  parent_id text not null references concepts(id),
  child_id  text not null references concepts(id),
  primary key (parent_id, child_id)
);

-- ---------------------------------------------------------------------------
-- user_concept_state (Glicko-lite mastery state, one row per user x concept)
-- ---------------------------------------------------------------------------
create table user_concept_state (
  user_id              text not null references users(id),
  concept_id           text not null references concepts(id),
  rating               double precision not null default 1200,
  uncertainty          double precision not null default 350,
  attempts             int not null default 0,
  solves               int not null default 0,
  unassisted_solves    int not null default 0,
  skips                int not null default 0,
  current_streak       int not null default 0,
  best_streak          int not null default 0,
  total_active_ms      bigint not null default 0,
  hint_counts          jsonb not null default '{}',
  error_counts         jsonb not null default '{}',
  last_practiced_at    timestamptz,
  next_review_at       timestamptz,
  review_interval_days double precision not null default 1,
  review_ease          double precision not null default 2.5,
  review_reps          int not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (user_id, concept_id)
);

-- review-due scan: "give me everything due for review, oldest first" —
-- workout assembly and the review scheduler both filter user_id and range
-- over next_review_at.
create index user_concept_state_user_next_review_idx
  on user_concept_state (user_id, next_review_at);

-- ---------------------------------------------------------------------------
-- problems / problem_versions / problem_concepts
-- ---------------------------------------------------------------------------
create table problems (
  id            text primary key,
  internal_name text not null,
  created_at    timestamptz not null default now(),
  retired_at    timestamptz
);

create table problem_versions (
  id                    text primary key,
  problem_id            text not null references problems(id),
  version               int not null,
  state                 text not null default 'candidate'
                          check (state in ('candidate','verifying','approved','rejected','retired')),
  content               jsonb not null,
  title                 text not null,
  difficulty_rating     int not null,
  difficulty_confidence text not null default 'generated'
                          check (difficulty_confidence in ('generated','verified','calibrated')),
  expected_min_minutes  int,
  expected_max_minutes  int,
  comparator            text not null default 'exact'
                          check (comparator in ('exact','float_tol','unordered','checker_py')),
  provenance            jsonb not null default '{}',
  rejected_reason       text,
  created_at            timestamptz not null default now(),
  approved_at           timestamptz,
  unique (problem_id, version)
);

-- CONTRACTS.md §3: "index on (state, difficulty_rating)" — the workout
-- assembler and replenishment worker both select approved problems filtered
-- by state and ordered/filtered by difficulty band.
create index problem_versions_state_difficulty_idx
  on problem_versions (state, difficulty_rating);

create table problem_concepts (
  problem_version_id text not null references problem_versions(id) on delete cascade,
  concept_id          text not null references concepts(id),
  role                text not null check (role in ('primary','secondary')),
  weight              double precision not null,
  primary key (problem_version_id, concept_id)
);

-- reverse lookup: "which problems touch concept X" — used by replenishment
-- buffer counts and progress/mastery views.
create index problem_concepts_concept_idx
  on problem_concepts (concept_id);

-- ---------------------------------------------------------------------------
-- verification_reports
-- ---------------------------------------------------------------------------
create table verification_reports (
  id                  text primary key,
  problem_version_id  text not null references problem_versions(id) on delete cascade,
  passed              boolean not null,
  failed_stage        text,
  stages              jsonb not null,
  seeds               jsonb not null default '[]',
  counterexample      jsonb,
  solution_hashes     jsonb not null default '{}',
  duration_ms         int,
  correlation_id      text,
  created_at          timestamptz not null default now()
);

-- /system stage-pass-rate and per-version report history lookups.
create index verification_reports_problem_version_idx
  on verification_reports (problem_version_id);

-- ---------------------------------------------------------------------------
-- workouts / workout_items (created ahead of submissions: submissions has an
-- optional FK into workout_items)
-- ---------------------------------------------------------------------------
create table workouts (
  id                text primary key,
  user_id           text not null references users(id),
  kind              text not null default 'standard' check (kind in ('standard','diagnostic')),
  status            text not null default 'active' check (status in ('active','completed','abandoned')),
  rationale         jsonb not null default '{}',
  estimated_minutes int,
  target_minutes    int,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);

-- "current workout for this user" / workout history list, most recent first.
create index workouts_user_status_idx
  on workouts (user_id, status);

create table workout_items (
  id                  text primary key,
  workout_id          text not null references workouts(id) on delete cascade,
  position            int not null,
  role                text not null check (role in ('warmup','working','overload','recovery','diagnostic')),
  problem_version_id  text not null references problem_versions(id),
  rationale           text not null default '',
  selection_evidence  jsonb not null default '{}',
  state               text not null default 'pending'
                        check (state in ('pending','active','solved','skipped_inability','skipped_preference','gave_up')),
  active_ms           int not null default 0,
  started_at          timestamptz,
  completed_at        timestamptz,
  unique (workout_id, position)
);

-- ---------------------------------------------------------------------------
-- submissions / execution_attempts
-- ---------------------------------------------------------------------------
create table submissions (
  id                  text primary key,
  user_id             text not null references users(id),
  problem_version_id  text not null references problem_versions(id),
  workout_item_id     text references workout_items(id),
  mode                text not null check (mode in ('run','submit')),
  language            text not null check (language in ('python','cpp')),
  source              text not null,
  source_hash         text not null,
  status              text not null default 'created'
                        check (status in ('created','queued','assigned','compiling','running','completed','cancelled')),
  verdict             text
                        check (verdict is null or verdict in (
                          'accepted','wrong_answer','compilation_error','runtime_error',
                          'time_limit','memory_limit','output_limit','internal_error','cancelled'
                        )),
  passed_tests        int not null default 0,
  total_tests         int not null default 0,
  runtime_ms          int,
  memory_kb           int,
  failure             jsonb,
  active_ms           int,
  custom_input        jsonb,
  idempotency_key     text unique,
  correlation_id      text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

-- "my recent submissions" feed, newest first.
create index submissions_user_created_idx
  on submissions (user_id, created_at desc);

-- "all submissions against this problem version" (progress stats, rejudge scoping).
create index submissions_problem_version_idx
  on submissions (problem_version_id);

-- judge coordinator / /system need to find in-flight (non-terminal) work
-- quickly; partial index keeps it tiny since most rows end up 'completed'.
create index submissions_status_active_idx
  on submissions (status) where status <> 'completed';

create table execution_attempts (
  id                text primary key,
  submission_id     text not null references submissions(id) on delete cascade,
  attempt           int not null,
  worker_id         text not null,
  image_digest      text,
  language_version  text,
  flags             text,
  limits            jsonb not null,
  usage             jsonb,
  per_test          jsonb,
  exit_code         int,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);

-- "all attempts for this submission" (retry/rejudge history, most recent attempt).
create index execution_attempts_submission_idx
  on execution_attempts (submission_id);

-- ---------------------------------------------------------------------------
-- hint_events
-- ---------------------------------------------------------------------------
create table hint_events (
  id                  text primary key,
  user_id             text not null references users(id),
  problem_version_id  text not null references problem_versions(id),
  level               text not null check (level in ('l1_orientation','l2_conceptual','l3_structural','outline','editorial')),
  created_at          timestamptz not null default now(),
  unique (user_id, problem_version_id, level)
);

-- "hints already taken for this user on this problem" — read on every
-- workspace load to compute available/penalty state.
create index hint_events_user_problem_idx
  on hint_events (user_id, problem_version_id);

-- ---------------------------------------------------------------------------
-- learning_events (append-only)
-- ---------------------------------------------------------------------------
create table learning_events (
  id                  text primary key,
  user_id             text not null references users(id),
  problem_version_id  text references problem_versions(id),
  submission_id       text references submissions(id),
  kind                text not null check (kind in ('submission','skip','give_up','diagnostic','review','decay')),
  outcome             double precision not null,
  evidence            jsonb not null,
  before_state        jsonb not null,
  after_state         jsonb not null,
  idempotency_key     text unique,
  correlation_id      text,
  created_at          timestamptz not null default now()
);

-- progress dashboard / mastery history feed, newest first.
create index learning_events_user_created_idx
  on learning_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- model_runs
-- ---------------------------------------------------------------------------
create table model_runs (
  id                  text primary key,
  kind                text not null check (kind in ('generate','repair')),
  invoker             text not null,
  model               text,
  prompt_version      text not null,
  request             jsonb not null,
  duration_ms         int,
  output_hash         text,
  input_tokens        int,
  output_tokens       int,
  cost_usd            double precision,
  problem_version_id  text references problem_versions(id),
  status              text not null check (status in ('ok','schema_error','invoke_error')),
  error               text,
  correlation_id      text,
  created_at          timestamptz not null default now()
);

-- /system model-run latency/cost panel reads the most recent runs.
create index model_runs_created_idx
  on model_runs (created_at desc);

-- ---------------------------------------------------------------------------
-- jobs (hand-built Postgres queue) + worker_heartbeats
-- ---------------------------------------------------------------------------
create table jobs (
  id               text primary key,
  kind             text not null check (kind in ('judge','verify','generate')),
  priority         int not null default 100,
  payload          jsonb not null,
  status           text not null default 'queued'
                     check (status in ('queued','leased','done','failed','dead','cancelled')),
  attempts         int not null default 0,
  max_attempts     int not null default 3,
  run_at           timestamptz not null default now(),
  lease_expires_at timestamptz,
  leased_by        text,
  last_error       text,
  idempotency_key  text unique,
  correlation_id   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- claim query: status='queued' and kind = any($kinds) and run_at <= now(),
-- ordered by priority, created_at — this composite index makes the
-- `for update skip locked` claim a single index scan instead of a seq scan.
create index jobs_claim_idx
  on jobs (status, kind, priority, run_at);

-- reaper sweep: status='leased' and lease_expires_at < now().
create index jobs_lease_idx
  on jobs (status, lease_expires_at);

create or replace function algolift_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at
  before update on jobs
  for each row
  execute function algolift_touch_updated_at();

create table worker_heartbeats (
  worker_id    text primary key,
  kind         text not null,
  last_seen_at timestamptz not null default now(),
  meta         jsonb not null default '{}'
);
