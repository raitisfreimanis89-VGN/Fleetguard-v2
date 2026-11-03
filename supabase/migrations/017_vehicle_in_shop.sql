-- ================================================================
-- Migration 017 — "In the shop" status for a truck (2026-11-03)
--
-- A truck off the road for a long repair keeps its driver, dispatcher and
-- history, but nothing should chase the driver about inspections meanwhile.
-- Asked for after #25141 went in for a long stay and its driver kept getting
-- daily tyre reminders.
--
--   shop_since  the date it went in. NULL = on the road. This is the switch:
--               send-reminders and pti-queue skip the truck while it is set.
--   shop_until  expected back, optional. The dashboard turns the truck amber
--               once this passes (or after 14 days when it is left blank).
--   shop_note   free text for the office ("engine at Rush").
--
-- Additive only. dispatcher_digest_data() is deliberately left alone: the
-- digest Edge Function reads these three columns from vehicles itself and
-- joins on vehicle_id, so no function has to be dropped and recreated.
-- ================================================================
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS shop_since date,
  ADD COLUMN IF NOT EXISTS shop_until date,
  ADD COLUMN IF NOT EXISTS shop_note  text;
