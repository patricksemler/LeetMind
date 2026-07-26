-- 007_teaching_and_followups.sql
--
-- Four related additions, all in service of the same change: the app stops being purely a
-- *measuring* instrument and starts being a *teaching* one.
--
--   1. problem_versions.shape   — a queryable archetype, orthogonal to the concept taxonomy
--   2. scheduled_followups      — the reinforce/transfer pair owed after a teaching episode
--   3. submissions mode 'transcribe' (+ paste_detected) — the write-it-out step
--   4. user_concept_state.mastered_at — explicit mastery, no longer inferred from the rating
--
-- The baseline tables (`baseline_sessions` / `baseline_items`) are deliberately NOT dropped here
-- even though the baseline product surface is removed in this same change. `submissions
-- .baseline_item_id` and historical `learning_events` still reference them, and a local install
-- may hold real practice history whose provenance would be destroyed. They become read-only
-- history: nothing writes them after this migration.

-- ---------------------------------------------------------------------------
-- 1. problem_versions.shape
-- ---------------------------------------------------------------------------
-- What a problem *asks you to do*, as opposed to which technique solves it. The concept taxonomy
-- already answers the second question; nothing answered the first, and "same concept, different
-- form" — the whole premise of a transfer problem — is not expressible without it. Two Sum and
-- Subarray Sum Equals K are both `arrays_hashing`, and serving the second as a transfer test of
-- the first is exactly right; serving another find-a-pair problem is not, and before this column
-- the query could not tell them apart.
--
-- The generator already emits `similarity_exclusions`, but that is free text aimed at an LLM's
-- judgment at write time — it cannot be selected on. This can.
--
-- Nullable on purpose: every problem approved before this migration has no shape, and the
-- follow-up matcher degrades to "a different problem on the same concept" rather than refusing to
-- serve anything (see lib/followups.ts).
alter table problem_versions add column shape text
  check (shape is null or shape in (
    'find_pair',          -- locate elements standing in some relation (Two Sum, pair with diff k)
    'count_occurrences',  -- tally things matching a predicate (number of subarrays summing to k)
    'find_extremum',      -- the longest/shortest/max/min such thing (longest substring, max profit)
    'check_property',     -- a yes/no question about the input (valid parentheses, is this a BST)
    'build_output',       -- construct a new structure from the input (merge intervals, group anagrams)
    'in_place_transform', -- mutate the given structure (reverse a list, rotate a matrix)
    'simulate_process',   -- run a described process to its end state (car fleet, asteroid collision)
    'partition_group',    -- split or bucket elements (partition labels, k closest points)
    'path_or_order',      -- produce an ordering or a route (course schedule, word ladder)
    'optimize_value'      -- maximise/minimise an objective under constraints (knapsack, coin change)
  ));

comment on column problem_versions.shape is
  'What the problem asks you to produce, orthogonal to the concept that solves it. Drives transfer-problem selection ("same concept, different form"). Null for problems approved before 007.';

-- Transfer selection filters by concept AND shape AND rating band; the existing
-- problem_versions_state_difficulty_idx cannot serve the shape predicate.
create index problem_versions_shape_idx
  on problem_versions (shape, state, difficulty_rating)
  where shape is not null;

