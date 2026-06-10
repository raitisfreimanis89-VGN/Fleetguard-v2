// driver-inspection — receives a completed pre-trip from the portal (driver JWT),
// uploads photos/signature, writes inspections (+ tyre_records, mileage_records for
// dispatcher back-compat), and texts a confirmation. Deploy with --no-verify-jwt.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { preflight, json } from "../_shared/common.ts";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SERVICE_ROLE_KEY")!;
const GV_SERVICE_URL = Deno.env.get("GV_SERVICE_URL")!;
const GV_SECRET      = Deno.env.get("GV_SERVICE_SECRET")!;
const JWT_SECRET     = Deno.env.get("DRIVER_JWT_SECRET")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const key = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(JWT_SECRET),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
);

const DATA_URL = /^data:(image\/[a-z]+);base64,(.+)$/i;

async function uploadDataUrl(path: string, dataUrl: string): Promise<string | null> {
  try {
    const m = DATA_URL.exec(dataUrl);
    if (!m) return null;
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const { error } = await sb.storage
      .from("inspection-photos")
      .upload(path, new Blob([bytes], { type: m[1] }), { contentType: m[1], upsert: true });
    return error ? null : path;
  } catch { return null; }
}

serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // --- verify driver session token ---
  const auth = req.headers.get("Authorization") ?? "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  let driverId = "";
  try {
    const p = await verify(tok, key);
    driverId = String(p.sub ?? "");
    if (p.role !== "driver" || !driverId) throw new Error("bad token");
  } catch {
    return json({ error: "Unauthorized" }, 401);
  }

  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  const inspectionId = String(b.inspectionId ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inspectionId)) {
    return json({ error: "Missing/invalid inspectionId" }, 400);
  }

  // Idempotency: if already saved, return the existing ref (offline-retry safe).
  const { data: existing } = await sb.from("inspections").select("ref").eq("id", inspectionId).maybeSingle();
  if (existing) return json({ ok: true, ref: existing.ref });

  // Resolve vehicle (prefer explicit id, else by truck number).
  let vehicleId: string | null = b.vehicleId ?? null;
  if (!vehicleId && b.truckNumber) {
    const { data: veh } = await sb.from("vehicles").select("id").eq("truck_number", String(b.truckNumber)).maybeSingle();
    vehicleId = veh?.id ?? null;
  }

  const tyres  = Array.isArray(b.tyres)  ? b.tyres  : [];
  const checks = Array.isArray(b.checks) ? b.checks : [];
  const tyresFlagged = tyres.filter((t: any) => t.rating === "fail" || t.pressure === "low").length;
  const checksFailed = checks.filter((c: any) => c.result === "fail").length;
  const critical = checks.some((c: any) => c.result === "fail" && (c.severity === "Critical" || c.severity === "Major"))
                || tyres.some((t: any) => t.rating === "fail");
  const overall = critical ? "defect" : (tyresFlagged || checksFailed) ? "minor" : "roadworthy";

  // Stable, unique ref derived from the (uuid) inspectionId.
  const ref = "FG-INSP-" + inspectionId.replace(/-/g, "").slice(0, 6).toUpperCase();

  // Upload signature + any photos to private storage; keep paths in details.
  let signatureUrl: string | null = null;
  if (typeof b.signature === "string" && b.signature.startsWith("data:")) {
    signatureUrl = await uploadDataUrl(`${inspectionId}/signature.png`, b.signature);
  }
  const details: { tyres: any[]; checks: any[] } = { tyres: [], checks: [] };
  for (let i = 0; i < tyres.length; i++) {
    const t = { ...tyres[i] };
    if (typeof t.photo === "string" && t.photo.startsWith("data:")) {
      t.photoUrl = await uploadDataUrl(`${inspectionId}/tyre-${i}.jpg`, t.photo);
    }
    delete t.photo;
    details.tyres.push(t);
  }
  for (let i = 0; i < checks.length; i++) {
    const c = { ...checks[i] };
    if (typeof c.photo === "string" && c.photo.startsWith("data:")) {
      c.photoUrl = await uploadDataUrl(`${inspectionId}/check-${c.id || i}.jpg`, c.photo);
    }
    delete c.photo;
    details.checks.push(c);
  }

  // Insert the inspection record.
  const { error: insErr } = await sb.from("inspections").insert({
    id: inspectionId,
    ref,
    vehicle_id: vehicleId,
    driver_id: driverId,
    truck_number: b.truckNumber ?? null,
    trailer_number: b.trailerNumber ?? null,
    started_at: b.startedAt ?? null,
    duration_sec: typeof b.durationSec === "number" ? b.durationSec : null,
    odometer: typeof b.odometer === "number" ? b.odometer : null,
    gps_lat: b.gps?.lat ?? null,
    gps_lng: b.gps?.lng ?? null,
    gps_accuracy: b.gps?.acc ?? null,
    overall_result: overall,
    tyres_flagged: tyresFlagged,
    checks_failed: checksFailed,
    signature_url: signatureUrl,
    notes: b.finalNotes ?? null,
    details,
  });
  if (insErr) return json({ error: "Save failed", detail: insErr.message }, 500);

  // Back-compat writes for existing dispatcher views (best-effort).
  try {
    if (vehicleId && tyres.length) {
      const readings = tyres.map((t: any) => ({
        axleIndex: t.axleIndex, position: t.position, status: t.status,
        rating: t.rating, pressure: t.pressure ?? null,
      }));
      const photoDate = String(b.startedAt ?? new Date().toISOString()).split("T")[0];
      await sb.from("tyre_records").insert({ id: crypto.randomUUID(), vehicle_id: vehicleId, photo_date: photoDate, readings });
    }
    if (vehicleId && typeof b.odometer === "number" && b.odometer > 0) {
      await sb.from("mileage_records").insert({
        id: crypto.randomUUID(), vehicle_id: vehicleId, driver_id: driverId,
        mileage: b.odometer, date: new Date().toISOString().split("T")[0],
      });
    }
  } catch { /* non-fatal */ }

  // Confirmation SMS (best-effort).
  try {
    const { data: ph } = await sb.from("driver_phones").select("phone_number, sms_hold").eq("driver_id", driverId).maybeSingle();
    if (ph?.phone_number && !ph.sms_hold) {
      const msg = `FleetGuard: pre-trip received for Truck #${b.truckNumber ?? "—"} (Ref ${ref}).`
        + (overall !== "roadworthy" ? " Defects noted — dispatch has been alerted." : " All good — drive safe.");
      await fetch(`${GV_SERVICE_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
        body: JSON.stringify({ to: ph.phone_number, body: msg }),
        signal: AbortSignal.timeout(60_000),
      }).catch(() => {});
    }
  } catch { /* non-fatal */ }

  return json({ ok: true, ref });
});
