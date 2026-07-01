-- ================================================================
-- Dispatcher phones — Migration 006 (2026-07-01)
-- Cells for dispatcher notifications (overdue/due, driver confirmations,
-- PTI link/code/completed). Keyed by dispatcher_name to match the free-text
-- vehicles.assigned_dispatcher. Multiple names may share one number
-- (e.g. Alex/Max/Tom/Carl on one cell). Admin-only; Edge Functions use
-- service_role (bypasses RLS). Phone ROWS are seeded via the API, not here,
-- so staff numbers never land in the committed repo (same as driver_phones).
-- Safe to re-run.
-- ================================================================
CREATE TABLE IF NOT EXISTS dispatcher_phones (
  dispatcher_name TEXT        PRIMARY KEY,                       -- = vehicles.assigned_dispatcher
  phone_number    TEXT        NOT NULL
                              CHECK (phone_number ~ '^\+[1-9]\d{7,14}$'),  -- E.164
  sms_hold        BOOLEAN     NOT NULL DEFAULT false,            -- pause notifications for this dispatcher
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE dispatcher_phones IS 'Dispatcher cells for follow-up notifications. Admin-managed; keyed by assigned_dispatcher name.';

ALTER TABLE dispatcher_phones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dispatcher_phones_admin" ON dispatcher_phones;
CREATE POLICY "dispatcher_phones_admin" ON dispatcher_phones
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
