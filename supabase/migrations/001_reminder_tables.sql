-- ================================================================
-- FleetGuard Reminder System — Migration 001
-- File: 001_reminder_tables.sql
-- Safe to re-run: all statements use IF NOT EXISTS / OR REPLACE
-- Requires: is_admin() function (already in rls_policies.sql)
-- ================================================================

-- ----------------------------------------------------------------
-- TABLE: reminder_schedules
-- Per-vehicle interval config; NULL vehicle_id = global default
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

-- Unique constraint: one row per (vehicle, type).
-- NULL vehicle_id = global default; use partial indexes because
-- standard UNIQUE treats NULL != NULL (multiple NULLs allowed).
CREATE UNIQUE INDEX IF NOT EXISTS reminder_schedules_global_uniq
  ON reminder_schedules (reminder_type)
  WHERE vehicle_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reminder_schedules_vehicle_uniq
  ON reminder_schedules (vehicle_id, reminder_type)
  WHERE vehicle_id IS NOT NULL;

-- ----------------------------------------------------------------
-- TABLE: sms_notifications
-- One row per outbound SMS attempt
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_notifications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      UUID        REFERENCES vehicles(id) ON DELETE SET NULL,
  driver_id       UUID        REFERENCES drivers(id)  ON DELETE SET NULL,
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
-- TABLE: sms_replies
-- Inbound messages received from drivers
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
-- TABLE: escalation_log
-- Tracks when and to whom reminders were escalated
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

-- ----------------------------------------------------------------
-- RLS: reminder_schedules — all authenticated read; admin write
-- ----------------------------------------------------------------
ALTER TABLE reminder_schedules  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rsch_select_auth"  ON reminder_schedules;
DROP POLICY IF EXISTS "rsch_insert_admin" ON reminder_schedules;
DROP POLICY IF EXISTS "rsch_update_admin" ON reminder_schedules;
DROP POLICY IF EXISTS "rsch_delete_admin" ON reminder_schedules;

CREATE POLICY "rsch_select_auth"  ON reminder_schedules FOR SELECT TO authenticated USING (true);
CREATE POLICY "rsch_insert_admin" ON reminder_schedules FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "rsch_update_admin" ON reminder_schedules FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "rsch_delete_admin" ON reminder_schedules FOR DELETE TO authenticated USING (is_admin());

-- ----------------------------------------------------------------
-- RLS: sms_notifications — admin read/write; service_role inserts
-- ----------------------------------------------------------------
ALTER TABLE sms_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "smsn_select_admin" ON sms_notifications;
DROP POLICY IF EXISTS "smsn_insert_admin" ON sms_notifications;
DROP POLICY IF EXISTS "smsn_update_admin" ON sms_notifications;
DROP POLICY IF EXISTS "smsn_delete_admin" ON sms_notifications;

CREATE POLICY "smsn_select_admin" ON sms_notifications FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "smsn_insert_admin" ON sms_notifications FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "smsn_update_admin" ON sms_notifications FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY "smsn_delete_admin" ON sms_notifications FOR DELETE TO authenticated USING (is_admin());

-- ----------------------------------------------------------------
-- RLS: sms_replies — admin only
-- ----------------------------------------------------------------
ALTER TABLE sms_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "smsr_select_admin" ON sms_replies;
DROP POLICY IF EXISTS "smsr_insert_admin" ON sms_replies;
DROP POLICY IF EXISTS "smsr_delete_admin" ON sms_replies;

CREATE POLICY "smsr_select_admin" ON sms_replies FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "smsr_insert_admin" ON sms_replies FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "smsr_delete_admin" ON sms_replies FOR DELETE TO authenticated USING (is_admin());

-- ----------------------------------------------------------------
-- RLS: escalation_log — admin only
-- ----------------------------------------------------------------
ALTER TABLE escalation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "escl_select_admin" ON escalation_log;
DROP POLICY IF EXISTS "escl_insert_admin" ON escalation_log;
DROP POLICY IF EXISTS "escl_delete_admin" ON escalation_log;

CREATE POLICY "escl_select_admin" ON escalation_log FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "escl_insert_admin" ON escalation_log FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "escl_delete_admin" ON escalation_log FOR DELETE TO authenticated USING (is_admin());

-- ----------------------------------------------------------------
-- Seed global default schedules
-- Uses ON CONFLICT on the partial index key (reminder_type WHERE vehicle_id IS NULL)
-- ----------------------------------------------------------------
INSERT INTO reminder_schedules
  (vehicle_id, reminder_type, interval_days, warning_days_before, escalation_hours, enabled)
VALUES
  (NULL, 'dot_inspection', 90, 14, 48, true),
  (NULL, 'brake_service',  42,  7, 24, true),
  (NULL, 'pm_service',     60,  7, 48, true)
ON CONFLICT (reminder_type) WHERE vehicle_id IS NULL
DO UPDATE SET
  updated_at = now();   -- touch row so we know the seed ran; preserves user-edited values

-- ----------------------------------------------------------------
-- Verify (uncomment to run manually after applying)
-- ----------------------------------------------------------------
-- SELECT table_name, rowsecurity
--   FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('reminder_schedules','sms_notifications','sms_replies','escalation_log');
--
-- SELECT tablename, policyname, roles, cmd
--   FROM pg_policies
--   WHERE tablename IN ('reminder_schedules','sms_notifications','sms_replies','escalation_log')
--   ORDER BY tablename, policyname;
