// driver-send-pm - ADMIN-ONLY, HUMAN-INITIATED ONLY. A logged-in admin texts a
// driver to route for PM service (oil change) at any TA or Love's. Verifies the
// caller's Supabase JWT, sends via gvoice, writes an audit row.
// Deploy with --no-verify-jwt.
//
// Stricter than driver-send-link, which was opened to dispatchers on 2026-07-01:
// this one stays admin-only by decision (2026-07-29). Never scheduled, never
// automatic, only on an explicit click, always attributed to whoever clicked.
// Audited to sms_notifications with reminder_type 'pm_service' so these sends
// sit alongside the bot's own reminders rather than in a separate silo.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { preflight, json, maskPhone, notifyDispatcher, bgRun } from "../_shared/common.ts";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SERVICE_ROLE_KEY")!;
const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
const GV_SERVICE_URL = Deno.env.get("GV_SERVICE_URL")!;
const GV_SECRET      = Deno.env.get("GV_SERVICE_SECRET")!;

const svc = createClient(SUPABASE_URL, SERVICE_KEY);

serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // --- caller must be an authenticated admin or dispatcher ---
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user }, error: uErr } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: "Unauthorized" }, 401);

  // ADMIN ONLY — deliberately narrower than driver-send-link, which was opened to
  // dispatchers on 2026-07-01. Committing the company to a paid oil change is a
  // maintenance decision, not a dispatch one. The UI hides the button from
  // dispatchers, but this is the gate that actually holds: without it a
  // dispatcher could call the function directly with their own token.
  const { data: prof } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* ignore */ }
  const driverId  = String(b.driverId ?? "");
  const vehicleId = String(b.vehicleId ?? "");
  if (!driverId) return json({ error: "driverId required" }, 400);

  // Driver phone (respect hold).
  const { data: ph } = await svc.from("driver_phones").select("phone_number, sms_hold").eq("driver_id", driverId).maybeSingle();
  if (!ph?.phone_number) return json({ error: "Driver has no phone on file" }, 400);
  if (ph.sms_hold) return json({ error: "Driver's number is on SMS hold" }, 400);

  let truck = "", trailer = "";
  if (vehicleId) {
    const { data: v } = await svc.from("vehicles").select("truck_number, trailer_number").eq("id", vehicleId).maybeSingle();
    truck   = v?.truck_number ?? "";
    trailer = v?.trailer_number ?? "";
  }

  // Plain GSM-7 only — no emoji or smart quotes, which would force UCS-2 and cut
  // the segment size from 153 chars to 67, doubling the cost of every send.
  // "Reply OK" matches the bot's existing two-stage protocol: OK marks it
  // acknowledged and auto-replies asking for DONE once the work is finished.
  const unit = truck ? ` for Truck #${truck}${trailer ? ` / Trailer #${trailer}` : ""}` : "";
  const msg  = `From Safety & Compliance: PM / oil change is due${unit}. `
             + `Please plan to get it done ASAP at any TA or Love's, `
             + `and double-check your brakes while you're there. Reply OK to confirm.`;

  const gv = await fetch(`${GV_SERVICE_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
    body: JSON.stringify({ to: ph.phone_number, body: msg }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, statusText: String(e) } as Response));

  // Audit alongside the bot's own reminders. 'pm_service' is already permitted
  // by the sms_notifications reminder_type CHECK constraint.
  await svc.from("sms_notifications").insert({
    vehicle_id: vehicleId || null,
    driver_id: driverId,
    reminder_type: "pm_service",
    phone_number: ph.phone_number,
    message_body: msg,
    status: gv.ok ? "sent" : "failed",
    sent_at: gv.ok ? new Date().toISOString() : null,
    error_message: gv.ok ? null : `gvoice send failed (manual send by ${user.email ?? user.id})`,
  });

  if (!gv.ok) return json({ ok: false, error: "SMS send failed" }, 502);

  try {
    const { data: dr } = await svc.from("drivers").select("name").eq("id", driverId).maybeSingle();
    bgRun(notifyDispatcher(svc, vehicleId || null, `FleetGuard - PM/oil change request sent to ${dr?.name ?? "driver"}${truck ? ` (Truck #${truck})` : ""}.`));
  } catch { /* non-fatal */ }

  return json({ ok: true, sentTo: maskPhone(ph.phone_number) });
});