-- ---------------------------------------------------------------------------
-- 2. scheduled_followups
-- ---------------------------------------------------------------------------
-- The two problems owed to a user after they have been taught something: an immediate easier
-- same-shape `reinforce`, and a delayed different-shape `transfer`. See packages/learner/src/
-- teaching.ts for why the pair is planned together at reveal time rather than the transfer being
-- scheduled once the reinforce resolves.
--
-- This is the one piece of genuinely *scheduled* state in an otherwise stateless practice loop.
-- It earns that: a debt incurred now and settled days later cannot be recomputed from concept
-- ratings, because by then the ratings have moved on and the fact that a specific reveal happened
-- is gone.
create table scheduled_followups (
  id                        text primary key,
  user_id                   text not null references users(id),
  concept_id                text not null references concepts(id),
  -- The problem whose editorial was revealed — the debt's origin.
  origin_problem_version_id text not null references problem_versions(id),
  kind                      text not null check (kind in ('reinforce','transfer')),
  -- Why the teaching episode that created this debt fired. Stored rather than recomputed: by the
  -- time the debt is served, the attempt history that triggered it has moved on, so
  -- `shouldTeach` would no longer return the reason the user was actually given.
  origin_trigger            text not null default 'editorial_revealed'
                              check (origin_trigger in ('editorial_revealed','consecutive_failures')),
  target_rating             int not null,
  shape_match               text not null check (shape_match in ('same','different')),
  -- Snapshotted rather than joined through origin_problem_version_id: the matcher needs the shape
  -- as it was when the debt was incurred, and reading it here keeps the hot selection query to a
  -- single table.
  origin_shape              text,
  rationale                 text not null default '',
  due_at                    timestamptz not null,
  -- Set when the follow-up is actually served, so a reload doesn't hand out a different problem
  -- for the same debt.
  served_problem_version_id text references problem_versions(id),
  served_at                 timestamptz,
  -- Set when the served problem reaches a terminal outcome. A follow-up is settled by being
  -- *attempted*, not by being passed: a failed transfer is a real answer to the question it asks.
  satisfied_at              timestamptz,
  created_at                timestamptz not null default now(),
  -- At most one debt of each kind per teaching episode. This is what makes "queue the follow-ups"
  -- safe to call from a retried request: the judge delivers at-least-once, and without this a
  -- redelivered transcription would stack duplicate reinforce rows.
  unique (user_id, origin_problem_version_id, kind)
);

-- The hot path: "does this user owe me a follow-up right now?", run on every GET
-- /api/practice/next. Partial on unsettled rows so settled history never enters the scan.
create index scheduled_followups_due_idx
  on scheduled_followups (user_id, due_at)
  where satisfied_at is null;

-- ---------------------------------------------------------------------------
-- 3. submissions: the 'transcribe' mode
-- ---------------------------------------------------------------------------
-- A transcription runs the hidden tests like any other submission — the user needs to see their
-- typed-out solution actually pass — but writes NO learning event. That separation is the whole
-- design: reading the editorial has already been scored (outcome 0 at full evidence weight, via
-- give-up), and copying it out afterwards is pedagogy, not new evidence about ability. Grading it
-- would hand back the rating the reveal correctly took away.
alter table submissions drop constraint submissions_mode_check;
alter table submissions add constraint submissions_mode_check
  check (mode in ('run','submit','transcribe'));

-- Whether the editor saw a paste during a transcription. Recorded, not enforced: blocking paste is
-- trivially worked around (retype one character, use devtools, edit the draft in another tab) and
-- punishes the honest user who pasted their own scratch work. The transfer problem is the real
-- check, and this column is what lets a later "you pasted every transcription and failed every
-- transfer" diagnosis be made at all.
alter table submissions add column paste_detected boolean not null default false;

comment on column submissions.paste_detected is
  'Transcription mode only: the editor observed a paste. Advisory signal, never a gate.';

-- ---------------------------------------------------------------------------
-- 4. user_concept_state.mastered_at
-- ---------------------------------------------------------------------------
-- Mastery was previously implicit in the rating, which cannot distinguish "solved three different
-- problems unaided over three weeks" from "solved one problem after four hints yesterday" — both
-- can land on 1500. packages/learner/src/mastery.ts states the five clauses; this column records
-- the first moment they all held.
--
-- Sticky by design: it is never cleared once set. Mastery is a claim about something that
-- happened, and a later bad day is already reflected in the rating. Un-setting it would make the
-- field a second, noisier copy of the rating instead of a record of evidence.
alter table user_concept_state add column mastered_at timestamptz;

comment on column user_concept_state.mastered_at is
  'When all five mastery clauses (learner/src/mastery.ts) first held simultaneously. Never cleared.';
