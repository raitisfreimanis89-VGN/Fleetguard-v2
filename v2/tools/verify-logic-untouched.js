#!/usr/bin/env node
/* ==========================================================================
   Port verification — run from the repo root:

     node v2/tools/verify-logic-untouched.js [baseline-ref]     (default: main)

   A v2 port is only allowed to change what a page LOOKS like. This extracts
   every named function from the baseline's js/app.js and from the working
   tree's, and byte-compares them. Anything other than the render function
   being ported must come back identical.

   Why by function and not by diff: a diff of js/app.js after a port is
   thousands of lines of new markup and says nothing useful. This answers the
   question that actually matters — did the compliance engine, the SMS path,
   the auth flow or a database write change while we were moving markup around?
   ========================================================================== */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');

const BASE = process.argv[2] || 'main';
const FILE = 'js/app.js';

let baseline;
try {
  baseline = execFileSync('git', ['show', BASE + ':' + FILE], { encoding: 'utf8', maxBuffer: 1 << 28 });
} catch {
  console.error('  cannot read ' + FILE + ' at "' + BASE + '" — is that ref valid?');
  process.exit(2);
}
const current = fs.readFileSync(FILE, 'utf8');

/* Pull one function out by walking braces from its opening `{`. Naive on
   braces inside strings or regex literals, but it is applied identically to
   both sides, so a mismatch is still a real difference. */
function grab(src, name) {
  const m = new RegExp('(?:async )?function ' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let depth = 0, i = src.indexOf('{', m.index), j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) { j++; break; }
  }
  return src.slice(m.index, j).replace(/\r/g, '');
}

/* Grouped so a failure names the capability at risk, not just a symbol. */
const GROUPS = {
  'PTI link sending / SMS queue': ['doSendLink', 'doSendLinkFromPicker', 'doBulkSendAll', 'doBulkCancel', 'loadPtiQueueStatus'],
  'Defect repair flow':           ['doMarkRepaired', 'openInspection', 'isOpenDefect', 'openDefectFor'],
  'Driver portal submissions':    ['doSubmitPortal', 'addTyreRecord', 'addMileage', 'renderPortal'],
  'Compliance engine':            ['getVehicleStatus', 'vehSched', 'driverPtiStats', 'driverSafetyScore', 'onNewTruckLadder', 'businessDaysInWindow'],
  'Database writes':              ['addVehicle', 'updateVehicle', 'deleteVehicle', 'addDriver', 'updateDriver', 'deleteDriver',
                                   'addBrakeTest', 'addServiceRecord', 'addDOTInspection', 'addMaintenance'],
  'Auth / data load / routing':   ['signIn', 'signOut', 'loadAll', 'init', 'navigate', 'render'],
  'Render functions not yet ported': ['renderDrivers', 'renderCalendar', 'renderReports',
                                      'renderDispatcherBoard', 'renderVehicleDetail', 'renderUsers'],
};

/* Ported deliberately — expected to differ, and listed so the count is honest. */
const PORTED = ['renderDashboard', 'renderVehicles', 'renderInspections'];

console.log('  baseline: ' + BASE + ':' + FILE + '\n');
let total = 0, identical = 0;
const changed = [];

for (const [group, fns] of Object.entries(GROUPS)) {
  const ok = [], diff = [], missing = [];
  for (const fn of fns) {
    const a = grab(baseline, fn), b = grab(current, fn);
    if (a === null || b === null) { missing.push(fn); continue; }
    total++;
    if (a === b) { ok.push(fn); identical++; } else { diff.push(fn); changed.push(fn); }
  }
  console.log('  ' + group);
  console.log('    ' + ok.length + '/' + (fns.length - missing.length) +
    (diff.length ? ' — CHANGED: ' + diff.join(', ') : ' identical') +
    (missing.length ? '   [not found: ' + missing.join(', ') + ']' : ''));
}

const stillPorted = PORTED.filter(fn => {
  const a = grab(baseline, fn), b = grab(current, fn);
  return a !== null && b !== null && a !== b;
});
console.log('\n  ported on purpose (markup only): ' + (stillPorted.join(', ') || 'none yet'));
console.log('  ' + identical + ' of ' + total + ' functions byte-identical to ' + BASE);
console.log('  unexpected changes: ' + (changed.length ? changed.join(', ') : 'NONE'));

if (changed.length) {
  console.log('\n  A port must not alter these. Move the change back out, or if it is');
  console.log('  intended, it is not a port — raise it separately. See v2/PORTING.md.');
}
process.exit(changed.length ? 1 : 0);
