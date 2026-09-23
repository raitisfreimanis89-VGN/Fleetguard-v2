// driver-apply - PUBLIC. A driver on the recruiting page (fleetguards.app/vgn/)
// submits the callback form. We save the FULL lead to driver_leads (service role)
// and text a SHORT heads-up to recruiting via the gvoice bot. No user auth (public
// form) - protected by a honeypot, validation, and a per-phone rate limit.
// Self-contained (no ../_shared import) so it deploys as a single file.
// Deploy with verify_jwt = false.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const E164 = /^\+[1-9]\d{7,14}$/;
function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  let p = String(raw).trim().replace(/[()\s.\-]/g, "");
  if (/^\d{10}$/.test(p)) p = "+1" + p;
  else if (/^1\d{10}$/.test(p)) p = "+" + p;
  else if (!p.startsWith("+")) p = "+" + p;
  return E164.test(p) ? p : null;
}

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SERVICE_ROLE_KEY")!;
const GV_SERVICE_URL = Deno.env.get("GV_SERVICE_URL")!;
const GV_SECRET      = Deno.env.get("GV_SERVICE_SECRET")!;
const RECRUIT_PHONE  = Deno.env.get("RECRUIT_LEAD_PHONE") ?? "+17082328523";

const svc = createClient(SUPABASE_URL, SERVICE_KEY);
const clip = (v: unknown, n: number) => (v == null ? "" : String(v)).trim().slice(0, n);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  // Honeypot: real users never fill the hidden 'company' field. Bots do.
  if (clip(b.company, 100)) return json({ ok: true });

  const full_name = clip(b.full_name, 120);
  const phoneRaw  = clip(b.phone, 40);
  const phone     = normalizePhone(phoneRaw);
  const cdl_experience = clip(b.cdl_experience, 60);
  const sap       = clip(b.sap, 60);
  const best_time = clip(b.best_time, 160);
  const consent   = b.consent === true || b.consent === "true" || b.consent === "on";

  if (!full_name || !phone) return json({ error: "Please enter your name and a valid phone number." }, 400);
  if (!consent) return json({ error: "Please check the consent box so we can contact you." }, 400);

  // Rate limit: at most 3 submissions per phone in 10 minutes.
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await svc.from("driver_leads")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone).gte("created_at", since);
  if ((count ?? 0) >= 3) return json({ ok: true });

  // Save the full lead first, so nothing is lost even if the SMS bot is down.
  const { data: lead, error: insErr } = await svc.from("driver_leads").insert({
    full_name, phone, cdl_experience, sap, best_time, consent,
    source: clip(b.source, 60) || "vgn-jobs",
    ua: clip(req.headers.get("user-agent"), 200),
  }).select("id").single();
  if (insErr) return json({ error: "Could not save right now - please call instead." }, 500);

  // Short heads-up to recruiting (under Google Voice's 153-char single-segment limit).
  const expBit = cdl_experience ? ` - ${cdl_experience}` : "";
  const msg = clip(`New driver lead: ${full_name}, ${phoneRaw}${expBit}. Full details in Leads.`, 150);
  const gv = await fetch(`${GV_SERVICE_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
    body: JSON.stringify({ to: RECRUIT_PHONE, body: msg }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, statusText: String(e) } as Response));

  await svc.from("driver_leads").update({ sms_status: gv.ok ? "sent" : "failed" }).eq("id", lead.id);

  return json({ ok: true });
});
