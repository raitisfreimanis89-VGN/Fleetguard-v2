// pti-queue — bulk PTI link rollout, ADMIN-INITIATED, wave-drained.
// actions: preview | enqueue | cancel (admin JWT) · drain (bot, x-api-key).
// The bot's drain cron only DELIVERS rows an admin explicitly queued — it
// never decides to send on its own (governance: links are admin-initiated).
// Deploy with --no-verify-jwt (browser-called; auth enforced in-code).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { preflight, json, maskPhone } from "../_shared/common.ts";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SERVICE_ROLE_KEY")!;
const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
const GV_SERVICE_URL = Deno.env.get("GV_SERVICE_URL")!;
const GV_SECRET      = Deno.env.get("GV_SERVICE_SECRET")!;
const PORTAL_BASE    = Deno.env.get("PORTAL_BASE_URL") ?? "https://fleetguards.app/driver";
const WAVE_SIZE      = parseInt(Deno.env.get("PTI_WAVE_SIZE") ?? "5", 10);
const RECENT_DAYS    = parseInt(Deno.env.get("PTI_RECENT_DAYS") ?? "3", 10);
const MAX_ATTEMPTS   = 3;

const svc = createClient(SUPABASE_URL, SERVICE_KEY);

async function requireAdmin(req: Request): Promise<{ id: string; email: string | null } | Response> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (prof?.role !== "admin") return json({ error: "Admins only" }, 403);
  return { id: user.id, email: user.email ?? null };
}

// Skip rules agreed 2026-06-11: vacation, PTI within RECENT_DAYS, sms_hold,
// no phone, no assigned truck, already pending in the queue.
async function eligibility() {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
  const [dr, ph, ve, insp, q] = await Promise.all([
    svc.from("drivers").select("id, name, on_vacation"),
    svc.from("driver_phones").select("driver_id, phone_number, sms_hold"),
    svc.from("vehicles").select("id, truck_number, assigned_driver_id"),
    svc.from("inspections").select("driver_id").gte("submitted_at", since),
    svc.from("pti_send_queue").select("driver_id").eq("status", "pending"),
  ]);
  const errs = [dr, ph, ve, insp, q].map((r) => r.error?.message).filter(Boolean);
  if (errs.length) throw new Error("DB read failed: " + errs.join("; "));

  const phones = new Map((ph.data ?? []).map((p) => [p.driver_id, p]));
  const vehByDriver = new Map<string, { id: string; truck_number: string }>();
  (ve.data ?? []).forEach((v) => {
    if (v.assigned_driver_id) vehByDriver.set(v.assigned_driver_id, { id: v.id, truck_number: v.truck_number });
  });
  const recent = new Set((insp.data ?? []).map((i) => i.driver_id));
  const queued = new Set((q.data ?? []).map((r) => r.driver_id));

  const skipped = { vacation: 0, recentPTI: 0, smsHold: 0, noPhone: 0, noVehicle: 0, alreadyQueued: 0 };
  const eligible: { driver_id: string; name: string; vehicle_id: string; truck_number: string; phone: string }[] = [];
  for (const d of dr.data ?? []) {
    if (d.on_vacation)        { skipped.vacation++;      continue; }
    if (recent.has(d.id))     { skipped.recentPTI++;     continue; }
    const p = phones.get(d.id);
    if (!p?.phone_number)     { skipped.noPhone++;       continue; }
    if (p.sms_hold)           { skipped.smsHold++;       continue; }
    const v = vehByDriver.get(d.id);
    if (!v?.truck_number)     { skipped.noVehicle++;     continue; }
    if (queued.has(d.id))     { skipped.alreadyQueued++; continue; }
    eligible.push({ driver_id: d.id, name: d.name, vehicle_id: v.id, truck_number: v.truck_number, phone: p.phone_number });
  }
  return { total: (dr.data ?? []).length, eligible, skipped };
}

