// Does KEEP_IF_ABSENT still cover everything the full save writes?
//
// PUT /api/bookings/:id saves the whole reservation, so every field
// parseBooking produces is written on every save, whether or not the request
// carried a value for it. KEEP_IF_ABSENT is what makes that safe: a field the
// request never mentioned is taken back off the record instead of being
// written from whatever the parser defaulted to.
//
// The rule only works while the list is complete, and an incomplete list fails
// silently and expensively. Taking the Totals box off the reservation page left
// the form without a trip total or a commission, and from that moment saving a
// confirmation number wrote zero over both. Nothing threw. Nothing on screen
// says a figure has gone; a reservation with no money on it looks like a
// reservation somebody has not finished entering.
//
// So a field added to parseBooking and not added to KEEP_IF_ABSENT fails here,
// and so does one left in the list after the parser stops producing it.
//
//   node scripts/check-keep.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Not the request's to set at any time. It is read off the record
// unconditionally, a few lines below the call, and letting a request carry it
// is the commission-split hole that endpoint was closed for.
const EXEMPT = new Set(['advisorSplitPct']);

const src = readFileSync(join(ROOT, 'src/bookings.js'), 'utf8');

function slice(from, to) {
  const i = src.indexOf(from);
  if (i === -1) throw new Error(`check-keep: could not find ${from}`);
  const j = src.indexOf(to, i);
  if (j === -1) throw new Error(`check-keep: could not find the end of ${from}`);
  return src.slice(i, j);
}

// Both spellings. Eight of these are shorthand, because parseBooking builds
// them as locals first so it can validate them against each other, and a
// reader that only saw `name:` would report the whole lot as missing.
const body = slice('function parseBooking(', '\n}');
const produced = new Set();
for (const m of body.matchAll(/^ {6}(\w+)\s*[:,]\s*$/gm)) produced.add(m[1]);
for (const m of body.matchAll(/^ {6}(\w+):/gm)) produced.add(m[1]);

const list = slice('const KEEP_IF_ABSENT = [', '\n];');
const kept = new Set([...list.matchAll(/\[\s*'(\w+)'/g)].map((m) => m[1]));

let problems = 0;
const line = (needle) => src.slice(0, src.indexOf(needle)).split('\n').length;

for (const field of [...produced].sort()) {
  if (kept.has(field) || EXEMPT.has(field)) continue;
  const message = `${field} is written on every save and is not in KEEP_IF_ABSENT, `
    + 'so a request that does not carry it will overwrite it with whatever '
    + 'parseBooking defaults to.';
  problems += 1;
  console.log(`FAIL  src/bookings.js:${line('const KEEP_IF_ABSENT')}  ${message}`);
  annotate({ file: 'src/bookings.js', line: line('const KEEP_IF_ABSENT'), message });
}

for (const field of [...kept].sort()) {
  if (produced.has(field)) continue;
  const message = `${field} is in KEEP_IF_ABSENT and parseBooking no longer produces it.`;
  problems += 1;
  console.log(`FAIL  src/bookings.js:${line('const KEEP_IF_ABSENT')}  ${message}`);
  annotate({ file: 'src/bookings.js', line: line('const KEEP_IF_ABSENT'), message });
}

console.log(`\n${problems} problem(s); ${produced.size} field(s) written, `
  + `${kept.size} kept when absent, ${EXEMPT.size} exempt`);
process.exit(problems ? 1 : 0);
