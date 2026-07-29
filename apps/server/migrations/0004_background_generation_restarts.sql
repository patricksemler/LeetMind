-- A failed on-deck generation job may be replaced automatically while the learner is still
-- working on an active problem. Carry the restart count on the replacement lineage so this
-- remains bounded even during a provider outage.

ALTER TABLE generation_jobs
  ADD COLUMN background_restart_count smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT generation_jobs_background_restart_count_valid CHECK (
    background_restart_count BETWEEN 0 AND 5
  );
