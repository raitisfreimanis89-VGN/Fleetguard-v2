-- ================================================================
-- Migration 009 — phased ("ladder") inspection intervals (2026-07-23)
--
-- A truck fresh from the dealer eases onto the fleet cadence over its first
-- few inspections rather than switching in one step:
--
--            step 1   step 2   steady state (fleet default)
--   Brake      60        —        42
--   Yard       90       90        60
--   Tyre       21       14         7
--
-- Previously this needed a human to remember three or four reverts per truck,
-- at different dates. A missed revert is silent and leaves the truck on a
-- relaxed safety interval indefinitely, so the step-down is computed instead.
--
-- HOW IT WORKS
--   step_intervals  int[]  the ladder; NULL = no exemption, use interval_days
--   exemption_from  date   delivery date; inspections AFTER it advance the ladder
--   interval_days   int    steady state once the ladder is exhausted
--
--   n = inspections recorded after exemption_from   (the baseline row is dated
--       exactly exemption_from, so it is correctly excluded)
--   n < length(step_intervals)  ->  step_intervals[n+1]
--   otherwise                   ->  interval_days
--
-- Rows that set neither column behave exactly as before.
-- ================================================================

ALTER TABLE reminder_schedules
  ADD COLUMN IF NOT EXISTS step_intervals int[],
  ADD COLUMN IF NOT EXISTS exemption_from date;

COMMENT ON COLUMN reminder_schedules.step_intervals IS
  'Phased intervals for a new-truck exemption, e.g. {21,14}. NULL = flat interval_days.';
COMMENT ON COLUMN reminder_schedules.exemption_from IS
  'Delivery/baseline date. Inspections dated after it advance the ladder.';

-- Every ladder entry must be a positive number of days.
-- Uses `0 < ALL(...)` rather than a subquery: CHECK constraints cannot contain
-- subqueries, so an EXISTS/unnest form would be rejected outright.
ALTER TABLE reminder_schedules DROP CONSTRAINT IF EXISTS reminder_schedules_steps_positive;
ALTER TABLE reminder_schedules ADD  CONSTRAINT reminder_schedules_steps_positive
  CHECK (step_intervals IS NULL OR (
    array_length(step_intervals, 1) > 0
    AND array_position(step_intervals, NULL) IS NULL
    AND 0 < ALL (step_intervals)
  ));

-- A ladder is meaningless without a date to count from.
ALTER TABLE reminder_schedules DROP CONSTRAINT IF EXISTS reminder_schedules_steps_need_from;
ALTER TABLE reminder_schedules ADD  CONSTRAINT reminder_schedules_steps_need_from
  CHECK (step_intervals IS NULL OR exemption_from IS NOT NULL);


-- ── The single source of truth for "what interval applies right now" ────────
-- Dashboard, morning digest and SMS bot all read this view, so the ladder
-- logic exists in exactly one place and cannot drift between them.
-- security_invoker: the view runs as the *querying* user, so table RLS still
-- applies and this grants no extra visibility.
DROP VIEW IF EXISTS vehicle_effective_schedules;
CREATE VIEW vehicle_effective_schedules
WITH (security_invoker = true) AS
SELECT
  rs.vehicle_id,
  rs.reminder_type,
  CASE
    WHEN rs.step_intervals IS NULL                                    THEN rs.interval_days
    WHEN done.n < COALESCE(array_length(rs.step_intervals, 1), 0)     THEN rs.step_intervals[done.n + 1]
    ELSE rs.interval_days
  END                        AS interval_days,
  rs.warning_days_before,
  rs.enabled,
  rs.interval_days           AS steady_interval_days,
  rs.step_intervals,
  rs.exemption_from,
  done.n                     AS completed_since_exemption
FROM reminder_schedules rs
LEFT JOIN LATERAL (
  SELECT count(*)::int AS n
  FROM (
    -- Only the table that actually drives this reminder type is counted.
    SELECT bt.test_date AS d
      FROM brake_tests bt
     WHERE rs.reminder_type = 'brake_service' AND bt.vehicle_id = rs.vehicle_id
    UNION ALL
    -- Yard/periodic and PM both read service history; maintenance_records is
    -- included to match the fallback used by the dashboard and send-reminders.
    SELECT sr.service_date
      FROM service_records sr
     WHERE rs.reminder_type IN ('dot_inspection','pm_service') AND sr.vehicle_id = rs.vehicle_id
    UNION ALL
    SELECT mr.service_date
      FROM maintenance_records mr
     WHERE rs.reminder_type IN ('dot_inspection','pm_service') AND mr.vehicle_id = rs.vehicle_id
    UNION ALL
    SELECT tr.photo_date
      FROM tyre_records tr
     WHERE rs.reminder_type = 'tyre_check' AND tr.vehicle_id = rs.vehicle_id
  ) r
  WHERE rs.exemption_from IS NOT NULL AND r.d > rs.exemption_from
) done ON true
WHERE rs.vehicle_id IS NOT NULL;

GRANT SELECT ON vehicle_effective_schedules TO authenticated, service_role;

-- Inspect the current state of every exemption:
--   SELECT * FROM vehicle_effective_schedules ORDER BY vehicle_id, reminder_type;
