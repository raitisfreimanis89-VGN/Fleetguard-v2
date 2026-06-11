-- ================================================================
-- FleetGuard PTI bulk-send queue — Migration 004
-- Wave rollout of pre-trip links. Rows are created ONLY by an
-- explicit admin action (pti-queue Edge Function, action=enqueue);
-- the bot's drain cron merely delivers what an admin queued, 5 per
-- cycle. Satisfies the "links are admin-initiated, audited" rule —
-- every delivery is also mirrored into link_sends.
-- Safe to re-run: IF NOT EXISTS / DROP POLICY IF EXISTS throughout.
-- ================================================================
CREATE TABLE IF NOT EXISTS pti_send_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       UUID        NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  vehicle_id      UUID        REFERENCES vehicles(id) ON DELETE SET NULL,
  truck_number    TEXT        NOT NULL,
  phone           TEXT        NOT NULL,  -- raw E.164; table is admin-read only (same trust level as get_driver_phone)
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts        INT         NOT NULL DEFAULT 0,
  last_error      TEXT,
  queued_by       UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  queued_by_email TEXT,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pti_queue_pending_idx ON pti_send_queue (status, queued_at);

ALTER TABLE pti_send_queue ENABLE ROW LEVEL SECURITY;
-- Admins watch progress in the dispatcher app; ALL writes go through
-- service_role (the pti-queue function) — no client write policies.
DROP POLICY IF EXISTS "pti_queue_select_admin" ON pti_send_queue;
CREATE POLICY "pti_queue_select_admin" ON pti_send_queue FOR SELECT TO authenticated USING (is_admin());
