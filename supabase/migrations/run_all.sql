-- ================================================================
-- FleetGuard Reminder System — Combined Migration
-- Paste this entire file into Supabase SQL Editor and click RUN
-- Safe to re-run multiple times
-- ================================================================


-- ----------------------------------------------------------------
-- STEP 0: Ensure is_admin() helper exists
-- (Already in rls_policies.sql — recreating here as a safety net)
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


-- ================================================================
-- PART 1: REMINDER TABLES
-- ================================================================

-- ----------------------------------------------------------------
-- reminder_schedules
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_schedules (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id          UUID        REFERENCES vehicles(id) ON DELETE CASCADE,
  reminder_type       TEXT        NOT NULL
                                  CHECK (reminder_type IN ('dot_inspection','brake_service','pm_service')),
  interval_days       INT         NOT NULL DEFAULT 30 CHECK (interval_days > 0),
  warning_days_before INT         NOT NULL DEFAULT 7  CHECK (warning_days_before > 0),
  escalation_hours    INT         NOT NULL DEFAULT 48 CHECK (escalation_hours > 0),
  enabled             BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique indexes (handles NULL vehicle_id correctly)
CREATE UNIQUE INDEX IF NOT EXISTS reminder_schedules_global_uniq
  ON reminder_schedules (reminder_type)
  WHERE vehicle_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reminder_schedules_vehicle_uniq
  ON reminder_schedules (vehicle_id, reminder_type)
  WHERE vehicle_id IS NOT NULL;

-- ----------------------------------------------------------------
-- sms_notifications
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_notifications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      UUID        REFERENCES vehicles(id)  ON DELETE SET NULL,
  driver_id       UUID        REFERENCES drivers(id)   ON DELETE SET NULL,
  reminder_type   TEXT        NOT NULL
                              CHECK (reminder_type IN ('dot_inspection','brake_service','pm_service')),
  phone_number    TEXT        NOT NULL,
  message_body    TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','sent','failed','acknowledged')),
  sent_at         TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_notifications_driver_status_idx
  ON sms_notifications (driver_id, status);

CREATE INDEX IF NOT EXISTS sms_notifications_created_idx
  ON sms_notifications (created_at DESC);

-- ----------------------------------------------------------------
-- sms_replies
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_replies (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_number     TEXT        NOT NULL,
  body            TEXT        NOT NULL,
  driver_id       UUID        REFERENCES drivers(id)           ON DELETE SET NULL,
  notification_id UUID        REFERENCES sms_notifications(id) ON DELETE SET NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_replies_received_idx
  ON sms_replies (received_at DESC);

-- ----------------------------------------------------------------
-- escalation_log
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS escalation_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID        NOT NULL REFERENCES sms_notifications(id) ON DELETE CASCADE,
  escalated_to    TEXT        NOT NULL,
  escalation_type TEXT        NOT NULL CHECK (escalation_type IN ('email','sms')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS escalation_log_notification_idx
  ON escalation_log (notification_id);


-- ================================================================
-- PART 2: DRIVER PHONES
-- ================================================================

CREATE TABLE IF NOT EXISTS driver_phones (
  driver_id    UUID        PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  phone_number TEXT        NOT NULL,
  verified     BOOLEAN     NOT NULL DEFAULT false,
  added_by     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  driver_phones              IS 'Admin-only. Isolated from drivers table to prevent dispatcher access.';
COMMENT ON COLUMN driver_phones.phone_number IS 'E.164 format, e.g. +12625551234';


-- ================================================================
-- PART 3: ROW LEVEL SECURITY
-- ================================================================

ALTER TABLE reminder_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_notifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_replies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_phones      ENABLE ROW LEVEL SECURITY;

-- ── reminder_schedules (all authenticated can read; admin writes) ──
DROP POLICY IF EXISTS "rsch_select_auth"  ON reminder_schedules;
DROP POLICY IF EXISTS "rsch_insert_admin" ON reminder_schedules;
DROP POLICY IF EXISTS "rsch_update_admin" ON reminder_schedules;
DROP POLICY IF EXISTS "rsch_delete_admin" ON reminder_schedules;
CREATE POLICY "rsch_select_auth"  ON reminder_schedules FOR SELECT TO authenticated USING (true);
CREATE POLICY "rsch_insert_admin" ON reminder_schedules FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "rsch_update_admin" ON reminder_schedules FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "rsch_delete_admin" ON reminder_schedules FOR DELETE TO authenticated USING (is_admin());

-- ── sms_notifications (admin only) ──────────────────────────────
DROP POLICY IF EXISTS "smsn_select_admin" ON sms_notifications;
DROP POLICY IF EXISTS "smsn_insert_admin" ON sms_notifications;
DROP POLICY IF EXISTS "smsn_update_admin" ON sms_notifications;
DROP POLICY IF EXISTS "smsn_delete_admin" ON sms_notifications;
CREATE POLICY "smsn_select_admin" ON sms_notifications FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "smsn_insert_admin" ON sms_notifications FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "smsn_update_admin" ON sms_notifications FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "smsn_delete_admin" ON sms_notifications FOR DELETE TO authenticated USING (is_admin());

-- ── sms_replies (admin only) ─────────────────────────────────────
DROP POLICY IF EXISTS "smsr_select_admin" ON sms_replies;
DROP POLICY IF EXISTS "smsr_insert_admin" ON sms_replies;
DROP POLICY IF EXISTS "smsr_delete_admin" ON sms_replies;
CREATE POLICY "smsr_select_admin" ON sms_replies FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "smsr_insert_admin" ON sms_replies FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "smsr_delete_admin" ON sms_replies FOR DELETE TO authenticated USING (is_admin());

-- ── escalation_log (admin only) ──────────────────────────────────
DROP POLICY IF EXISTS "escl_select_admin" ON escalation_log;
DROP POLICY IF EXISTS "escl_insert_admin" ON escalation_log;
DROP POLICY IF EXISTS "escl_delete_admin" ON escalation_log;
CREATE POLICY "escl_select_admin" ON escalation_log FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "escl_insert_admin" ON escalation_log FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "escl_delete_admin" ON escalation_log FOR DELETE TO authenticated USING (is_admin());

-- ── driver_phones (admin only) ───────────────────────────────────
DROP POLICY IF EXISTS "phones_select_admin" ON driver_phones;
DROP POLICY IF EXISTS "phones_insert_admin" ON driver_phones;
DROP POLICY IF EXISTS "phones_update_admin" ON driver_phones;
DROP POLICY IF EXISTS "phones_delete_admin" ON driver_phones;
CREATE POLICY "phones_select_admin" ON driver_phones FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "phones_insert_admin" ON driver_phones FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "phones_update_admin" ON driver_phones FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "phones_delete_admin" ON driver_phones FOR DELETE TO authenticated USING (is_admin());

-- Belt-and-suspenders: column-level revoke on phone_number
REVOKE SELECT (phone_number) ON driver_phones FROM anon;
REVOKE SELECT (phone_number) ON driver_phones FROM authenticated;


-- ================================================================
-- PART 4: SECURITY DEFINER HELPER (admin-only phone lookup)
-- ================================================================
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


-- ================================================================
-- PART 5: SEED DEFAULT SCHEDULES
-- Uses WHERE NOT EXISTS — avoids any ON CONFLICT partial index issues
-- ================================================================
INSERT INTO reminder_schedules (vehicle_id, reminder_type, interval_days, warning_days_before, escalation_hours, enabled)
SELECT NULL, 'dot_inspection', 90, 14, 48, true
WHERE NOT EXISTS (
  SELECT 1 FROM reminder_schedules WHERE vehicle_id IS NULL AND reminder_type = 'dot_inspection'
);

INSERT INTO reminder_schedules (vehicle_id, reminder_type, interval_days, warning_days_before, escalation_hours, enabled)
SELECT NULL, 'brake_service', 42, 7, 24, true
WHERE NOT EXISTS (
  SELECT 1 FROM reminder_schedules WHERE vehicle_id IS NULL AND reminder_type = 'brake_service'
);

INSERT INTO reminder_schedules (vehicle_id, reminder_type, interval_days, warning_days_before, escalation_hours, enabled)
SELECT NULL, 'pm_service', 60, 7, 48, true
WHERE NOT EXISTS (
  SELECT 1 FROM reminder_schedules WHERE vehicle_id IS NULL AND reminder_type = 'pm_service'
);


-- ================================================================
-- VERIFY — results should show 5 tables with rowsecurity = true
-- ================================================================
SELECT
  table_name,
  (SELECT rowsecurity FROM pg_class WHERE relname = table_name) AS rls_on
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'reminder_schedules','sms_notifications',
    'sms_replies','escalation_log','driver_phones'
  )
ORDER BY table_name;
