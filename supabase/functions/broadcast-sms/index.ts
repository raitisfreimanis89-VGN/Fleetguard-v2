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

  // ── health action ────────────────────────────────────────────
  // Read-only: recent SMS send outcomes + any stuck rows.
  if (body.action === "health") {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: recent } = await sb.from("sms_notifications")
      .select("status, reminder_type, error_message, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    const counts: Record<string, number> = {};
    for (const r of recent ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const failures = (recent ?? []).filter((r) => r.status === "failed").slice(0, 15);
    // Pending rows older than 10 min = stuck (never flipped to sent/failed)
    const stuckCutoff = new Date(Date.now() - 600_000).toISOString();
    const stuck = (recent ?? []).filter((r) => r.status === "pending" && r.created_at < stuckCutoff).length;
    return new Response(JSON.stringify({
      ok: true,
      window: "7 days",
      countsByStatus: counts,
      failedCount: counts["failed"] ?? 0,
      stuckPending: stuck,
      recentFailures: failures,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
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
    // Inspections linked to this vehicle_id
    const { data: inspByVehicle } = await sb.from("inspections")
      .select("ref, submitted_at, truck_number, vehicle_id, tyres_flagged, checks_failed, overall_result")
      .eq("vehicle_id", v.id).order("submitted_at", { ascending: false }).limit(6);
    // Inspections by truck number — catches PTIs that never linked to a vehicle_id
    const { data: inspByTruck } = await sb.from("inspections")
      .select("ref, submitted_at, truck_number, vehicle_id, tyres_flagged")
      .eq("truck_number", truck).order("submitted_at", { ascending: false }).limit(6);
    // Recent tyre_records (what drives the dashboard tyre date)
    const { data: tyreRows } = await sb.from("tyre_records")
      .select("photo_date, created_at")
      .eq("vehicle_id", v.id).order("created_at", { ascending: false }).limit(6);

    const dsince = (d: string | null) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000) : null;
    const svcDate = svc ?? maint;
    return new Response(JSON.stringify({
      ok: true,
      vehicle: v,
      driver: dr,
      lastDates: { brake, tyre, service: svcDate, dot },
      daysSince: { brake: dsince(brake), tyre: dsince(tyre), service: dsince(svcDate), dot: dsince(dot) },
      inspectionsByVehicle: inspByVehicle,
      inspectionsByTruckNumber: inspByTruck,
      tyreRecords: tyreRows,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  // ── set_last_tyre_date action ────────────────────────────────
  // Correct the photo_date on a vehicle's most-recent tyre_records row (used to
  // fix a PTI that stamped a stale draft date instead of the submission date).
  if (body.action === "set_last_tyre_date") {
    const truck = String(body.truck ?? "").trim();
    const date  = String(body.date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response(JSON.stringify({ error: "date must be YYYY-MM-DD" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const { data: v } = await sb.from("vehicles").select("id").eq("truck_number", truck).maybeSingle();
    if (!v) return new Response(JSON.stringify({ error: "No vehicle", truck }), { status: 404, headers: { "Content-Type": "application/json" } });
    const { data: row } = await sb.from("tyre_records").select("id, photo_date, created_at").eq("vehicle_id", v.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!row) return new Response(JSON.stringify({ error: "No tyre_records for vehicle" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const { error } = await sb.from("tyre_records").update({ photo_date: date }).eq("id", row.id);
    if (error) return new Response(JSON.stringify({ error: "Update failed", detail: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true, truck, rowId: row.id, oldPhotoDate: row.photo_date, newPhotoDate: date, rowCreatedAt: row.created_at }), { headers: { "Content-Type": "application/json" } });
  }

  // ── list_dispatchers action ──────────────────────────────────
  if (body.action === "list_dispatchers") {
    const { data } = await sb.from("dispatcher_phones")
      .select("dispatcher_name, phone_number, sms_hold").order("dispatcher_name");
    return new Response(JSON.stringify({ ok: true, dispatchers: data }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  // ── rename_driver action ─────────────────────────────────────
  // Debug/admin helper: rename a driver by exact (case-insensitive) old name.
  if (body.action === "rename_driver") {
    const oldName = String(body.oldName ?? "").trim();
    const newName = String(body.newName ?? "").trim();
    if (!oldName || !newName) return new Response(JSON.stringify({ error: "oldName and newName required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const { data: d } = await sb.from("drivers").select("id, name").ilike("name", oldName).maybeSingle();
    if (!d) return new Response(JSON.stringify({ error: "No driver by that name", oldName }), { status: 404, headers: { "Content-Type": "application/json" } });
    const { error } = await sb.from("drivers").update({ name: newName }).eq("id", d.id);
    if (error) return new Response(JSON.stringify({ error: "Update failed", detail: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true, driverId: d.id, oldName: d.name, newName }), { headers: { "Content-Type": "application/json" } });
  }

  // ── set_vacation action ──────────────────────────────────────
  // Debug/admin helper: toggle a driver's on_vacation flag by exact name.
  if (body.action === "set_vacation") {
    const name = String(body.name ?? "").trim();
    const on   = !!body.on;
    const { data: d } = await sb.from("drivers").select("id, name").ilike("name", name).maybeSingle();
    if (!d) return new Response(JSON.stringify({ error: "No driver by that name", name }), { status: 404, headers: { "Content-Type": "application/json" } });
    const { error } = await sb.from("drivers").update({ on_vacation: on }).eq("id", d.id);
    if (error) return new Response(JSON.stringify({ error: "Update failed", detail: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true, driver: d.name, on_vacation: on }), { headers: { "Content-Type": "application/json" } });
  }

  // ── update_dispatcher_phone action ───────────────────────────
  // Upsert a dispatcher's cell. Keyed by dispatcher_name (= vehicles.assigned_dispatcher).
  if (body.action === "update_dispatcher_phone") {
    const name = String(body.name ?? "").trim();
    const raw  = String(body.phone ?? "").trim();
    const digits = raw.replace(/\D/g, "");
    const phone = digits.length === 10 ? "+1" + digits
                : digits.length === 11 && digits[0] === "1" ? "+" + digits
                : raw.startsWith("+") ? raw : "";
    if (!name) return new Response(JSON.stringify({ error: "Missing name" }), { status: 400, headers: { "Content-Type": "application/json" } });
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return new Response(JSON.stringify({ error: "Invalid phone (E.164)", got: phone }), { status: 400, headers: { "Content-Type": "application/json" } });

    const { data: existing } = await sb.from("dispatcher_phones").select("phone_number").eq("dispatcher_name", name).maybeSingle();
    const now = new Date().toISOString();
    const { error } = await sb.from("dispatcher_phones").upsert({ dispatcher_name: name, phone_number: phone, sms_hold: false, updated_at: now }, { onConflict: "dispatcher_name" });
    if (error) return new Response(JSON.stringify({ error: "Update failed", detail: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });

    return new Response(JSON.stringify({ ok: true, dispatcher: name, oldPhone: existing?.phone_number ?? null, newPhone: phone, wasNew: !existing }), { headers: { "Content-Type": "application/json" } });
  }

  // ── add_driver action ────────────────────────────────────────
  // Create driver + vehicle + phone together. Refuses duplicates.
  if (body.action === "add_driver") {
    const name       = String(body.name ?? "").trim();
    const truck      = String(body.truck ?? "").trim();
    const trailer    = String(body.trailer ?? "").trim() || null;
    const dispatcher = String(body.dispatcher ?? "").trim() || "";
    const raw        = String(body.phone ?? "").trim();
    const digits     = raw.replace(/\D/g, "");
    const phone = digits.length === 10 ? "+1" + digits
                : digits.length === 11 && digits[0] === "1" ? "+" + digits
                : raw.startsWith("+") ? raw : "";
    if (!name || !truck) return new Response(JSON.stringify({ error: "name and truck required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return new Response(JSON.stringify({ error: "invalid phone", got: phone }), { status: 400, headers: { "Content-Type": "application/json" } });

    const { data: dupDriver } = await sb.from("drivers").select("id, name").ilike("name", name).maybeSingle();
    if (dupDriver) return new Response(JSON.stringify({ error: "driver already exists", existing: dupDriver }), { status: 409, headers: { "Content-Type": "application/json" } });

    const now = new Date().toISOString();
    const driverId = crypto.randomUUID();
    const { error: dErr } = await sb.from("drivers").insert({ id: driverId, name, on_vacation: false, created_at: now });
    if (dErr) return new Response(JSON.stringify({ error: "driver insert failed", detail: dErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });

    // Reuse the truck if it already exists, otherwise create it.
    const { data: veh } = await sb.from("vehicles").select("id").eq("truck_number", truck).maybeSingle();
    let vehicleId: string;
    if (veh) {
      vehicleId = veh.id;
      await sb.from("vehicles").update({ trailer_number: trailer, assigned_driver_id: driverId, assigned_dispatcher: dispatcher }).eq("id", vehicleId);
    } else {
      vehicleId = crypto.randomUUID();
      const { error: vErr } = await sb.from("vehicles").insert({ id: vehicleId, truck_number: truck, trailer_number: trailer, assigned_driver_id: driverId, assigned_dispatcher: dispatcher, created_at: now });
      if (vErr) return new Response(JSON.stringify({ error: "vehicle insert failed", detail: vErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    const { error: pErr } = await sb.from("driver_phones").insert({ driver_id: driverId, phone_number: phone, verified: false, added_at: now, updated_at: now });
    if (pErr) return new Response(JSON.stringify({ error: "phone insert failed", detail: pErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });

    return new Response(JSON.stringify({ ok: true, driver: name, driverId, truck, trailer, dispatcher, phone, vehicleCreated: !veh }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  // ── list_drivers_vehicles action ─────────────────────────────
  // All drivers with their currently-assigned truck (for name resolution).
  if (body.action === "list_drivers_vehicles") {
    const { data: drivers } = await sb.from("drivers").select("id, name").order("name");
    const { data: vehicles } = await sb.from("vehicles").select("id, truck_number, assigned_driver_id");
    const vehByDriver = new Map<string, { id: string; truck_number: string }>();
    for (const v of vehicles ?? []) if (v.assigned_driver_id) vehByDriver.set(v.assigned_driver_id, v);
    const out = (drivers ?? []).map((d) => ({
      name: d.name, driverId: d.id,
      truck: vehByDriver.get(d.id)?.truck_number ?? null,
      vehicleId: vehByDriver.get(d.id)?.id ?? null,
    }));
    return new Response(JSON.stringify({ ok: true, count: out.length, drivers: out }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  // ── add_dot_batch action ─────────────────────────────────────
  // Insert DOT roadside inspections. items: [{driverId, vehicleId, date, result, notes}]
  if (body.action === "add_dot_batch") {
    const items = Array.isArray(body.items) ? body.items : [];
    const results: unknown[] = [];
    for (const it of items as Record<string, string>[]) {
      if (!/^(pass|violation|oos)$/.test(it.result)) { results.push({ driverId: it.driverId, ok: false, error: "bad result" }); continue; }
      // Resolve the driver's current truck unless a vehicleId is given explicitly.
      let vehicleId: string | null = (it.vehicleId as string) ?? null;
      if (!vehicleId && it.driverId) {
        const { data: veh } = await sb.from("vehicles").select("id").eq("assigned_driver_id", it.driverId).maybeSingle();
        vehicleId = (veh as { id: string } | null)?.id ?? null;
      }
      const { error } = await sb.from("dot_inspections").insert({
        id: crypto.randomUUID(),
        vehicle_id: vehicleId,
        driver_id: it.driverId ?? null,
        inspection_date: it.date,
        result: it.result,
        notes: it.notes ?? null,
      });
      results.push({ driverId: it.driverId, date: it.date, result: it.result, ok: !error, error: error?.message ?? null });
    }
    return new Response(JSON.stringify({ ok: true, inserted: (results as { ok: boolean }[]).filter((r) => r.ok).length, results }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  // ── scan_stale_tyre action ───────────────────────────────────
  // Find vehicles whose LATEST tyre record is back-dated (photo_date well
  // before created_at) — the stale-draft bug. Cross-checks each against a PTI
  // submitted at the same moment so we only flag PTI-created rows, not manual
  // dispatcher entries. suggestedDate = the submission (created_at) date.
  if (body.action === "scan_stale_tyre") {
    const minGap = Number(body.minGapDays ?? 3);
    const { data: rows } = await sb.from("tyre_records")
      .select("vehicle_id, photo_date, created_at")
      .order("created_at", { ascending: false }).limit(3000);
    const latestByVeh = new Map<string, { photo_date: string; created_at: string }>();
    for (const r of rows ?? []) {
      if (r.vehicle_id && !latestByVeh.has(r.vehicle_id)) latestByVeh.set(r.vehicle_id, r);
    }
    const vehIds = [...latestByVeh.keys()];
    const { data: vehs } = await sb.from("vehicles").select("id, truck_number").in("id", vehIds);
    const vmap = new Map((vehs ?? []).map((v) => [v.id, v.truck_number]));
    const { data: insp } = await sb.from("inspections")
      .select("vehicle_id, submitted_at").order("submitted_at", { ascending: false }).limit(3000);
    const inspByVeh = new Map<string, number[]>();
    for (const i of insp ?? []) {
      if (!i.vehicle_id) continue;
      if (!inspByVeh.has(i.vehicle_id)) inspByVeh.set(i.vehicle_id, []);
      inspByVeh.get(i.vehicle_id)!.push(new Date(i.submitted_at).getTime());
    }
    const flagged: unknown[] = [];
    for (const [vid, r] of latestByVeh) {
      const gap = Math.floor((new Date(r.created_at.slice(0, 10)).getTime() - new Date(r.photo_date).getTime()) / 86_400_000);
      if (gap < minGap) continue;
      const createdMs = new Date(r.created_at).getTime();
      const ptiLinked = (inspByVeh.get(vid) ?? []).some((ms) => Math.abs(ms - createdMs) < 120_000);
      flagged.push({ truck: vmap.get(vid) ?? vid, photo_date: r.photo_date, created_at: r.created_at.slice(0, 10), gapDays: gap, ptiLinked, suggestedDate: r.created_at.slice(0, 10) });
    }
    (flagged as { gapDays: number }[]).sort((a, b) => b.gapDays - a.gapDays);
    return new Response(JSON.stringify({
      ok: true, minGap,
      flaggedCount: flagged.length,
      ptiLinkedCount: (flagged as { ptiLinked: boolean }[]).filter((f) => f.ptiLinked).length,
      flagged,
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
