-- ================================================================
-- Migration 010 — reusable new-truck exemption (2026-07-23)
--
-- Stores the new-truck policy as DATA and provides one function to apply it,
-- so onboarding a truck is a single call instead of hand-editing a script:
--
--   SELECT * FROM apply_new_truck_exemption('25042', DATE '2026-07-23');
--
-- Changing the policy later is an UPDATE on new_truck_policy — every truck
-- onboarded afterwards picks it up, with no code change.
-- Depends on migration 009 (step_intervals / exemption_from / the view).
-- ================================================================

-- ── Allow 'tyre_check' as a reminder type ───────────────────────────────────
-- send-reminders has always sent tyre_check, but migration 001 never listed it.
-- Harmless if the live database was already patched by hand.
ALTER TABLE reminder_schedules DROP CONSTRAINT IF EXISTS reminder_schedules_reminder_type_check;
ALTER TABLE reminder_schedules ADD  CONSTRAINT reminder_schedules_reminder_type_check
  CHECK (reminder_type IN ('dot_inspection','brake_service','pm_service','tyre_check'));

ALTER TABLE sms_notifications  DROP CONSTRAINT IF EXISTS sms_notifications_reminder_type_check;
ALTER TABLE sms_notifications  ADD  CONSTRAINT sms_notifications_reminder_type_check
  CHECK (reminder_type IN ('dot_inspection','brake_service','pm_service','tyre_check'));


-- ── The policy itself ───────────────────────────────────────────────────────
-- step_intervals   the phased ladder applied from the delivery date
-- steady_fallback  used only when no global row exists for that reminder type
CREATE TABLE IF NOT EXISTS new_truck_policy (
  reminder_type       text PRIMARY KEY
                      CHECK (reminder_type IN ('dot_inspection','brake_service','pm_service','tyre_check')),
  step_intervals      int[]   NOT NULL CHECK (array_length(step_intervals,1) > 0 AND 0 < ALL (step_intervals)),
  steady_fallback     int     NOT NULL CHECK (steady_fallback > 0),
  warning_days_before int     NOT NULL DEFAULT 7 CHECK (warning_days_before > 0),
  enabled             boolean NOT NULL DEFAULT true,
  note                text
);

COMMENT ON TABLE new_truck_policy IS
  'Exemption template applied to a newly delivered truck by apply_new_truck_exemption().';

-- Agreed 2026-07-23: brake 60 once; yard 90 twice; tyres 21 then 14; then fleet cadence.
INSERT INTO new_truck_policy (reminder_type, step_intervals, steady_fallback, warning_days_before, note) VALUES
  ('brake_service' , ARRAY[60]   , 42, 7, '60 days for the 1st brake inspection, then fleet cadence'),
  ('dot_inspection', ARRAY[90,90], 60, 7, '90 days for the first 2 yard inspections, then fleet cadence'),
  ('pm_service'    , ARRAY[90,90], 60, 7, 'mirrors the yard inspection — same underlying service history'),
  ('tyre_check'    , ARRAY[21,14],  7, 2, '21 days, then 14, then the weekly fleet cadence')
ON CONFLICT (reminder_type) DO NOTHING;


-- ── Apply the policy to one truck ───────────────────────────────────────────
-- Seeds the baseline records every interval counts from, then writes the
-- schedule rows. Safe to re-run: baselines are guarded and schedules upsert.
-- Raises rather than silently doing nothing if the truck cannot be identified.
CREATE OR REPLACE FUNCTION apply_new_truck_exemption(p_truck_number text, p_received date)
RETURNS TABLE (
  reminder_type   text,
  applies_today   int,
  ladder          int[],
  after_ladder    int
)
LANGUAGE plpgsql AS $$
-- RETURNS TABLE turns reminder_type/applies_today/ladder/after_ladder into
-- plpgsql variables, which collide with the real columns. ON CONFLICT needs a
-- bare column name and cannot be qualified, so tell plpgsql that columns win.
-- Safe here: no local variable (v_id, v_count, p_*) shares a column name.
#variable_conflict use_column
DECLARE
  v_id    uuid;
  v_count int;
