'use strict';
require('dotenv').config();
const cron  = require('node-cron');
const fetch = require('node-fetch');
const log   = require('./logger');
const { pollReplies } = require('./gvoice');

const POLL_MINUTES  = parseInt(process.env.REPLY_POLL_INTERVAL_MINUTES || '3', 10);
const SCAN_MINUTES  = parseInt(process.env.SCAN_INTERVAL_MINUTES || '10', 10);
const INBOUND_URL   = process.env.SUPABASE_INBOUND_SMS_URL;
const REMINDERS_URL = process.env.SUPABASE_SEND_REMINDERS_URL;
const SECRET        = process.env.GV_SERVICE_SECRET;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY;

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
    const replies = await pollReplies(POLL_MINUTES + 1);

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

// ── Start all scheduled jobs ───────────────────────────────────
function startScheduler() {
  // Reply poll: every N minutes
  cron.schedule(`*/${POLL_MINUTES} * * * *`, runReplyPoll);
  log.info(`Reply poller scheduled every ${POLL_MINUTES} min`);

  // Reminder scan: every SCAN_MINUTES — drains the backlog in batches
  cron.schedule(`*/${SCAN_MINUTES} * * * *`, runStartupScan);
  log.info(`Reminder scan scheduled every ${SCAN_MINUTES} min (batch of 4)`);
}

module.exports = { runStartupScan, startScheduler };
