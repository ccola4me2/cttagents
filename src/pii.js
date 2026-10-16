// Encrypting the two things worth stealing.
//
// A date of birth and a passport number are the only facts this portal holds
// that are worth something to somebody who takes a copy of the database. Names
// and itineraries are not nothing, but they are not a passport.
//
// What this protects against, honestly: a copy of the database getting out. A
// stolen export, a backup bundle read by somebody it was not meant for, a
// console session somebody left open. In every one of those the ciphertext is
// useless without the key, and the key is a Worker secret rather than a row.
//
// What it does not protect against: the Worker itself. Anything that can run
// this code can read the key and therefore the plaintext, so an attacker with
// code execution in the Worker is past this entirely. There is no way around
// that short of not holding the data, which is not an option when a cruise
// line will not take a booking without it.
//
// AES-GCM, 256 bit, a fresh 12 byte nonce for every value. GCM authenticates
// as well as encrypts, so a ciphertext somebody has edited fails to decrypt
// rather than decrypting to something else.
//
// The stored form is `v1.<base64 nonce>.<base64 ciphertext>`. Versioned from
// the first row, because the alternative is finding out there is no version
// marker on the day the scheme has to change.

import { bytesToB64, b64ToBytes } from './util.js';

const VERSION = 'v1';
const NONCE_BYTES = 12;

// Importing a key is not free and this runs once per field per request. An
// isolate handles many requests, so the imported key is kept against the
// secret it came from: a changed secret produces a different entry rather than
// a stale key that silently keeps working.
const keys = new Map();

/**
 * Is there a key to work with?
 *
 * Every caller asks this before offering somebody a box to type a passport
 * into. Without a key the right behaviour is to not collect it at all: a form
 * that takes a passport number and cannot encrypt it has to either store it in
 * the clear or throw the value away, and both are worse than not asking.
 */
export function piiReady(env) {
  return typeof env.PII_KEY === 'string' && env.PII_KEY.length >= 43;
}

async function keyFor(env) {
  const secret = env.PII_KEY;
  if (!secret) throw new Error('PII_KEY is not set');
  if (keys.has(secret)) return keys.get(secret);

  const raw = b64ToBytes(secret);
  if (raw.length !== 32) {
    throw new Error(`PII_KEY must decode to 32 bytes, got ${raw.length}`);
  }
  const key = await crypto.subtle.importKey(
    'raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
  keys.set(secret, key);
  return key;
}

/**
 * Plaintext in, stored form out.
 *
 * Empty in, null out: a blank passport box and a passport box nobody filled in
 * are the same fact, and storing 48 bytes of ciphertext for an empty string
 * would make them look different for ever.
 *
 * Throws when there is no key rather than returning the plaintext. Falling
 * back to storing it in the clear is the one failure mode this module exists
 * to prevent, and it would be invisible: the row looks the same either way
 * until somebody reads it.
 */
export async function seal(env, value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return null;

  const key = await keyFor(env);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(text)
  );
  return `${VERSION}.${bytesToB64(nonce)}.${bytesToB64(new Uint8Array(body))}`;
}

/**
 * Stored form in, plaintext out, and null for anything that will not open.
 *
 * Null rather than a throw, because the callers are screens and a manifest
 * that will not load at all is a worse answer than a manifest with one blank
 * cell in it. Whatever is wrong with the row, it is wrong already, and the
 * other nine travellers still have to be read.
 */
export async function open(env, stored) {
  if (!stored || typeof stored !== 'string') return null;
  const parts = stored.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  try {
    const key = await keyFor(env);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(parts[1]) }, key, b64ToBytes(parts[2])
    );
    return new TextDecoder().decode(plain);
  } catch {
    // A wrong key, a truncated value, or a row somebody has edited. All three
    // are "this cannot be read", and the caller has nothing different to do
    // about any of them.
    return null;
  }
}

/**
 * A whole row's worth, in one pass.
 *
 * Takes the stored column names and gives back the plain ones, so a caller
 * reading ten travellers writes one line rather than thirty awaits. The `_enc`
 * suffix is the convention the schema uses and is stripped here, which keeps
 * the column naming honest in the migration and the property naming honest in
 * the JSON.
 */
export async function openRow(env, row, columns) {
  const out = {};
  for (const column of columns) {
    const plainName = column.replace(/_enc$/, '');
    out[plainName] = await open(env, row ? row[column] : null);
  }
  return out;
}

/**
 * What a screen shows when it is not allowed to show the real thing.
 *
 * A passport number is wanted in full by the person filing the manifest and by
 * nobody else, so the ordinary case is the last three characters and a row of
 * dots. Short values are hidden completely rather than nearly completely: four
 * characters with the last three shown is not a mask.
 */
export function masked(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 5) return '•'.repeat(text.length);
  return `${'•'.repeat(text.length - 3)}${text.slice(-3)}`;
}
