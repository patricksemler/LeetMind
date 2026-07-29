-- Generation SLO and reliability report. Bind $1 to the reporting window (for example,
-- interval '24 hours'). Provider outages remain visible by failure category and can be excluded
-- from the normal-capacity SLO using the `normal_capacity` filter below.
WITH jobs AS (
  SELECT
    id,
    status,
    repair_count,
    failure_code,
    created_at,
    updated_at,
    EXTRACT(epoch FROM (updated_at - created_at)) AS wall_seconds
  FROM generation_jobs
  WHERE created_at >= now() - $1::interval
    AND status IN ('ready', 'failed')
),
normal_capacity AS (
  SELECT *
  FROM jobs
  WHERE failure_code IS DISTINCT FROM 'provider_unavailable'
),
summary AS (
  SELECT
    COUNT(*) AS terminal_jobs,
    COUNT(*) FILTER (WHERE status = 'ready') AS successful_jobs,
    COUNT(*) FILTER (WHERE status = 'ready' AND repair_count = 0) AS first_pass_jobs,
    COUNT(*) FILTER (WHERE repair_count > 0) AS repaired_jobs,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY wall_seconds)
      FILTER (WHERE status = 'ready') AS successful_p50_seconds,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY wall_seconds)
      FILTER (WHERE status = 'ready') AS successful_p95_seconds
  FROM normal_capacity
)
SELECT
  terminal_jobs,
  successful_jobs,
  ROUND(100.0 * first_pass_jobs / NULLIF(successful_jobs, 0), 1)
    AS first_pass_success_percent,
  repaired_jobs,
  failed_jobs,
  ROUND(successful_p50_seconds::numeric, 1) AS successful_p50_seconds,
  ROUND(successful_p95_seconds::numeric, 1) AS successful_p95_seconds
FROM summary;

-- Failure-category detail for the same reporting window.
SELECT
  COALESCE(failure_code, 'uncategorized') AS failure_category,
  COUNT(*) AS jobs
FROM generation_jobs
WHERE created_at >= now() - $1::interval
  AND status = 'failed'
GROUP BY failure_code
ORDER BY jobs DESC, failure_category;

-- Per-phase latency. A transition lasts until the next transition for the same job.
WITH timed AS (
  SELECT
    job_id,
    phase,
    EXTRACT(
      epoch FROM (
        LEAD(occurred_at) OVER (PARTITION BY job_id ORDER BY occurred_at) - occurred_at
      )
    ) AS seconds
  FROM generation_job_transitions
  WHERE occurred_at >= now() - $1::interval
)
SELECT
  phase,
  COUNT(seconds) AS samples,
  ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY seconds)::numeric, 2) AS p50_seconds,
  ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds)::numeric, 2) AS p95_seconds
FROM timed
WHERE seconds IS NOT NULL
GROUP BY phase
ORDER BY phase;
