// Shared helpers: JSON responses, cookies, crypto (password hashing, tokens).
// Mirrors the helper module used across the other Worker sites so the two
// codebases stay readable side by side.

const encoder = new TextEncoder();

export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function redirect(location, status = 302, extraHeaders = {}) {
  return new Response(null, { status, headers: { Location: location, ...extraHeaders } });
}

export function badRequest(message) {
  return json({ error: message }, 400);
}

export function unauthorized(message = 'Sign in required') {
  return json({ error: message }, 401);
}

export function forbidden(message = 'Not allowed') {
  return json({ error: message }, 403);
}

export function notFound(message = 'Not found') {
  return json({ error: message }, 404);
}

// ---------------------------------------------------------------------------
// Base64 and hex
// ---------------------------------------------------------------------------
export function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, expires } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  if (typeof maxAge === 'number') c += `; Max-Age=${maxAge}`;
  if (expires) c += `; Expires=${expires}`;
  return c;
}

export function clearCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Ids, time, random tokens
// ---------------------------------------------------------------------------
export function uid() {
  return crypto.randomUUID();
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Password hashing: PBKDF2/SHA-256 via Web Crypto (available in Workers).
// Stored format: pbkdf2$<iterations>$<salt_b64>$<hash_b64>
// ---------------------------------------------------------------------------
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN_BITS = 256;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const iterations = parseInt(iterStr, 10);
    const salt = b64ToBytes(saltB64);
    const expected = b64ToBytes(hashB64);
    const bits = await deriveBits(password, salt, iterations, expected.length * 8);
    return timingSafeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

async function deriveBits(password, salt, iterations, lengthBits = PBKDF2_KEYLEN_BITS) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    lengthBits
  );
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Validation and formatting
// ---------------------------------------------------------------------------
/**
 * Text made safe to put inside HTML.
 *
 * One copy, here, because there were four: email.js, publicform.js, share.js
 * and suppression.js each had their own, all five characters, all identical.
 * Identical today is the problem rather than the reassurance. Every one of
 * them renders into a page or a message that somebody outside this agency
 * reads, and the failure mode is one of them being improved and the other
 * three not.
 *
 * The five characters are the standard set: a quote is escaped because the
 * output goes inside attributes as well as between tags.
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Trim, collapse whitespace, cap length. Returns '' for nullish input. */
export function clean(value, maxLength = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Like clean, but for text that was written in paragraphs.
 *
 * clean collapses every run of whitespace into one space, which is right for a
 * name and wrong for anything typed into a textarea: a supplier's registration
 * instructions are a numbered list, and they arrived as one unbroken line. The
 * page renders these with pre-wrap, which only means something if the newlines
 * survive being saved.
 */
export function cleanText(value, maxLength = 4000) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

/** Accepts a real yyyy-mm-dd day in a plausible year. Null for anything else. */
export function cleanDate(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;

  // A year outside this range is a typo, not a date.
  //
  // A browser date field turns a mistyped "206" into "0206-09-09", which is
  // four digits and passes the shape test above. A reservation went in
  // departing the ninth of September, 206: it sorted to the top of every list
  // ordered by date, counted as eighteen hundred years overdue anywhere days
  // are subtracted, and printed as "Sep 9, 206", where it reads as the screen
  // being broken rather than as the data being wrong.
  //
  // The floor is 1900 rather than anything nearer because this also cleans a
  // passport holder's date of birth, and the ceiling leaves room for a cruise
  // booked further ahead than any vendor sells.
  const year = Number(s.slice(0, 4));
  if (year < 1900 || year > 2100) return null;

  // And the day has to be one that existed. The shape test takes 2026-02-30
  // and 2026-13-01 happily, and a Date built from either rolls quietly forward
  // into a different day from the one somebody typed. Round-tripping it back
  // to a string is what catches that, the same way nextDue does above.
  const when = new Date(`${s}T00:00:00Z`);
  if (!Number.isFinite(when.getTime())) return null;
  return when.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * Was a date typed, and is it unusable?
 *
 * cleanDate answers "give me the date or nothing", which is what a caller
 * wants when the field is optional. It cannot tell a box somebody left empty
 * from a box somebody typed 0206-09-09 into, and on a save that writes every
 * column those two mean opposite things: one is "no date", the other is "stop,
 * that is wrong". This is the second question, asked only where it matters.
 */
export function badDate(value) {
  const s = String(value ?? '').trim();
  return Boolean(s) && cleanDate(s) === null;
}

/** Dollars (string or number) to integer cents. Negative and NaN become 0. */
/**
 * The next time a month and day comes round, on or after a given day.
 *
 * Birthdays and anniversaries are the two dates in the portal where the year
 * is the part nobody wants. Returns an ISO date, or null when the date does
 * not exist in either year worth looking at, which is February 29 and only
 * February 29.
 */
export function nextAnnual(iso, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return null;
  const from = Date.parse(`${today}T00:00:00Z`);
  const md = String(iso).slice(5);
  for (const year of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
    const candidate = `${year}-${md}`;
    const at = Date.parse(`${candidate}T00:00:00Z`);
    if (!Number.isFinite(at)) continue;
    // Date.parse takes 2025-02-29 and hands back March 1. Round-tripping it
    // is how you find out the day was never there.
    if (new Date(at).toISOString().slice(0, 10) !== candidate) continue;
    if (at >= from) return candidate;
  }
  return null;
}

export function toCents(value) {
  const n = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/** One of `allowed`, else the first entry. Keeps bad input out of the DB. */
export function oneOf(value, allowed) {
  const s = String(value ?? '').trim().toLowerCase();
  return allowed.includes(s) ? s : allowed[0];
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

/**
 * An error that retrying cannot fix.
 *
 * The automation engine retries a failed step four times with backoff, which
 * is right for a timeout or a 500 and useless for a missing API key: nothing
 * changes between attempts, and the run sits in `waiting` for twenty minutes
 * pretending it might yet succeed. Worse, it reads as "waiting" on the
 * automation screen, so an unconfigured or revoked key looks like patience
 * rather than a broken automation. Throw this instead and the run fails at
 * once, with the reason on the record.
 */
export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    this.permanent = true;
  }
}
