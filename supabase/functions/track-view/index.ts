// track-view - PUBLIC. First-party analytics for the recruiting site.
//  * Load beacon  {path, ref, vid}       -> INSERT a visit row (bot-filtered).
//  * Leave beacon {vid, dwell_ms}         -> UPDATE that row's time-on-page.
// verify_jwt = false. Self-contained.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SERVICE_ROLE_KEY")!;
const svc = createClient(SUPABASE_URL, SERVICE_KEY);
const clip = (v: unknown, n: number) => (v == null ? "" : String(v)).trim().slice(0, n);
const MAX_DWELL = 30 * 60 * 1000; // cap idle tabs at 30 min

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: true });

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* beacon may send empty body */ }

  const vid = clip(b.vid, 64);

  // Leave beacon: record how long they stayed (largest value wins).
  if (b.dwell_ms != null && vid) {
    let dwell = Math.round(Number(b.dwell_ms));
    if (!Number.isFinite(dwell) || dwell < 0) dwell = 0;
    if (dwell > MAX_DWELL) dwell = MAX_DWELL;
    await svc.from("page_views").update({ dwell_ms: dwell }).eq("vid", vid);
    return json({ ok: true });
  }

  // Load beacon: log the visit (skip obvious crawlers).
  const ua = clip(req.headers.get("user-agent"), 200);
  if (/bot|spider|crawl|slurp|bing|preview|favicon|monitor|headless/i.test(ua)) return json({ ok: true });

  await svc.from("page_views").insert({
    path: clip(b.path, 200) || "/vgn/",
    referrer: clip(b.ref, 300),
    ua,
    vid: vid || null,
    source: clip(b.source, 60) || null,
  });
  return json({ ok: true });
});
