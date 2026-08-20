import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Environment ───────────────────────────────────────────────
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SERVICE_ROLE_KEY")!;
const GV_SERVICE_URL = Deno.env.get("GV_SERVICE_URL")!;   // http://your-pc:3000
const GV_SECRET      = Deno.env.get("GV_SERVICE_SECRET")!;
const PORTAL_BASE    = Deno.env.get("PORTAL_BASE_URL") ?? "https://fleetguards.app/driver";

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ── Table → last-service-date lookup ─────────────────────────
const SERVICE_SOURCES: Record<string, { table: string; dateCol: string }> = {
  dot_inspection: { table: "service_records",    dateCol: "service_date"    },  // "Periodic/Yard inspection" = 🔧 Service record (2026-07-01); dot_inspections is roadside-only now
  brake_service:  { table: "brake_tests",        dateCol: "test_date"       },
  pm_service:     { table: "service_records",    dateCol: "service_date"    },
  tyre_check:     { table: "tyre_records",       dateCol: "photo_date"      },
};

// Fallback: pm_service also checks maintenance_records if service_records is empty
async function getLastDate(vehicleId: string, type: string): Promise<string | null> {
  const src = SERVICE_SOURCES[type];
  const { data } = await sb
    .from(src.table)
    .select(src.dateCol)
    .eq("vehicle_id", vehicleId)
    .order(src.dateCol, { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data?.[src.dateCol]) return data[src.dateCol];

  // Periodic/Yard (service) fallback: use maintenance_records.service_date if no service_records row
  if (type === "dot_inspection") {
    const { data: m } = await sb
      .from("maintenance_records")
      .select("service_date")
      .eq("vehicle_id", vehicleId)
      .order("service_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    return m?.service_date ?? null;
  }
  return null;
}

// ── Get effective schedule for a vehicle + type ───────────────
// Vehicle-specific row wins over global default (vehicle_id = null)
async function getSchedule(vehicleId: string, type: string) {
  // vehicle_effective_schedules (migration 009) resolves any new-truck ladder
  // (e.g. tyres 21 -> 14 -> 7) to the interval that applies today. For rows
  // without a ladder it returns interval_days unchanged.
  const { data: specific } = await sb
    .from("vehicle_effective_schedules")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .eq("reminder_type", type)
    .eq("enabled", true)
    .maybeSingle();

  if (specific) return specific;

  const { data: global } = await sb
    .from("reminder_schedules")
    .select("*")
    .is("vehicle_id", null)
    .eq("reminder_type", type)
    .eq("enabled", true)
    .maybeSingle();

  return global ?? null;
}

// ── Build human-readable message ──────────────────────────────
const TYPE_LABEL: Record<string, string> = {
  dot_inspection: "DOT inspection",
  brake_service:  "brake inspection",
  pm_service:     "PM service",
};

// HARD LIMIT 153 CHARS — Google Voice does not concatenate multipart SMS. It
// sends the first segment and silently drops the rest. Until 2026-07-29 four of
// these templates ran 182-206 chars, so every one of them lost its trailing
// "Reply OK to confirm" — the instruction the whole acknowledgement flow depends
// on — and the tyre message was cut MID-URL, handing drivers a dead upload link.
// Keep every message under 153 and plain GSM-7 (emoji/smart quotes force UCS-2,
// which cuts the segment to 67). fit() is the backstop if an identifier is long.
const GSM_SINGLE = 153;

// Shed detail rather than let Google Voice cut mid-sentence: try the full text,
// then without the trailer, then without the unit. The reply instruction and any
// link must always survive.
function fit(variants: string[]): string {
  return variants.find((v) => v.length <= GSM_SINGLE) ?? variants[variants.length - 1];
}

function buildMessage(truckNum: string, trailerNum: string, type: string, daysUntilDue: number): string {
  const overdue = daysUntilDue <= 0;
  const d       = `${daysUntilDue} day${daysUntilDue !== 1 ? "s" : ""}`;
  const unit    = ` for Trk #${truckNum} / Tlr #${trailerNum}`;
  const short   = ` for Trk #${truckNum}`;

  if (type === "brake_service") {
    if (overdue) {
      return fit([
        `Safety & Compliance: Brake inspection OVERDUE${unit}. Route to any TA or Love's within 5 days. Reply OK to confirm.`,
        `Safety & Compliance: Brake inspection OVERDUE${short}. Route to any TA or Love's within 5 days. Reply OK to confirm.`,
      ]);
    }
    return fit([
      `Safety & Compliance: Brake inspection due in ${d}${unit}. Please visit TA/Loves soon. Reply OK to confirm.`,
      `Safety & Compliance: Brake inspection due in ${d}${short}. Please visit TA/Loves soon. Reply OK to confirm.`,
    ]);
  }

  if (type === "tyre_check") {
    // The link is the entire point of this message — the trailer number goes
    // first if anything has to give.
    const link = `${PORTAL_BASE}/${encodeURIComponent(truckNum)}`;
    if (overdue) {
      return fit([
        `Safety & Compliance: Tire tread check OVERDUE${short}. Upload photos: ${link} (within 2 days). Reply OK.`,
        `Safety & Compliance: Tire tread check OVERDUE. Upload photos: ${link} (within 2 days). Reply OK.`,
      ]);
    }
    return fit([
      `Safety & Compliance: Tire tread check due in ${d}${short}. Upload photos: ${link}. Reply OK to confirm.`,
      `Safety & Compliance: Tire tread check due. Upload photos: ${link}. Reply OK to confirm.`,
    ]);
  }

  if (type === "dot_inspection") {
    if (overdue) {
      return fit([
        `Safety & Compliance: Yard inspection OVERDUE${unit}. Please visit the yard within 7 days. Reply OK to confirm.`,
        `Safety & Compliance: Yard inspection OVERDUE${short}. Please visit the yard within 7 days. Reply OK to confirm.`,
      ]);
    }
    return fit([
      `Safety & Compliance: Yard inspection due soon${unit}. Please plan a yard visit ASAP. Reply OK to confirm.`,
      `Safety & Compliance: Yard inspection due soon${short}. Please plan a yard visit ASAP. Reply OK to confirm.`,
    ]);
  }

  if (type === "pm_service") {
    if (overdue) {
      return fit([
        `Safety & Compliance: PM Service OVERDUE${unit}. Visit any TA or Love's within 5 days. Reply OK to confirm.`,
        `Safety & Compliance: PM Service OVERDUE${short}. Visit any TA or Love's within 5 days. Reply OK to confirm.`,
      ]);
    }
    return fit([
      `Safety & Compliance: PM Service due in ${d}${unit}. Please schedule a TA or Love's visit. Reply OK to confirm.`,
      `Safety & Compliance: PM Service due in ${d}${short}. Please schedule a TA or Love's visit. Reply OK to confirm.`,
    ]);
  }

  return `Safety & Compliance: Trk #${truckNum} has a service due. Reply OK to confirm.`;
}

// ── Main handler ──────────────────────────────────────────────
serve(async (req) => {
  // Auth: called by GV service (Bearer) or pg_cron (same secret)
  // Auth: accept x-api-key or Bearer token matching GV_SECRET
  // If GV_SECRET is not set yet, skip check (debug mode)
  if (GV_SECRET) {
    const apiKey     = req.headers.get("x-api-key") ?? "";
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer     = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (apiKey !== GV_SECRET && bearer !== GV_SECRET) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", received_key_length: apiKey.length, expected_key_length: GV_SECRET.length }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // A wave can request specific reminder types via { types: [...] } in the body,
  // so the bot runs tyre-only at 7:30, yard at 10, brake at noon (kept apart so a
  // driver never gets several texts at once). No/empty body = all types.
  let reqBody: { types?: string[] } = {};
  try { reqBody = await req.json(); } catch { /* empty body is fine */ }
  const ALL_TYPES = ["dot_inspection", "brake_service", "pm_service", "tyre_check"];
  const scanTypes = Array.isArray(reqBody.types) && reqBody.types.length
    ? ALL_TYPES.filter((t) => reqBody.types!.includes(t))
    : ALL_TYPES;

  // Send window: reminders only Mon-Fri, 7 AM-5 PM America/Chicago. No texting
  // drivers about overdue items at night or on weekends. OTP login codes and
  // PTI links live in other functions and remain available 24/7.
  const nowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", weekday: "short", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const chicagoDow  = nowParts.find((p) => p.type === "weekday")?.value ?? "";
  const chicagoHour = Number(nowParts.find((p) => p.type === "hour")?.value ?? "0");
  const isWeekend    = chicagoDow === "Sat" || chicagoDow === "Sun";
  const outsideHours = chicagoHour < 7 || chicagoHour >= 18;   // 07:00-17:59 CST (through 5:59 PM)
  if (isWeekend || outsideHours) {
    return new Response(
      JSON.stringify({ ok: true, sent: 0, skipped: 0, paused: isWeekend ? "weekend" : "outside 07:00-17:59 CST", day: chicagoDow, hour: chicagoHour }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const today    = new Date();
  const todayStr = today.toISOString().split("T")[0];
  let   sent            = 0;
  let   skipped         = 0;
  let   vacationSkipped = 0;
  const errors: string[] = [];

  // Batch cap: each GV send takes ~25s and the whole call must finish
  // within the Edge Function time limit (~150s). Send at most this many
  // per invocation; remaining vehicles are picked up on the next scan.
  // The dedup guard (already-sent-today) prevents duplicates across runs.
  const MAX_PER_RUN = 4;

  // Load all vehicles with their assigned driver
  const { data: vehicles, error: vErr } = await sb
    .from("vehicles")
    .select("id, truck_number, trailer_number, assigned_driver_id");

  if (vErr || !vehicles) {
    return new Response(JSON.stringify({ error: "Failed to load vehicles" }), { status: 500 });
  }

  for (const v of vehicles) {
    if (sent >= MAX_PER_RUN) break;   // batch limit reached — stop this run
    if (!v.assigned_driver_id) { skipped++; continue; }

    // Skip drivers currently marked on vacation
    const { data: driverRow } = await sb
      .from("drivers")
      .select("on_vacation")
      .eq("id", v.assigned_driver_id)
      .maybeSingle();
    if (driverRow?.on_vacation) { skipped++; vacationSkipped++; continue; }

    // Look up phone — only exists in driver_phones (admin/service_role only)
    const { data: phoneRow } = await sb
      .from("driver_phones")
      .select("phone_number, sms_hold")
      .eq("driver_id", v.assigned_driver_id)
      .maybeSingle();

    if (!phoneRow?.phone_number) { skipped++; continue; }
    if (phoneRow.sms_hold) { skipped++; continue; }   // number on hold — do not send

    for (const type of scanTypes) {
      if (sent >= MAX_PER_RUN) break;   // batch limit reached
      try {
        const sched = await getSchedule(v.id, type);
        if (!sched) continue;

        const lastDate = await getLastDate(v.id, type);
        if (!lastDate) continue;

        const daysSince   = Math.floor((today.getTime() - new Date(lastDate).getTime()) / 86_400_000);
        const daysUntilDue = sched.interval_days - daysSince;

        // Only send if overdue OR within warning window
        const shouldSend = daysUntilDue <= sched.warning_days_before;
        if (!shouldSend) continue;

        // Avoid duplicate: skip if we already sent this type today
        const { data: existing } = await sb
          .from("sms_notifications")
          .select("id")
          .eq("vehicle_id", v.id)
          .eq("reminder_type", type)
          .gte("created_at", `${todayStr}T00:00:00Z`)
          .in("status", ["sent", "acknowledged"])
          .limit(1)
          .maybeSingle();

        if (existing) { skipped++; continue; }

        const msg = buildMessage(v.truck_number, v.trailer_number ?? "—", type, daysUntilDue);

        // Log notification row first (status = pending)
        const { data: notif, error: nErr } = await sb
          .from("sms_notifications")
          .insert({
            vehicle_id:    v.id,
            driver_id:     v.assigned_driver_id,
            reminder_type: type,
            phone_number:  phoneRow.phone_number,
            message_body:  msg,
            status:        "pending",
          })
          .select("id")
          .single();

        if (nErr || !notif) {
          errors.push(`Insert notif failed for ${v.truck_number}/${type}: ${nErr?.message}`);
          continue;
        }

        // Call Google Voice service
        const gvRes = await fetch(`${GV_SERVICE_URL}/send`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
          body:    JSON.stringify({ to: phoneRow.phone_number, body: msg, notificationId: notif.id }),
          signal:  AbortSignal.timeout(60_000),
        }).catch((e) => ({ ok: false, statusText: e.message } as Response));

        const newStatus = gvRes.ok ? "sent" : "failed";
        const errMsg    = gvRes.ok ? null : `HTTP ${(gvRes as Response).status ?? "network error"}`;

        await sb.from("sms_notifications").update({
          status:        newStatus,
          sent_at:       new Date().toISOString(),
          error_message: errMsg,
        }).eq("id", notif.id);

        if (gvRes.ok) {
          sent++;
          // Schedule escalation check: insert a pending escalation_log row
          if (sched.escalation_hours > 0) {
            const escalateAfter = new Date(Date.now() + sched.escalation_hours * 3_600_000).toISOString();
            await sb.from("escalation_log").insert({
              notification_id: notif.id,
              escalated_to:    "pending",
              escalation_type: "sms",
              notes:           `escalate_after:${escalateAfter}`,
            });
          }
        } else {
          errors.push(`GV send failed for ${v.truck_number}: ${errMsg}`);
        }
      } catch (e) {
        errors.push(`${v.truck_number}/${type}: ${(e as Error).message}`);
      }
    }
  }

  return new Response(
    JSON.stringify({ ok: true, sent, skipped, vacationSkipped, errors }),
    { headers: { "Content-Type": "application/json" } }
  );
});
