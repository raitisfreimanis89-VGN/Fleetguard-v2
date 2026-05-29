-- ================================================================
-- FleetGuard Driver Phones — Migration 002
-- File: 002_driver_phones.sql
-- Isolated table: phone numbers NEVER on the drivers table.
-- Only admins and the Edge Function (service_role) can read.
-- Safe to re-run: IF NOT EXISTS / DROP POLICY IF EXISTS throughout
-- ================================================================

-- ----------------------------------------------------------------
-- TABLE: driver_phones
-- Kept separate from drivers so dispatchers cannot access phones
-- even by querying the drivers table directly.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_phones (
  driver_id    UUID        PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  phone_number TEXT        NOT NULL
                           CHECK (phone_number ~ '^\+[1-9]\d{7,14}$'),  -- E.164 format
  verified     BOOLEAN     NOT NULL DEFAULT false,
  added_by     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  driver_phones              IS 'Admin-only. Phone numbers isolated from drivers table to prevent dispatcher exposure.';
COMMENT ON COLUMN driver_phones.phone_number IS 'E.164 format required, e.g. +12625551234';

-- ----------------------------------------------------------------
-- RLS: admin-only on all operations
-- Dispatchers cannot SELECT even if they query directly.
-- Edge Function reads via service_role key (bypasses RLS).
-- ----------------------------------------------------------------
ALTER TABLE driver_phones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "phones_select_admin" ON driver_phones;
DROP POLICY IF EXISTS "phones_insert_admin" ON driver_phones;
DROP POLICY IF EXISTS "phones_update_admin" ON driver_phones;
DROP POLICY IF EXISTS "phones_delete_admin" ON driver_phones;

CREATE POLICY "phones_select_admin" ON driver_phones FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "phones_insert_admin" ON driver_phones FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "phones_update_admin" ON driver_phones FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "phones_delete_admin" ON driver_phones FOR DELETE TO authenticated USING (is_admin());

-- ----------------------------------------------------------------
-- Explicit column-level revoke: belt-and-suspenders.
-- Even if RLS were disabled by accident, anon/authenticated cannot
-- read phone_number at the column level.
-- ----------------------------------------------------------------
REVOKE SELECT (phone_number) ON driver_phones FROM anon;
REVOKE SELECT (phone_number) ON driver_phones FROM authenticated;
-- service_role retains full access (not affected by REVOKE on role-level grants)

-- ----------------------------------------------------------------
-- Helper RPC: admins fetch a single driver's phone for display.
-- Returns NULL instead of error if driver has no phone on file.
-- SECURITY DEFINER runs as postgres (service role), so it can
-- read phone_number even after the column-level REVOKE above.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_driver_phone(p_driver_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN is_admin()
    THEN (SELECT phone_number FROM driver_phones WHERE driver_id = p_driver_id)
    ELSE NULL
  END;
$$;

-- ----------------------------------------------------------------
-- Verify (uncomment to run manually after applying)
-- ----------------------------------------------------------------
-- SELECT column_name, privilege_type, grantee
--   FROM information_schema.column_privileges
--   WHERE table_name = 'driver_phones' AND column_name = 'phone_number';
--
-- SELECT tablename, policyname, roles, cmd, qual
--   FROM pg_policies
--   WHERE tablename = 'driver_phones'
--   ORDER BY policyname;
