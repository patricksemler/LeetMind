-- Detailed, user-safe generation progress plus append-only transition telemetry. The coarse
-- `job_status` enum remains unchanged so existing rows and claim/resume logic stay compatible.

ALTER TABLE generation_jobs
  ADD COLUMN phase text NOT NULL DEFAULT 'waiting',
  ADD COLUMN phase_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN failure_code text,
  ADD COLUMN recovery_reason text,
  ADD CONSTRAINT generation_jobs_phase_valid CHECK (
    phase IN (
      'waiting', 'selecting', 'drafting', 'independent_review', 'checking_examples',
      'stress_testing', 'repairing', 'finalizing', 'ready', 'failed'
    )
  ),
  ADD CONSTRAINT generation_jobs_failure_code_valid CHECK (
    failure_code IS NULL OR failure_code IN (
      'provider_unavailable', 'generation_invalid', 'quality_mismatch',
      'verification_failed', 'verification_unavailable', 'deadline_exceeded'
    )
  ),
  ADD CONSTRAINT generation_jobs_recovery_reason_valid CHECK (
    recovery_reason IS NULL OR recovery_reason IN (
      'format', 'activity_fit', 'test_disagreement', 'provider',
      'verification_infrastructure'
    )
  );

UPDATE generation_jobs
SET phase = CASE status::text
  WHEN 'queued' THEN 'waiting'
  WHEN 'planning' THEN 'selecting'
  WHEN 'building' THEN 'drafting'
  WHEN 'verifying' THEN 'checking_examples'
  WHEN 'ready' THEN 'ready'
  WHEN 'failed' THEN 'failed'
END,
phase_started_at = updated_at,
claimed_at = CASE WHEN lease_token IS NOT NULL THEN updated_at ELSE NULL END;

CREATE TABLE generation_job_transitions (
  id              bigserial PRIMARY KEY,
  job_id          uuid NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  phase           text NOT NULL,
  attempt         int NOT NULL CHECK (attempt BETWEEN 1 AND 2),
  recovery_reason text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_job_transitions_phase_valid CHECK (
    phase IN (
      'waiting', 'selecting', 'drafting', 'independent_review', 'checking_examples',
      'stress_testing', 'repairing', 'finalizing', 'ready', 'failed'
    )
  ),
  CONSTRAINT generation_job_transitions_recovery_reason_valid CHECK (
    recovery_reason IS NULL OR recovery_reason IN (
      'format', 'activity_fit', 'test_disagreement', 'provider',
      'verification_infrastructure'
    )
  )
);

CREATE INDEX generation_job_transitions_job_time
  ON generation_job_transitions (job_id, occurred_at);

-- Seed one transition for legacy jobs, then ensure every newly enqueued job starts its timeline
-- at `waiting` without relying on every enqueue call site to remember a second insert.
INSERT INTO generation_job_transitions (job_id, phase, attempt, occurred_at)
SELECT
  id,
  phase,
  LEAST(repair_count + 1, 2),
  CASE WHEN phase = 'waiting' THEN created_at ELSE updated_at END
FROM generation_jobs;

CREATE FUNCTION record_generation_job_waiting_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO generation_job_transitions (job_id, phase, attempt, occurred_at)
  VALUES (NEW.id, 'waiting', 1, NEW.created_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER generation_job_waiting_transition
AFTER INSERT ON generation_jobs
FOR EACH ROW
EXECUTE FUNCTION record_generation_job_waiting_transition();
