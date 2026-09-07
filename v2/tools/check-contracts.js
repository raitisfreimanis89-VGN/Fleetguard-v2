#!/usr/bin/env node
/* ==========================================================================
   DOM contract check — run from the repo root:

     node v2/tools/check-contracts.js [baseline-ref]        (default: main)

   A port rewrites the markup a render function emits. The rest of the
   application reaches into that markup by element id, by class, by data
   attribute and by inline handler. Drop one and nothing throws — the code
   that wanted it just does nothing:

     const el = document.getElementById('pti-queue-status');
     if (!el || !sb || !isAdmin()) return;        // silent

   That is the failure mode this catches. For every function present in both
   the baseline and the working tree it extracts the contract surface and
   reports what the baseline emitted and the working tree no longer does.

   Losses are failures. Additions are not — new markup is the point of a port.

   What counts as contract surface
     ids               every one; an id exists to be looked up
     data-* attributes read via dataset by delegated listeners
     inline handlers   onclick="doSendLinkFromPicker()" and friends
     classes           only those the codebase actually queries. Styling
                       classes change freely during a port — .btn becoming
                       .v2-btn-send is the work, not a regression — but
                       .mark-repaired-btn is bound by querySelectorAll and is
                       as load-bearing as any id.
   ========================================================================== */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'main';
const SOURCES = ['js/app.js', 'js/reminders.js'];

