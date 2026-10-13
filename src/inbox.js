// Vendor confirmations, forwarded to an address.
//
// The same idea as forwarded meeting invites (inbound.js) and the same private address: the part
// before the @ is a token that belongs to one advisor, issued on request. A confirmation forwarded
// to conf-<token>@ is read and held on the Import page as waiting for that advisor, who opens it,
// checks every field and creates the reservation.
//
// It is held and not created, for the reason the reader is a reader: vendor confirmations have no
// standard shape, so some will be misread, and a reservation written straight to the books on a
// guess is worse than typing. A wrong sail date somebody corrected is a nuisance. A wrong sail
// date nobody saw is a missed holiday.
//
// Nothing here trusts the sender. The token is the whole permission, as it is for invites. A message
// that cannot be read bounces with the reason, because an advisor who forwards something and hears
// nothing cannot tell "it worked" from "it went in the bin".

import { parseConfirmation } from './confirm.js';
import { readableParts } from './mime.js';
import { pdfRead } from './pdftext.js';
import { json, badRequest, notFound, uid, now, clean } from './util.js';
import { requireUser, borrowedSeat } from './auth.js';
import { inviteDomain } from './appointments.js';
import { tokenOf } from './inbound.js';
import * as db from './db.js';

const MAX_RAW_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 60000;
const MAX_WAITING = 30;
// Held for as long as it is a thing somebody might still open, and not for ever: a confirmation
// carries a client's name and what they paid.
const KEEP_DAYS = 45;

/** How much a reading found, so the better of several readings of one message can be told. */
function score(read) {
  const fields = Object.keys(read.fields || {}).length;
  const priced = read.pricing && read.pricing.lines && read.pricing.lines.length ? 3 : 0;
  return fields + priced;
}

/** Whether a reading found enough to be worth holding: the essentials, not just a word like "cruise". */
function usable(read) {
  const f = read.fields || {};
  const essentials = ['confirmationNumber', 'departDate', 'gross', 'productName'].filter((k) => f[k]).length;
  return essentials >= 1 && score(read) >= 3;
}

/** The text of a message as the confirmation reader should see it, and where it came from. */
export async function bestReading(raw) {
  const parts = readableParts(raw);
  const candidates = [...parts.texts];
  for (const pdf of parts.pdfs.slice(0, 3)) {
    try {
      const read = await pdfRead(pdf.bytes);
      if (read && read.text && read.text.trim()) candidates.push({ source: 'pdf', text: read.text });
    } catch { /* a PDF that cannot be opened is one candidate fewer */ }
  }
  let best = null;
  for (const c of candidates) {
    const text = c.text.slice(0, MAX_TEXT_CHARS);
    const read = parseConfirmation(text);
    if (!best || score(read) > score(best.read)) best = { ...c, text, read };
  }
  return { best, headers: parts.headers };
}

/**
 * One forwarded message, turned into something waiting on the Import page.
 *
 * Separated from the mail plumbing so it can be run against a message that is a string. The email
 * handler in worker.js is the ten lines that turn one into the other.
 */
