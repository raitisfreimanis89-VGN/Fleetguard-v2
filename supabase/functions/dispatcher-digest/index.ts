// dispatcher-digest — one morning summary per dispatcher (fired 7:15 CST by the
// gvoice bot cron). Overdue/due snapshot for planning; a rotating "keep it up"
// message when a fleet is all-clear. POST {dryRun:true} returns the messages
// without sending. Auth: x-api-key = GV_SERVICE_SECRET. Deploy --no-verify-jwt.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json } from "../_shared/common.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SERVICE_ROLE_KEY")!;
const GV_URL       = Deno.env.get("GV_SERVICE_URL")!;
const GV_SECRET    = Deno.env.get("GV_SERVICE_SECRET")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Overdue thresholds (days) + warning windows, matching the reminder cadence.
// LAST-RESORT fallbacks only. Resolution order is: this truck's own row, then
// the fleet default row in reminder_schedules (vehicle_id IS NULL), then these.
// Until 2026-07-29 these constants WERE the policy here, and they had drifted
// from the dashboard — brakes 35 vs 42, tyres 14 vs 7 — so dispatchers were told
// a truck was fine for another week after the board had flagged it.
const BRAKE = 30, SERVICE = 90, TYRE = 7;
const BRAKE_W = 7, SERVICE_W = 7, TYRE_W = 2;

const CLEAR: Array<(d: string, n: number) => string> = [
  (d, n) => `Good morning, ${d}! All ${n} trucks are up to date — no overdue inspections or services. Great job staying on top of it!`,
  (d, n) => `Good morning, ${d}! Fleet is looking good this morning — all ${n} trucks are compliant, nothing outstanding. Keep it up!`,
  (d, n) => `Good morning, ${d}! Clean sweep across all ${n} trucks — no overdue items and everything on schedule. Excellent work!`,
  (d, n) => `Good morning, ${d}! All ${n} trucks are on track — no overdue inspections, no pending services. Well done keeping the fleet clean!`,
];

type Row = {
  dispatcher_name: string; phone_number: string; vehicle_id: string; truck_number: string;
  driver_name: string | null; on_vacation: boolean;
  brake_days: number | null; service_days: number | null; tyre_days: number | null;
  pti_yesterday: boolean;
};

// Per-vehicle interval overrides: vehicle_id -> { reminder_type: interval_days }.
// A truck without its own row falls back to the fleet default row, then to the
// constants above.
type SchedMap = Map<string, Record<string, number>>;

function days(n: number): string { return `${n} day${n === 1 ? "" : "s"}`; }
function dueIn(n: number): string { return n === 0 ? "due today" : `due in ${days(n)}`; }

