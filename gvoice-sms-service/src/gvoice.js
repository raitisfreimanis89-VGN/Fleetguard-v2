'use strict';
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const log = require('./logger');

const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');
const GV_URL      = 'https://voice.google.com/u/0/messages';
const GV_HOME     = 'https://voice.google.com';

let browserCtx = null;
let page       = null;
let lastPollTs = Date.now();

// ── Boot: launch persistent browser context ───────────────────
async function initBrowser() {
  log.info('Launching Chromium (persistent session)...');
  browserCtx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,           // visible window so you can see it working
    slowMo: 80,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1100,820'],
    viewport: { width: 1100, height: 820 },
  });
  const pages = browserCtx.pages();
  page = pages.length > 0 ? pages[0] : await browserCtx.newPage();
  log.info('Browser ready');
}

// ── Ensure we are logged into Google Voice ────────────────────
async function ensureLoggedIn() {
  try {
    // If already on GV, skip navigation (fast path)
    if (page.url().includes('voice.google.com')) {
      log.info('Google Voice session already active (fast path)');
      return;
    }

    await page.goto(GV_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const url = page.url();
    log.debug(`Current URL: ${url}`);

    // If redirected to Google sign-in, log in now
    if (url.includes('accounts.google.com')) {
      log.info('Session expired — logging in...');
      await googleLogin();
      await page.waitForTimeout(2000);
    }

    // Verify we are on Google Voice
    const finalUrl = page.url();
    if (!finalUrl.includes('voice.google.com')) {
      throw new Error(`Unexpected URL after login: ${finalUrl}`);
    }
    log.info('Google Voice session active');
  } catch (err) {
    log.error(`ensureLoggedIn failed: ${err.message}`);
    throw err;
  }
}

// ── Google login flow (runs only when session expires) ────────
async function googleLogin() {
  const email    = process.env.GV_EMAIL;
  const password = process.env.GV_APP_PASSWORD?.replace(/\s/g, '');

  if (!email || !password) {
    throw new Error('GV_EMAIL or GV_APP_PASSWORD not set in .env');
  }

  // Email step
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', email);
  await page.click('#identifierNext, [data-primary-action-label] button');
  await page.waitForTimeout(1500);

  // Password step
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[type="password"]', password);
  await page.click('#passwordNext, [data-primary-action-label] button');

  // Wait for redirect back to Google Voice
  await page.waitForURL(/voice\.google\.com/, { timeout: 30000 });
  log.info('Login successful — session saved to .browser-profile');
}

// ── Send SMS to a phone number ────────────────────────────────
async function sendSMS(to, body) {
  await ensureLoggedIn();

  // Navigate to messages
  await page.goto(GV_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);
  log.info(`GV page loaded: ${page.url()}`);

  // Take stock of what buttons are visible
  const btns = await page.$$eval('button', els => els.map(e => e.getAttribute('aria-label') || e.textContent?.trim()).filter(Boolean).slice(0, 20));
  log.info(`Visible buttons: ${JSON.stringify(btns)}`);

  // Try keyboard shortcut 'C' to open new conversation (works in GV)
  await page.keyboard.press('c');
  await page.waitForTimeout(1500);

  // Click "Send new message" button if it appears after pressing C
  const sendNewMsgBtn = await page.$('button:has-text("Send new message"), [aria-label="Send new message"]');
  if (sendNewMsgBtn) {
    log.info('Clicking "Send new message" button');
    await sendNewMsgBtn.click();
    // Wait up to 15 seconds for "To" field to become active
    log.info('Waiting for To field to become active...');
    await page.waitForSelector('input[placeholder="Type a name or phone number"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
  } else {
    // Try other compose selectors
    const newConvSelectors = [
      '[data-e2e-new-conversation]',
      'button[aria-label="New conversation"]',
      'button[aria-label="New message"]',
      'button[aria-label="Compose"]',
      'gv-icon-button[icon="create"]',
      '[mattooltip="New conversation"]',
    ];
    const found = await findFirst(newConvSelectors);
    if (found) { await found.click(); await page.waitForTimeout(1000); }
  }
  await page.waitForTimeout(1500);

  // Debug: log all inputs visible after compose opened
  const inputs = await page.$$eval('input, textarea', els => els.map(e => ({
    tag: e.tagName,
    placeholder: e.getAttribute('placeholder'),
    ariaLabel: e.getAttribute('aria-label'),
    type: e.getAttribute('type'),
    visible: e.offsetParent !== null,
  }))).catch(() => []);
  log.info(`Inputs after compose: ${JSON.stringify(inputs)}`);

  // Type recipient phone number
  const recipientSelectors = [
    'input[placeholder="Type a name or phone number"]',
    'input[placeholder*="name or phone"]',
    'input[placeholder*="phone number"]',
    'input[aria-label="Search contacts or type a number"]',
    'input[aria-label="Search contacts"]',
    'gv-recipient-picker input',
    'input[aria-label="To"]',
    'input[placeholder*="phone"]',
    'input[placeholder*="name"]',
    'input[placeholder*="number"]',
  ];
  // Wait for recipient input to be ready then fill it
  const toInput = await page.waitForSelector(
    'input[placeholder="Type a name or phone number"]',
    { timeout: 10000 }
  ).catch(() => null);

  if (toInput) {
    log.info('Found "To" input — typing phone number');

    // Click with force to bypass overlay backdrop (part of GV compose UI)
    const toLocator = page.locator('input[placeholder="Type a name or phone number"]');
    await toLocator.click({ force: true });
    await page.waitForTimeout(1000);

    // Type number character by character
    await toLocator.pressSequentially(to, { delay: 100 });
    log.info('Number typed — waiting for suggestion popup...');
    await page.waitForTimeout(3000);

    // Log what suggestions are visible
    const allOptions = await page.$$eval('[role="option"], li[role="listitem"], .mat-option, mat-option', els =>
      els.map(e => e.textContent?.trim()).filter(Boolean)
    ).catch(() => []);
    log.info(`Suggestions visible: ${JSON.stringify(allOptions)}`);

    // Select suggestion using keyboard: ArrowDown selects first option, Enter confirms
    log.info('Selecting suggestion with ArrowDown + Enter');
    await toLocator.press('ArrowDown');
    await page.waitForTimeout(500);
    await toLocator.press('Enter');
    await page.waitForTimeout(1000);
  } else {
    log.error('Could not find "To" input field');
    throw new Error('To input not found');
  }
  await page.waitForTimeout(2000);

  // Wait for message textarea then type
  const msgInput = await page.waitForSelector(
    'textarea[placeholder="Type a message"]',
    { timeout: 10000 }
  ).catch(() => null);

  if (msgInput) {
    log.info('Found message textarea — typing message');
    const msgLocator = page.locator('textarea[placeholder="Type a message"]');
    await msgLocator.click({ force: true });
    await page.waitForTimeout(500);
    await msgLocator.pressSequentially(body, { delay: 30 });
    await page.waitForTimeout(800);
    await msgLocator.press('Enter');
    log.info('Enter pressed — message sent');
    await page.waitForTimeout(2000);
  } else {
    log.error('Could not find message textarea');
    throw new Error('Message textarea not found');
  }

  log.info(`SMS sent → ${to.slice(0, 6)}****`);
}

// ── Poll inbox for recent inbound replies ─────────────────────
async function pollReplies(sinceMinutes = 4) {
  await ensureLoggedIn();
  await page.goto(GV_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const cutoff = Date.now() - sinceMinutes * 60 * 1000;
  const replies = [];

  // Get all conversation rows
  const rowSelectors = [
    'gv-conversation-list-item',
    '[data-e2e-conversation]',
    '.gv-thread-item',
    'mat-list-item.thread',
  ];

  let rows = [];
  for (const sel of rowSelectors) {
    rows = await page.$$(sel);
    if (rows.length > 0) break;
  }

  log.debug(`Found ${rows.length} conversation rows`);

  for (const row of rows.slice(0, 20)) {
    try {
      // Get timestamp from the row
      const timeEl = await row.$('[data-e2e-time], .gv-time, time, .time');
      if (!timeEl) continue;

      const timeAttr = await timeEl.getAttribute('datetime')
        || await timeEl.getAttribute('data-e2e-time')
        || await timeEl.innerText();

      const rowTime = parseGVTime(timeAttr);
      if (!rowTime || rowTime < cutoff) continue;

      // Get the phone number / sender
      const phoneEl = await row.$('[data-e2e-phone], .phone, gv-participant');
      const fromRaw = phoneEl ? await phoneEl.innerText() : '';
      const from    = normalizePhone(fromRaw);
      if (!from) continue;

      // Get preview text
      const previewEl = await row.$('[data-e2e-preview], .preview, .snippet, .message-preview');
      const preview   = previewEl ? (await previewEl.innerText()).trim() : '';
      if (!preview) continue;

      // Open the conversation to confirm it's an inbound message
      await row.click();
      await page.waitForTimeout(1000);

      const inbound = await getLatestInboundMessage();
      if (!inbound) continue;

      // Only return if it looks like a driver reply (not our own sent message)
      replies.push({
        from:       from,
        body:       inbound.body,
        receivedAt: new Date(rowTime).toISOString(),
      });

      log.info(`Reply from ${from.slice(0, 6)}****: "${inbound.body.slice(0, 40)}"`);
    } catch (e) {
      log.debug(`Row parse error: ${e.message}`);
    }
  }

  lastPollTs = Date.now();
  return replies;
}

// ── Read the latest inbound (received) message in open thread ─
async function getLatestInboundMessage() {
  // In GV web UI, received messages have a different class than sent ones.
  // Sent messages: .gv-message-outgoing / [data-e2e-outgoing] / right-aligned
  // Received:      .gv-message-incoming / [data-e2e-incoming] / left-aligned
  const inboundSelectors = [
    '[data-e2e-incoming]:last-child .gv-message-content',
    '.gv-message-incoming:last-of-type .content',
    'gv-message-item:last-child:not(.outgoing) .message-text',
    '.gv-message:not(.outgoing):last-child',
  ];

  for (const sel of inboundSelectors) {
    const el = await page.$(sel);
    if (el) {
      const body = (await el.innerText()).trim();
      if (body) return { body };
    }
  }

  // Fallback: read all messages and return last non-sent one
  const allMsgs = await page.$$eval(
    'gv-message-item, .gv-message, [data-e2e-message]',
    (els) => els.map(el => ({
      text:    el.innerText?.trim() || '',
      outgoing: el.classList.contains('outgoing')
              || el.dataset?.e2eOutgoing !== undefined
              || el.style.alignSelf === 'flex-end',
    }))
  ).catch(() => []);

  const inbound = allMsgs.filter(m => m.text && !m.outgoing);
  if (inbound.length === 0) return null;
  return { body: inbound[inbound.length - 1].text };
}

// ── Helpers ───────────────────────────────────────────────────
async function clickFirst(selectors, label) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); return; }
    } catch (_) {}
  }
  throw new Error(`Could not find: ${label}\nTried: ${selectors.join(', ')}`);
}

async function findFirst(selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits.length >= 7 ? `+${digits}` : null;
}

function parseGVTime(raw) {
  if (!raw) return null;
  // ISO string
  const d = new Date(raw);
  if (!isNaN(d)) return d.getTime();
  // "2:34 PM" style — assume today
  const today = new Date().toDateString();
  const d2 = new Date(`${today} ${raw}`);
  if (!isNaN(d2)) return d2.getTime();
  // "Mon" / "Tue" etc — within last 7 days, treat as recent
  if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(raw.trim())) {
    return Date.now() - 60 * 60 * 1000; // treat as 1h ago
  }
  return null;
}

async function closeBrowser() {
  if (browserCtx) { await browserCtx.close(); browserCtx = null; page = null; }
}

module.exports = { initBrowser, sendSMS, pollReplies, closeBrowser };
