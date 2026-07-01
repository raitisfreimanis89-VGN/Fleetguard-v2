// driver-send-link — ADMIN-INITIATED ONLY. A logged-in admin (dispatcher app)
// texts a driver the pre-trip portal link. Verifies the caller's Supabase JWT is
// an admin, sends via gvoice, and writes an audit row. Deploy with --no-verify-jwt.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { preflight, json, maskPhone } from "../_shared/common.ts";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SERVICE_ROLE_KEY")!;
const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
const GV_SERVICE_URL = Deno.env.get("GV_SERVICE_URL")!;
const GV_SECRET      = Deno.env.get("GV_SERVICE_SECRET")!;
const PORTAL_BASE    = Deno.env.get("PORTAL_BASE_URL") ?? "https://fleetguards.app/driver";

const svc = createClient(SUPABASE_URL, SERVICE_KEY);

serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // --- caller must be an authenticated admin or dispatcher ---
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user }, error: uErr } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: "Unauthorized" }, 401);

  const { data: prof } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
  // Admin OR dispatcher may send (governance updated 2026-07-01). sent_by audit still records who.
  if (prof?.role !== "admin" && prof?.role !== "dispatcher") return json({ error: "Unauthorized" }, 403);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* ignore */ }
  const driverId  = String(b.driverId ?? "");
  const vehicleId = String(b.vehicleId ?? "");
  if (!driverId) return json({ error: "driverId required" }, 400);

  // Driver phone (respect hold).
  const { data: ph } = await svc.from("driver_phones").select("phone_number, sms_hold").eq("driver_id", driverId).maybeSingle();
  if (!ph?.phone_number) return json({ error: "Driver has no phone on file" }, 400);
  if (ph.sms_hold) return json({ error: "Driver's number is on SMS hold" }, 400);

  // Optional vehicle → prefill truck number in the link (page reads ?v=).
  let truck = "";
  if (vehicleId) {
    const { data: v } = await svc.from("vehicles").select("truck_number").eq("id", vehicleId).maybeSingle();
    truck = v?.truck_number ?? "";
  }

  const url = truck ? `${PORTAL_BASE}/${encodeURIComponent(truck)}` : PORTAL_BASE;
  const msg = `FleetGuard pre-trip${truck ? ` for Truck #${truck}` : ""}: tap to start your inspection ${url}`;

  const gv = await fetch(`${GV_SERVICE_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
    body: JSON.stringify({ to: ph.phone_number, body: msg }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, statusText: String(e) } as Response));

  // Audit every send (who/when/driver/vehicle).
  await svc.from("link_sends").insert({
    sent_by: user.id,
    sent_by_email: user.email ?? null,
    driver_id: driverId,
    vehicle_id: vehicleId || null,
    phone_masked: maskPhone(ph.phone_number),
    status: gv.ok ? "sent" : "failed",
    error_message: gv.ok ? null : "gvoice send failed",
  });

  if (!gv.ok) return json({ ok: false, error: "SMS send failed" }, 502);
  return json({ ok: true, sentTo: maskPhone(ph.phone_number) });
});
