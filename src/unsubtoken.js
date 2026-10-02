// The signed link a client uses to leave a list, and nothing else.
//
// Its own file, and a leaf, for the reason brand.js is one: email.js has to put an
// unsubscribe link in every message a client reads, suppression.js needs auth.js
// to answer an advisor's requests, and auth.js sends mail through email.js. A
// module that imported all three in a ring would have one of them reading a
// binding that has not been initialised yet, and sign in would throw. So the part
// that signs and verifies lives here and imports only what it cannot do without.

import { uid, now, sha256Hex } from './util.js';

/** Lowercased and trimmed. Anything cleverer would suppress the wrong person. */
export function normalise(email) {
  return String(email || '').trim().toLowerCase();
}

// The literal this used to sign with, kept only for reading.
//
// It is in the git history of a public repository, so anybody could mint a
// valid unsubscribe for any address on any list with it. Nothing is signed with
// it any more. It stays in the verifying set so that a link already sitting in
// somebody's inbox still works, and can be deleted once no mail signed with it
// is plausibly still out there.
const LEGACY_KEY = 'ctt-unsubscribe';

/**
 * The secret the unsubscribe links are signed with.
 *
 * This key has two requirements that every candidate the Worker already held
 * fails. It has to be **stable for years**, because a link sent today is
 * clicked whenever somebody gets round to it, which rules out the Resend key
 * and the CRM token: both are rotated for reasons that have nothing to do with
 * email preferences, and rotating one used to break every unsubscribe link ever
 * sent. And it has to be **secret**, which rules out a literal in the source,
 * because this repository is public.
 *
 * So the portal makes its own, once, and keeps it in app_settings. Nothing to
 * set and nothing to remember. INSERT OR IGNORE and then a re-read, rather than
 * trusting the insert, because two requests arriving together would otherwise
 * leave one of them signing with a value that lost the race and was discarded.
 *
 * UNSUBSCRIBE_SECRET in the environment still wins, for an operator who would
 * rather hold it themselves.
 */
async function signingKey(env) {
  if (env.UNSUBSCRIBE_SECRET) return env.UNSUBSCRIBE_SECRET;
  try {
    const read = async () => {
      const row = await env.DB.prepare(
        "SELECT value FROM app_settings WHERE key = 'unsubscribe_secret'"
      ).first();
      return row && row.value ? row.value : null;
    };
    const found = await read();
    if (found) return found;
    const ts = now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO app_settings (key, value, created_at, updated_at)
       VALUES ('unsubscribe_secret', ?, ?, ?)`
    ).bind(`${uid()}${uid()}`, ts, ts).run();
    return (await read()) || LEGACY_KEY;
  } catch (e) {
    // A link that cannot be verified is a client who cannot get off the list,
    // so this falls back rather than throwing. It also means the table is
    // missing, which is worth saying out loud.
    console.error('unsubscribe secret', e);
    return LEGACY_KEY;
  }
}

/**
 * A link somebody can use without signing in, that nobody can forge.
 *
 * Signed rather than stored. A stored token needs a row per recipient per
 * send, an expiry policy and a cleanup job, and all of that to answer a
 * question the signature already answers. The agency is in the payload so a
 * link cannot be replayed against another agency's list.
 */
export async function unsubscribeToken(env, agencyId, email) {
  const who = `${agencyId || ''}:${normalise(email)}`;
  const sig = (await sha256Hex(`${await signingKey(env)}|${who}`)).slice(0, 24);
  // base64url, so it survives being a path segment and a mail client's
  // enthusiasm for turning things into links.
  const payload = btoa(who).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${payload}.${sig}`;
}

/** The address a token is for, or null if it was not signed by us. */
export async function readToken(env, token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  let who;
  try {
    who = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  } catch { return null; }
  // Signed with today's key, or with the literal that used to be the key. Both
  // are accepted for reading so a link already in an inbox keeps working; only
  // the first is ever used for signing.
  const keys = [await signingKey(env), LEGACY_KEY];
  let ok = false;
  for (const key of keys) {
    if ((await sha256Hex(`${key}|${who}`)).slice(0, 24) === sig) { ok = true; break; }
  }
  if (!ok) return null;
  const at = who.indexOf(':');
  if (at < 0) return null;
  return { agencyId: who.slice(0, at) || null, email: who.slice(at + 1) };
}
