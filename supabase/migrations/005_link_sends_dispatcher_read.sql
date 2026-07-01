-- ================================================================
-- Migration 005 — dispatchers can read link_sends
-- Governance update 2026-07-01: dispatchers may now send PTI links
-- (driver-send-link accepts the dispatcher role) and see send history,
-- so the vehicle PTI tab can show "last PTI link sent" to them.
-- INSERTs remain service_role only (unchanged). Every row still records
-- sent_by / sent_by_email, so accountability is preserved.
-- Reversible: restore the is_admin() policy to re-lock reads to admins.
-- ================================================================
DROP POLICY IF EXISTS "link_sends_select_admin" ON link_sends;
DROP POLICY IF EXISTS "link_sends_select_auth"  ON link_sends;
CREATE POLICY "link_sends_select_auth" ON link_sends
  FOR SELECT TO authenticated USING (true);