BEGIN
  -- Counted and fetched separately: there is no min() aggregate for uuid, so
  -- combining these into one aggregate query fails with "function min(uuid)
  -- does not exist".
  SELECT count(*) INTO v_count
  FROM vehicles v WHERE v.truck_number = p_truck_number;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No vehicle with truck_number %. Check the number and try again.', p_truck_number;
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION '% vehicles share truck_number % — resolve the duplicate first.', v_count, p_truck_number;
  END IF;

  SELECT v.id INTO v_id
  FROM vehicles v WHERE v.truck_number = p_truck_number;

  IF p_received > current_date THEN
    RAISE EXCEPTION 'Received date % is in the future.', p_received;
  END IF;

  -- Baselines. Each interval counts from the newest row in its OWN table, so all
  -- three are required: send-reminders does `if (!lastDate) continue`, meaning a
  -- missing baseline silently produces no reminder at all.
  -- These date columns are a MIX of types across tables (brake_tests.test_date
  -- is text, service_records.service_date is date). Neither a bare date nor an
  -- explicit ::text works for both: casts FROM a string type are assignment-level
  -- only for an untyped literal, and text -> date is explicit-only. %L emits a
  -- quoted literal of unknown type, which Postgres coerces to whatever each
  -- column actually is. Reads use ::date for the same reason.
  EXECUTE format($q$
    INSERT INTO service_records (id, vehicle_id, service_date, result, notes)
    SELECT gen_random_uuid(), %1$L::uuid, %2$L, 'pass', 'New truck received - baseline yard inspection'
    WHERE NOT EXISTS (SELECT 1 FROM service_records s
                       WHERE s.vehicle_id = %1$L::uuid AND s.service_date::date = %2$L::date)
  $q$, v_id, p_received);

  EXECUTE format($q$
    INSERT INTO brake_tests (id, vehicle_id, test_date, result, notes)
    SELECT gen_random_uuid(), %1$L::uuid, %2$L, 'pass', 'New truck received - baseline brake inspection'
    WHERE NOT EXISTS (SELECT 1 FROM brake_tests b
                       WHERE b.vehicle_id = %1$L::uuid AND b.test_date::date = %2$L::date)
  $q$, v_id, p_received);

  -- Uncast '[]' so Postgres coerces it to the column's own json/jsonb type.
  EXECUTE format($q$
    INSERT INTO tyre_records (id, vehicle_id, photo_date, readings)
    SELECT gen_random_uuid(), %1$L::uuid, %2$L, '[]'
    WHERE NOT EXISTS (SELECT 1 FROM tyre_records t
                       WHERE t.vehicle_id = %1$L::uuid AND t.photo_date::date = %2$L::date)
  $q$, v_id, p_received);

  -- Schedule rows straight from the policy. Steady state prefers the existing
  -- global row so the truck rejoins whatever the fleet actually runs.
  INSERT INTO reminder_schedules
    (vehicle_id, reminder_type, interval_days, step_intervals, exemption_from, warning_days_before, enabled)
  SELECT
    v_id,
    p.reminder_type,
    COALESCE((SELECT g.interval_days FROM reminder_schedules g
               WHERE g.vehicle_id IS NULL AND g.reminder_type = p.reminder_type),
             p.steady_fallback),
    p.step_intervals,
    p_received,
    p.warning_days_before,
    true
  FROM new_truck_policy p
  WHERE p.enabled
  ON CONFLICT (vehicle_id, reminder_type) WHERE vehicle_id IS NOT NULL
  DO UPDATE SET interval_days       = EXCLUDED.interval_days,
                step_intervals      = EXCLUDED.step_intervals,
                exemption_from      = EXCLUDED.exemption_from,
                warning_days_before = EXCLUDED.warning_days_before,
                enabled             = true,
                updated_at          = now();

  RETURN QUERY
  SELECT es.reminder_type, es.interval_days, es.step_intervals, es.steady_interval_days
  FROM vehicle_effective_schedules es
  WHERE es.vehicle_id = v_id
  ORDER BY es.reminder_type;
END;
$$;

-- Ops tool: run from the SQL editor / service_role, not from the browser.
REVOKE ALL ON FUNCTION apply_new_truck_exemption(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_new_truck_exemption(text, date) TO service_role;

-- Undo an exemption early (immediate return to fleet cadence):
--   DELETE FROM reminder_schedules rs USING vehicles v
--    WHERE rs.vehicle_id = v.id AND v.truck_number = '<truck>';
