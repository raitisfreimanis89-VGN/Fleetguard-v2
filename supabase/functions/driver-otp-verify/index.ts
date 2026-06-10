// driver-otp-verify — verify the 6-digit code and, on success, mint a short-lived
// driver session JWT (drivers are NOT Supabase Auth users). Deploy with --no-verify-jwt.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { preflight, json, normalizePhone, sha256Hex } from "../_shared/common.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SERVICE_ROLE_KEY")!;
const JWT_SECRET   = Deno.env.get("DRIVER_JWT_SECRET")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const key = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(JWT_SECRET),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
);

serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const phone = normalizePhone(String(body.phone ?? ""));
  const code  = String(body.code ?? "").replace(/\D/g, "");
  if (!phone || code.length !== 6) return json({ ok: false }, 400);

  // Newest unconsumed code for this phone.
  const { data: row } = await sb
    .from("driver_otp_codes")
    .select("*")
    .eq("phone", phone)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return json({ ok: false }, 401);
  if (new Date(row.expires_at) < new Date()) return json({ ok: false }, 401);
  if (row.attempts >= 5) return json({ ok: false, error: "too_many_attempts" }, 429);

  const hash = await sha256Hex(`${phone.toLowerCase()}:${code}`);
  if (hash !== row.code_hash) {
    await sb.from("driver_otp_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return json({ ok: false }, 401);
  }

  // Success — consume the code so it can't be reused.
  await sb.from("driver_otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", row.id);

  // Resolve driver + assigned vehicles.
  const { data: ph } = await sb.from("driver_phones").select("driver_id").eq("phone_number", phone).maybeSingle();
  const driverId = ph?.driver_id as string | undefined;
  if (!driverId) return json({ ok: false }, 401);

  await sb.from("driver_phones").update({ verified: true }).eq("driver_id", driverId);

  const { data: driver }   = await sb.from("drivers").select("id, name").eq("id", driverId).maybeSingle();
  const { data: vehicles } = await sb.from("vehicles")
    .select("id, truck_number, trailer_number")
    .eq("assigned_driver_id", driverId);

  const token = await create(
    { alg: "HS256", typ: "JWT" },
    { sub: driverId, name: driver?.name ?? "", role: "driver", exp: getNumericDate(60 * 60 * 12) },
    key,
  );

  return json({
    ok: true,
    token,
    driver: { id: driverId, name: driver?.name ?? "" },
    vehicles: (vehicles ?? []).map((v) => ({
      id: v.id, truckNumber: v.truck_number, trailerNumber: v.trailer_number,
    })),
  });
});
