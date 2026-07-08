'use strict';
require('dotenv').config();
const cron  = require('node-cron');
const fetch = require('node-fetch');
const log   = require('./logger');
const { pollReplies } = require('./gvoice');
const { enqueue }      = require('./queue');

const POLL_MINUTES  = parseInt(process.env.REPLY_POLL_INTERVAL_MINUTES || '3', 10);
const SCAN_MINUTES  = parseInt(process.env.SCAN_INTERVAL_MINUTES || '10', 10);
const DRAIN_MINUTES = parseInt(process.env.PTI_DRAIN_INTERVAL_MINUTES || '5', 10);
const INBOUND_URL   = process.env.SUPABASE_INBOUND_SMS_URL;
const REMINDERS_URL = process.env.SUPABASE_SEND_REMINDERS_URL;
const DRAIN_URL     = process.env.SUPABASE_PTI_DRAIN_URL;
const SECRET        = process.env.GV_SERVICE_SECRET;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY;
const DIGEST_URL    = process.env.SUPABASE_DISPATCHER_DIGEST_URL;
const PORT          = parseInt(process.env.PORT || '3000', 10);

// Shared browser lock — scan and poll both drive the same GV page,
// so they must never run at the same time.
let busy = false;

// ── Reminder scan — sends one batch (Edge Function caps at 4/run) ──
// Runs at startup and repeats every SCAN_MINUTES so large backlogs
// drain in safe chunks. Dedup guard prevents duplicate sends.
async function runStartupScan() {
  if (busy) { log.debug('Scan skipped — bot busy'); return; }
  busy = true;
  log.info('Running reminder scan (batch)...');
  try {
    const res = await fetch(REMINDERS_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${ANON_KEY}`,
        'x-api-key':     SECRET,
        'Content-Type':  'application/json',
      },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      log.info(`Reminder scan complete — sent:${data.sent} skipped:${data.skipped} (on vacation:${data.vacationSkipped ?? 0})`);
      if (data.errors?.length) log.warn(`Scan errors: ${JSON.stringify(data.errors)}`);
    } else {
      log.warn(`Reminder scan returned ${res.status}: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    log.error(`Startup scan failed: ${err.message}`);
  } finally {
    busy = false;
  }
}

// ── Poll inbox and forward replies to Supabase ─────────────────
async function runReplyPoll() {
  if (busy) { log.debug('Poll skipped — bot busy'); return; }
  busy = true;
  log.debug('Polling Google Voice inbox...');
  try {
    // page op goes through the FIFO so polls never collide with sends
    const replies = await enqueue('reply-poll', () => pollReplies(POLL_MINUTES + 1));

    if (replies.length === 0) {
      log.debug('No new replies');
      return;
    }

    log.info(`Found ${replies.length} new reply(ies) — forwarding to Supabase`);

    for (const reply of replies) {
      const who = reply.name || reply.from || 'unknown';
      try {
        const res = await fetch(INBOUND_URL, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${ANON_KEY}`,
            'x-api-key':     SECRET,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(reply),
        });
        if (res.ok) {
          const j = await res.json().catch(() => ({}));
          log.info(`Reply from "${who}" logged (action: ${j.action ?? '?'})`);
        } else {
          log.warn(`Inbound webhook returned ${res.status} for "${who}"`);
        }
      } catch (e) {
        log.error(`Failed to forward reply: ${e.message}`);
      }
    }
  } catch (err) {
    log.error(`Reply poll failed: ${err.message}`);
  } finally {
    busy = false;
  }
}

// ── PTI link queue drain — delivers what an admin explicitly queued ──
// The cron never decides to send; it only ships rows created by the
// admin's "Send PTI link to all" action (wave pattern, 5 per cycle).
let drainBusy = false;
async function runPtiDrain() {
  if (!DRAIN_URL) return;
  if (drainBusy) { log.debug('PTI drain skipped — previous drain still running'); return; }
  drainBusy = true;
  try {
    const res = await fetch(DRAIN_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${ANON_KEY}`,
        'x-api-key':     SECRET,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ action: 'drain' }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if ((data.sent ?? 0) || (data.failed ?? 0) || (data.remaining ?? 0)) {
        log.info(`PTI drain — sent:${data.sent} failed:${data.failed} remaining:${data.remaining}`);
      }
    } else {
      log.warn(`PTI drain returned ${res.status}: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    log.error(`PTI drain failed: ${err.message}`);
  } finally {
    drainBusy = false;
  }
}

// ── Dispatcher morning digest — Edge Function computes per-fleet messages,
// the bot sends them (paced via the GV FIFO). Fires 7:15 AM America/Chicago.
async function runDispatcherDigest() {
  if (!DIGEST_URL) return;
  log.info('Building dispatcher morning digest...');
  try {
    const res = await fetch(DIGEST_URL, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${ANON_KEY}`, 'x-api-key': SECRET, 'Content-Type': 'application/json' },
      body:    '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { log.warn(`Digest compute returned ${res.status}: ${JSON.stringify(data)}`); return; }
    const msgs = data.messages || [];
    log.info(`Dispatcher digest: ${msgs.length} message(s) to send`);
    let sent = 0;
    for (const m of msgs) {
      try {
        const r = await fetch(`http://localhost:${PORT}/send`, {
          method:  'POST',
          headers: { 'x-api-key': SECRET, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ to: m.to, body: m.body }),
        });
        if (r.ok) sent++; else log.warn(`Digest send (${m.dispatcher}) failed: ${r.status}`);
      } catch (e) { log.error(`Digest send error (${m.dispatcher}): ${e.message}`); }
    }
    log.info(`Dispatcher digest sent ${sent}/${msgs.length}`);
  } catch (err) {
    log.error(`Dispatcher digest failed: ${err.message}`);
  }
}

// ── Start all scheduled jobs ───────────────────────────────────
function startScheduler() {
  // Reply poll: every N minutes
  cron.schedule(`*/${POLL_MINUTES} * * * *`, runReplyPoll);
  log.info(`Reply poller scheduled every ${POLL_MINUTES} min`);

  // Reminder scan: every SCAN_MINUTES, Mon-Fri 7AM-5PM CST — drains the backlog
  // in batches. The send-reminders function also hard-enforces this window, so
  // this just avoids pointless off-hours calls.
  cron.schedule(`*/${SCAN_MINUTES} 7-16 * * 1-5`, runStartupScan, { timezone: 'America/Chicago' });
  log.info(`Reminder scan scheduled every ${SCAN_MINUTES} min, Mon-Fri 7AM-5PM CST (batch of 4)`);

  // PTI link drain: only active when SUPABASE_PTI_DRAIN_URL is configured
  if (DRAIN_URL) {
    cron.schedule(`*/${DRAIN_MINUTES} * * * *`, runPtiDrain);
    log.info(`PTI link drain scheduled every ${DRAIN_MINUTES} min (wave of 5)`);
  }

  // Dispatcher morning digest: 7:15 AM America/Chicago (node-cron handles DST)
  if (DIGEST_URL) {
    cron.schedule('15 7 * * 1-5', runDispatcherDigest, { timezone: 'America/Chicago' });
    log.info('Dispatcher digest scheduled 7:15 AM America/Chicago (Mon-Fri only)');
  }
}

module.exports = { runStartupScan, startScheduler, runDispatcherDigest };
