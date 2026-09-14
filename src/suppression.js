// Who has asked not to be emailed, and the link that lets them ask.
//
// Two rules run through this file and they are easy to get backwards.
//
// A marketing email is one somebody could reasonably not want: a newsletter, a
// deal, a drip to a list. Those check the suppression list, carry an
// unsubscribe link, and carry a postal address, because that is what the law
// asks for and what a spam filter looks for.
//
// A transactional email is about something the person already has: their
// quote, their invoice, their payment falling due next Tuesday. Those are not
// suppressed and do not carry an unsubscribe link, because offering to stop
// sending somebody their own payment reminders is not a kindness, and because
// mixing the two is how a genuine service email ends up unsent.
//
// The distinction is the caller's to make, and it is stated at every send
// rather than inferred here. Inferring it would mean guessing, and the cost of
// guessing wrong in one direction is a fine and in the other is a client who
// never hears that their balance is due.

import { uid, now, clean, sha256Hex, json, badRequest, readJson, escapeHtml } from './util.js';
import { requireUser } from './auth.js';

/** Lowercased and trimmed. Anything cleverer would suppress the wrong person. */
export function normalise(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * The secret the unsubscribe links are signed with.
 *
 * One secret, and a named one. It used to fall back to the Resend key and then
 * to the CRM token, on the reasoning that both are secrets this Worker already
 * holds. They are, and they are also the wrong ones: the key that signs a link
 * has to outlive everything, and those two are rotated and revoked for reasons
 * that have nothing to do with unsubscribing. Rotate the Resend key and every
 * unsubscribe link ever sent stops verifying, which a client experiences as
 * "this link is not one of ours" on the page whose whole job is to take them
 * off the list. Removing the CRM made the same point louder.
 *
 * The literal keeps the feature working before anybody sets the secret, which
 * is the state on a fresh deployment. Set UNSUBSCRIBE_SECRET before the first
 * broadcast goes out and it never needs setting again.
 */
function signingKey(env) {
  return env.UNSUBSCRIBE_SECRET || 'ctt-unsubscribe';
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
  const sig = (await sha256Hex(`${signingKey(env)}|${who}`)).slice(0, 24);
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
  const expected = (await sha256Hex(`${signingKey(env)}|${who}`)).slice(0, 24);
  if (expected !== sig) return null;
  const at = who.indexOf(':');
  if (at < 0) return null;
  return { agencyId: who.slice(0, at) || null, email: who.slice(at + 1) };
}

/** Has this person asked this agency to stop? */
export async function isSuppressed(env, agencyId, email) {
  const who = normalise(email);
  if (!who) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS yes FROM email_suppression
        WHERE email = ? AND (agency_id IS ? OR agency_id IS NULL) LIMIT 1`
    ).bind(who, agencyId || null).first();
    return Boolean(row);
  } catch (e) {
    // A suppression list that cannot be read is not a licence to send. The
    // send is stopped and the reason is logged, because the alternative is
    // mailing somebody who opted out because a query failed.
    console.error('isSuppressed', e);
    return true;
  }
}

/** Record that they asked. Saying it twice is not an error. */
export async function suppress(env, agencyId, email, { reason = 'unsubscribed', source = null, note = null } = {}) {
  const who = normalise(email);
  if (!who) return false;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO email_suppression (id, agency_id, email, reason, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(uid(), agencyId || null, who, clean(reason, 40) || 'unsubscribed',
         clean(source, 80), clean(note, 200), now()).run();
  return true;
}

/** Undo it, for the person who unsubscribed by accident and rang up about it. */
export async function unsuppress(env, agencyId, email) {
  const who = normalise(email);
  if (!who) return false;
  const res = await env.DB.prepare(
    'DELETE FROM email_suppression WHERE email = ? AND (agency_id IS ? OR agency_id IS NULL)'
  ).bind(who, agencyId || null).run();
  return Boolean(res.meta && res.meta.changes);
}

/**
 * The footer a marketing email carries.
 *
 * The way out, and who it is from. No postal address: Brent asked for it left
 * off on 2026-09-13, having been told that US commercial email is supposed to
 * carry one and that its absence is read as a bad sign by the large mailbox
 * providers. His agency, his decision.
 *
 * Putting it back is one line. `agencyAddress` is still on the agency record
 * and on each advisor's own settings, and `agencyFor` in broadcasts.js still
 * resolves it, so nothing needs rebuilding: add the parameter back and push
 * it into `bits` below.
 */
export function marketingFooter({ agencyName, unsubscribeUrl }) {
  const bits = [];
  if (agencyName) bits.push(escapeHtml(agencyName));
  return `${bits.join(' &middot; ')}<br>
    <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7a8c;">Unsubscribe</a>
    from emails like this. Messages about a trip you have booked are sent separately.`;
}

/**
 * The page behind the unsubscribe link.
 *
 * Two steps, not one. A one-click link gets fired by every scanner and preview
 * pane between the sender and the reader, so a mail security appliance would
 * unsubscribe people who never opened the email. The GET shows who it is
 * about and asks; the POST does it.
 *
 * Plain HTML, no session, no styling shared with the portal: whoever opens
 * this is a client, not an advisor, and the page has one job.
 */
/**
 * The agency whose list this is, by name.
 *
 * The footer of the email says "Cruises Tours & Travel", and until now the page
 * that footer links to said "us". On a portal that carries several agencies
 * that is not a rough edge, it is the client being unable to tell whose list
 * they just left. The name is one row away and the token already carries the
 * agency, so there is nothing to thread through and nothing to trust.
 *
 * Null rather than a guess when there is no agency on the token or the lookup
 * fails: the page drops back to "us", which is what it always said.
 */
async function agencyName(env, agencyId) {
  if (!agencyId) return null;
  try {
    const row = await env.DB.prepare('SELECT name FROM agencies WHERE id = ? LIMIT 1')
      .bind(agencyId).first();
    return (row && row.name) || null;
  } catch (e) {
    console.error('agencyName', e);
    return null;
  }
}

function page(title, body, brand) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; background:#f7fafb; color:#0f272f;
         font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .wrap { max-width: 34rem; margin: 12vh auto; padding: 0 1.25rem; }
  .card { background:#fff; border:1px solid #dbe4e8; border-radius:14px; padding:2rem 1.9rem; }
  h1 { font-size:1.4rem; margin:0 0 .6rem; }
  p { margin:0 0 1rem; color:#4b6169; }
  button { font:inherit; font-weight:600; border:0; border-radius:999px; cursor:pointer;
           background:#0f6270; color:#fff; padding:.75rem 1.5rem; }
  .quiet { background:none; color:#4b6169; padding:.75rem .4rem; }
  strong { color:#0f272f; }
  .who { margin:0 0 1.25rem; font-size:.8rem; letter-spacing:.08em; text-transform:uppercase;
         color:#6b7a8c; }
</style></head><body><div class="wrap"><div class="card">${
    brand ? `<p class="who">${escapeHtml(brand)}</p>` : ''}${body}</div></div></body></html>`;
}

const htmlResponse = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

export async function renderUnsubscribe(env, token) {
  const who = await readToken(env, token);
  if (!who) {
    return htmlResponse(page('Link not recognised', `
      <h1>This link is not one of ours</h1>
      <p>It may have been cut in half by an email client. Reply to the message you received
        and ask to be taken off the list, and somebody will do it by hand.</p>`), 404);
  }

  const brand = await agencyName(env, who.agencyId);

  if (await isSuppressed(env, who.agencyId, who.email)) {
    return htmlResponse(page('Already unsubscribed', `
      <h1>You are already unsubscribed</h1>
      <p><strong>${escapeHtml(who.email)}</strong> is off ${brand
        ? `the ${escapeHtml(brand)} marketing list` : 'the marketing list'}. Messages about a
        trip you have booked are sent separately and will still reach you.</p>`, brand));
  }

  return htmlResponse(page('Unsubscribe', `
    <h1>Stop these emails?</h1>
    <p>${brand ? escapeHtml(brand) : 'We'} will stop sending marketing email to
      <strong>${escapeHtml(who.email)}</strong>.</p>
    <p>Messages about a trip you have already booked, your payment dates and your documents,
      are sent separately and will still reach you.</p>
    <form method="post">
      <button type="submit">Yes, unsubscribe me</button>
    </form>`, brand));
}

export async function handleUnsubscribe(env, token) {
  const who = await readToken(env, token);
  if (!who) {
    return htmlResponse(page('Link not recognised', `
      <h1>This link is not one of ours</h1>
      <p>Reply to the message you received and ask to be taken off the list.</p>`), 404);
  }

  await suppress(env, who.agencyId, who.email, { reason: 'unsubscribed', source: 'footer link' });

  const brand = await agencyName(env, who.agencyId);

  return htmlResponse(page('Unsubscribed', `
    <h1>Done</h1>
    <p><strong>${escapeHtml(who.email)}</strong> will not receive any more marketing email
      from ${brand ? escapeHtml(brand) : 'us'}.</p>
    <p>Anything about a trip you have booked still will. If you did not mean to do this, reply
      to any message from your advisor and they will put you back.</p>`, brand));
}

// ---------------------------------------------------------------------------
// What an advisor can see and do about it
// ---------------------------------------------------------------------------
//
// Until now this list could only be written to, by a client clicking a link.
// That is the wrong half to build first and it is the half that is easy: an
// advisor who cannot see that somebody opted out will write to them personally
// wondering why they never reply, and an advisor with no way to undo it has to
// ring somebody at Cloudflare when a client unsubscribes by accident and then
// rings up about it.
//
// The list is the agency's, the same as the sending identity is, so everybody
// in the agency sees it and may undo an entry. That is wider than one advisor's
// book on purpose: an address is on it once, whoever it belongs to, and an
// entry nobody can reach is worse than one several people can.

/** One person's entry, or null. Used on the client record. */
export async function suppressionFor(env, agencyId, email) {
  const who = normalise(email);
  if (!who) return null;
  try {
    return await env.DB.prepare(
      `SELECT email, reason, source, note, created_at FROM email_suppression
        WHERE email = ? AND (agency_id IS ? OR agency_id IS NULL) LIMIT 1`
    ).bind(who, agencyId || null).first();
  } catch (e) {
    console.error('suppressionFor', e);
    return null;
  }
}

export async function handleListSuppressions(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const url = new URL(request.url);
  const q = normalise(url.searchParams.get('q'));

  const { results } = await env.DB.prepare(
    `SELECT s.email, s.reason, s.source, s.note, s.created_at,
            (SELECT c.name FROM clients c
              WHERE LOWER(TRIM(c.email)) = s.email AND c.user_id = ? LIMIT 1) AS client_name
       FROM email_suppression s
      WHERE (s.agency_id IS ? OR s.agency_id IS NULL)
        AND (? = '' OR s.email LIKE ?)
      ORDER BY s.created_at DESC LIMIT 500`
  ).bind(user.id, user.agency_id || null, q, `%${q}%`).all();

  return json({ suppressions: results || [] });
}

export async function handleAddSuppression(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);
  const email = normalise(body.email);
  if (!email) return badRequest('Which address?');
  // "They told me on the phone" is the ordinary way this happens and it has to
  // be recordable, or it lives in somebody's memory until the next send.
  await suppress(env, user.agency_id || null, email, {
    reason: clean(body.reason, 40) || 'asked us to stop',
    source: 'added by their advisor',
    note: clean(body.note, 200),
  });
  return json({ ok: true });
}

export async function handleRestoreSuppression(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);
  const email = normalise(body.email);
  if (!email) return badRequest('Which address?');
  const done = await unsuppress(env, user.agency_id || null, email);
  if (!done) return badRequest('That address is not on the list.');
  return json({ ok: true });
}
