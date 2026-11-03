-- ================================================================
-- Migration 018 — lock dispatcher_digest_data() to service_role (2026-11-03)
--
-- 007/008 granted EXECUTE to service_role but never took away the defaults:
-- Postgres gives every new function EXECUTE to PUBLIC, and this project's
-- default privileges in public add anon and authenticated on top. The
-- function is SECURITY DEFINER with no caller check, so anyone holding the
-- anon key from js/app.js could POST /rest/v1/rpc/dispatcher_digest_data and
-- get every dispatcher's cell number alongside driver names and trucks.
--
-- The dispatcher-digest Edge Function is the only caller and it uses the
-- service role key, so nothing in the app loses access.
--
-- If this function is ever dropped and recreated again (as 008 did), the
-- default grants come back with it: repeat the REVOKE in that migration.
-- ================================================================
REVOKE EXECUTE ON FUNCTION dispatcher_digest_data() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION dispatcher_digest_data() TO service_role;

-- VERIFY — anon and authenticated false, service_role true:
--   SELECT r, has_function_privilege(r, 'dispatcher_digest_data()', 'EXECUTE')
--   FROM unnest(ARRAY['anon','authenticated','service_role']) r;
