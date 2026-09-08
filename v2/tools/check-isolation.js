#!/usr/bin/env node
/* ==========================================================================
   v2 isolation check — run from the repo root:  node v2/tools/check-isolation.js

   Answers one question: can every v2 stylesheet be linked into the live
   index.html without changing a pixel outside a v2 subtree?

   A selector is isolated when the element it actually styles is a v2 element.
   That is true two ways: the selector starts .v2- (so it is confined to a v2
   subtree — .v2-app :is(a, button):focus-visible only reaches inside the v2
   frame), or its subject, the rightmost compound, is .v2- prefixed (so a
   production ancestor may appear as context — .light .v2-region styles the
   region, not .light). :root is allowed, for custom properties. A bare `body`,
   `a` or `*` reaches the whole application and is a hard failure.

   v2-staging-reset.css is the one deliberate exception: it holds the globals
   the standalone v2/*.html pages need, and the live app never links it. See
   v2/PORTING.md section 1.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'css');
const STAGING_ONLY = 'v2-staging-reset.css';
const SCOPED  = /^(\.v2-|:root\b)/;         // .v2-app a  — confined to a v2 subtree
const V2_PART = /\.v2-/;                    // .light .v2-region — subject is the v2 element

/* Rightmost compound: what the selector actually styles. Combinators only
   count at paren depth 0, so :is(.a > .b) stays one compound. */
function subject(sel) {
  let depth = 0, out = '';
  for (const c of sel) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) { out = ''; continue; }
    out += c;
  }
  return out;
}

const isIsolated = sel => SCOPED.test(sel) || V2_PART.test(subject(sel));

/* Split a selector list on top-level commas only, so the commas inside
   :is(a, button, input) do not read as three separate selectors. */
function selectorList(src) {
  const out = [];
  let depth = 0, buf = '';
  for (const c of src) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out.map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/* Walk brace depth and collect the selector that opens each rule. Rules nested
   directly inside @media / @supports / @layer are collected too; anything
   deeper (a descriptor block in @font-face, keyframe stops) is not a selector. */
function rules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let depth = 0, buf = '', pending = null, blockStart = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      const sel = buf.trim(); buf = '';
      const atRule = sel.startsWith('@');
      const nestable = atRule && /^@(media|supports|layer|container)\b/.test(sel);
      if (!atRule && (depth === 0 || stack[depth - 1] === 'nestable')) {
        pending = selectorList(sel);
        blockStart = i + 1;
      }
      stack[depth] = nestable ? 'nestable' : 'opaque';
      depth++;
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
      if (pending) { out.push(...pending.map(s => ({ sel: s, body: src.slice(blockStart, i) }))); pending = null; }
      buf = '';
    }
    else buf += c;
  }
  return out;
}

/* A rule that declares ONLY --v2- custom properties cannot change anything
   outside the v2 layer, whatever its selector: it paints nothing itself, and
   only a v2 component reads those names. That is what lets the light theme
   live on a bare `.light` — the same shape :root already gets.

   The restriction to --v2- names is the whole safety argument, and it is not
   cosmetic. `.light { --primary: red }` declares only a custom property too,
   and would repaint production's buttons. v2-skin.css does exactly that on
   purpose and is the documented exception, scoped :root:not(.light). */
function tokensOnly(body) {
  const decls = body.split(';').map(d => d.trim()).filter(Boolean);
  if (!decls.length) return false;
  return decls.every(d => /^--v2-[a-z0-9-]+\s*:/.test(d));
}

let failures = 0, checked = 0, safeCount = 0;
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.css')).sort();

for (const file of files) {
  const parsed = rules(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const sels = parsed.map(r => r.sel);
  const leaks = parsed.filter(r => !isIsolated(r.sel) && !tokensOnly(r.body)).map(r => r.sel);
  checked++;
  safeCount += sels.length - leaks.length;

  if (file === STAGING_ONLY) {
    console.log(`  ${file.padEnd(24)} ${sels.length} selectors  [staging only — globals expected, never linked in index.html]`);
    continue;
  }
  if (leaks.length) {
    failures += leaks.length;
    console.log(`  ${file.padEnd(24)} ${leaks.length} LEAK${leaks.length > 1 ? 'S' : ''}`);
    leaks.forEach(s => console.log(`      ${s}`));
  } else {
    console.log(`  ${file.padEnd(24)} ${String(sels.length).padStart(3)} selectors  ok`);
  }
}

console.log(`\n  ${checked} sheets, ${safeCount} isolated selectors`);
console.log(`  leaked selectors outside ${STAGING_ONLY}: ${failures}`);
if (failures) {
  console.log('\n  A leaked selector would change the live application. Prefix it .v2-,');
  console.log('  or scope it under .v2-app / .v2-region. See v2/PORTING.md section 1.');
}
process.exit(failures ? 1 : 0);
