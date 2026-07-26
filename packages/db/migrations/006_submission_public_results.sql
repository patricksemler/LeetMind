-- 006_submission_public_results.sql
--
-- Per-test outcomes for the PUBLIC tests of a submission, in statement order:
--   [{ index, status, passed, actual? }, ...]
--
-- The workspace shows every public example as its own case (LeetCode-style) and colours each one
-- green or red once a run lands. That needs the outcome of *every* public test, and until now the
-- only per-test detail that ever reached the client was `failure.first_failing_test_index` plus a
-- preview of that single test — enough to say "example 2 broke", not enough to draw the list.
--
-- Public tests only, by construction: `publicResults` (apps/judge/src/execution.ts) filters on the
-- test's own origin before building the array, so a hidden test's expected value or the user's
-- output for it can never reach this column. Storing it here rather than deriving it per request
-- keeps the SSE verdict payload and a later `GET /api/submissions/:id` in agreement, and keeps the
-- full `execution_attempts.per_test` (which DOES cover hidden tests) server-side where it belongs.

alter table submissions add column public_results jsonb;

comment on column submissions.public_results is
  'Per-test outcomes for the public/example tests only, safe to serve verbatim. Null for rows judged before this column existed.';
