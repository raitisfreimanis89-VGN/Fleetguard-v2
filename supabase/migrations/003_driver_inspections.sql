-- ================================================================
-- FleetGuard Driver Pre-Trip — Migration 003
-- File: 003_driver_inspections.sql
-- Adds: driver_otp_codes, inspections, link_sends, inspection-photos bucket.
-- Purely additive (no ALTERs on existing tables). Safe to re-run.
-- Requires: is_admin() (rls_policies.sql), drivers, vehicles.
-- ================================================================

-- ----------------------------------------------------------------
-- TABLE: driver_otp_codes
-- Short-lived OTP login codes. service_role only (no anon/auth policy).
-- code_hash = sha256(lower(phone) || ':' || code), never the raw code.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_otp_codes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT        NOT NULL CHECK (phone ~ '^\+[1-9]\d{7,14}$'),
  code_hash    TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT         NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_otp_codes_phone_idx   ON driver_otp_codes (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS driver_otp_codes_expires_idx ON driver_otp_codes (expires_at);

ALTER TABLE driver_otp_codes ENABLE ROW LEVEL SECURITY;
-- No policies → only service_role (Edge Functions) can touch it.

-- ----------------------------------------------------------------
-- TABLE: inspections
-- One row per submitted pre-trip. id is client-generated (idempotency).
-- details jsonb holds the full tyres[] + checks[] (incl. pressure).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspections (
  id              UUID        PRIMARY KEY,                       -- client-generated
  ref             TEXT        UNIQUE NOT NULL,                   -- FG-INSP-####
  vehicle_id      UUID        REFERENCES vehicles(id) ON DELETE SET NULL,
  driver_id       UUID        REFERENCES drivers(id)  ON DELETE SET NULL,
  truck_number    TEXT,
  trailer_number  TEXT,
  started_at      TIMESTAMPTZ,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_sec    INT         CHECK (duration_sec IS NULL OR duration_sec >= 0),
  odometer        INT         CHECK (odometer IS NULL OR (odometer > 0 AND odometer <= 9999999)),
  gps_lat         DOUBLE PRECISION,
  gps_lng         DOUBLE PRECISION,
  gps_accuracy    REAL,
  overall_result  TEXT        NOT NULL DEFAULT 'roadworthy'
                              CHECK (overall_result IN ('roadworthy','minor','defect')),
  tyres_flagged   INT         NOT NULL DEFAULT 0,
  checks_failed   INT         NOT NULL DEFAULT 0,
  signature_url   TEXT,
  notes           TEXT,
  details         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspections_vehicle_idx   ON inspections (vehicle_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS inspections_submitted_idx ON inspections (submitted_at DESC);

ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
-- Dispatchers/admins read; only service_role (the Edge Function) writes.
DROP POLICY IF EXISTS "insp_select_auth" ON inspections;
CREATE POLICY "insp_select_auth" ON inspections FOR SELECT TO authenticated USING (true);
-- (No INSERT/UPDATE/DELETE policy for authenticated → writes are service_role only.)

-- ----------------------------------------------------------------
-- TABLE: link_sends — audit trail for admin-initiated portal links
-- Satisfies the "links are admin-initiated, audited" rule.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS link_sends (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_by      UUID        REFERENCES profiles(id) ON DELETE SET NULL,  -- admin who sent
  sent_by_email TEXT,
  driver_id    UUID        REFERENCES drivers(id)  ON DELETE SET NULL,
  vehicle_id   UUID        REFERENCES vehicles(id) ON DELETE SET NULL,
  phone_masked TEXT,                                              -- e.g. (•••) •••-2302
  status       TEXT        NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error_message TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_sends_created_idx ON link_sends (created_at DESC);

ALTER TABLE link_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "link_sends_select_admin" ON link_sends;
CREATE POLICY "link_sends_select_admin" ON link_sends FOR SELECT TO authenticated USING (is_admin());
-- Inserts are service_role only (the driver-send-link function).

-- ----------------------------------------------------------------
-- STORAGE: private bucket for inspection photos + signatures
-- service_role (Edge Function) writes; authenticated (dispatchers) read.
-- ----------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('inspection-photos', 'inspection-photos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "insp_photos_read_auth" ON storage.objects;
CREATE POLICY "insp_photos_read_auth" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'inspection-photos');
-- (Writes happen via service_role in the Edge Function, which bypasses RLS.)

-- ----------------------------------------------------------------
-- VERIFY (optional) — run after applying
-- ----------------------------------------------------------------
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name IN ('driver_otp_codes','inspections','link_sends');
-- SELECT id, public FROM storage.buckets WHERE id='inspection-photos';
