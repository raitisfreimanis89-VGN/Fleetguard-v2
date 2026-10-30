'use strict';
require('dotenv').config();
const express  = require('express');
const log      = require('./logger');
const { initBrowser, sendSMS, closeBrowser, getLoginState, verifyLogin, recordSend, getSendHealth } = require('./gvoice');
const { enqueue, queueDepth }                 = require('./queue');
const { runStartupScan, startScheduler }      = require('./scheduler');

const PORT         = parseInt(process.env.PORT || '3000', 10);
const SECRET       = process.env.GV_SERVICE_SECRET;
const ADMIN_PHONE  = process.env.ADMIN_ALERT_PHONE || '';
const app          = express();
app.use(express.json());

// ── Admin status alerts (start/stop) ───────────────────────────
// Best-effort: the bot is the only texting capability in this system, so a
// hard crash/kill/power-loss can't self-report (nothing left to send it).
// This covers the reachable cases — clean start, and graceful shutdown.
async function notifyAdmin(message) {
  if (!ADMIN_PHONE) return;
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('notify timeout')), 30_000));
    await Promise.race([sendSMS(ADMIN_PHONE, message), timeout]);
    log.info(`Admin alert sent: ${message}`);
  } catch (e) {
    log.warn(`Admin alert failed: ${e.message}`);
  }
}

