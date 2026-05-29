'use strict';
// Simple timestamped console logger — no dependencies needed
const LEVEL = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVEL[process.env.LOG_LEVEL || 'info'] ?? 1;

function ts() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: false });
}

const logger = {
  debug: (msg) => current <= 0 && console.log(`[${ts()}] 🔍 ${msg}`),
  info:  (msg) => current <= 1 && console.log(`[${ts()}] ✅ ${msg}`),
  warn:  (msg) => current <= 2 && console.warn(`[${ts()}] ⚠️  ${msg}`),
  error: (msg) => current <= 3 && console.error(`[${ts()}] ❌ ${msg}`),
};

module.exports = logger;
