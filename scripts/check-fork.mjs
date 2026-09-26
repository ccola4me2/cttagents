// Did a fix cross the fork, or only half of it?
//
// cttagents and trip-vara are the same portal with different names on it. Most
// of src/ is identical, and the two drift a file at a time: something is fixed
// on one side and the other is never told. That has cost real bugs. The Clients
// page on trip-vara threw on load from the day households shipped, because the
// script crossed and the markup did not. proposals.js crossed without the
// migration its columns needed, so every sent proposal was filed under "nobody
// opened it" and an advisor was advised to send it again.
//
// Text diffing the two is useless: it is dominated by the word CTT against the
// words Trip Vara, a logo extension, a bucket name. So this compares what each
// side *declares* rather than what it says, which drops comments and titles for
// free.
//
// One rule fails the build, and it is deliberately narrow: two shared modules
// must export the same surface. An export is the contract between files, and a
// module that has grown or lost one on a single side is a port that stopped
// half way. Everything else is printed as a report for somebody about to port
// something, and fails nothing, because pages legitimately differ and a rule
// that is mostly exceptions is worse than no rule.
//
//   node scripts/check-fork.mjs                  the sibling beside this repo
//   node scripts/check-fork.mjs ../somewhere     an explicit one
//
// Skips itself, with a message rather than silently, when the sibling is not
// checked out. A check that quietly passes because it did not run is worse
// than one that is not there.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Which portal this is, and which one it is compared against. Written down
// rather than read off the directory name, because the directory name is not
// the portal: CI checks the other one out at a path called "sibling", and
// inferring identity from that made every exception recorded against the other
// portal stop matching. The first thing this check did on its first real run
// was fail on itself for that.
const HERE = 'cttagents';
const THERE = 'trip-vara-website';

// Exports one side has and the other does not, and why that is right. Every
// entry is a claim somebody checked, which is the point of writing it down
// rather than widening the rule until nothing fails.
//
// Keyed "file:name", valued with the portal that should have it and the reason.
const ALLOWED = new Map([
  ['admin.js:handleCreateAdvisor', ['cttagents', 'an owner creates advisors here; trip-vara advisors apply through a join link']],
  ['admin.js:handleReissueInvite', ['cttagents', 'same: there are no invites where people sign themselves up']],
  ['admin.js:handleStartActing', ['cttagents', 'working as an advisor is a cttagents feature']],
  ['admin.js:handleStopActing', ['cttagents', 'the other half of working as an advisor']],
  ['auth.js:realUserOf', ['cttagents', 'who you really are while acting as somebody else']],
  ['auth.js:handleSignup', ['trip-vara-website', 'the join link, which cttagents does not offer']],
  ['email.js:sendTrialNoticeEmail', ['trip-vara-website', 'telling somebody their fourteen day demo is running out. cttagents has no demos to run out']],
  ['auth.js:requirePlatformOwner', ['trip-vara-website', 'the second admin gate, needed because trip-vara signs demo agencies up on their own: role admin stopped meaning somebody approved by hand. cttagents creates every advisor by invitation, so its admins are all trusted and the gate would guard nothing. If cttagents ever opens a self serve signup it inherits this hole and wants this gate on the same ten handlers']],
  ['auth.js:trialOver', ['trip-vara-website', 'the fourteen day demo, which only trip-vara offers: cttagents has no self serve signup to run one from']],
  ['agencies.js:handleJoinInfo', ['trip-vara-website', 'what the join page shows before somebody applies']],
  ['db.js:RESERVATION_STAGES', ['cttagents', 'the reservation board, cttagents only']],
  ['db.js:reservationPipeline', ['cttagents', 'the reservation board, cttagents only']],
  ['db.js:clientKeys', ['cttagents', 'used by the prospect list, which trip-vara does not render']],
  ['db.js:getBilling', ['cttagents', 'advisor billing through Stripe, cttagents only']],
  ['db.js:getBillingByCustomer', ['cttagents', 'advisor billing through Stripe, cttagents only']],
  ['db.js:saveBilling', ['cttagents', 'advisor billing through Stripe, cttagents only']],
  ['db.js:setSessionActingAs', ['cttagents', 'working as an advisor is a cttagents feature']],
  ['db.js:openTasksBetween', ['cttagents', 'the month calendar reads it; trip-vara has no calendar widget']],
  ['email.js:sendAdvisorInviteEmail', ['cttagents', 'there are no invites where people sign themselves up']],
  ['email.js:fromAs', ['cttagents', 'sending as the agency for a broadcast, cttagents only']],
  ['itinerary.js:handleReorderItinerary', ['cttagents', 'dragging itinerary items, cttagents only']],
  ['split.js:COMPANY_LEAD', ['cttagents', 'a second commission rate for company-supplied leads, cttagents only']],
]);

