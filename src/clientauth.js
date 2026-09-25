// A client signs in, rather than holding a link.
//
// /c/<hub_code> works and is staying. Every link already sent keeps working,
// and for a one-off "here is your trip" it is still the right thing. What a
// link cannot do is tell two people apart: forwarded to a sister it is the
// same link, a household of four share one view, and taking it away from one
// person takes it away from everybody.
//
// So identity is an EMAIL, proved by a one-time link sent to that email. No
// password for a client. Somebody who signs in four times a year should not
// have a password to forget, and an advisor should not be answering reset
// requests on a Saturday. It also means this file never handles a credential
// anybody could reuse: the only secret is a link that dies in twenty minutes.
//
// The email rather than a client row, because clients is unique on
// (user_id, name), so the same person is two rows when two advisors both know
// them. One sign-in then shows everything the agency holds for that person,
// which is the thing the shared link could never do.
//
// Nothing in here may read a commission field. scripts/check-private.mjs
// holds that line for every client-facing file and this one is on its list.

import {
  clean, uid, now, cookieHeader, clearCookieHeader, parseCookies,
} from './util.js';
import { sendHtml } from './email.js';

export const CLIENT_COOKIE = 'tv_client';

// Twenty minutes. Long enough to walk to a laptop, short enough that a link
// sitting in an old inbox is not a way in.
const TOKEN_TTL = 20 * 60;

// One a minute per address. Not a rate limiter so much as a stop on somebody
// using this to post a hundred emails to a client we hold.
const RESEND_GAP = 60;

function sessionTtlSeconds(env) {
  const days = Number(env.CLIENT_SESSION_TTL_DAYS || 30);
  return Math.max(1, days) * 86400;
}

/** Lower case and trimmed, because that is how an email is compared. */
export function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 160);
}

/**
 * Which agencies hold a client at this address.
 *
 * Usually one. Two happens when somebody is a client of two agencies in the
 * same database, and picking one of them silently would show them the wrong
 * book, so a link is minted for each and the email names them.
 *
 * An advisor with no agency is skipped rather than grouped under null: a
 * session with no agency would fence on nothing.
 */
async function agenciesFor(env, email) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT u.agency_id AS agency_id,
            COALESCE(a.name, 'your travel advisor') AS agency_name
       FROM clients c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN agencies a ON a.id = u.agency_id
      WHERE LOWER(TRIM(c.email)) = ? AND u.agency_id IS NOT NULL`
  ).bind(email).all().catch(() => ({ results: [] }));
  return results || [];
}

/**
 * Ask for a link.
 *
 * Answers the same whether or not the address is known. This endpoint is
 * open to anybody, and an answer that differed would turn it into a way to
 * ask "is this person one of your clients", which is a fact about the client
 * and not ours to give away.
 */
/**
 * Mint a link and send it, or do nothing at all, without saying which.
 *
 * Returns nothing useful on purpose. Every caller must answer the same to a
 * known and an unknown address, and a return value that differed would be the
 * first thing somebody leaked by accident.
 */
export async function requestLink(env, email, origin) {
  const recent = await env.DB.prepare(
    'SELECT created_at FROM client_login_tokens WHERE email = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(email).first().catch(() => null);
  if (recent && now() - recent.created_at < RESEND_GAP) return;

  const agencies = await agenciesFor(env, email);
  if (!agencies.length) return;

  const ts = now();
  const base = origin;
  const links = [];
  for (const a of agencies) {
    const token = uid() + uid();
    await env.DB.prepare(
      `INSERT INTO client_login_tokens (id, email, agency_id, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).bind(token, email, a.agency_id, ts, ts + TOKEN_TTL).run();
    links.push({ name: a.agency_name, url: `${base}/portal/in?t=${encodeURIComponent(token)}` });
  }

  await sendHtml(env, {
    to: email,
    subject: 'Your link to see your trips',
    html: `<p style="margin:0 0 1rem;">Here is your way in. It works once and stops working
      after twenty minutes, so ask for another if this one has gone stale.</p>
      ${links.map((l) => `<p style="margin:0 0 1rem;">
        <a href="${l.url}" style="background:#1b3a5f;color:#fff;padding:.7rem 1.2rem;
          border-radius:8px;text-decoration:none;display:inline-block;">See your trips${
          links.length > 1 ? ` with ${l.name}` : ''}</a></p>`).join('')}
      <p style="margin:0;color:#5c7286;font-size:.9rem;">If you did not ask for this, nothing
        has happened and you can ignore it.</p>`,
  }).catch((e) => { console.error('client link email', e); });
}

