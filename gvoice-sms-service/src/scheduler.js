'use strict';
require('dotenv').config();
const cron  = require('node-cron');
const fetch = require('node-fetch');
const log   = require('./logger');
const { pollReplies } = require('./gvoice');

const POLL_MINUTES  = parseInt(process.env.REPLY_POLL_INTERVAL_MINUTES || '3', 10);
const INBOUND_URL   = process.env.SUPABASE_INBOUND_SMS_URL;
const REMINDERS_URL = process.env.SUPABASE_SEND_REMINDERS_URL;
const SECRET        = process.env.GV_SERVICE_SECRET;

// ── On startup: fire the daily reminder scan immediately ──────
// No cron timing dependency — scan runs the moment the service starts.
async function runStartupScan() {
  log.info('Running startup reminder scan...');
  try {
    const res = await fetch(REMINDERS_URL, {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${SECRET}`,
        'Content-Type':   'application/json',
      },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      log.info(`Reminder scan complete — ${data.sent ?? '?'} SMS queued`);
    } else {
      log.warn(`Reminder scan returned ${res.status}: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    log.error(`Startup scan failed: ${err.message}`);
  }
}

// ── Poll inbox and forward replies to Supabase ─────────────────
async function runReplyPoll() {
  log.debug('Polling Google Voice inbox...');
  try {
    const replies = await pollReplies(POLL_MINUTES + 1);

    if (replies.length === 0) {
      log.debug('No new replies');
      return;
    }

    log.info(`Found ${replies.length} new reply(ies) — forwarding to Supabase`);

    for (const reply of replies) {
      try {
        const res = await fetch(INBOUND_URL, {
          method:  'POST',
          headers: {
            'x-api-key':    SECRET,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(reply),
        });
        if (res.ok) {
          log.info(`Reply from ${reply.from.slice(0, 6)}**** logged`);
        } else {
          log.warn(`Inbound webhook returned ${res.status} for ${reply.from.slice(0, 6)}****`);
        }
      } catch (e) {
        log.error(`Failed to forward reply: ${e.message}`);
      }
    }
  } catch (err) {
    log.error(`Reply poll failed: ${err.message}`);
  }
}

// ── Start all scheduled jobs ───────────────────────────────────
function startScheduler() {
  // Reply poll: every N minutes
  const cronExpr = `*/${POLL_MINUTES} * * * *`;
  cron.schedule(cronExpr, runReplyPoll);
  log.info(`Reply poller scheduled every ${POLL_MINUTES} min`);
}

module.exports = { runStartupScan, startScheduler };
