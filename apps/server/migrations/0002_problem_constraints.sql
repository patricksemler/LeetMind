-- Examples already have a first-class home in public_tests. Give constraints the same treatment
-- so statement_md remains a concise description instead of accumulating every display section.
ALTER TABLE problems
  ADD COLUMN constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT problems_constraints_is_array
    CHECK (jsonb_typeof(constraints) = 'array');
