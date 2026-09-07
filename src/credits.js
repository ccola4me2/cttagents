// Credits a client holds with a vendor, and the date they stop being worth
// anything.
//
// Future cruise deposits, future cruise credits, refunds taken as credit, a
// goodwill certificate after a bad sailing. The vendor will not remind anyone.
// An unused credit that expires is money the client has already paid and will
// never see again, and the advisor is the only person tracking it.

import { json, badRequest, notFound, clean, cleanDate, oneOf, toCents, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const KINDS = ['credit', 'deposit', 'certificate'];

const COLUMNS = `
  c.id, c.user_id, c.client_name, c.client_id, c.contact_id, c.vendor, c.kind,
  c.reference, c.amount_cents, c.issued_on, c.expires_on, c.used_on,
  c.booking_id, c.notes, c.created_at, c.updated_at
`;

function parse(body) {
  const clientName = clean(body.clientName, 120);
  if (!clientName) return { error: 'Whose credit is it?' };

  const amountCents = toCents(body.amount);
  if (amountCents <= 0) return { error: 'Enter an amount.' };

  const issuedOn = cleanDate(body.issuedOn);
  const expiresOn = cleanDate(body.expiresOn);
  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    return { error: 'The expiry falls before the credit was issued.' };
  }

  return {
    fields: {
      clientName,
      contactId: clean(body.contactId, 64) || null,
      vendor: clean(body.vendor, 120),
      kind: oneOf(body.kind, KINDS),
      reference: clean(body.reference, 80),
      amountCents,
      issuedOn,
      expiresOn,
      usedOn: cleanDate(body.usedOn),
      bookingId: clean(body.bookingId, 64) || null,
      notes: clean(body.notes, 2000),
    },
  };
}

export async function listCredits(env, scope, { state = 'open', limit = 300 } = {}) {
  const scoped = db.scopeWhere(scope, 'c.user_id');
  const where = [scoped.sql];
  if (state === 'open') where.push('c.used_on IS NULL');
  if (state === 'used') where.push('c.used_on IS NOT NULL');

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS}, b.client_name AS booking_client,
            cl.email AS client_email, cl.phone AS client_phone,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
              AS advisor_name
       FROM client_credits c
       LEFT JOIN bookings b ON b.id = c.booking_id
       LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN users u ON u.id = c.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(c.expires_on, '9999-12-31') ASC LIMIT ?`
  ).bind(...scoped.binds, Math.min(Number(limit) || 300, 500)).all();
  return results || [];
}

export async function handleListCredits(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const state = oneOf(url.searchParams.get('state'), ['open', 'used', 'all']);
  const scope = db.scopeFor(env, user, request);
  const credits = await listCredits(env, scope, { state });

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const live = credits.filter((c) => !c.used_on);

  return json({
    credits,
    today,
    stats: {
      openCents: live.reduce((n, c) => n + (c.amount_cents || 0), 0),
      openCount: live.length,
      expiringCents: live.filter((c) => c.expires_on && c.expires_on >= today && c.expires_on <= soon)
        .reduce((n, c) => n + (c.amount_cents || 0), 0),
      expiringCount: live.filter((c) => c.expires_on && c.expires_on >= today && c.expires_on <= soon).length,
      // Reported rather than hidden. Money that has already gone is still
      // worth seeing, because it is the argument for watching the rest.
      lapsedCents: live.filter((c) => c.expires_on && c.expires_on < today)
        .reduce((n, c) => n + (c.amount_cents || 0), 0),
      lapsedCount: live.filter((c) => c.expires_on && c.expires_on < today).length,
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

async function getCredit(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${COLUMNS} FROM client_credits c WHERE c.id = ? AND c.user_id = ?`
  ).bind(id, userId).first();
}

export async function handleCreateCredit(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);
  if (fields.bookingId && !(await db.getBooking(env, fields.bookingId, user.id))) {
    return badRequest('That reservation is not yours.');
  }

  const clientId = await db.resolveClient(env, user.id, fields.clientName);
  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO client_credits (id, user_id, client_name, client_id, contact_id, vendor, kind,
       reference, amount_cents, issued_on, expires_on, used_on, booking_id, notes,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.clientName, clientId, fields.contactId, fields.vendor, fields.kind,
         fields.reference, fields.amountCents, fields.issuedOn, fields.expiresOn,
         fields.usedOn, fields.bookingId, fields.notes, ts, ts).run();

  await db.logActivity(env, user.id, 'credit.create',
    `Recorded a credit for ${fields.clientName}`, { id });
  return json({ ok: true, credit: await getCredit(env, id, user.id) }, 201);
}

export async function handleUpdateCredit(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);
  if (fields.bookingId && !(await db.getBooking(env, fields.bookingId, user.id))) {
    return badRequest('That reservation is not yours.');
  }

  const clientId = await db.resolveClient(env, user.id, fields.clientName);
  const res = await env.DB.prepare(
    `UPDATE client_credits SET client_name = ?, client_id = ?, contact_id = ?, vendor = ?, kind = ?,
       reference = ?, amount_cents = ?, issued_on = ?, expires_on = ?, used_on = ?,
       booking_id = ?, notes = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.clientName, clientId, fields.contactId, fields.vendor, fields.kind, fields.reference,
         fields.amountCents, fields.issuedOn, fields.expiresOn, fields.usedOn,
         fields.bookingId, fields.notes, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Credit not found.');

  return json({ ok: true, credit: await getCredit(env, id, user.id) });
}

export async function handleDeleteCredit(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM client_credits WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Credit not found.');
  return json({ ok: true });
}