// ── Auth middleware ───────────────────────────────────────────
function requireSecret(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!key || key !== SECRET) {
    log.warn(`Rejected request from ${req.ip} — bad API key`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── POST /send — called by Supabase Edge Function ─────────────
// Body: { to: "+12625550192", body: "FleetGuard...", notificationId: "uuid" }
app.post('/send', requireSecret, async (req, res) => {
  const { to, body, notificationId } = req.body || {};

  if (!to || !body) {
    return res.status(400).json({ error: 'Missing required fields: to, body' });
  }
  if (!/^\+[1-9]\d{7,14}$/.test(to)) {
    return res.status(400).json({ error: 'Invalid phone number — must be E.164 format' });
  }

  log.info(`Send request → ${to.slice(0, 6)}**** (notif: ${notificationId ?? 'none'})`);

  try {
    // serialized: concurrent requests wait their turn for the one GV page
    await enqueue(`send→${to.slice(0, 6)}****`, () => sendSMS(to, body));
    recordSend(true);
    res.json({ ok: true, notificationId });
  } catch (err) {
    if (err.queueFull) {
      // backpressure, not a GV failure — don't count it against send health
      log.warn(`Send rejected — queue full (depth ${queueDepth()})`);
      return res.status(503).json({ ok: false, error: 'Send queue full — try again shortly' });
    }
    recordSend(false);
    log.error(`sendSMS failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /health — quick liveness + GV login check ─────────────
// Returns 503 (degraded) when Google Voice is signed out, so a plain uptime
// monitor pinging this URL alerts on a GV logout as well as a bot outage.
// gvLoggedIn: true = OK, false = signed out (needs a human re-login),
// null = not checked yet (fresh boot). The state is refreshed on every send
// and by the login watchdog below, so this stays cheap (no browser work here).
app.get('/health', (req, res) => {
  const gv = getLoginState();
  const sh = getSendHealth();
  // Degraded if GV is signed out OR real sends keep failing (up-but-broken).
  const degraded = gv.loggedIn === false || sh.failing;
  res.status(degraded ? 503 : 200).json({
    status:           degraded ? 'degraded' : 'ok',
    service:          'fleetguard-gvoice',
    gvLoggedIn:       gv.loggedIn,
    gvReason:         gv.reason,
    gvCheckedAt:      gv.checkedAt,
    sendsFailing:     sh.failing,
    consecutiveFails: sh.consecutiveFails,
    lastOkAt:         sh.lastOkAt,
    lastFailAt:       sh.lastFailAt,
    queue:            queueDepth(),
    time:             new Date().toISOString(),
  });
});

// ── GET /diag — what /health cannot see ───────────────────────
// Everything here previously required somebody to remote into the office PC.
// During the 2026-10-20 outage the fix was gated on one line of bot.log that
// took a day to reach; and the watchdog scheduled task — the thing that
// restarts this bot after a reboot — is invisible from outside entirely, so a
// disabled one stays silent until the next restart never happens (that is how
// the bot sat dead for four weeks in July 2026).
//
// Behind the same x-api-key as /send. Commands are fixed strings with no
// request input interpolated, and every one is allowed to fail without
// taking the endpoint down.
app.get('/diag', requireSecret, async (req, res) => {
  const { execFile } = require('child_process');
  const fs   = require('fs/promises');
  const path = require('path');

  const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 40, 1), 200);

  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) =>
      resolve(err ? `unavailable: ${(err.message || stderr || '').split('\n')[0]}` : stdout.trim()));
  });

  // bot.log: launched as `node src\index.js >> logs\bot.log 2>&1`, so it sits
  // beside src/. Read the tail only — this file grows for months.
  // bot.log carries contact PII that this endpoint would otherwise publish to
  // anyone holding the API key: sendSMS dumps the Google Voice page's visible
  // controls and inputs for debugging, and that scrape includes the contact
  // list — real driver names beside full phone numbers. The bot masks its own
  // sends (+13129****) but those dumps walk straight past it. Drop the scrape
  // lines to a marker, then mask any phone-shaped digits left anywhere else.
  const SCRAPE_LINE = /(Visible buttons|Inputs after compose|Suggestions visible|Visible controls):/i;
  const redact = (line) => {
    const hit = line.match(SCRAPE_LINE);
    if (hit) return `${line.slice(0, hit.index + hit[0].length)} [redacted — contains contact data]`;
    // Phone-shaped runs, including GV's digit-per-character spelling ("7 0 2 ...").
    return line.replace(/\+?\d(?:[\s().‐-―-]*\d){6,}/g, '[number]');
  };

  let logTail;
  try {
    const file = path.join(__dirname, '..', 'logs', 'bot.log');
    const buf  = await fs.readFile(file, 'utf8');
    logTail    = buf.split(/\r?\n/).filter(Boolean).slice(-lines).map(redact);
  } catch (e) {
    logTail = [`unavailable: ${e.message}`];
  }

  const TASK = 'FleetGuard GVoice SMS watchdog';
  const [taskRaw, nodeRaw] = await Promise.all([
    run('schtasks', ['/query', '/tn', TASK, '/fo', 'list']),
    run('tasklist', ['/fi', 'imagename eq node.exe', '/fo', 'csv', '/nh']),
  ]);

  // schtasks prints a localised "Status:" line; Disabled is the one that matters.
  const taskStatus = /unavailable:/.test(taskRaw)
    ? taskRaw
    : (taskRaw.match(/^\s*Status:\s*(.+)$/mi)?.[1]?.trim() || 'unknown');

  const nodeCount = /unavailable:/.test(nodeRaw)
    ? null
    : nodeRaw.split(/\r?\n/).filter((l) => /node\.exe/i.test(l)).length;

  res.json({
    service: 'fleetguard-gvoice',
    time:    new Date().toISOString(),
    watchdog: {
      task:     TASK,
      status:   taskStatus,
      // The whole reason this endpoint exists: a disabled watchdog looks
      // identical to a healthy one until the next reboot.
      healthy:  /ready|running/i.test(taskStatus),
    },
    processes: {
      node:     nodeCount,
      // Two node processes means start.bat spawned a second one that cannot
      // bind the port and sits idle while the original keeps serving stale
      // code — the trap that wasted hours on 2026-08-04.
      warning:  nodeCount > 1 ? 'more than one node process — stale bot may still be serving' : null,
    },
    log: { lines: logTail.length, tail: logTail },
  });
});

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  await notifyAdmin(`FleetGuard: bot is shutting down (${signal}).`);
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (e) => log.error(`Uncaught: ${e.message}`));
process.on('unhandledRejection', (e) => log.error(`Unhandled: ${e}`));

// ── Boot sequence ─────────────────────────────────────────────
(async () => {
  // 1. Validate config
  const required = ['GV_EMAIL', 'GV_APP_PASSWORD', 'GV_SERVICE_SECRET',
                    'SUPABASE_SEND_REMINDERS_URL', 'SUPABASE_INBOUND_SMS_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`\n❌ Missing required .env variables: ${missing.join(', ')}`);
    console.error('   Copy .env.example → .env and fill in all values.\n');
    process.exit(1);
  }

  // 2. Start Express server
  app.listen(PORT, '0.0.0.0', () => log.info(`HTTP server listening on port ${PORT} (all interfaces)`));

  // 3. Launch browser
  await initBrowser();

  // 4. Fire startup reminder scan (no cron dependency)
  await runStartupScan();

  // 5. Start reply poller
  startScheduler();

  // 5b. GV login watchdog — refresh the cached login state on a timer so
  // /health (and any uptime monitor pinging it) flags a signed-out GV, which
  // otherwise fails sends silently. Runs through the same queue as sends, so
  // it never races the single browser page. Seed once now, then every 10 min.
  const LOGIN_CHECK_MS = parseInt(process.env.GV_LOGIN_CHECK_MS || '600000', 10);
  const runLoginCheck = () =>
    enqueue('gv-login-check', () => verifyLogin())
      .then((ok) => log[ok ? 'debug' : 'warn'](`GV login check: ${ok ? 'logged in' : 'LOGGED OUT'}`))
      .catch((e) => log.warn(`GV login check skipped: ${e.message}`));
  await runLoginCheck();
  setInterval(runLoginCheck, LOGIN_CHECK_MS);

  log.info('FleetGuard GVoice service fully started ✅');
  log.info(`Press Ctrl+C to stop`);

  // 6. Confirm to the admin that the bot is up (covers both a fresh start
  // and a watchdog-triggered recovery restart after a crash).
  await notifyAdmin('FleetGuard: bot is ONLINE.');
})();
