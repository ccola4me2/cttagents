// Can anything put a quote in front of a client without the advisor saying so?
//
// This is the one rule in the portal where being wrong is not a bug report, it
// is a client reading a price the advisor had not finished deciding. A quote
// goes out when somebody presses send, and at no other time.
//
// It holds today, and it holds by accident. Nothing sends a quote automatically
// because no trigger context happens to carry a share code, and nobody has
// added a cron job that mails one. Both of those are one careless line away
// from changing, and neither would fail any other check here: the code would
// be correct, the tests would pass, and the first sign of trouble would be a
// client replying to a proposal nobody sent.
//
// So the rule is written down. Three parts:
//
//   1. Only the two advisor endpoints may mark a quote as sent or mint a share
//      code. If a cron job or an automation ever starts doing it, this fails.
//   2. No automation trigger may carry a share code or a /t/ link in its
//      context. An automation can say anything an advisor typed into it, and
//      giving it the address of a live proposal turns "when a booking is made,
//      email them" into "publish the quote".
//   3. The two endpoints stay behind requireUser. An unauthenticated send is
//      not a policy question.
//
//   node scripts/check-sending.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// The columns that record "a client has been shown this".
const SENDING_COLUMNS = ['quote_sent_at', 'statement_sent_at', 'share_code'];

// The only two files allowed to write them, and what each one is.
const SENDERS = new Map([
  ['statement.js', 'POST /api/bookings/:id/statement, which an advisor presses after a preview'],
  ['share.js', 'POST /api/bookings/:id/share, which an advisor presses to make the link'],
  // The third, added when the client hub shipped and only after this check
  // caught it minting codes for quotes. It is an advisor pressing a button on
  // a client record, the same act one level up, and its statement is narrowed
  // to status IN ('booked','travelled') so it cannot reach a quote. The page
  // it serves shows a quote only where a share code already exists, which is
  // to say only where somebody pressed send on that quote.
  ['hub.js', "POST /api/clients/:id/hub, which an advisor presses to give one client a page; "
    + "its write names status IN ('booked','travelled') so it can never mint a code for a quote"],
]);

const files = readdirSync(SRC).filter((f) => f.endsWith('.js'));
let problems = 0;

// ---- 1. who may say a quote has gone out ---------------------------------
for (const file of files) {
  const src = readFileSync(join(SRC, file), 'utf8');
  for (const column of SENDING_COLUMNS) {
    // A write, not a read. `SET quote_sent_at = ?` counts; selecting it does not.
    const writes = new RegExp(`(?:SET|,)\\s*${column}\\s*=`, 'g');
    if (!writes.test(src)) continue;
    if (SENDERS.has(file)) continue;
    problems += 1;
    const message = `src/${file} writes ${column}, so something other than an advisor `
      + 'pressing send can mark a quote as delivered';
    console.log(`FAIL  src/${file}`);
    console.log(`        writes ${column}`);
    console.log('        only these may: ' + [...SENDERS.keys()].join(', '));
    annotate('Sending', message);
  }
}

// ---- 2. nothing automatic may hold the address of a live proposal ---------
//
// The context object of every fireTrigger call. An automation fills its message
// from these and from nothing else, so a share code here is a share code an
// automation can email.
const LINKY = /share_code|shareCode|\/t\/\$\{|tripUrl|trip_url|shareUrl|share_url/;
for (const file of files) {
  const src = readFileSync(join(SRC, file), 'utf8');
  let at = src.indexOf('fireTrigger(');
  while (at !== -1) {
    // From the call to the end of its argument list, by brace depth.
    let depth = 0;
    let end = at;
    for (let i = at; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    const call = src.slice(at, end + 1);
    if (LINKY.test(call)) {
      problems += 1;
      const line = src.slice(0, at).split('\n').length;
      const message = `src/${file}:${line} hands a trigger the address of the trip page. `
        + 'An automation can email anything in its context, so this lets one publish a quote';
      console.log(`FAIL  src/${file}:${line}`);
      console.log('        a trigger context carries a share code or trip link');
      console.log('        an automation fills its message from the context and nothing else');
      annotate('Sending', message);
    }
    at = src.indexOf('fireTrigger(', at + 1);
  }
}

// ---- 3. and both senders stay behind a session ----------------------------
for (const [file, what] of SENDERS) {
  const src = readFileSync(join(SRC, file), 'utf8');
  if (src.includes('requireUser(')) continue;
  problems += 1;
  console.log(`FAIL  src/${file} no longer calls requireUser`);
  console.log(`        ${what}`);
  annotate('Sending', `src/${file} sends a quote without requiring a session`);
}

console.log('');
if (problems) {
  console.log(`${problems} way${problems === 1 ? '' : 's'} a quote could reach a client `
    + 'without an advisor sending it.');
  process.exit(1);
}
console.log('check-sending: a quote reaches a client only when an advisor presses send '
  + `(${SENDERS.size} endpoints may say so, ${files.length} files checked)`);
