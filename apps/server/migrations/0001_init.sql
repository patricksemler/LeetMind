-- LeetMind schema, PLAN_BACKEND.md §4. Applied once by db.run_migrations; re-running the
-- migration set is a no-op (see schema_migrations, created by the runner itself).

-- 20 rows, seeded below. slug is the stable Elo key (leetmind.taxonomy.PROBLEM_TYPES).
CREATE TABLE problem_types (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  ordinal     int  NOT NULL
);

CREATE TABLE ratings (
  user_id     uuid NOT NULL,
  type_slug   text NOT NULL REFERENCES problem_types(slug),
  rating      real NOT NULL DEFAULT 1200,
  attempts    int  NOT NULL DEFAULT 0,        -- resolved problems only; the evidence gate
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type_slug)
);
-- rows created lazily: all 20 on first authenticated request

CREATE TYPE problem_status AS ENUM
  ('building', 'ready', 'active', 'solved', 'given_up', 'failed');

CREATE TABLE problems (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  status             problem_status NOT NULL,
  primary_type       text NOT NULL REFERENCES problem_types(slug),
  support_types      text[] NOT NULL DEFAULT '{}',
  shape              text NOT NULL,                -- from the fixed shape list (invariant I4)
  problem_rating     int  NOT NULL,                -- target rating set by the planner
  is_probe           boolean NOT NULL DEFAULT false,
  title              text NOT NULL,
  statement_md       text NOT NULL,                -- includes worked examples = public tests
  signature          jsonb NOT NULL,               -- typed per the §8.4 value contract
  starter_code       text NOT NULL,
  public_tests       jsonb NOT NULL,               -- [{input:[...], expected}]
  private_tests      jsonb NOT NULL,               -- never serialized to the client
  hints              jsonb NOT NULL,               -- 4 rungs: orientation/conceptual/structural/outline
  reference_solution text NOT NULL,                -- revealed only on give-up
  complexity         jsonb NOT NULL,               -- {time, space}  e.g. {"time":"O(n log n)",...}
  par_minutes        int  NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  served_at          timestamptz,                  -- stamped once by POST /problems/{id}/open
                                                   --   (workspace mount), never on promotion
  resolved_at        timestamptz
);
CREATE INDEX ON problems (user_id, status);
-- the queue invariant, enforced by the database (amendment 27):
CREATE UNIQUE INDEX one_active_per_user ON problems (user_id) WHERE status = 'active';
CREATE UNIQUE INDEX one_ready_per_user  ON problems (user_id) WHERE status = 'ready';

CREATE TABLE executions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id  uuid NOT NULL REFERENCES problems(id),
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('run', 'submit')),  -- post-demotion kind
  code        text NOT NULL,
  passed      boolean NOT NULL,
  results     jsonb NOT NULL,     -- per-test outcomes as returned to the client
  duration_ms int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hint_reveals (
  problem_id  uuid NOT NULL REFERENCES problems(id),
  rung        int  NOT NULL CHECK (rung BETWEEN 1 AND 4),
  revealed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (problem_id, rung)
);

CREATE TABLE rating_updates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  type_slug         text NOT NULL,
  problem_id        uuid NOT NULL UNIQUE REFERENCES problems(id),  -- Elo can never apply twice
  rating_before     real NOT NULL,
  rating_after      real NOT NULL,
  problem_rating    int  NOT NULL,
  expected_score    real NOT NULL,
  performance_score real NOT NULL,
  k_factor          real NOT NULL,
  metrics           jsonb NOT NULL,   -- {runs, submissions, hints_revealed, minutes, gave_up}
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE job_status AS ENUM ('queued', 'planning', 'building', 'verifying', 'ready', 'failed');

CREATE TABLE generation_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  status        job_status NOT NULL DEFAULT 'queued',
  problem_id    uuid REFERENCES problems(id),   -- set once the build starts
  plan_json     jsonb,                          -- persisted planner output; later stages, repair,
                                                --   and reservation lookups resume from it
  repair_count  int NOT NULL DEFAULT 0,
  error         text,
  lease_token   uuid,                           -- fencing token; every stage write requires a match
  heartbeat_at  timestamptz,                    -- refreshed every 60 s while a stage runs;
                                                --   lease is stale (reclaimable) after 5 min silent
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON generation_jobs (status, created_at);

-- Taxonomy seed (PLAN_BACKEND.md §5) — leetmind.taxonomy.PROBLEM_TYPES is the source of truth;
-- keep this list in sync with it.
INSERT INTO problem_types (slug, name, ordinal) VALUES
  ('arrays_hashing',       'Arrays & Hashing',          0),
  ('two_pointers',         'Two Pointers',              1),
  ('sliding_window',       'Sliding Window',            2),
  ('binary_search',        'Binary Search',             3),
  ('stack',                'Stack',                     4),
  ('queue_deque',          'Queue & Deque',              5),
  ('linked_list',          'Linked List',               6),
  ('trees',                'Trees',                     7),
  ('bst',                  'Binary Search Trees',       8),
  ('heap_priority_queue',  'Heap / Priority Queue',     9),
  ('tries',                'Tries',                     10),
  ('backtracking',         'Backtracking',              11),
  ('graphs_bfs_dfs',       'Graphs (BFS/DFS)',          12),
  ('graphs_advanced',      'Graphs (Advanced)',         13),
  ('dp_1d',                'Dynamic Programming (1D)',  14),
  ('dp_2d',                'Dynamic Programming (2D)',  15),
  ('greedy',                'Greedy',                    16),
  ('intervals',            'Intervals',                 17),
  ('bit_manipulation',     'Bit Manipulation',          18),
  ('math_geometry',        'Math & Geometry',           19);
