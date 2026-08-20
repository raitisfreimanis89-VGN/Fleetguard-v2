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

// ── Reminder wave — sends one batch of the given reminder type(s) ──
// Edge Function caps at 4/run and enforces the 7-17:59 CST window. Types are
// kept apart across the day (tyre 7:30, yard 10, brake noon) so a driver never
// gets tyre+yard+brake back-to-back. Dedup guard prevents duplicate sends.
async function runReminderWave(types, label) {
  if (busy) { log.debug(`${label} wave skipped — bot busy`); return; }
  busy = true;
  log.info(`Running ${label} reminder wave...`);
  try {
    const res = await fetch(REMINDERS_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${ANON_KEY}`,
        'x-api-key':     SECRET,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ types }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      log.info(`${label} wave complete — sent:${data.sent} skipped:${data.skipped} (on vacation:${data.vacationSkipped ?? 0})`);
      if (data.errors?.length) log.warn(`${label} wave errors: ${JSON.stringify(data.errors)}`);
    } else {
      log.warn(`${label} wave returned ${res.status}: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    log.error(`${label} wave failed: ${err.message}`);
  } finally {
    busy = false;
  }
}

// On boot, run the wave that matches the current CST window, so a restart never
// fires the wrong type at the wrong hour (e.g. brakes before noon).
async function runStartupScan() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hour >= 7  && hour < 10) return runReminderWave(['tyre_check'],     'tyre/PTI (startup)');
  if (hour >= 10 && hour < 12) return runReminderWave(['dot_inspection'], 'yard (startup)');
  if (hour >= 12 && hour < 18) return runReminderWave(['brake_service'],  'brake (startup)');
  log.info('Startup scan — outside reminder windows, nothing to send');
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

  // Three separated reminder waves (Mon-Fri, America/Chicago), each sending ONE
  // type so a driver never gets tyre+yard+brake back-to-back. Dispatcher digest
  // fires 7:15 AM; drivers always follow. send-reminders also enforces 7-17:59.
  //   Tyre/PTI  7:30 AM -> 9:50 AM
  //   Yard     10:00 AM -> 11:50 AM
  //   Brake    12:00 PM -> 5:50 PM
  const TZ = { timezone: 'America/Chicago' };
  cron.schedule(`30,40,50 7 * * 1-5`,           () => runReminderWave(['tyre_check'],     'tyre/PTI'), TZ);
  cron.schedule(`*/${SCAN_MINUTES} 8-9 * * 1-5`,   () => runReminderWave(['tyre_check'],     'tyre/PTI'), TZ);
  cron.schedule(`*/${SCAN_MINUTES} 10-11 * * 1-5`, () => runReminderWave(['dot_inspection'], 'yard'),     TZ);
  cron.schedule(`*/${SCAN_MINUTES} 12-17 * * 1-5`, () => runReminderWave(['brake_service'],  'brake'),    TZ);
  log.info('Reminder waves: tyre/PTI 7:30-9:50, yard 10-11:50, brake 12-17:50 CST (Mon-Fri)');

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
