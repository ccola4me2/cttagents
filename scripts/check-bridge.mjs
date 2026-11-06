// The Trip Vara bridge, without either portal running.
//
// What this guards is not the happy path, which a sheet shows you. It is the
// four ways it can go wrong quietly:
//
//   The other portal is slow, or mid deploy, or has no shared secret set. A
//   cabin sheet that will not open because of any of those is worse than one
//   missing a row somebody can still type in, so every failure has to come
//   back as an empty list rather than an exception.
//
//   Two portals mean two id spaces in one booking_id column. A row has to say
//   which database to go and ask, or a Trip Vara reservation gets looked up
//   here, is not found, and silently stops being kept true.
//
//   The answer is cached for a few seconds because the desk overview refreshes
//   every group it lists. A cache that outlives a write would show yesterday.
//
//   node scripts/check-bridge.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { tripVaraPeople, forgetTripVara } = await import(join(ROOT, 'src', 'peertv.js'));

let checks = 0;
let failures = 0;
function check(cond, label, detail) {
  checks += 1;
  if (cond) { console.log(`  ok    ${label}`); return true; }
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::bridge: ${label}`);
  return false;
}

// A database that answers the one question peertv asks it.
const dbWith = (rows) => ({
  prepare: () => ({ all: async () => ({ results: rows }) }),
});
const MEMBERS = [{ email: 'lori@example.com', first_name: 'Lori', last_name: 'Judd' }];

const peerReturning = (body, { ok = true, slow = 0 } = {}) => ({
  fetch: async () => {
    if (slow) await new Promise((r) => setTimeout(r, slow));
    return { ok, json: async () => body };
  },
});

console.log('\nIt stays quiet when it cannot ask');
forgetTripVara();
check((await tripVaraPeople({ DB: dbWith(MEMBERS), PEER_SECRET: 'x'.repeat(40) })).length === 0,
  'with no service binding, nobody');
forgetTripVara();
check((await tripVaraPeople({ DB: dbWith(MEMBERS), PEER: peerReturning({ people: [] }) })).length === 0,
  'with no shared secret, nobody');
forgetTripVara();
check((await tripVaraPeople({
  DB: dbWith([]), PEER: peerReturning({ people: [{ email: 'x', bookings: [] }] }),
  PEER_SECRET: 'x'.repeat(40),
})).length === 0, 'with nobody on the desk it does not even ask');

console.log('\nAnd when the answer is no good');
for (const [label, env] of [
  ['the other portal refuses', { PEER: peerReturning({}, { ok: false }) }],
  ['it answers with nothing', { PEER: peerReturning(null) }],
  ['it answers with the wrong shape', { PEER: peerReturning({ people: 'not a list' }) }],
  ['it throws', { PEER: { fetch: async () => { throw new Error('down'); } } }],
]) {
  forgetTripVara();
  const out = await tripVaraPeople({ DB: dbWith(MEMBERS), PEER_SECRET: 'x'.repeat(40), ...env });
  check(Array.isArray(out) && out.length === 0, `${label}: an empty list, not an exception`,
    JSON.stringify(out));
}

console.log('\nWhat comes back');
forgetTripVara();
const answer = {
  people: [{
    email: 'lori@example.com', name: 'L Judd',
    bookings: [{ id: 'tv-1', cabinNo: '5235', groupNumber: '4882', totalCents: 197680 }],
  }],
};
const got = await tripVaraPeople({
  DB: dbWith(MEMBERS), PEER_SECRET: 'x'.repeat(40), PEER: peerReturning(answer),
});
check(got.length === 1, 'one person asked about is one person back');
check(got[0].name === 'Lori Judd',
  'and the desk calls them what the desk already calls them, not what the other portal said',
  got[0].name);
check(got[0].bookings[0].cabinNo === '5235', 'the cabin comes across', got[0].bookings[0].cabinNo);

console.log('\nThe cache');
let asks = 0;
const counting = {
  DB: dbWith(MEMBERS), PEER_SECRET: 'x'.repeat(40),
  PEER: { fetch: async () => { asks += 1; return { ok: true, json: async () => answer }; } },
};
forgetTripVara();
await tripVaraPeople(counting);
await tripVaraPeople(counting);
await tripVaraPeople(counting);
check(asks === 1, 'the desk overview refreshing four groups asks the other portal once',
  `asked ${asks} times`);
forgetTripVara();
await tripVaraPeople(counting);
check(asks === 2, 'and forgetting it asks again', `asked ${asks} times`);

console.log('\nThe sheet knows which database a row came from');
const cabins = readFileSync(join(ROOT, 'src', 'groupcabins.js'), 'utf8');
check(/booking_source/.test(cabins), 'refreshBridge reads booking_source');
check(/\(r\.booking_source === 'tv' \? there : here\)/.test(cabins),
  'and files each linked row under the portal it lives in');
check(/extra\.bookingSource === 'tv' \? 'tv' : 'ctt'/.test(cabins),
  'a new row records where its reservation is, defaulting to this portal');
// The early return that used to be here would have skipped the Trip Vara pass
// entirely whenever nobody on the desk had an account on this portal, which is
// the ordinary case for Lori and Dawn.
check(!/const people = await bridges\(env\);\s*\n\s*if \(!people\.length\) return;/.test(cabins),
  'and no early return stops the Trip Vara pass when nobody here is bridged');

console.log('\nAnd the way back');
const peertv = readFileSync(join(ROOT, 'src', 'peertv.js'), 'utf8');
check(/export async function takeToTripVara/.test(peertv), 'a cabin can be sent the other way');
check(/\.\.\.cabin, email \}/.test(peertv),
  'and the address goes last, so a caller cannot send somebody else\'s');
check(/return null;[\s\S]*catch/.test(peertv), 'a failure is null rather than a throw');

check(/booking_source = 'tv'/.test(cabins),
  'the row it made is linked, so the refresh keeps it in step from then on');
check(/forgetTripVara\(\)/.test(cabins),
  'and the cached answer is dropped, because it predates the reservation just made');
check(/already a reservation/.test(cabins), 'a cabin that is already linked is refused');
check(/booking number on the cabin first/.test(cabins),
  'and one with no booking number, because nothing could stop it going twice');
check(/takeToTripVara\(env, user\.email/.test(cabins),
  'it goes into the book of whoever pressed it, not the group owner\'s');

const sheet = readFileSync(join(ROOT, 'public', 'app', 'group-sheet.html'), 'utf8');
check(/data-tobook/.test(sheet), 'the sheet has the button');
check(/r\.linked \? '' :/.test(sheet), 'and shows it only on a cabin that is not one already');
check(/from \$\{r\.source === 'tv' \? 'Trip Vara' : 'CTT'\}/.test(sheet),
  'a linked row says which portal to go and change it in');

const migration = readFileSync(join(ROOT, 'migrations', '0146_group_cabin_source.sql'), 'utf8');
check(/DEFAULT 'ctt'/.test(migration), 'everything already on a sheet counts as this portal');

console.log(failures
  ? `\n${failures} of ${checks} bridge checks failed.`
  : `\ncheck-bridge: all ${checks} bridge checks passed.`);
process.exit(failures ? 1 : 0);