function fromGit(ref, file) {
  try {
    return execFileSync('git', ['show', ref + ':' + file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch { return null; }
}

/* Collapse the dynamic part of a built string so 'vcard-' + v.id + '' and
   `vcard-${v.id}` both normalise to vcard-*, comparable across versions. */
const norm = s => s
  .replace(/'\s*\+[\s\S]*?\+\s*'/g, '*')
  .replace(/"\s*\+[\s\S]*?\+\s*"/g, '*')
  .replace(/\$\{[\s\S]*?\}/g, '*')
  .replace(/\s+/g, ' ')
  .trim();

const all = (re, src, fn) => {
  const out = new Set();
  for (const m of src.matchAll(re)) { const v = fn(m); if (v) (Array.isArray(v) ? v : [v]).forEach(x => x && out.add(x)); }
  return out;
};

/* Classes the codebase queries by name — the only ones a port must preserve. */
function queriedClasses(sources) {
  const joined = sources.join('\n');
  const out = new Set();
  for (const re of [
    /querySelectorAll?\(\s*['"`]([^'"`]+)['"`]/g,
    /closest\(\s*['"`]([^'"`]+)['"`]/g,
    /classList\.(?:contains|toggle|add|remove)\(\s*['"`]([^'"`]+)['"`]/g,
    /getElementsByClassName\(\s*['"`]([^'"`]+)['"`]/g,
  ]) {
    for (const m of joined.matchAll(re)) {
      for (const cls of m[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(cls[1]);
      if (re.source.includes('classList') || re.source.includes('ClassName')) {
        m[1].split(/\s+/).filter(Boolean).forEach(c => { if (!/[.#\[\]:>]/.test(c)) out.add(c); });
      }
    }
  }
  return out;
}

function surface(body, queried) {
  const ids = all(/\bid="([^"]*)"/g, body, m => norm(m[1]));
  const data = all(/\s(data-[a-z-]+)=/g, body, m => m[1]);
  const handlers = all(/\son(?:click|change|input|submit|keydown|keyup|blur|focus)="([^"]*)"/g, body,
    m => [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(h => h[1] + '()'));
  const classes = new Set();
  for (const m of body.matchAll(/\bclass="([^"]*)"/g)) {
    for (const c of norm(m[1]).split(/\s+/)) if (queried.has(c)) classes.add(c);
  }
  return { ids, data, handlers, classes };
}

function grab(src, name) {
  const m = new RegExp('(?:async )?function ' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let depth = 0, i = src.indexOf('{', m.index), j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) { j++; break; }
  }
  // strip CR so a checkout with different line endings is not read as a rewrite
  return src.slice(m.index, j).replace(/\r/g, '');
}

/* ── gather ──────────────────────────────────────────────────────────────── */
const baseSrc = {}, currSrc = {};
for (const f of SOURCES) {
  const b = fromGit(BASE, f);
  if (b === null) { console.error('  cannot read ' + f + ' at "' + BASE + '"'); process.exit(2); }
  baseSrc[f] = b;
  currSrc[f] = fs.readFileSync(f, 'utf8');
}
/* Only the CURRENT source decides what counts as a queried class, because the
   current source is what will run. Including the baseline's queries made a
   class look load-bearing after it had been retired along with its only
   querier: renaming .rem-tab to .v2-subtab, and updating remSwitchTab in the
   same commit, was reported as a dropped contract even though nothing looks
   for .rem-tab any more.

   This does not weaken the check that matters. Dropping a class from markup
   while the code still queries it — the actual failure mode — is still caught,
   because that query is still in the current source. */
const queried = queriedClasses(Object.values(currSrc));

/* ── 1. differential: what did a port drop? ──────────────────────────────── */
console.log('  baseline: ' + BASE + '\n');
let losses = 0, compared = 0;
const KIND = { ids: 'id', data: 'data attribute', handlers: 'inline handler', classes: 'queried class' };

for (const f of SOURCES) {
  const names = [...baseSrc[f].matchAll(/(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  for (const name of [...new Set(names)]) {
    const a = grab(baseSrc[f], name), b = grab(currSrc[f], name);
    if (a === null || b === null) continue;
    compared++;
    if (a === b) continue;                        // untouched, nothing to compare
    const sa = surface(a, queried), sb = surface(b, queried);
    const dropped = [];
    for (const k of Object.keys(KIND)) {
      for (const v of sa[k]) if (!sb[k].has(v)) dropped.push(KIND[k] + '  ' + v);
    }
    if (dropped.length) {
      losses += dropped.length;
      console.log('  ' + f + ' :: ' + name + '  — DROPPED ' + dropped.length);
      dropped.forEach(d => console.log('      ' + d));
    } else {
      const kept = Object.keys(KIND).reduce((n, k) => n + sa[k].size, 0);
      console.log('  ' + f + ' :: ' + name + '  rewritten, all ' + kept + ' contracts kept');
    }
  }
}

/* ── 2. resolution: does every literal lookup have an emitter? ───────────── */
const emitted = new Set();
for (const src of Object.values(currSrc)) for (const m of src.matchAll(/\bid="([^"]*)"/g)) emitted.add(norm(m[1]));
for (const html of fs.readdirSync('.').filter(f => f.endsWith('.html')))
  for (const m of fs.readFileSync(html, 'utf8').matchAll(/\bid="([^"]*)"/g)) emitted.add(m[1]);

const wildcards = [...emitted].filter(e => e.includes('*')).map(e => new RegExp('^' + e.replace(/[.*+?^${}()|[\]\\]/g, r => r === '*' ? '.+' : '\\' + r) + '$'));
const resolves = id => emitted.has(id) || wildcards.some(re => re.test(id));

const lookups = new Set();
for (const src of Object.values(currSrc))
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) lookups.add(m[1]);

const unresolved = [...lookups].filter(id => !resolves(id)).sort();
console.log('\n  ' + lookups.size + ' literal getElementById lookups, ' + (lookups.size - unresolved.length) + ' resolve to emitted markup');
if (unresolved.length) {
  console.log('  no emitter found for ' + unresolved.length + ':');
  unresolved.forEach(id => console.log('      ' + id));
  console.log('  (a lookup with no emitter is dead code or a broken contract — check by hand)');
}

console.log('\n  ' + compared + ' functions compared');
console.log('  dropped contracts: ' + (losses || 'NONE'));
if (losses) {
  console.log('\n  Each of these was reachable before and is not now. The code that');
  console.log('  looks it up will fail silently. See v2/PORTING.md section 3.');
}
process.exit(losses ? 1 : 0);