/**
 * Redeem a link.
 *
 * Single use: used_at is stamped in the same statement that checks it is
 * unused, so a link opened twice out of an inbox cannot open two sessions.
 * The condition lives in the UPDATE rather than in a read followed by a
 * write, which is the version that races.
 */
export async function handleClientLinkRedeem(request, env) {
  const token = clean(new URL(request.url).searchParams.get('t'), 128);
  const bad = new Response(null, { status: 302, headers: { Location: '/portal?e=expired' } });
  if (!token) return bad;

  const claimed = await env.DB.prepare(
    `UPDATE client_login_tokens SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND expires_at > ?`
  ).bind(now(), token, now()).run().catch(() => null);
  if (!claimed || !claimed.meta || claimed.meta.changes !== 1) return bad;

  const row = await env.DB.prepare(
    'SELECT email, agency_id FROM client_login_tokens WHERE id = ?'
  ).bind(token).first();
  if (!row) return bad;

  const sid = uid() + uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO client_sessions (id, email, agency_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(sid, row.email, row.agency_id, ts, ts + sessionTtlSeconds(env), ts).run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/portal',
      'Set-Cookie': cookieHeader(CLIENT_COOKIE, sid, { maxAge: sessionTtlSeconds(env) }),
    },
  });
}

/**
 * Who is asking, or null.
 *
 * Returns the email and the agency, which together are the fence every read
 * in the portal is built on. Never a client id: one address can be several
 * client rows and the portal is deliberately the union of them.
 */
export async function currentClient(request, env) {
  const sid = parseCookies(request)[CLIENT_COOKIE];
  if (!sid) return null;
  const row = await env.DB.prepare(
    'SELECT id, email, agency_id, expires_at FROM client_sessions WHERE id = ?'
  ).bind(sid).first().catch(() => null);
  if (!row || row.expires_at <= now()) return null;

  // Cheap enough once a request, and it is the only way to tell a live
  // session from one nobody has used since March.
  await env.DB.prepare('UPDATE client_sessions SET last_seen_at = ? WHERE id = ?')
    .bind(now(), sid).run().catch(() => {});

  return { sessionId: row.id, email: row.email, agencyId: row.agency_id };
}

export async function handleClientSignOut(request, env) {
  const sid = parseCookies(request)[CLIENT_COOKIE];
  if (sid) {
    await env.DB.prepare('DELETE FROM client_sessions WHERE id = ?').bind(sid).run().catch(() => {});
  }
  return new Response(null, {
    status: 302,
    headers: { Location: '/portal', 'Set-Cookie': clearCookieHeader(CLIENT_COOKIE) },
  });
}

/**
 * Every client row this person is, inside their agency.
 *
 * Both halves of the fence on every read: the address proves who they are,
 * the agency decides whose book they are in. A client of two agencies has a
 * session for one of them and cannot see the other from it.
 */
export async function clientRowsFor(env, who) {
  if (!who || !who.agencyId) return [];
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.user_id, c.name, c.email, c.hub_code
       FROM clients c
       JOIN users u ON u.id = c.user_id
      WHERE LOWER(TRIM(c.email)) = ? AND u.agency_id = ?`
  ).bind(who.email, who.agencyId).all().catch(() => ({ results: [] }));
  return results || [];
}
