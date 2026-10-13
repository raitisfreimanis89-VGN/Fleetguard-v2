// prune-photos — storage retention for PTI tyre photos.
//
// WHY: the inspection-photos bucket reached 984 MB of a 1 GB free-tier limit
// (5,991 files), at which point PTI photo uploads start failing outright. Tyre
// photos are 973 MB of that — they are the fleet's own verification that the
// depth readings are honest, NOT a DOT record, and the readings themselves live
// permanently in tyre_records regardless.
//
// WHAT IT NEVER TOUCHES:
//   signature.png  — 49 CFR 396.11 requires a SIGNED driver vehicle inspection
//                    report. All 330 signatures together are 8.6 MB, so there is
//                    no reason to ever delete one.
//   check-*.jpg    — photos of actual defects. 14 files, ~2 MB, and they are the
//                    evidence that a defect was real. Kept.
// Only files named tyre-*.jpg are ever removed.
//
// The inspection ROW is never touched either — reports stay in the database for
// good, which is what the 3-month retention rule actually governs.
//
// Folder layout is <inspection-id>/<filename>, so old photos are found from the
// inspections table rather than needing access to the storage schema.
//
// Auth: x-api-key = GV_SERVICE_SECRET. Run daily by the gvoice bot, like the
// digest. POST {dryRun:true} reports what WOULD go without deleting anything.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined from _shared/common.ts so this function deploys self-contained
// (identical behaviour to the shared json() helper).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SERVICE_ROLE_KEY")!;
const GV_SECRET    = Deno.env.get("GV_SERVICE_SECRET")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const BUCKET = "inspection-photos";
const DEFAULT_DAYS = 30;   // tyre photos older than this are removed
const DEFAULT_LIMIT = 60;  // folders inspected per run — bounds runtime

/** The one rule that matters: only tyre photos are deletable. */
function isDeletable(filename: string): boolean {
  return /^tyre-.*\.(jpg|jpeg|png|webp)$/i.test(filename);
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (req.headers.get("x-api-key") !== GV_SECRET) return json({ error: "unauthorized" }, 401);

  let body: { dryRun?: boolean; days?: number; limit?: number } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const days   = Number.isFinite(body.days)  && body.days!  > 0 ? Math.floor(body.days!)  : DEFAULT_DAYS;
  const limit  = Number.isFinite(body.limit) && body.limit! > 0 ? Math.floor(body.limit!) : DEFAULT_LIMIT;
  const dryRun = body.dryRun === true;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  // Newest-first among those past the cutoff: in steady state the folders that
  // have just crossed the threshold are the only ones with anything left to
  // delete, so a small daily limit keeps up without re-walking old folders.
  const { data: old, error } = await sb
    .from("inspections")
    .select("id, submitted_at")
    .lt("submitted_at", cutoff)
    .order("submitted_at", { ascending: false })
    .limit(limit);

  if (error) return json({ error: `inspection lookup failed: ${error.message}` }, 500);

  let foldersWithPhotos = 0, filesDeleted = 0, bytesFreed = 0, kept = 0;
  const failures: string[] = [];

  for (const insp of old ?? []) {
    const { data: files, error: listErr } = await sb.storage.from(BUCKET).list(insp.id, { limit: 200 });
    if (listErr) { failures.push(`list ${insp.id}: ${listErr.message}`); continue; }
    if (!files?.length) continue;

    const doomed = files.filter((f) => isDeletable(f.name));
    kept += files.length - doomed.length;
    if (!doomed.length) continue;

    foldersWithPhotos++;
    const bytes = doomed.reduce((sum, f) => sum + (f.metadata?.size ?? 0), 0);

    if (!dryRun) {
      const paths = doomed.map((f) => `${insp.id}/${f.name}`);
      const { error: delErr } = await sb.storage.from(BUCKET).remove(paths);
      if (delErr) { failures.push(`delete ${insp.id}: ${delErr.message}`); continue; }
    }
    filesDeleted += doomed.length;
    bytesFreed   += bytes;
  }

  return json({
    ok: true,
    dryRun,
    retention_days: days,
    cutoff,
    inspections_examined: old?.length ?? 0,
    folders_with_tyre_photos: foldersWithPhotos,
    files_deleted: filesDeleted,
    mb_freed: +(bytesFreed / 1048576).toFixed(1),
    files_kept_signatures_and_defects: kept,
    failures,
  });
});
