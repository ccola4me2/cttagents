// Does the group deadline digest say the right things on the right days?
//
// A table rather than reading the code, because the last time this portal
// shipped a "which notice is due" function it looked correct and was not: the
// trial reminder returned the furthest threshold instead of the nearest, so a
// trial one day from ending saw the seven day notice already sent and went
// silent for the rest of the fortnight. Nothing but a table of days found it.
//
// Four deadlines, each with a window, each with a condition that makes it
// worth saying at all. The conditions are the half worth testing: a group
// three weeks from its option date with every cabin sold has nothing to do
// about it, and an email about it is how a reminder becomes something people
// filter.
//
//   node scripts/check-groupremind.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { noticesFor, daysTo, WINDOWS } = await import(join(ROOT, 'src', 'groupremind.js'));

let checks = 0;
let failures = 0;

function check(condition, label, detail) {
  checks += 1;
  if (condition) { console.log(`  ok    ${label}`); return true; }
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
  annotate('Group reminders', detail === undefined ? label : `${label} -- ${detail}`);
  return false;
}

const TODAY = '2026-06-01';
const day = (offset) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86400000)
  .toISOString().slice(0, 10);

const GROUP = {
  id: 'g', user_id: 'u', name: 'Test Group', cabins_held: 10,
  option_date: null, proposal_expires: null, deposit_due: null, passport_due: null,
};
const QUIET = { sold: 10, unbooked: 0, missingPassport: 0 };

const kinds = (group, facts) => noticesFor({ ...GROUP, ...group }, { ...QUIET, ...facts }, TODAY)
  .map((n) => n.kind).sort();

console.log('\nCounting days');
check(daysTo(day(0), TODAY) === 0, 'today is nought');
check(daysTo(day(1), TODAY) === 1, 'tomorrow is one');
check(daysTo(day(-1), TODAY) === -1, 'yesterday is minus one');
check(daysTo(null, TODAY) === null, 'no date is null, not nought');
check(daysTo('not-a-date', TODAY) === null, 'and neither is rubbish');

console.log('\nNothing to say');
check(kinds({}, {}).length === 0, 'a group with no dates says nothing');
check(kinds({ option_date: day(3) }, {}).length === 0,
  'an option date three days out with every cabin sold says nothing',
  JSON.stringify(kinds({ option_date: day(3) }, {})));
check(kinds({ deposit_due: day(3) }, {}).length === 0,
  'a deposit date with every party booked says nothing');
check(kinds({ passport_due: day(3) }, {}).length === 0,
  'a passport date with every passport in says nothing');

console.log('\nThe option date');
const unsold = { sold: 4 };
for (const [offset, want] of [[0, true], [1, true], [WINDOWS.option, true],
  [WINDOWS.option + 1, false], [-1, true], [-7, true], [-8, false]]) {
  const got = kinds({ option_date: day(offset) }, unsold).includes('option');
  check(got === want,
    `${offset} days out with cabins left: ${want ? 'says so' : 'says nothing'}`,
    `got ${got}`);
}

console.log('\nThe proposal expiry');
for (const [offset, want] of [[0, true], [WINDOWS.proposal, true],
  [WINDOWS.proposal + 1, false], [-3, true], [-4, false]]) {
  const got = kinds({ proposal_expires: day(offset) }, {}).includes('proposal');
  check(got === want, `${offset} days out: ${want ? 'says so' : 'says nothing'}`, `got ${got}`);
}
check(kinds({ proposal_expires: day(2) }, {}).includes('proposal'),
  'and it does not need anything unsold, because the terms lapse either way');

console.log('\nThe deposit date');
for (const [offset, want] of [[0, true], [WINDOWS.deposit, true],
  [WINDOWS.deposit + 1, false], [-7, true], [-8, false]]) {
  const got = kinds({ deposit_due: day(offset) }, { unbooked: 2 }).includes('deposit');
  check(got === want, `${offset} days out with parties unbooked: ${want ? 'says so' : 'says nothing'}`,
    `got ${got}`);
}

console.log('\nThe passport date');
for (const [offset, want] of [[0, true], [WINDOWS.passport, true],
  [WINDOWS.passport + 1, false], [-14, true], [-15, false]]) {
  const got = kinds({ passport_due: day(offset) }, { missingPassport: 3 }).includes('passport');
  check(got === want, `${offset} days out with passports missing: ${want ? 'says so' : 'says nothing'}`,
    `got ${got}`);
}

console.log('\nAll four at once');
const all = noticesFor(
  { ...GROUP, option_date: day(5), proposal_expires: day(2), deposit_due: day(7), passport_due: day(20) },
  { sold: 1, unbooked: 3, missingPassport: 4 }, TODAY
);
check(all.length === 4, 'four deadlines produce four lines, not four emails', `${all.length}`);
check(new Set(all.map((n) => n.kind)).size === 4, 'and each one is a different kind');

console.log('\nHow it reads');
const soon = noticesFor({ ...GROUP, option_date: day(1) }, { sold: 2 }, TODAY)[0];
check(/tomorrow/.test(soon.text), 'a day out reads as tomorrow', soon.text);
const todayOne = noticesFor({ ...GROUP, option_date: day(0) }, { sold: 2 }, TODAY)[0];
check(/today/.test(todayOne.text), 'the day itself reads as today', todayOne.text);
const past = noticesFor({ ...GROUP, option_date: day(-2) }, { sold: 2 }, TODAY)[0];
check(/2 days ago/.test(past.text), 'and a passed one says how long ago', past.text);
check(/8 of 10 cabins/.test(soon.text), 'the option notice counts what is left, not what is held',
  soon.text);
check(!/[\u2013\u2014]/.test(JSON.stringify(all)),
  'no em dashes reach an advisor');

console.log(failures
  ? `\n${failures} of ${checks} group reminder checks failed.`
  : `\ncheck-groupremind: all ${checks} group reminder checks passed.`);
process.exit(failures ? 1 : 0);
