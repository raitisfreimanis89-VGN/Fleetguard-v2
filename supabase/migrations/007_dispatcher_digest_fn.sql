-- ================================================================
-- Migration 007 — dispatcher_digest_data() (2026-07-01)
-- Returns one row per truck for every dispatcher that has a cell (and no
-- sms_hold), with days-since-last brake/service/tyre and whether a pre-trip
-- landed yesterday. The dispatcher-digest Edge Function groups these into a
-- per-fleet morning summary. SECURITY DEFINER so it reads across tables.
-- Thresholds live in the Edge Function (brake 35 / service 60 / tyre 14).
-- ================================================================
CREATE OR REPLACE FUNCTION dispatcher_digest_data()
RETURNS TABLE (
  dispatcher_name text,
  phone_number    text,
  truck_number    text,
  driver_name     text,
  on_vacation     boolean,
  brake_days      int,
  service_days    int,
  tyre_days       int,
  pti_yesterday   boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    dp.dispatcher_name,
    dp.phone_number,
    v.truck_number,
    d.name,
    COALESCE(d.on_vacation, false),
    (SELECT current_date - max(bt.test_date)::date FROM brake_tests bt WHERE bt.vehicle_id = v.id),
    (SELECT current_date - max(x.sd) FROM (
        SELECT service_date::date sd FROM service_records     WHERE vehicle_id = v.id
        UNION ALL
        SELECT service_date::date    FROM maintenance_records WHERE vehicle_id = v.id
     ) x),
    (SELECT current_date - max(tr.photo_date)::date FROM tyre_records tr WHERE tr.vehicle_id = v.id),
    EXISTS (SELECT 1 FROM inspections i WHERE i.vehicle_id = v.id AND i.submitted_at::date = current_date - 1)
  FROM dispatcher_phones dp
  JOIN vehicles v ON v.assigned_dispatcher = dp.dispatcher_name
  LEFT JOIN drivers d ON d.id = v.assigned_driver_id
  WHERE NOT dp.sms_hold
  ORDER BY dp.dispatcher_name, v.truck_number;
$$;

GRANT EXECUTE ON FUNCTION dispatcher_digest_data() TO service_role;
