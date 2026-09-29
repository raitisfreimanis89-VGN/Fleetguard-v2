// track-view - PUBLIC. Logs one page view for the recruiting site. Called as a
// fire-and-forget beacon from fleetguards.app/vgn/ on load. Inserts via service
// role into page_views. verify_jwt = false. Self-contained.
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: true });

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* beacon may send empty body */ }

  const ua = clip(req.headers.get("user-agent"), 200);
  // Skip obvious crawlers so they don't inflate visit counts.
  if (/bot|spider|crawl|slurp|bing|preview|favicon|monitor|headless/i.test(ua)) return json({ ok: true });

  await svc.from("page_views").insert({
    path: clip(b.path, 200) || "/vgn/",
    referrer: clip(b.ref, 300),
    ua,
  });
  return json({ ok: true });
});
