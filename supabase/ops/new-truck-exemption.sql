-- ================================================================
-- NEW TRUCK — RUNBOOK
--
-- A truck fresh from the dealer eases onto the fleet cadence over its first
-- few inspections instead of switching in one step:
--
--                     step 1   step 2   then
--   Brake               60       —      fleet (42)
--   Yard / periodic     90       90     fleet (60)
--   Tyre                21       14     fleet (7)
--
-- The step-down is automatic. Each recorded inspection advances the ladder and
-- the exemption expires on its own — there is nothing to remember later.
--
-- Requires migrations 009 and 010.
-- ================================================================


-- ── 1. Onboard the truck ────────────────────────────────────────────────────
-- Arguments: truck number, and the date the truck was received.
-- The received date is the baseline every interval counts from.
--
-- Raises an error (rather than silently doing nothing) if the truck number
-- matches no vehicle or more than one. Safe to re-run.

SELECT * FROM apply_new_truck_exemption('25042', DATE '2026-07-23');

-- Expected: 4 rows, applies_today = brake 60 | yard 90 | pm 90 | tyre 21.
-- It also creates the three baseline records (yard, brake, tyre) dated that
-- day. All three are required — an interval with no record in its own table
-- produces no reminder at all, silently.


-- ── 2. Check where a truck currently sits ───────────────────────────────────
SELECT v.truck_number, d.name AS driver, es.reminder_type,
       es.interval_days              AS applies_today,
       es.step_intervals             AS ladder,
       es.completed_since_exemption  AS done_since_delivery,
       es.steady_interval_days       AS after_ladder,
       es.exemption_from
FROM vehicle_effective_schedules es
JOIN vehicles v ON v.id = es.vehicle_id
LEFT JOIN drivers d ON d.id = v.assigned_driver_id
ORDER BY v.truck_number, es.reminder_type;


-- ── 3. End an exemption early ───────────────────────────────────────────────
-- Deleting the rows returns the truck to the fleet cadence immediately.
-- Rows whose ladder is already exhausted are harmless, just redundant.
--
--   DELETE FROM reminder_schedules rs USING vehicles v
--    WHERE rs.vehicle_id = v.id AND v.truck_number = '25042';


-- ── 4. Change the policy for FUTURE trucks ──────────────────────────────────
-- Edit the template — trucks already onboarded keep the ladder they were given.
--
--   SELECT * FROM new_truck_policy ORDER BY reminder_type;
--
--   UPDATE new_truck_policy
--      SET step_intervals = ARRAY[75]
--    WHERE reminder_type = 'brake_service';
--
-- To re-apply a changed policy to a truck already onboarded, just call
-- apply_new_truck_exemption() again with the same received date.
