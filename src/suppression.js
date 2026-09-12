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

import { uid, now, clean, sha256Hex } from './util.js';

/** Lowercased and trimmed. Anything cleverer would suppress the wrong person. */
export function normalise(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * The secret the unsubscribe links are signed with.
 *
 * Falls back to the Resend key, which is already a secret this Worker holds
 * and is never sent anywhere as part of a link. A dedicated secret is better
 * and this is what makes the feature work before somebody sets one.
 */
function signingKey(env) {
  return env.UNSUBSCRIBE_SECRET || env.RESEND_API_KEY || env.GHL_API_TOKEN || 'ctt-unsubscribe';
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
 * The footer a marketing email has to carry.
 *
 * A postal address and a way out, both of which the CAN-SPAM rules ask for and
 * both of which a spam filter reads as evidence this is a real sender. The
 * address is the agency's own; when there is not one recorded the email still
 * sends, because a missing address is a thing to fix on the settings page
 * rather than a reason a client hears nothing.
 */
export function marketingFooter({ agencyName, agencyAddress, unsubscribeUrl }) {
  const bits = [];
  if (agencyName) bits.push(escapeish(agencyName));
  if (agencyAddress) bits.push(escapeish(String(agencyAddress).replace(/\s*\n\s*/g, ', ')));
  return `${bits.join(' &middot; ')}<br>
    <a href="${escapeish(unsubscribeUrl)}" style="color:#6b7a8c;">Unsubscribe</a>
    from emails like this. Messages about a trip you have booked are sent separately.`;
}

// Small and local: this file builds one string and importing the escaper from
// email.js would make the two depend on each other for the sake of it.
function escapeish(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeish(title)}</title>
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
</style></head><body><div class="wrap"><div class="card">${body}</div></div></body></html>`;
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

  if (await isSuppressed(env, who.agencyId, who.email)) {
    return htmlResponse(page('Already unsubscribed', `
      <h1>You are already unsubscribed</h1>
      <p><strong>${escapeish(who.email)}</strong> is off the marketing list. Messages about a
        trip you have booked are sent separately and will still reach you.</p>`));
  }

  return htmlResponse(page('Unsubscribe', `
    <h1>Stop these emails?</h1>
    <p>We will stop sending marketing email to <strong>${escapeish(who.email)}</strong>.</p>
    <p>Messages about a trip you have already booked, your payment dates and your documents,
      are sent separately and will still reach you.</p>
    <form method="post">
      <button type="submit">Yes, unsubscribe me</button>
    </form>`));
}

export async function handleUnsubscribe(env, token) {
  const who = await readToken(env, token);
  if (!who) {
    return htmlResponse(page('Link not recognised', `
      <h1>This link is not one of ours</h1>
      <p>Reply to the message you received and ask to be taken off the list.</p>`), 404);
  }

  await suppress(env, who.agencyId, who.email, { reason: 'unsubscribed', source: 'footer link' });

  return htmlResponse(page('Unsubscribed', `
    <h1>Done</h1>
    <p><strong>${escapeish(who.email)}</strong> will not receive any more marketing email
      from us.</p>
    <p>Anything about a trip you have booked still will. If you did not mean to do this, reply
      to any message from your advisor and they will put you back.</p>`));
}
