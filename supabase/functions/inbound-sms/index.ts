import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GV_SECRET    = Deno.env.get("GV_SERVICE_SECRET")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Words that count as acknowledgement from a driver
const ACK_PATTERN = /^\s*(ok|yes|yep|yeah|confirmed?|done|scheduled?|will\s+do|got\s+it|on\s+it|roger)\b/i;

serve(async (req) => {
  // Auth: only the GV Playwright service can call this
  if (req.headers.get("x-api-key") !== GV_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: { from?: string; body?: string; receivedAt?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { from, body: text, receivedAt } = body;
  if (!from || !text) {
    return new Response("Missing from or body", { status: 400 });
  }

  const receivedTs = receivedAt ?? new Date().toISOString();

  // ── Match phone number → driver ───────────────────────────
  const { data: phoneRow } = await sb
    .from("driver_phones")
    .select("driver_id")
    .eq("phone_number", from)
    .maybeSingle();

  const driverId = phoneRow?.driver_id ?? null;

  // ── Find most recent unacknowledged notification for driver ─
  let notificationId: string | null = null;
  if (driverId) {
    const { data: notif } = await sb
      .from("sms_notifications")
      .select("id")
      .eq("driver_id", driverId)
      .in("status", ["sent", "pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    notificationId = notif?.id ?? null;
  }

  // ── Log the reply ─────────────────────────────────────────
  await sb.from("sms_replies").insert({
    from_number:     from,
    body:            text.trim(),
    driver_id:       driverId,
    notification_id: notificationId,
    received_at:     receivedTs,
  });

  // ── Acknowledge notification if reply is affirmative ─────
  if (notificationId && ACK_PATTERN.test(text)) {
    await sb
      .from("sms_notifications")
      .update({
        status:         "acknowledged",
        acknowledged_at: new Date().toISOString(),
      })
      .eq("id", notificationId);

    // Cancel any pending escalation for this notification
    await sb
      .from("escalation_log")
      .delete()
      .eq("notification_id", notificationId)
      .eq("escalated_to", "pending");
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