// Returns null when the dispatcher has no active trucks — the caller skips them
// rather than sending "All 0 trucks are up to date".
function buildMessage(disp: string, trucks: Row[], sched: SchedMap, fleet: Record<string, number>): string | null {
  // Trucks on vacation are excluded outright. They were already skipped for
  // overdue items, but still counted toward the header total and the pre-trip
  // ratio — so a dispatcher with 2 of 8 parked up read "(8 trucks)" and
  // "3 of 8 completed" when only 6 could ever have completed one.
  const active = trucks.filter((t) => !t.on_vacation);
  if (active.length === 0) return null;

  const n = active.length;
  const overdueByTruck = new Map<string, string[]>();
  const soonByTruck    = new Map<string, string[]>();
  let ptiDone = 0;

  for (const t of active) {
    if (t.pti_yesterday) ptiDone++;
    const { brake_days: b, service_days: s, tyre_days: y, truck_number: tn } = t;
    const od: string[] = [], sn: string[] = [];

    // Truck's own row -> fleet default row -> constant. Same chain the dashboard
    // and the SMS bot use, so all three agree on when a truck is overdue.
    const ov = sched.get(t.vehicle_id) ?? {};
    const BR = ov.brake_service  ?? fleet.brake_service  ?? BRAKE;
    const SV = ov.dot_inspection ?? fleet.dot_inspection ?? SERVICE;
    const TY = ov.tyre_check     ?? fleet.tyre_check     ?? TYRE;

    if (b != null && b > BR)             od.push(`Brake inspection ${days(b - BR)} overdue`);
    else if (b != null && b > BR - BRAKE_W) sn.push(`Brake inspection ${dueIn(BR - b)}`);

    if (s != null && s > SV)               od.push(`Yard inspection ${days(s - SV)} overdue`);
    else if (s != null && s > SV - SERVICE_W) sn.push(`Yard inspection ${dueIn(SV - s)}`);

    if (y != null && y > TY)            od.push(`Tire check ${days(y - TY)} overdue`);
    else if (y != null && y > TY - TYRE_W) sn.push(`Tire check ${dueIn(TY - y)}`);

    if (od.length) overdueByTruck.set(tn, od);
    if (sn.length) soonByTruck.set(tn, sn);
  }

  const ptiLine = ptiDone
    ? `\nPre-trip inspections yesterday: ${ptiDone} of ${n} completed.`
    : "";

  if (overdueByTruck.size === 0 && soonByTruck.size === 0) {
    return CLEAR[new Date().getUTCDate() % CLEAR.length](disp, n) + ptiLine;
  }

  let msg = `Good morning, ${disp} - fleet report (${n} trucks).`;

  if (overdueByTruck.size > 0) {
    msg += `\n\nACTION REQUIRED:\n`;
    for (const [tn, items] of overdueByTruck) {
      msg += `Truck #${tn}: ${items.join(", ")}\n`;
    }
  }

  if (soonByTruck.size > 0) {
    msg += `\nCOMING UP:\n`;
    for (const [tn, items] of soonByTruck) {
      msg += `Truck #${tn}: ${items.join(", ")}\n`;
    }
  }

  return msg + `\nPlease follow up with your drivers today.` + ptiLine;
}

serve(async (req) => {
  if (req.headers.get("x-api-key") !== GV_SECRET) return json({ error: "Unauthorized" }, 401);

  const { data: rows, error } = await sb.rpc("dispatcher_digest_data");
  if (error) return json({ ok: false, error: error.message }, 500);

  // Vehicle-specific interval overrides. A failed fetch is non-fatal: the map
  // stays empty and every truck falls back to the fleet constants.
  const sched: SchedMap = new Map();
  // The view has already resolved any new-truck ladder to today's interval.
  const { data: schedRows } = await sb
    .from("vehicle_effective_schedules")
    .select("vehicle_id,reminder_type,interval_days,enabled")
    .eq("enabled", true);
  for (const s of schedRows ?? []) {
    if (!(s.interval_days > 0)) continue;
    const m = sched.get(s.vehicle_id) ?? {};
    m[s.reminder_type] = s.interval_days;
    sched.set(s.vehicle_id, m);
  }

  // Fleet defaults — the same rows the SMS bot reads, so the digest can no
  // longer disagree with it about when something is due.
  const fleet: Record<string, number> = {};
  const { data: fleetRows } = await sb
    .from("reminder_schedules")
    .select("reminder_type,interval_days,enabled")
    .is("vehicle_id", null)
    .eq("enabled", true);
  for (const f of fleetRows ?? []) {
    if (f.interval_days > 0) fleet[f.reminder_type] = f.interval_days;
  }

  const byDisp = new Map<string, { phone: string; trucks: Row[] }>();
  for (const r of (rows ?? []) as Row[]) {
    if (!byDisp.has(r.dispatcher_name)) byDisp.set(r.dispatcher_name, { phone: r.phone_number, trucks: [] });
    byDisp.get(r.dispatcher_name)!.trucks.push(r);
  }

  // Compute only — the gvoice bot does the actual sending (paced through its
  // own queue), so this stays fast and never hits the function time limit.
  const messages: Array<{ dispatcher: string; to: string; body: string }> = [];
  for (const [disp, info] of byDisp) {
    const body = buildMessage(disp, info.trucks, sched, fleet);
    if (!body) continue;   // every truck on vacation — nothing worth texting
    messages.push({ dispatcher: disp, to: info.phone, body });
  }
  return json({ ok: true, dispatchers: byDisp.size, messages });
});
