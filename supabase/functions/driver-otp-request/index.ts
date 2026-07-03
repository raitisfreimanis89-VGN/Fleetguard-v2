// driver-otp-request — driver enters their cell number on the portal; we text
// a one-time code IF the number is on file. Always responds generically
// (never reveals whether a number exists). Deploy with --no-verify-jwt.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { preflight, json, normalizePhone, sha256Hex, sixDigitCode, bgRun } from "../_shared/common.ts";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SERVICE_ROLE_KEY")!;
const GV_SERVICE_URL = Deno.env.get("GV_SERVICE_URL")!;
const GV_SECRET      = Deno.env.get("GV_SERVICE_SECRET")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const phone = normalizePhone(String(body.phone ?? ""));
  // Generic success response — used for every branch so callers can't enumerate.
  const generic = json({ ok: true });
  if (!phone) return generic;

  try {
    // 1. Must correspond to a driver on file, and not be on SMS hold.
    const { data: ph } = await sb
      .from("driver_phones")
      .select("phone_number, sms_hold")
      .eq("phone_number", phone)
      .maybeSingle();
    if (!ph || ph.sms_hold) return generic;

    // 2. Throttle: ignore if a code was issued in the last 30 s.
    const since = new Date(Date.now() - 30_000).toISOString();
    const { data: recent } = await sb
      .from("driver_otp_codes")
      .select("id")
      .eq("phone", phone)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();
    if (recent) return generic;

    // 3. Generate + store hashed code (5-min TTL).
    const code = sixDigitCode();
    const code_hash = await sha256Hex(`${phone.toLowerCase()}:${code}`);
    const expires_at = new Date(Date.now() + 5 * 60_000).toISOString();
    await sb.from("driver_otp_codes").insert({ phone, code_hash, expires_at });

    // 4. Fire the GV send in the background — respond to the portal immediately
    // so the code-entry screen appears without waiting ~25s for the SMS to send.
    const smsBody = `FleetGuard code: ${code}\nExpires in 5 min. Do not share.`;
    bgRun(fetch(`${GV_SERVICE_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
      body: JSON.stringify({ to: phone, body: smsBody }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => {}));
  } catch (_e) {
    /* swallow all errors — response stays generic */
  }
  return generic;
});