// One wave: oldest pending rows, sent sequentially through the bot's FIFO.
// Status flips right after each send so a mid-run crash leaves consistent
// rows ('pending' rows simply ride the next wave; attempts caps retries).
async function drain(): Promise<Response> {
  const t0 = Date.now();
  await svc.from("pti_send_queue")
    .update({ status: "failed", last_error: "max attempts reached" })
    .eq("status", "pending").gte("attempts", MAX_ATTEMPTS);

  const { data: rows, error } = await svc.from("pti_send_queue")
    .select("id, driver_id, vehicle_id, phone, truck_number, queued_by, queued_by_email, attempts")
    .eq("status", "pending").lt("attempts", MAX_ATTEMPTS)
    .order("queued_at", { ascending: true }).limit(WAVE_SIZE);
  if (error) return json({ ok: false, error: error.message }, 500);

  let sent = 0, failed = 0;
  for (const r of rows ?? []) {
    if (Date.now() - t0 > 100_000) break; // function wall-clock guard — rest rides the next wave
    await svc.from("pti_send_queue").update({ attempts: r.attempts + 1 }).eq("id", r.id);

    const url = `${PORTAL_BASE}/${encodeURIComponent(r.truck_number)}`;
    const msg = `FleetGuard pre-trip for Truck #${r.truck_number}: tap to start your inspection ${url}`;
    let ok = false, errMsg = "";
    try {
      const gv = await fetch(`${GV_SERVICE_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
        body: JSON.stringify({ to: r.phone, body: msg }),
        signal: AbortSignal.timeout(90_000),
      });
      ok = gv.ok;
      if (!ok) errMsg = `gvoice HTTP ${gv.status}`;
    } catch (e) { errMsg = String(e); }

    const final = ok ? "sent" : (r.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending");
    await svc.from("pti_send_queue").update({
      status: final,
      sent_at: ok ? new Date().toISOString() : null,
      last_error: ok ? null : errMsg,
    }).eq("id", r.id);

    // every delivery attempt lands in the same audit trail as single sends
    await svc.from("link_sends").insert({
      sent_by: r.queued_by, sent_by_email: r.queued_by_email,
      driver_id: r.driver_id, vehicle_id: r.vehicle_id,
      phone_masked: maskPhone(r.phone),
      status: ok ? "sent" : "failed",
      error_message: ok ? null : ("bulk: " + errMsg),
    });
    if (ok) sent++; else if (final === "failed") failed++;
  }

  const { count } = await svc.from("pti_send_queue")
    .select("id", { count: "exact", head: true }).eq("status", "pending");
  return json({ ok: true, sent, failed, remaining: count ?? 0 });
}

serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* ignore */ }
  const action = String(b.action ?? "");

  if (action === "drain") {
    if (req.headers.get("x-api-key") !== GV_SECRET) return json({ error: "Unauthorized" }, 401);
    try { return await drain(); } catch (e) { return json({ ok: false, error: String(e) }, 500); }
  }

  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  try {
    if (action === "preview") {
      const { total, eligible, skipped } = await eligibility();
      return json({ ok: true, total, eligible: eligible.length, names: eligible.map((e) => e.name), skipped });
    }
    if (action === "enqueue") {
      const { total, eligible, skipped } = await eligibility();
      if (eligible.length) {
        const { error } = await svc.from("pti_send_queue").insert(eligible.map((e) => ({
          driver_id: e.driver_id, vehicle_id: e.vehicle_id, phone: e.phone,
          truck_number: e.truck_number, queued_by: admin.id, queued_by_email: admin.email,
        })));
        if (error) return json({ ok: false, error: error.message }, 500);
      }
      return json({ ok: true, total, queued: eligible.length, skipped });
    }
    if (action === "cancel") {
      const { data, error } = await svc.from("pti_send_queue").delete().eq("status", "pending").select("id");
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, cancelled: (data ?? []).length });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
