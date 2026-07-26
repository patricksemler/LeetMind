-- 005_rename_baseline_constraints.sql
--
-- Migration 003 renamed the tables and columns but not their constraints: Postgres keeps the
-- original constraint names through `alter table ... rename`. The result is a schema with no
-- workouts in it that still reports errors like
--
--   violates foreign key constraint "submissions_workout_item_id_fkey" on table "submissions"
--
-- which sends whoever is reading it looking for a table that no longer exists. That is exactly how
-- long this cost during the demo-script fix, so it is worth the five lines.
--
-- Renaming a constraint is metadata-only — no table rewrite, no lock beyond a brief ACCESS
-- EXCLUSIVE, and no effect on behaviour.

alter table baseline_sessions rename constraint workouts_user_id_fkey to baseline_sessions_user_id_fkey;
alter table baseline_sessions rename constraint workouts_status_check to baseline_sessions_status_check;
alter index workouts_pkey rename to baseline_sessions_pkey;

alter table baseline_items rename constraint workout_items_workout_id_fkey to baseline_items_session_id_fkey;
alter table baseline_items rename constraint workout_items_problem_version_id_fkey to baseline_items_problem_version_id_fkey;
alter table baseline_items rename constraint workout_items_state_check to baseline_items_state_check;
alter index workout_items_pkey rename to baseline_items_pkey;
alter index workout_items_workout_id_position_key rename to baseline_items_session_id_position_key;

alter table submissions rename constraint submissions_workout_item_id_fkey to submissions_baseline_item_id_fkey;
