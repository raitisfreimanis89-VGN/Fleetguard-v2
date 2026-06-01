import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SERVICE_ROLE_KEY")!;
const GV_SECRET      = Deno.env.get("GV_SERVICE_SECRET")!;
const GV_SERVICE_URL = Deno.env.get("GV_SERVICE_URL")!;   // ngrok URL → GV bot

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// "DONE" = work finished (check first — more specific)
const DONE_PATTERN = /^\s*(done|finished|complete|completed|fixed)\b/i;
// "OK" = driver acknowledges they will schedule
const ACK_PATTERN  = /^\s*(ok|okay|yes|yep|yeah|confirm(ed)?|scheduled?|will\s+do|got\s+it|on\s+it|roger|k)\b/i;

const CONFIRM_REPLY =
  "Safety & Compliance: Confirmation received. Please text back DONE once the work is finished. Thank you! ✓";

// Send an SMS back through the Google Voice bot
async function sendReply(to: string, message: string) {
  try {
    const res = await fetch(`${GV_SERVICE_URL}/send`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-api-key": GV_SECRET },
      body:    JSON.stringify({ to, body: message }),
      signal:  AbortSignal.timeout(60_000),
    });
    return res.ok;
  } catch (e) {
    console.error(`Auto-reply send failed: ${(e as Error).message}`);
    return false;
  }
}

serve(async (req) => {
  if (req.headers.get("x-api-key") !== GV_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: { from?: string; body?: string; receivedAt?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { from, name, body: text, receivedAt } = body as
    { from?: string; name?: string; body?: string; receivedAt?: string };
  if ((!from && !name) || !text) {
    return new Response("Missing identifier (from/name) or body", { status: 400 });
  }

  const receivedTs = receivedAt ?? new Date().toISOString();
  const trimmed    = text.trim();

  // ── Resolve driver: by phone first, else by contact name ──
  let driverId: string | null = null;
  let driverPhone: string | null = from ?? null;

  if (from) {
    const { data: pr } = await sb
      .from("driver_phones")
      .select("driver_id")
      .eq("phone_number", from)
      .maybeSingle();
    driverId = pr?.driver_id ?? null;
  }

  if (!driverId && name) {
    // GV shows saved contact names which may be SHORTER than the DB name
    // (e.g. GV "Ewan Francis" vs DB "Ewan Alexander Francis").
    const clean = name.trim();

    // 1. Exact (case-insensitive) match
    const { data: exact } = await sb
      .from("drivers")
      .select("id, name")
      .ilike("name", clean)
      .maybeSingle();
    driverId = exact?.id ?? null;

    // 2. Fuzzy: match on first + last name tokens
    if (!driverId) {
      const tokens = clean.split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        const first = tokens[0];
        const last  = tokens[tokens.length - 1];
        const { data: fuzzy } = await sb
          .from("drivers")
          .select("id, name")
          .ilike("name", `${first}%`)
          .ilike("name", `%${last}`);
        if (fuzzy && fuzzy.length === 1) {
          driverId = fuzzy[0].id;          // unambiguous single match
        }
      }
    }
  }

  // Look up phone for the matched driver (needed for the auto-reply)
  if (driverId && !driverPhone) {
    const { data: ph } = await sb
      .from("driver_phones")
      .select("phone_number")
      .eq("driver_id", driverId)
      .maybeSingle();
    driverPhone = ph?.phone_number ?? null;
  }

  // ── Find most recent active notification for driver ───────
  let notificationId: string | null = null;
  if (driverId) {
    const { data: notif } = await sb
      .from("sms_notifications")
      .select("id")
      .eq("driver_id", driverId)
      .in("status", ["sent", "pending", "acknowledged"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    notificationId = notif?.id ?? null;
  }

  // ── Log the inbound reply ─────────────────────────────────
  await sb.from("sms_replies").insert({
    from_number:     driverPhone ?? name ?? "unknown",
    body:            trimmed,
    driver_id:       driverId,
    notification_id: notificationId,
    received_at:     receivedTs,
  });

  let action = "logged";

  if (notificationId) {
    // DONE — work finished. Check first (more specific than OK).
    if (DONE_PATTERN.test(trimmed)) {
      await sb
        .from("sms_notifications")
        .update({ status: "completed", acknowledged_at: new Date().toISOString() })
        .eq("id", notificationId);

      await sb
        .from("escalation_log")
        .delete()
        .eq("notification_id", notificationId)
        .eq("escalated_to", "pending");

      action = "completed";

    // OK — driver acknowledges, send confirmation + ask for DONE later
    } else if (ACK_PATTERN.test(trimmed)) {
      await sb
        .from("sms_notifications")
        .update({ status: "acknowledged", acknowledged_at: new Date().toISOString() })
        .eq("id", notificationId);

      await sb
        .from("escalation_log")
        .delete()
        .eq("notification_id", notificationId)
        .eq("escalated_to", "pending");

      // Auto-reply asking them to text DONE when finished
      if (driverPhone) await sendReply(driverPhone, CONFIRM_REPLY);
      action = "acknowledged";
    }
  }

  return new Response(JSON.stringify({ ok: true, action }), {
    headers: { "Content-Type": "application/json" },
  });
});
