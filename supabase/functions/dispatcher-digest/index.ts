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
const BRAKE = 35, SERVICE = 60, TYRE = 14;
const BRAKE_W = 5, SERVICE_W = 7, TYRE_W = 2;

const CLEAR: Array<(d: string, n: number) => string> = [
  (d, n) => `Good morning, ${d}! All ${n} trucks are up to date — no overdue inspections or services. Great job staying on top of it!`,
  (d, n) => `Good morning, ${d}! Fleet is looking good this morning — all ${n} trucks are compliant, nothing outstanding. Keep it up!`,
  (d, n) => `Good morning, ${d}! Clean sweep across all ${n} trucks — no overdue items and everything on schedule. Excellent work!`,
  (d, n) => `Good morning, ${d}! All ${n} trucks are on track — no overdue inspections, no pending services. Well done keeping the fleet clean!`,
];

type Row = {
  dispatcher_name: string; phone_number: string; truck_number: string;
  driver_name: string | null; on_vacation: boolean;
  brake_days: number | null; service_days: number | null; tyre_days: number | null;
  pti_yesterday: boolean;
};

function days(n: number): string { return `${n} day${n === 1 ? "" : "s"}`; }
function dueIn(n: number): string { return n === 0 ? "due today" : `due in ${days(n)}`; }

function buildMessage(disp: string, trucks: Row[]): string {
  const n = trucks.length;
  const overdueByTruck = new Map<string, string[]>();
  const soonByTruck    = new Map<string, string[]>();
  let ptiDone = 0;

  for (const t of trucks) {
    if (t.pti_yesterday) ptiDone++;
    if (t.on_vacation) continue;
    const { brake_days: b, service_days: s, tyre_days: y, truck_number: tn } = t;
    const od: string[] = [], sn: string[] = [];

    if (b != null && b > BRAKE)                od.push(`Brake inspection ${days(b - BRAKE)} overdue`);
    else if (b != null && b > BRAKE - BRAKE_W) sn.push(`Brake inspection ${dueIn(BRAKE - b)}`);

    if (s != null && s > SERVICE)                  od.push(`Yard inspection ${days(s - SERVICE)} overdue`);
    else if (s != null && s > SERVICE - SERVICE_W) sn.push(`Yard inspection ${dueIn(SERVICE - s)}`);

    if (y != null && y > TYRE)                od.push(`Tire check ${days(y - TYRE)} overdue`);
    else if (y != null && y > TYRE - TYRE_W)  sn.push(`Tire check ${dueIn(TYRE - y)}`);

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

  const byDisp = new Map<string, { phone: string; trucks: Row[] }>();
  for (const r of (rows ?? []) as Row[]) {
    if (!byDisp.has(r.dispatcher_name)) byDisp.set(r.dispatcher_name, { phone: r.phone_number, trucks: [] });
    byDisp.get(r.dispatcher_name)!.trucks.push(r);
  }

  // Compute only — the gvoice bot does the actual sending (paced through its
  // own queue), so this stays fast and never hits the function time limit.
  const messages: Array<{ dispatcher: string; to: string; body: string }> = [];
  for (const [disp, info] of byDisp) {
    messages.push({ dispatcher: disp, to: info.phone, body: buildMessage(disp, info.trucks) });
  }
  return json({ ok: true, dispatchers: byDisp.size, messages });
});
