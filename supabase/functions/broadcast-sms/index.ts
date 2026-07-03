import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SERVICE_ROLE_KEY")!;
const GV_SECRET    = Deno.env.get("GV_SERVICE_SECRET")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

serve(async (req) => {
  const apiKey = req.headers.get("x-api-key") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!GV_SECRET || (apiKey !== GV_SECRET && bearer !== GV_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }

  // ── otp_check action ─────────────────────────────────────────
  if (body.action === "otp_check") {
    const phone = (body.phone as string)?.trim();
    const { data: rows } = await sb
      .from("driver_otp_codes")
      .select("created_at, expires_at, consumed_at, attempts")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(5);
    return new Response(JSON.stringify({ ok: true, rows }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── inspect_vehicle action ───────────────────────────────────
  // Debug: why did a reminder fire while the dashboard shows green?
  if (body.action === "inspect_vehicle") {
    const truck = String(body.truck ?? "").trim();
    const { data: v } = await sb.from("vehicles")
      .select("id, truck_number, trailer_number, assigned_driver_id, assigned_dispatcher")
      .eq("truck_number", truck).maybeSingle();
    if (!v) return new Response(JSON.stringify({ error: "No vehicle", truck }), { status: 404, headers: { "Content-Type": "application/json" } });

    const { data: dr } = v.assigned_driver_id
      ? await sb.from("drivers").select("name, on_vacation").eq("id", v.assigned_driver_id).maybeSingle()
      : { data: null };

    const latest = async (table: string, col: string) => {
      const { data } = await sb.from(table).select(col).eq("vehicle_id", v.id).order(col, { ascending: false }).limit(1).maybeSingle();
      return (data as Record<string, string> | null)?.[col] ?? null;
    };
    const brake = await latest("brake_tests", "test_date");
    const tyre  = await latest("tyre_records", "photo_date");
    const svc   = await latest("service_records", "service_date");
    const maint = await latest("maintenance_records", "service_date");
    const dot   = await latest("dot_inspections", "inspection_date");

    const { data: scheds } = await sb.from("reminder_schedules")
      .select("vehicle_id, reminder_type, interval_days, warning_days_before, enabled")
      .or(`vehicle_id.eq.${v.id},vehicle_id.is.null`);
    const { data: notifs } = await sb.from("sms_notifications")
      .select("reminder_type, message_body, status, created_at, sent_at")
      .eq("vehicle_id", v.id).order("created_at", { ascending: false }).limit(12);

    const dsince = (d: string | null) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000) : null;
    const svcDate = svc ?? maint;
    return new Response(JSON.stringify({
      ok: true,
      vehicle: v,
      driver: dr,
      lastDates: { brake, tyre, service: svcDate, dot },
      daysSince: { brake: dsince(brake), tyre: dsince(tyre), service: dsince(svcDate), dot: dsince(dot) },
      schedules: scheds,
      notifications: notifs,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  // ── update_phone action ──────────────────────────────────────
  // Change a driver's cell number. Match by exact (case-insensitive) name;
  // refuse if the name is ambiguous so we never edit the wrong driver.
  if (body.action === "update_phone") {
    const name  = (body.name as string)?.trim();
    const raw   = (body.phone as string)?.trim() ?? "";
    const digits = raw.replace(/\D/g, "");
    const phone = digits.length === 10 ? "+1" + digits
                : digits.length === 11 && digits[0] === "1" ? "+" + digits
                : raw.startsWith("+") ? raw : "";
    if (!name)  return new Response(JSON.stringify({ error: "Missing name" }), { status: 400, headers: { "Content-Type": "application/json" } });
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return new Response(JSON.stringify({ error: "Invalid phone (E.164)", got: phone }), { status: 400, headers: { "Content-Type": "application/json" } });

    const { data: matches } = await sb.from("drivers").select("id, name").ilike("name", name);
    if (!matches || matches.length === 0) return new Response(JSON.stringify({ error: "No driver by that name", name }), { status: 404, headers: { "Content-Type": "application/json" } });
    if (matches.length > 1) return new Response(JSON.stringify({ error: "Ambiguous name — multiple drivers", matches }), { status: 409, headers: { "Content-Type": "application/json" } });

    const driverId = matches[0].id;
    const now = new Date().toISOString();
    const { data: existing } = await sb.from("driver_phones").select("phone_number").eq("driver_id", driverId).maybeSingle();

    let err;
    if (existing) {
      ({ error: err } = await sb.from("driver_phones").update({ phone_number: phone, verified: false, updated_at: now }).eq("driver_id", driverId));
    } else {
      ({ error: err } = await sb.from("driver_phones").insert({ driver_id: driverId, phone_number: phone, verified: false, added_at: now, updated_at: now }));
    }
    if (err) return new Response(JSON.stringify({ error: "Update failed", detail: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });

    return new Response(JSON.stringify({ ok: true, driver: matches[0].name, oldPhone: existing?.phone_number ?? null, newPhone: phone }), { headers: { "Content-Type": "application/json" } });
  }

  // ── create_test action ────────────────────────────────────────
  if (body.action === "create_test") {
    const phone = (body.phone as string)?.trim();
    if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
      return new Response(JSON.stringify({ error: "Invalid or missing phone (E.164)" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const driverId  = crypto.randomUUID();
    const vehicleId = crypto.randomUUID();
    const now       = new Date().toISOString();

    // 1. Insert driver
    const { error: dErr } = await sb.from("drivers").insert({
      id: driverId, name: "Test Driver", on_vacation: false, created_at: now,
    });
    if (dErr) return new Response(JSON.stringify({ error: "Driver insert failed", detail: dErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });

    // 2. Insert vehicle (truck + trailer)
    const { error: vErr } = await sb.from("vehicles").insert({
      id: vehicleId, truck_number: "TEST-TRK", trailer_number: "TEST-TRL",
      assigned_driver_id: driverId, assigned_dispatcher: "", created_at: now,
    });
    if (vErr) return new Response(JSON.stringify({ error: "Vehicle insert failed", detail: vErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });

    // 3. Insert phone
    const { error: pErr } = await sb.from("driver_phones").insert({
      driver_id: driverId, phone_number: phone, verified: false, added_at: now, updated_at: now,
    });
    if (pErr) return new Response(JSON.stringify({ error: "Phone insert failed", detail: pErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });

    return new Response(
      JSON.stringify({ ok: true, driverId, vehicleId, name: "Test Driver", truck: "TEST-TRK", trailer: "TEST-TRL", phone }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ── default: return eligible phone list ──────────────────────
  const { data: allDrivers } = await sb.from("drivers").select("id, name, on_vacation");
  const { data: phones, error: phonesErr } = await sb.from("driver_phones").select("driver_id, phone_number");

  if (phonesErr || !phones) {
    return new Response(
      JSON.stringify({ error: "Failed to load driver phones", detail: phonesErr?.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const withPhone  = new Set(phones.map((p) => p.driver_id));
  const onVacation = new Set((allDrivers ?? []).filter((d) => d.on_vacation).map((d) => d.id));
  const phoneMap   = new Map(phones.map((p) => [p.driver_id, p.phone_number]));

  const eligible = (allDrivers ?? [])
    .filter((d) => withPhone.has(d.id) && !onVacation.has(d.id))
    .map((d) => ({ phone: phoneMap.get(d.id)!, name: d.name }));

  const noPhone = (allDrivers ?? [])
    .filter((d) => !withPhone.has(d.id))
    .map((d) => ({ id: d.id, name: d.name }));

  return new Response(
    JSON.stringify({ ok: true, drivers: eligible, noPhone }),
    { headers: { "Content-Type": "application/json" } }
  );
});
