// Does the encryption actually encrypt?
//
// Every other check here reads the source and reasons about it. This one runs
// the thing, because the properties worth having from a cipher are not visible
// in the text of the code: that two seals of one value differ, that a wrong key
// gives nothing rather than nonsense, that an edited ciphertext is refused
// rather than quietly opened to something else.
//
// It is in the offline set rather than the smoke suite on purpose. The smoke
// suite needs a dev server and a database; this needs neither, so it runs on
// every push and fails in two seconds when somebody changes the format.
//
//   node scripts/check-pii.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { seal, open, openRow, masked, piiReady } = await import(join(ROOT, 'src', 'pii.js'));

let checks = 0;
let failures = 0;

function check(condition, label, detail) {
  checks += 1;
  if (condition) { console.log(`  ok    ${label}`); return true; }
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
  annotate('PII', detail === undefined ? label : `${label} -- ${detail}`);
  return false;
}

const keyOf = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const env = { PII_KEY: keyOf() };
const other = { PII_KEY: keyOf() };

console.log('\nIs there a key');
check(piiReady(env) === true, 'a 32 byte key is ready');
check(piiReady({}) === false, 'no key is not ready');
check(piiReady({ PII_KEY: 'too-short' }) === false, 'a short key is not ready');

console.log('\nSealing and opening');
const PASSPORT = 'X12345678';
const sealed = await seal(env, PASSPORT);
check(typeof sealed === 'string' && sealed.startsWith('v1.'),
  'a sealed value names its version first', String(sealed).slice(0, 8));
check(sealed.split('.').length === 3, 'and is three parts', sealed);
check(!sealed.includes(PASSPORT), 'and does not contain the plaintext');
check(await open(env, sealed) === PASSPORT, 'and opens back to what went in');

console.log('\nThe properties that matter');
check(await seal(env, 'A') !== await seal(env, 'A'),
  'two seals of one value differ, so equal passports are not visibly equal');
check(await open(other, sealed) === null, 'the wrong key gives nothing, not nonsense');
check(await open(env, `${sealed.slice(0, -4)}AAAA`) === null,
  'an edited ciphertext is refused rather than opened to something else');
check(await open(env, `${sealed.slice(0, -40)}${'A'.repeat(36)}`) === null,
  'and so is one edited in the middle');
check(await open(env, 'v2.abc.def') === null, 'a version this does not know is refused');

console.log('\nEmptiness');
check(await seal(env, '') === null, 'an empty string seals to null');
check(await seal(env, null) === null, 'and so does null');
check(await seal(env, undefined) === null, 'and so does nothing at all');
check(await seal(env, '   ') === null, 'and so does whitespace');
check(await open(env, null) === null, 'opening null gives null');
check(await open(env, 'not-a-sealed-value') === null, 'and so does opening rubbish');

console.log('\nNo key is a refusal, never a fallback');
let threw = null;
try { await seal({}, 'a passport number'); } catch (e) { threw = e; }
check(threw !== null, 'sealing without a key throws rather than storing the plaintext');
threw = null;
try { await seal({ PII_KEY: Buffer.from('short').toString('base64') }, 'x'); }
catch (e) { threw = e; }
check(threw !== null, 'and a key of the wrong length is refused');

console.log('\nA row at a time');
const row = {
  dob_enc: await seal(env, '1972-04-18'),
  passport_number_enc: sealed,
  passport_expiry_enc: null,
};
const opened = await openRow(env, row, ['dob_enc', 'passport_number_enc', 'passport_expiry_enc']);
check(opened.dob === '1972-04-18', 'openRow strips the suffix and opens the value', opened.dob);
check(opened.passport_number === PASSPORT, 'every column in the list', opened.passport_number);
check(opened.passport_expiry === null, 'and an unset one stays null');

console.log('\nMasking');
check(masked('X12345678') === '•'.repeat(6) + '678', 'the last three show', masked('X12345678'));
check(masked('AB12') === '•'.repeat(4), 'a short value shows nothing', masked('AB12'));
check(masked('') === '', 'and an empty one masks to empty');
check(masked(null) === '', 'and so does null');

console.log(failures
  ? `\n${failures} of ${checks} encryption checks failed.`
  : `\ncheck-pii: all ${checks} encryption checks passed.`);
process.exit(failures ? 1 : 0);
