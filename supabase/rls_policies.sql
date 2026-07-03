-- ================================================================
-- FleetGuard RLS Policies
-- Run this in: Supabase Dashboard → SQL Editor
-- ================================================================

-- ----------------------------------------------------------------
-- STEP 0: Helper function (avoids recursive policy lookups)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- ----------------------------------------------------------------
-- STEP 1: FIX user_activity — currently open to anonymous access
-- ----------------------------------------------------------------
REVOKE SELECT ON user_activity FROM anon;
-- Keep authenticated access but enforce is_admin() via app layer
-- (view cannot have RLS directly; anon revoke is the DB-level fix)

-- ----------------------------------------------------------------
-- STEP 2: profiles — enforce admin-only writes
-- ----------------------------------------------------------------
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own"    ON profiles;
DROP POLICY IF EXISTS "profiles_select_admin"  ON profiles;
DROP POLICY IF EXISTS "profiles_update_admin"  ON profiles;
DROP POLICY IF EXISTS "profiles_delete_admin"  ON profiles;

-- Each user can read their own profile (needed for role check on login)
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

-- Admins can read all profiles
CREATE POLICY "profiles_select_admin" ON profiles
  FOR SELECT TO authenticated
  USING (is_admin());

-- Only admins can change roles
CREATE POLICY "profiles_update_admin" ON profiles
  FOR UPDATE TO authenticated
  USING (is_admin());

-- Only admins can delete profiles
CREATE POLICY "profiles_delete_admin" ON profiles
  FOR DELETE TO authenticated
  USING (is_admin());

-- ----------------------------------------------------------------
-- STEP 3: Data tables — SELECT for all authenticated, writes admin-only
-- ----------------------------------------------------------------

-- VEHICLES
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vehicles_select_auth"  ON vehicles;
DROP POLICY IF EXISTS "vehicles_insert_admin" ON vehicles;
DROP POLICY IF EXISTS "vehicles_update_admin" ON vehicles;
DROP POLICY IF EXISTS "vehicles_delete_admin" ON vehicles;
CREATE POLICY "vehicles_select_auth"  ON vehicles FOR SELECT TO authenticated USING (true);
CREATE POLICY "vehicles_insert_admin" ON vehicles FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "vehicles_update_admin" ON vehicles FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "vehicles_delete_admin" ON vehicles FOR DELETE TO authenticated USING (is_admin());

-- DRIVERS
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "drivers_select_auth"  ON drivers;
DROP POLICY IF EXISTS "drivers_insert_admin" ON drivers;
DROP POLICY IF EXISTS "drivers_update_admin" ON drivers;
DROP POLICY IF EXISTS "drivers_delete_admin" ON drivers;
CREATE POLICY "drivers_select_auth"  ON drivers FOR SELECT TO authenticated USING (true);
CREATE POLICY "drivers_insert_admin" ON drivers FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "drivers_update_admin" ON drivers FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "drivers_delete_admin" ON drivers FOR DELETE TO authenticated USING (is_admin());

-- MAINTENANCE_RECORDS
ALTER TABLE maintenance_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "maintenance_select_auth"  ON maintenance_records;
DROP POLICY IF EXISTS "maintenance_insert_admin" ON maintenance_records;
DROP POLICY IF EXISTS "maintenance_update_admin" ON maintenance_records;
DROP POLICY IF EXISTS "maintenance_delete_admin" ON maintenance_records;
CREATE POLICY "maintenance_select_auth"  ON maintenance_records FOR SELECT TO authenticated USING (true);
CREATE POLICY "maintenance_insert_admin" ON maintenance_records FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "maintenance_update_admin" ON maintenance_records FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "maintenance_delete_admin" ON maintenance_records FOR DELETE TO authenticated USING (is_admin());

-- BRAKE_TESTS
ALTER TABLE brake_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brake_select_auth"  ON brake_tests;
DROP POLICY IF EXISTS "brake_insert_admin" ON brake_tests;
DROP POLICY IF EXISTS "brake_update_admin" ON brake_tests;
DROP POLICY IF EXISTS "brake_delete_admin" ON brake_tests;
CREATE POLICY "brake_select_auth"  ON brake_tests FOR SELECT TO authenticated USING (true);
CREATE POLICY "brake_insert_admin" ON brake_tests FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "brake_update_admin" ON brake_tests FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "brake_delete_admin" ON brake_tests FOR DELETE TO authenticated USING (is_admin());

-- TYRE_RECORDS
ALTER TABLE tyre_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tyre_select_auth"  ON tyre_records;
DROP POLICY IF EXISTS "tyre_insert_admin" ON tyre_records;
DROP POLICY IF EXISTS "tyre_update_admin" ON tyre_records;
DROP POLICY IF EXISTS "tyre_delete_admin" ON tyre_records;
CREATE POLICY "tyre_select_auth"  ON tyre_records FOR SELECT TO authenticated USING (true);
CREATE POLICY "tyre_insert_admin" ON tyre_records FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "tyre_update_admin" ON tyre_records FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "tyre_delete_admin" ON tyre_records FOR DELETE TO authenticated USING (is_admin());

-- DOT_INSPECTIONS
ALTER TABLE dot_inspections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dot_select_auth"  ON dot_inspections;
DROP POLICY IF EXISTS "dot_insert_admin" ON dot_inspections;
DROP POLICY IF EXISTS "dot_update_admin" ON dot_inspections;
DROP POLICY IF EXISTS "dot_delete_admin" ON dot_inspections;
CREATE POLICY "dot_select_auth"  ON dot_inspections FOR SELECT TO authenticated USING (true);
CREATE POLICY "dot_insert_admin" ON dot_inspections FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "dot_update_admin" ON dot_inspections FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "dot_delete_admin" ON dot_inspections FOR DELETE TO authenticated USING (is_admin());

-- MILEAGE_RECORDS (all authenticated can INSERT via Driver Portal; only admins can delete)
ALTER TABLE mileage_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mileage_select_auth"  ON mileage_records;
DROP POLICY IF EXISTS "mileage_insert_auth"  ON mileage_records;
DROP POLICY IF EXISTS "mileage_update_admin" ON mileage_records;
DROP POLICY IF EXISTS "mileage_delete_admin" ON mileage_records;
CREATE POLICY "mileage_select_auth"  ON mileage_records FOR SELECT TO authenticated USING (true);
CREATE POLICY "mileage_insert_auth"  ON mileage_records FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "mileage_update_admin" ON mileage_records FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "mileage_delete_admin" ON mileage_records FOR DELETE TO authenticated USING (is_admin());

-- SERVICE_RECORDS
ALTER TABLE service_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_select_auth"  ON service_records;
DROP POLICY IF EXISTS "service_insert_admin" ON service_records;
DROP POLICY IF EXISTS "service_update_admin" ON service_records;
DROP POLICY IF EXISTS "service_delete_admin" ON service_records;
CREATE POLICY "service_select_auth"  ON service_records FOR SELECT TO authenticated USING (true);
CREATE POLICY "service_insert_admin" ON service_records FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "service_update_admin" ON service_records FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "service_delete_admin" ON service_records FOR DELETE TO authenticated USING (is_admin());

-- ----------------------------------------------------------------
-- STEP 4: Verify — run this after applying to confirm
-- ----------------------------------------------------------------
-- SELECT schemaname, tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public';
--
-- SELECT tablename, policyname, roles, cmd, qual
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- ORDER BY tablename, policyname;
