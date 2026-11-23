-- ================================================================
-- Migration 019 — cameras on trucks + the safety log (2026-11-23)
--
-- Additive only. Until this runs, the app's CAMERA_AVAILABLE and
-- SAFETY_AVAILABLE flags stay false and both features simply do not show.
--
-- 1. vehicles.camera_*      which trucks carry a dash camera (rental trucks
--                           come and go, so it lives on the truck row and is
--                           cleared when the camera comes out).
-- 2. safety_events          one row per violation, ticket, crash or coaching
--                           talk. Admin only: these are disciplinary records.
--                           Doubles as the DOT accident register
--                           (49 CFR 390.15: date, location, driver, injuries,
--                           fatalities, hazmat; kept 3 years), so it keeps
--                           its own copy of the driver name and truck number
--                           and survives the driver or truck being deleted.
-- 3. safety-files bucket    tickets, roadside reports and photos for an entry.
-- ================================================================

-- ── 1. Cameras ──────────────────────────────────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS camera_type         text CHECK (camera_type IN ('road','dual')),
  ADD COLUMN IF NOT EXISTS camera_installed_on date,
  ADD COLUMN IF NOT EXISTS camera_provider     text,
  ADD COLUMN IF NOT EXISTS camera_serial       text;

COMMENT ON COLUMN vehicles.camera_type IS
  'NULL = no camera. road = road-facing, dual = road + driver-facing.';

-- ── 2. Safety log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS safety_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_date       date NOT NULL,
  driver_id        uuid REFERENCES drivers(id)  ON DELETE SET NULL,
  driver_name      text NOT NULL,
  vehicle_id       uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  truck_number     text,
  category         text NOT NULL CHECK (category IN ('camera','roadside','crash','other')),
  event_type       text NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('minor','major','critical')),
  source           text,
  description      text,
  clip_url         text,
  attachment_path  text,
  attachment_name  text,
  action_taken     text NOT NULL DEFAULT 'none'
                   CHECK (action_taken IN ('none','coached','verbal','written','final','suspended','terminated')),
  follow_up_on     date,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  -- Accident register (only filled for a DOT-recordable crash)
  dot_recordable   boolean NOT NULL DEFAULT false,
  crash_location   text,
  injuries         int CHECK (injuries   >= 0),
  fatalities       int CHECK (fatalities >= 0),
  hazmat_released  boolean,
  created_by       uuid DEFAULT auth.uid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS safety_events_date_idx   ON safety_events (event_date DESC);
CREATE INDEX IF NOT EXISTS safety_events_driver_idx ON safety_events (driver_id, event_date DESC);

ALTER TABLE safety_events ENABLE ROW LEVEL SECURITY;

-- Admin only, all four verbs. No anon policy, so the public key reads nothing.
CREATE POLICY safety_select_admin ON safety_events FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY safety_insert_admin ON safety_events FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY safety_update_admin ON safety_events FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY safety_delete_admin ON safety_events FOR DELETE TO authenticated USING (is_admin());

-- ── 3. Attachments ──────────────────────────────────────────────────────────
-- Private, 10 MB a file, photos and PDFs only. Photos are shrunk in the
-- browser before upload; PDFs (roadside reports, tickets) go up as they are.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('safety-files', 'safety-files', false, 10485760,
        ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY safety_files_read_admin   ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'safety-files' AND public.is_admin());
CREATE POLICY safety_files_insert_admin ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'safety-files' AND public.is_admin());
CREATE POLICY safety_files_delete_admin ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'safety-files' AND public.is_admin());