export async function handleInboundConfirmation(env, { to, raw }) {
  const token = tokenOf(to);
  const user = token
    ? await env.DB.prepare("SELECT id, email FROM users WHERE invite_token = ? AND status = 'active'")
      .bind(token).first().catch(() => null)
    : null;
  // The same answer whether the token is wrong or the account is closed.
  if (!user) return { reject: 'That address does not take confirmations.' };

  const waiting = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM inbox_confirmations WHERE user_id = ? AND status = 'waiting'"
  ).bind(user.id).first().catch(() => ({ n: 0 }));
  if ((waiting?.n || 0) >= MAX_WAITING) {
    return { user, reject: `You already have ${MAX_WAITING} confirmations waiting. Clear some on the Import page and forward it again.` };
  }

  const { best, headers } = await bestReading(raw);
  if (!best || !usable(best.read)) {
    return {
      user,
      reject: 'I could not find a booking confirmation in that message. Forward the confirmation email itself, '
        + 'or attach its PDF. A picture of a page cannot be read.',
    };
  }

  const f = best.read.fields;
  const summary = {
    client: f.clientName || '', vendor: f.supplier || '', ship: f.productName || '',
    departDate: f.departDate || '', number: f.confirmationNumber || '',
  };
  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO inbox_confirmations
       (id, user_id, from_addr, subject, source, text, summary_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`
  ).bind(id, user.id, clean(headers.get('from') || '', 200), clean(headers.get('subject') || '', 200),
    best.source, best.text, JSON.stringify(summary), ts, ts).run();

  await db.logActivity(env, user.id, 'inbox.received',
    `A confirmation arrived by email${summary.ship ? ` for ${summary.ship}` : ''}`, { id });
  return { user, id, summary };
}

// ---------------------------------------------------------------------------
// The advisor's side
// ---------------------------------------------------------------------------

function addressOf(env, user) {
  const domain = inviteDomain(env);
  if (!domain || !user.invite_token) return null;
  return `conf-${user.invite_token}@${domain}`;
}

const shape = (r) => {
  let summary = {};
  try { summary = JSON.parse(r.summary_json || '{}'); } catch { summary = {}; }
  return { id: r.id, from: r.from_addr || '', subject: r.subject || '', source: r.source, receivedAt: r.created_at, summary };
};

export async function handleListInbox(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return badRequest('Stop working as an advisor first. Their inbox is theirs.');

  const { results } = await env.DB.prepare(
    `SELECT id, from_addr, subject, source, summary_json, created_at FROM inbox_confirmations
      WHERE user_id = ? AND status = 'waiting' ORDER BY created_at DESC LIMIT 50`
  ).bind(user.id).all().catch(() => ({ results: [] }));

  const domain = inviteDomain(env);
  return json({
    items: (results || []).map(shape),
    ready: Boolean(domain),
    address: addressOf(env, user),
    why: domain ? null
      : 'Forwarding is not set up for this portal yet. The office has to point an address at it first.',
  });
}

/** Makes the advisor's address on request, the same token the meeting invites use. */
export async function handleMakeInboxAddress(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return badRequest('Stop working as an advisor first.');
  const domain = inviteDomain(env);
  if (!domain) return badRequest('Forwarding is not set up for this portal yet.');

  let token = user.invite_token || null;
  if (!token) {
    token = (uid() + uid()).replace(/-/g, '').slice(0, 32);
    await env.DB.prepare('UPDATE users SET invite_token = ?, updated_at = ? WHERE id = ?')
      .bind(token, now(), user.id).run();
  }
  return json({ ok: true, address: `conf-${token}@${domain}` });
}

export async function handleGetInboxItem(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return badRequest('Stop working as an advisor first.');
  const row = await env.DB.prepare(
    `SELECT id, from_addr, subject, source, text, summary_json, created_at FROM inbox_confirmations
      WHERE id = ? AND user_id = ? AND status = 'waiting'`
  ).bind(id, user.id).first();
  if (!row) return notFound('That confirmation is not waiting any more.');
  return json({ ...shape(row), text: row.text });
}

/** Dismissed, or turned into a reservation: either way it stops waiting, and the text goes with it. */
export async function handleResolveInbox(request, env, id, outcome) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return badRequest('Stop working as an advisor first.');
  const res = await env.DB.prepare('DELETE FROM inbox_confirmations WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That confirmation is not waiting any more.');
  if (outcome === 'done') {
    await db.logActivity(env, user.id, 'inbox.imported', 'Made a reservation from a forwarded confirmation', { id });
  }
  return json({ ok: true });
}

/** Old ones go, text and all. */
export async function purgeInbox(env) {
  const before = now() - KEEP_DAYS * 86400;
  const res = await env.DB.prepare('DELETE FROM inbox_confirmations WHERE created_at < ?').bind(before).run();
  return { removed: res.meta?.changes || 0 };
}

export const INBOX_LIMITS = { MAX_RAW_BYTES, MAX_WAITING, KEEP_DAYS };
