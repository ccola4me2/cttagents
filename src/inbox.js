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
import { json, badRequest, notFound, uid, now, clean, PermanentError } from './util.js';
import { requireUser, borrowedSeat } from './auth.js';
import { inviteDomain } from './appointments.js';
import { layout, sendHtml } from './email.js';
import { appUrl } from './share.js';
import { brandForUser } from './brand.js';
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
    // The HTML wins a tie. Its tables keep a row's cells apart, and a plain text version made from the
    // same email usually runs them together, which reads the same figures with less certainty.
    const points = score(read) + (c.source === 'html' ? 1 : 0);
    if (!best || points > best.points) best = { ...c, text, read, points };
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
  const alias = token ? null : aliasOf(to);
  const user = token
    ? await env.DB.prepare("SELECT id, email FROM users WHERE invite_token = ? AND status = 'active'")
      .bind(token).first().catch(() => null)
    : (alias
      ? await env.DB.prepare("SELECT id, email FROM users WHERE import_alias = ? AND status = 'active'")
        .bind(alias).first().catch(() => null)
      : null);
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
  // Told it is ready, with the one button. Best effort: the confirmation is waiting on the Import page whether or
  // not this message gets there.
  await tellConfirmationReady(env, user, id, summary).catch((e) => {
    // No mail key configured is not a fault worth a log line; the confirmation is on the Import page regardless.
    if (!(e instanceof PermanentError)) console.error('confirmation ready note', e);
  });
  return { user, id, summary };
}

const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A short note to the advisor that a forwarded confirmation has been read, with a button that opens it ready to create. */
async function tellConfirmationReady(env, user, id, summary) {
  const full = await db.getUserById(env, user.id);
  const to = (full && (full.notify_email || full.email)) || user.email;
  if (!to) return;
  const bits = [summary.client, summary.ship || summary.vendor, summary.departDate, summary.number ? `#${summary.number}` : '']
    .filter(Boolean).join(' · ');
  const first = (full && full.first_name) || 'there';
  const html = layout(env, {
    brand: await brandForUser(env, user.id),
    heading: 'Your confirmation is ready',
    body: `<p style="margin:0 0 14px;">Hello ${esc(first)},</p>
      <p style="margin:0 0 14px;">I read the confirmation you forwarded${bits ? `: <strong>${esc(bits)}</strong>` : ''}.</p>
      <p style="margin:0 0 14px;">One button makes the reservation. It files the guests as clients, sets up the payments and puts
        the dates on your task list. You can look over the details first if you like.</p>`,
    cta: { label: 'Make the reservation', href: `${appUrl(env)}/app/import?inbox=${encodeURIComponent(id)}` },
  });
  await sendHtml(env, { to, subject: `Ready to make: ${bits || 'your forwarded confirmation'}`, html });
}

// ---------------------------------------------------------------------------
// The advisor's side
// ---------------------------------------------------------------------------

function addressOf(env, user) {
  const domain = inviteDomain(env);
  if (!domain || !(user.import_alias || user.invite_token)) return null;
  return `conf-${user.import_alias || user.invite_token}@${domain}`;
}

/** The name in a conf- address, when it is a name and not the long code. */
function aliasOf(address) {
  const at = String(address || '').indexOf('@');
  const local = (at === -1 ? String(address || '') : String(address).slice(0, at))
    .toLowerCase().split('+')[0].trim().replace(/^conf[-.]/, '');
  return /^[a-z][a-z0-9]{1,30}$/.test(local) && !/^[a-f0-9]{16,64}$/.test(local) ? local : null;
}

/** The advisor's first name as their address, when nobody else has it. Null when it is taken or is not a usable name. */
async function claimAlias(env, user) {
  const name = String(user.first_name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  if (!/^[a-z][a-z0-9]{1,29}$/.test(name) || ['appt', 'conf', 'abc'].includes(name)) return null;
  try {
    const res = await env.DB.prepare(
      'UPDATE users SET import_alias = ?, updated_at = ? WHERE id = ? AND import_alias IS NULL'
    ).bind(name, now(), user.id).run();
    return res.meta && res.meta.changes > 0 ? name : null;
  } catch {
    // Somebody else has it: the long code address stands.
    return null;
  }
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
  const alias = user.import_alias || await claimAlias(env, user);
  return json({ ok: true, address: `conf-${alias || token}@${domain}` });
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
