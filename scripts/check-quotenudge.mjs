/**
 * The follow-up on an unanswered quote says what is true and does not nag for ever.
 *
 * The nudge is a task on the advisor's list, made three days after a quote went out with no answer.
 * What can go wrong quietly is the words (telling somebody a client has opened a page they have not,
 * or the other way round) and the limits (a quote reminded about every five minutes, or for a year).
 * The words are pinned here. The limits are numbers that the query reads, so they are pinned too.
 */

import { nudgeText, FIRST_AFTER_DAYS, AGAIN_AFTER_DAYS, MOST_NUDGES, TOO_OLD_DAYS, NUDGE_TITLE } from '../src/quotenudge.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::quotenudge: ${label}: ${detail}`);
};
const is = (label, got, want) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
const has = (label, text, part) => (text.includes(part) ? ok(label) : bad(label, `"${part}" is not in: ${text}`));
const lacks = (label, text, part) => (!text.includes(part) ? ok(label) : bad(label, `"${part}" should not be in: ${text}`));

console.log('\nThe follow-up on an unanswered quote');

const unopened = nudgeText({ product_name: 'Harmony of the Seas', deposit_cents: 75000, deposit_due: '2026-10-17', view_count: 0 }, 3);
has('it names the trip and how long ago', unopened, 'The quote for Harmony of the Seas went out 3 days ago and has not been answered.');
has('a quote nobody has opened says so and suggests a second send', unopened, 'They have not opened it yet.');
lacks('and does not claim they are looking at it', unopened, 'looking at it');
has('the deposit is stated with cents and its date', unopened, 'The deposit is $750.00, due 10/17/2026.');
has('it says what to do and that a deposit books it', unopened, 'post the deposit once it arrives, which books it.');

const opened = nudgeText({ product_name: 'Allure', view_count: 2 }, 4);
has('a quote that was opened says how many times', opened, 'They have opened their page 2 times');
lacks('and does not say it was never opened', opened, 'not opened it');
lacks('no deposit set means no deposit sentence', opened, 'The deposit is');
has('one day is singular', nudgeText({ product_name: 'X', view_count: 1 }, 1), 'went out 1 day ago');
has('one view is singular', nudgeText({ product_name: 'X', view_count: 1 }, 5), 'opened their page 1 time,');
has('with no trip name it falls back to the vendor', nudgeText({ supplier: 'Royal Caribbean', view_count: 0 }, 3), 'The quote for Royal Caribbean');

console.log('\nThe limits');
is('the first one is three days after it went out', FIRST_AFTER_DAYS, 3);
is('and they are four days apart', AGAIN_AFTER_DAYS, 4);
is('and there are at most three', MOST_NUDGES, 3);
is('a quote older than three weeks is not nudged', TOO_OLD_DAYS, 21);
has('every nudge is told apart by its title', `${NUDGE_TITLE} Pat`, 'Follow up on the quote for');

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) process.exit(1);
