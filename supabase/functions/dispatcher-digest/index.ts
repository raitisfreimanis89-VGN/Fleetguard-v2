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
  (d, n) => `Good morning, ${d} - all ${n} trucks current and every pre-trip in. Great work keeping it clean; keep it up!`,
  (d, n) => `${d}, your fleet's in top shape this morning - all ${n} trucks green, nothing outstanding. Solid work staying ahead of it.`,
  (d, n) => `All clear across ${d}'s ${n} trucks - no overdue items, pre-trips done. Excellent management; keep it rolling.`,
  (d, n) => `Morning ${d} - ${n} trucks, all compliant, nothing due. That's what staying on top of it looks like. Keep it up!`,
];

type Row = {
  dispatcher_name: string; phone_number: string; truck_number: string;
  driver_name: string | null; on_vacation: boolean;
  brake_days: number | null; service_days: number | null; tyre_days: number | null;
  pti_yesterday: boolean;
};

function buildMessage(disp: string, trucks: Row[]): string {
  const n = trucks.length;
  const overdue: string[] = [], soon: string[] = [];   // one entry per truck, items grouped
  let ptiDone = 0;
  for (const t of trucks) {
    if (t.pti_yesterday) ptiDone++;
    if (t.on_vacation) continue;                       // vacation trucks are frozen
    const { brake_days: b, service_days: s, tyre_days: y, truck_number: tn } = t;
    const od: string[] = [], sn: string[] = [];
    if (b != null && b > BRAKE)            od.push(`brake ${b - BRAKE}d`);
    else if (b != null && b > BRAKE - BRAKE_W)     sn.push(`brake in ${BRAKE - b}d`);
    if (s != null && s > SERVICE)          od.push(`yard ${s - SERVICE}d`);
    else if (s != null && s > SERVICE - SERVICE_W) sn.push(`yard in ${SERVICE - s}d`);
    if (y != null && y > TYRE)             od.push(`tyre ${y - TYRE}d`);
    else if (y != null && y > TYRE - TYRE_W)       sn.push(`tyre in ${TYRE - y}d`);
    if (od.length) overdue.push(`#${tn} ${od.join("/")}`);
    if (sn.length) soon.push(`#${tn} ${sn.join("/")}`);
  }
  const ptiLine = ptiDone ? ` Yesterday: ${ptiDone} pre-trip${ptiDone === 1 ? "" : "s"} completed.` : "";
  if (overdue.length === 0 && soon.length === 0) {
    return CLEAR[new Date().getUTCDate() % CLEAR.length](disp, n) + ptiLine;
  }
  let msg = `Good morning - ${disp}'s fleet (${n} trucks).`;
  if (overdue.length) msg += ` OVERDUE: ${overdue.join("; ")}.`;
  if (soon.length)    msg += ` Due soon: ${soon.join("; ")}.`;
  return msg + ptiLine + " Plan your follow-ups accordingly.";
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
