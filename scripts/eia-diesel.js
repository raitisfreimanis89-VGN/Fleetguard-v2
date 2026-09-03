#!/usr/bin/env node
/* ============================================================================
   Read the current US national on-highway diesel average from EIA's public
   weekly page, add the fleet margin, and emit data/fuel-price.json.

   NO API KEY. api.eia.gov needs one, but the public page does not — and the
   CORS wall that blocks a browser does not exist here, because this runs
   server-side in CI with curl. Deterministic parse of the authoritative
   source beats scraping a search engine for a number.

   Usage: node scripts/eia-diesel.js <fetched.html> [marginDollars]

   Fails loudly rather than writing a wrong number: a mispriced load is worse
   than a stale one, and the previous file simply stays in place.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const htmlFile = process.argv[2];
const MARGIN = parseFloat(process.argv[3] || '0.20');
const OUT = path.join('data', 'fuel-price.json');

function die(msg) { console.error('::error::' + msg); process.exit(1); }

if (!htmlFile || !fs.existsSync(htmlFile)) die('No input HTML at ' + htmlFile);
if (!(MARGIN >= 0 && MARGIN < 5)) die('Implausible margin: ' + MARGIN);

const tokens = fs.readFileSync(htmlFile, 'utf8')
  .replace(/<[^>]*>/g, '|')
  .split('|').map(s => s.trim()).filter(Boolean);

// The diesel block lists the last three weeks as columns, newest last:
//   "U.S. On-Highway Diesel Fuel Prices"  … 08/17/26 08/24/26 08/31/26 …
//   "U.S."  5.454  5.652  5.599  <2yr ago> <1yr ago> <wk change>
const start = tokens.findIndex(t => /U\.S\. On-Highway Diesel Fuel Prices/i.test(t));
if (start < 0) die('Diesel section not found — EIA changed their page layout.');

const win = tokens.slice(start, start + 40);
const dates = win.filter(t => /^\d{2}\/\d{2}\/\d{2}$/.test(t));
if (!dates.length) die('No week dates found in the diesel block.');

const usIdx = win.findIndex((t, i) => i > 0 && t === 'U.S.');
if (usIdx < 0) die('National ("U.S.") row not found in the diesel block.');

const nums = win.slice(usIdx + 1).filter(t => /^-?\d+\.\d+$/.test(t));
if (nums.length < dates.length) die('Fewer figures than week columns — layout changed.');

const national = parseFloat(nums[dates.length - 1]);
const mmddyy = dates[dates.length - 1];

if (!(national > 1 && national < 15)) {
  die('Implausible diesel price parsed: ' + national + ' (expected $1-15/gal)');
}

// Guard against a silent misparse: diesel does not move 25% in a week.
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (prev.national > 0) {
      const swing = Math.abs(national - prev.national) / prev.national;
      if (swing > 0.25) {
        die('Refusing a ' + (swing * 100).toFixed(0) + '% week-over-week swing: '
          + prev.national + ' -> ' + national + '. Almost certainly a parse error.');
      }
    }
  } catch (e) { /* unreadable previous file is not a reason to block an update */ }
}

const [mm, dd, yy] = mmddyy.split('/');
const period = '20' + yy + '-' + mm + '-' + dd;
const price = Math.round((national + MARGIN) * 1000) / 1000;

/* Leave the file untouched when nothing meaningful moved. fetchedAt changes
   on every run, so writing unconditionally would produce a commit and a
   Pages redeploy every single day for a figure that only moves weekly. */
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (prev.national === national && prev.margin === MARGIN && prev.period === period) {
      console.log(`unchanged: ${national} + ${MARGIN} = ${price} (week of ${period})`);
      process.exit(0);
    }
  } catch (e) { /* unreadable previous file — fall through and rewrite it */ }
}

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  price, national, margin: MARGIN, period,
  source: 'EIA weekly U.S. on-highway diesel retail average (eia.gov/petroleum/gasdiesel)',
  fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}, null, 2) + '\n');

console.log(`national=${national} + ${MARGIN} => ${price}  (week of ${period})`);
