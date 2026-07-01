// Shared helpers for FleetGuard driver-portal Edge Functions.
// These functions are called from the browser (fleetguards.app), so CORS is required.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Returns a preflight Response for OPTIONS, else null. */
export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return null;
}

/** JSON response with CORS headers. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export const E164 = /^\+[1-9]\d{7,14}$/;

/** Normalize a user-entered phone to E.164 (assumes US for bare 10-digit). */
export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  let p = String(raw).trim().replace(/[()\s.\-]/g, "");
  if (/^\d{10}$/.test(p)) p = "+1" + p;        // bare US 10-digit
  else if (/^1\d{10}$/.test(p)) p = "+" + p;   // 1 + 10-digit
  else if (!p.startsWith("+")) p = "+" + p;
  return E164.test(p) ? p : null;
}

/** Mask a phone for display/audit, e.g. (•••) •••-2302. */
export function maskPhone(p: string): string {
  const d = String(p).replace(/\D/g, "");
  return d.length >= 4 ? `(•••) •••-${d.slice(-4)}` : p;
}

/** Hex SHA-256 of a string (used to hash OTP codes — never store raw). */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cryptographically-strong 6-digit numeric code. */
export function sixDigitCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

/**
 * Notify the dispatcher assigned to a vehicle. Resolves vehicle → assigned
 * dispatcher → dispatcher_phones (respecting sms_hold) and texts via the gvoice
 * bot. Never throws — dispatcher notifications must never break the main flow.
 */
export async function notifyDispatcher(sb: any, vehicleId: string | null, message: string): Promise<void> {
  try {
    if (!vehicleId) return;
    const GV_URL = Deno.env.get("GV_SERVICE_URL");
    const GV_SECRET = Deno.env.get("GV_SERVICE_SECRET");
    if (!GV_URL || !GV_SECRET) return;
    const { data: v } = await sb.from("vehicles").select("assigned_dispatcher").eq("id", vehicleId).maybeSingle();
    const disp = (v?.assigned_dispatcher ?? "").trim();
    if (!disp) return;
    const { data: dp } = await sb.from("dispatcher_phones").select("phone_number, sms_hold").eq("dispatcher_name", disp).maybeSingle();
    if (!dp?.phone_number || dp.sms_hold) return;
    await fetch(`${GV_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
      body: JSON.stringify({ to: dp.phone_number, body: message }),
      signal: AbortSignal.timeout(90_000),
    }).catch(() => {});
  } catch { /* swallow — never block the caller */ }
}

/** Run a promise in the background (Edge Runtime) so it never delays the response. */
export function bgRun(p: Promise<unknown>): void {
  const wu = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof wu === "function") wu(p);
  else (p as Promise<unknown>).catch(() => {});
}
