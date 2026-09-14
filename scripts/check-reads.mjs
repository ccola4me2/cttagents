// Does a handler read a column its query never gave it?
//
// The failure is silent. A missing property is undefined, not an error, so the
// field is simply always blank or nought and nothing throws. It is found weeks
// later by somebody wondering why a number is always zero.
//
// It has happened here more than once. r.lifetime against r.lifetimeCents. And
// the one this was written for: proposals.js crossed to the other portal
// reading view_count, viewed_first_at and viewed_last_at, which that portal's
// bookings table did not have. No error. stateOf took the "nobody opened it"
// branch every time, so every proposal ever sent was filed under "Sent, not
// opened" and the advisor was told to send it again.
//
// check-columns reads the shared SELECT constants against the schema. This is
// the other end: what the JavaScript actually reaches for.
//
// Deliberately narrow, because the alternative is noise:
//
//   - Only snake_case properties. That is what a database column looks like
//     and what nothing else in this codebase is named.
//   - A name is fine if any table in the expected schema has it, or if any
//     query in src/ declares it with AS, or if any object literal in src/
//     builds it. A derived field is as real as a column.
//   - Quoted strings are stripped first, so a Stripe event named
//     'invoice.payment_failed' is not read as a property.
//
// What is left is a snake_case read that is no column, no alias and no field
// anything builds, which is almost always a typo for one of the three.
//
//   node scripts/check-reads.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// Shapes that come from somewhere other than this database, and what they are.
// Every entry is a claim somebody checked, which is the point of writing it
// down rather than widening the rule until nothing fails.
const ALLOWED = new Map([
  ['catalog.js', 'the CruiseFeed catalog response, whose field names are theirs and not ours'],
  ['catalogmirror.js', 'the same response, on the way into the mirror'],
]);

const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();

/**
 * Quoted strings out, so a dotted string literal is not read as a property.
 *
 * A line at a time, deliberately. Run over the whole file, the apostrophe in a
 * comment reading "this year's fee" opens a string that closes at the next
 * quote several lines later, swallowing real code and shifting every line
 * number after it. That is not hypothetical: it is what this check reported on
 * its first run. Neither quote spans a line in this codebase, so a line is the
 * safe unit and a stray apostrophe can only spoil its own.
 */
const unquoted = (s) => s.split('\n')
  .map((line) => line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""'))
  .join('\n');

// Every column the migrations describe, whatever the table.
const schema = readFileSync(join(SRC, 'schema-expected.js'), 'utf8');
const known = new Set();
for (const line of schema.match(/EXPECTED_SCHEMA = \{[\s\S]*?\n\};/)[0].split('\n')) {
  const m = line.match(/^\s*\w+: \[(.*)\],/);
  if (m) for (const c of m[1].split(',')) known.add(c.trim().replace(/'/g, ''));
}

// Names the code itself makes: a SELECT alias, or a key on an object it builds.
// Gathered across the whole of src, because a query lives in db.js and is read
// in a handler. Only snake_case keys, so a ternary's colon is not an alias.
const aliases = new Set();
for (const f of files) {
  const s = readFileSync(join(SRC, f), 'utf8');
  for (const m of s.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)) aliases.add(m[1]);
  for (const m of s.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\s*:/g)) aliases.add(m[1]);
  // A form's own field names. A submission is read by the key the form
  // declares, so key: 'travel_date' makes data.travel_date as real as a column,
  // and a typo for it is still caught because only the declared spelling counts.
  for (const m of s.matchAll(/\bkey:\s*'([a-z_][a-z0-9_]*)'/g)) aliases.add(m[1]);
}

// Receivers that are modules and namespaces rather than rows.
const NOT_A_ROW = new Set(['db', 'env', 'url', 'window', 'document', 'location',
  'process', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'console']);

let problems = 0;
let checked = 0;
let excused = 0;

for (const f of files) {
  if (f === 'schema-expected.js') continue;
  const raw = readFileSync(join(SRC, f), 'utf8');
  const s = unquoted(raw);
  const why = ALLOWED.get(f);

  for (const m of s.matchAll(/\b([a-z][a-zA-Z0-9]*)\.([a-z]+(?:_[a-z0-9]+)+)\b/g)) {
    const [, obj, field] = m;
    if (NOT_A_ROW.has(obj)) continue;
    checked += 1;
    if (known.has(field) || aliases.has(field)) continue;
    if (why) { excused += 1; continue; }
    problems += 1;
    const line = s.slice(0, m.index).split('\n').length;
    annotate('Reads', `src/${f}:${line} reads ${obj}.${field}, which is no column, `
      + 'no alias and nothing this code builds');
    console.log(`FAIL  src/${f}:${line}  ${obj}.${field} comes back undefined`);
    console.log('        It is no column, no SELECT alias, and no field anything here builds.');
  }
}

if (problems) {
  console.log(`\n${problems} read${problems === 1 ? '' : 's'} with nothing behind ${
    problems === 1 ? 'it' : 'them'}.`);
  process.exit(1);
}
console.log(`check-reads: ${checked} snake_case reads, every one of them real`
  + `${excused ? `, ${excused} excused as an outside shape` : ''}.`);
