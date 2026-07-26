-- 003_baseline_replaces_workouts.sql
--
-- The "workout" product surface (warm-up / working sets / overload / recovery ladders, duration
-- budgeting, PLAN.md §8 "Workouts") is removed. What survives is the half that was always the
-- genuinely useful part: the adaptive **baseline** that seeds honest per-concept ratings with a
-- first-class, judgment-free skip. Everything after the baseline is now the practice loop, which
-- is stateless — it selects (and, when the pool is thin, generates) one problem at a time from the
-- approved pool and needs no session container at all.
--
-- So `workouts` becomes `baseline_sessions` and `workout_items` becomes `baseline_items`, and the
-- workout-only columns go: `kind` (only 'diagnostic' remains, so the discriminator is dead),
-- `estimated_minutes` / `target_minutes` (duration budgeting was an assembleWorkout concern), and
-- `role` (every surviving item is a baseline probe).
--
-- Existing rows are preserved: any historical kind='standard' workout is marked 'abandoned' rather
-- than deleted, so the submissions and learning_events that reference it keep their provenance.

-- A standard workout can't be resumed once the feature is gone; retire any that were still open
-- instead of leaving a permanently-unfinishable row that `getActiveBaseline` would keep returning.
update workouts
   set status = 'abandoned'
 where kind = 'standard'
   and status = 'active';

alter table workouts rename to baseline_sessions;
alter table workout_items rename to baseline_items;

alter index workouts_user_status_idx rename to baseline_sessions_user_status_idx;

alter table baseline_items rename column workout_id to baseline_session_id;
alter table submissions rename column workout_item_id to baseline_item_id;

-- `kind` only ever distinguished 'standard' from 'diagnostic'; with standard gone the column is a
-- constant. Dropping it takes its check constraint with it.
alter table baseline_sessions drop column kind;
alter table baseline_sessions drop column estimated_minutes;
alter table baseline_sessions drop column target_minutes;

-- Same for `role`: 'warmup'/'working'/'overload'/'recovery' were workout roles, and every
-- remaining item is a baseline probe.
alter table baseline_items drop column role;
