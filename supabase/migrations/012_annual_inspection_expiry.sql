-- ================================================================
-- Migration 012 — annual DOT inspection expiry per vehicle (2026-07-27)
--
-- Operating without valid annual inspection documentation draws 133,000+
-- citations a year and is one of the most common vehicle-maintenance
-- violations. FleetGuard tracked yard/periodic service and roadside DOT
-- inspections, but never the annual certificate's own expiry date — so a
-- truck could be fully green here and still be placed out of service for an
-- expired sticker.
--
-- Stored as the EXPIRY date, not the inspection date: the sticker is what an
-- officer reads, and the expiry is what the driver is asked for.
--
-- NOTE: this is a "days UNTIL a future date" signal. The SMS reminder bot
-- models the opposite ("days SINCE last X > interval"), so it deliberately
-- does NOT feed send-reminders. Dashboard/card warning only, for now.
-- ================================================================

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS annual_inspection_expiry date;

COMMENT ON COLUMN vehicles.annual_inspection_expiry IS
  'Expiry date on the annual DOT inspection certificate. NULL = not recorded; the card shows "not set" rather than assuming compliance.';

-- Nothing is backfilled and nothing is assumed. A NULL renders as "not set"
-- in grey, never as green — an unknown expiry must not read as compliant.

-- Vehicles whose certificate has expired or expires within 30 days:
--   SELECT truck_number, annual_inspection_expiry,
--          annual_inspection_expiry - current_date AS days_left
--     FROM vehicles
--    WHERE annual_inspection_expiry IS NOT NULL
--      AND annual_inspection_expiry <= current_date + 30
--    ORDER BY annual_inspection_expiry;
