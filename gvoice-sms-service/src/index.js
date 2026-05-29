'use strict';
require('dotenv').config();
const express  = require('express');
const log      = require('./logger');
const { initBrowser, sendSMS, closeBrowser } = require('./gvoice');
const { runStartupScan, startScheduler }      = require('./scheduler');

const PORT   = parseInt(process.env.PORT || '3000', 10);
const SECRET = process.env.GV_SERVICE_SECRET;
const app    = express();
app.use(express.json());

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
    await sendSMS(to, body);
    res.json({ ok: true, notificationId });
  } catch (err) {
    log.error(`sendSMS failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /health — quick liveness check ───────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'fleetguard-gvoice',
    time:    new Date().toISOString(),
  });
});

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
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

  log.info('FleetGuard GVoice service fully started ✅');
  log.info(`Press Ctrl+C to stop`);
})();
