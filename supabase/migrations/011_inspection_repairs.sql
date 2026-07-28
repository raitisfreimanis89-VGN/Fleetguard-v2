-- ================================================================
-- Migration 011 — close the defect loop on pre-trip inspections (2026-07-27)
--
-- A PTI could record overall_result = 'defect' and nothing followed. The row
-- had no resolution state, and getVehicleStatus() never looked at it, so a
-- truck with a defect reported at 6am still showed a green OK pill and could
-- be dispatched. The signed, GPS-stamped inspection then stands as proof the
-- defect was known before dispatch.
--
-- FMCSA's 2026 "Vehicle Maintenance: Driver-Observed" BASIC scores DVIR
-- quality: a defect caught pre-trip and repaired before dispatch is treated
-- differently from one found at roadside. Attaching a repair to the record is
-- what turns it from exhibit into defence.
--
-- OPEN vs CLOSED is derived, not stored on insert:
--   open   = overall_result IN ('defect','minor') AND repair_status IS NULL or 'open'
--   closed = repair_status IN ('repaired','deferred')
-- Deriving it means the driver-inspection Edge Function needs no change and
-- new defects are open automatically, with no trigger and no backfill.
-- ================================================================

ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS repair_status text,
  ADD COLUMN IF NOT EXISTS repaired_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS repaired_at   timestamptz,
  ADD COLUMN IF NOT EXISTS repair_notes  text;

COMMENT ON COLUMN inspections.repair_status IS
  'NULL/open = defect outstanding; repaired = fixed; deferred = accepted risk, logged deliberately.';

ALTER TABLE inspections DROP CONSTRAINT IF EXISTS inspections_repair_status_check;
ALTER TABLE inspections ADD  CONSTRAINT inspections_repair_status_check
  CHECK (repair_status IS NULL OR repair_status IN ('open','repaired','deferred'));

-- A closed defect must say who closed it and when — an unattributable
-- "repaired" flag is worth nothing in an audit.
ALTER TABLE inspections DROP CONSTRAINT IF EXISTS inspections_repair_attribution;
ALTER TABLE inspections ADD  CONSTRAINT inspections_repair_attribution
  CHECK (repair_status IS NULL
         OR repair_status = 'open'
         OR (repaired_by IS NOT NULL AND repaired_at IS NOT NULL));

-- Deliberately NO backfill: existing rows keep repair_status NULL and are
-- therefore treated as open. That is the honest reading, and it means the
-- change surfaces the real backlog rather than quietly declaring it clean.
-- To start from a clean slate instead, close the historical ones explicitly:
--
--   UPDATE inspections SET repair_status = 'deferred',
--          repaired_by = '<your profile id>', repaired_at = now(),
--          repair_notes = 'Pre-existing, closed at rollout'
--    WHERE overall_result IN ('defect','minor')
--      AND repair_status IS NULL
--      AND submitted_at < now() - interval '7 days';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- inspections previously had SELECT for authenticated and no write policy at
-- all (service_role only). Marking a repair is an admin action performed from
-- the browser, so admins need UPDATE. Dispatchers deliberately do not get it:
-- closing a defect is a compliance assertion, not a dispatch decision.
DROP POLICY IF EXISTS "insp_update_admin" ON inspections;
CREATE POLICY "insp_update_admin" ON inspections
  FOR UPDATE TO authenticated
  USING (is_admin());

-- Open defects across the fleet:
--   SELECT truck_number, submitted_at, overall_result, checks_failed, tyres_flagged
--     FROM inspections
--    WHERE overall_result IN ('defect','minor')
--      AND COALESCE(repair_status,'open') = 'open'
--    ORDER BY submitted_at DESC;
