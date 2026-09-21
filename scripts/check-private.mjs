// Can a client see what the agency earns?
//
// The rule is one sentence and it is not negotiable: a page or an email a
// client reads never carries the commission, the split, what the agency takes
// or what an advisor is paid. Everything else in this portal is a judgement
// about convenience. This one is a promise to the people whose trips pay for
// all of it, and the cost of breaking it is not a bug report.
//
// It held before this check existed, and it held the way the sending rule
// held: by nobody having written the line yet. The trip page selected the
// whole reservation row, so commission_cents, the split, the agreed
// percentages, the lead source and the advisor's private notes were all in
// the template's scope, and one `${b.commission_cents}` typed by somebody
// reading the wrong column list would have published them to anybody holding
// a link. Nothing would have failed. The page would have rendered.
//
// So two rules over the files that render to a client:
//
//   1. None of the private names appear in the code at all. Not in a query,
//      not in a template, not in a helper. Comments are stripped first,
//      because explaining why commission is absent is the opposite of a leak.
//   2. Nothing selects a whole row from bookings. A named column list cannot
//      print a column it never fetched, which is a guarantee; "nobody has
//      printed it yet" is a hope.
//
//   node scripts/check-private.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every module that renders something a client reads, or builds the document
// one is sent. A new one belongs here the day it is written.
const CLIENT_FACING = [
  'share.js',      // the trip page at /t/<code>
  'hub.js',        // the client's own page at /c/<code>
  'publicform.js', // the public form and the group sign-up page
  'statement.js',  // the invoice and the quote a client is sent
  'reviews.js',    // the "how was it" form on the trip page
];

// What a client must never be shown, by the name the code would use.
const PRIVATE = [
  'commission_cents', 'commission_status', 'commission_pct', 'commission_kind',
  'advisor_split_pct', 'agreed_split_pct', 'agreed_lead_split_pct', 'lead_source',
  'commissionCents', 'advisorCents', 'agencyCents', 'payoutCents', 'payout_cents',
  'agency_received_cents', 'split_pct', 'advisor_cents',
];

/** Comments are prose about the code, not the code. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*/gm, '')
    .replace(/(?<![:\w])\/\/[^\n]*/g, '');
}

/**
 * The SQL of every env.DB.prepare in a file.
 *
 * The same walk check-scope does, for the same reason: a rule about what a
 * query selects has to be applied to one query at a time.
 */
function statements(src) {
  const out = [];
  const marker = 'env.DB.prepare(';
  let at = src.indexOf(marker);
  while (at !== -1) {
    let i = at + marker.length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    const quote = src[i];
    if (quote === '`' || quote === "'" || quote === '"') {
      i += 1;
      let sql = '';
      while (i < src.length) {
        if (src[i] === '\\') { sql += src[i] + src[i + 1]; i += 2; continue; }
        if (src[i] === quote) break;
        sql += src[i];
        i += 1;
      }
      out.push(sql);
    }
    at = src.indexOf(marker, at + marker.length);
  }
  return out;
}

let problems = 0;
let checked = 0;

for (const file of CLIENT_FACING) {
  const path = join(ROOT, 'src', file);
  if (!existsSync(path)) {
    problems += 1;
    annotate('Private', `check-private lists src/${file}, which does not exist: `
      + 'either it was renamed, in which case fix the list, or the page it rendered is gone');
    console.log(`FAIL  src/${file} is in the list and not in src/`);
    continue;
  }
  checked += 1;
  const body = code(readFileSync(path, 'utf8'));

  const found = PRIVATE.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
  if (found.length) {
    problems += 1;
    annotate('Private', `src/${file} names ${found.join(', ')}, and a client reads what `
      + 'this file renders');
    console.log(`FAIL  src/${file} names ${found.join(', ')}`);
    console.log('        a client reads what this file renders');
  }

  // A whole row from bookings brings every one of those columns with it.
  //
  // Per statement rather than by a window of characters. The first version
  // allowed 400 characters between the star and the FROM, which a twenty
  // column list walks straight past: the injected `SELECT b.*, b.client_name,
  // ...` that this rule exists to catch sat 550 characters from its own FROM
  // and passed. A statement is the right unit, and COUNT(*) is excluded by
  // the lookahead rather than by hoping it falls outside a window.
  for (const sql of statements(body)) {
    if (!/FROM\s+bookings\b/i.test(sql)) continue;
    if (!/(?:SELECT|,)\s*(?:[A-Za-z_]\w*\.)?\*(?!\s*\))/i.test(sql)) continue;
    problems += 1;
    const one = sql.replace(/\s+/g, ' ').slice(0, 90);
    annotate('Private', `src/${file} selects a whole row from bookings: ${one}`);
    console.log(`FAIL  src/${file} selects a whole row from bookings`);
    console.log(`        ${one}`);
  }

  if (!found.length) console.log(`ok    src/${file}`);
}

console.log('');
if (problems) {
  console.log(`${problems} place${problems === 1 ? '' : 's'} a client could be shown what the agency earns.`);
  process.exit(1);
}
console.log(`All ${checked} client-facing modules keep the money out of sight.`);