const sibling = process.argv[2] || join(ROOT, '..', THERE);
if (!existsSync(sibling) || !statSync(sibling).isDirectory()) {
  console.log(`check-fork: skipped, ${sibling} is not checked out.`);
  console.log('            Pass a path to compare against a different copy.');
  process.exit(0);
}

/** The names a module hands to other modules. */
function exportsOf(path) {
  const s = readFileSync(path, 'utf8');
  const out = new Set();
  for (const m of s.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) out.add(m[1]);
  for (const m of s.matchAll(/^export\s+const\s+(\w+)/gm)) out.add(m[1]);
  for (const m of s.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.split(' as ').pop().trim();
      if (name) out.add(name);
    }
  }
  return out;
}

/** The ids and data attributes a page declares, for the report. */
function markupOf(path) {
  const s = readFileSync(path, 'utf8');
  const out = new Set();
  for (const m of s.matchAll(/\bid="([\w-]+)"/g)) out.add(`#${m[1]}`);
  for (const m of s.matchAll(/\bdata-([a-z][\w-]*)\s*[=>\s]/g)) out.add(`[data-${m[1]}]`);
  return out;
}

const listing = (dir, ext) => (existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

// ---------------------------------------------------------------------------
// The rule: shared modules export the same surface
// ---------------------------------------------------------------------------
let problems = 0;
let compared = 0;

for (const file of listing(join(ROOT, 'src'), '.js')) {
  const mine = join(ROOT, 'src', file);
  const theirs = join(sibling, 'src', file);
  if (!existsSync(theirs)) continue;
  if (file === 'schema-expected.js') continue;
  compared += 1;

  const a = exportsOf(mine);
  const b = exportsOf(theirs);
  for (const [name, side] of [...[...a].filter((n) => !b.has(n)).map((n) => [n, HERE]),
    ...[...b].filter((n) => !a.has(n)).map((n) => [n, THERE])]) {
    const excuse = ALLOWED.get(`${file}:${name}`);
    if (excuse && excuse[0] === side) continue;
    problems += 1;
    annotate('Fork', `src/${file} exports ${name} on ${side} and not on the other portal`);
    console.log(`FAIL  src/${file}  ${name} is exported on ${side} only`);
    console.log(excuse
      ? `        recorded as ${excuse[0]} only, but it is on ${side}: ${excuse[1]}`
      : '        Port it, or record why it belongs to one portal in ALLOWED above.');
  }
}

// ---------------------------------------------------------------------------
// The report: what a page declares on one side and not the other
// ---------------------------------------------------------------------------
const drift = [];
for (const dir of ['public/app', 'public/js']) {
  for (const file of listing(join(ROOT, dir), dir.endsWith('js') ? '.js' : '.html')) {
    const mine = join(ROOT, dir, file);
    const theirs = join(sibling, dir, file);
    if (!existsSync(theirs)) continue;
    const a = markupOf(mine);
    const b = markupOf(theirs);
    const onlyMine = [...a].filter((n) => !b.has(n)).sort();
    const onlyTheirs = [...b].filter((n) => !a.has(n)).sort();
    if (onlyMine.length || onlyTheirs.length) {
      drift.push([`${dir}/${file}`, onlyMine, onlyTheirs]);
    }
  }
}

if (drift.length) {
  console.log(`\nPages that declare different things. Not a failure: these differ on`);
  console.log(`purpose more often than not. Worth reading before porting one.\n`);
  for (const [file, onlyMine, onlyTheirs] of drift) {
    console.log(`  ${file}`);
    if (onlyMine.length) console.log(`      ${HERE} only:  ${onlyMine.join(' ')}`);
    if (onlyTheirs.length) console.log(`      ${THERE} only: ${onlyTheirs.join(' ')}`);
  }
}

console.log(`\ncheck-fork: ${compared} shared modules compared against ${THERE}.`);
if (problems) {
  console.log(`${problems} export${problems === 1 ? '' : 's'} on one side only and unaccounted for.`);
  process.exit(1);
}
console.log('Every shared module exports the same surface, or says why not.');
