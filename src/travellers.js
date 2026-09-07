// The people on a reservation, and what the vendor has granted them.
//
// A traveller count is a number. Travellers are people, and the difference
// shows up in three places that matter:
//
//   Documents are issued per person, so a name has to be exactly as it appears
//   on the passport, not as the client says it in conversation.
//
//   A passport that expires within six months of travel is the commonest way
//   a holiday is lost at the airport, and it is the advisor who gets blamed.
//
//   A birthday is a reason to make contact that costs nothing and is welcome.

import { json, badRequest, notFound, clean, cleanDate, oneOf, toCents, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const AMENITY_STATUS = ['requested', 'confirmed', 'applied', 'declined'];
const AMENITY_SOURCE = ['vendor', 'agency', 'client'];

const TRAVELLER_COLUMNS = `
  id, booking_id, user_id, name, dob, email, phone, passport_number,
  passport_expiry, passport_country, is_lead, notes, created_at, updated_at
`;

function parseTraveller(body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'A traveller needs a name.' };
  return {
    fields: {
      name,
      dob: cleanDate(body.dob),
      email: clean(body.email, 160),
      phone: clean(body.phone, 40),
      passportNumber: clean(body.passportNumber, 40),
      passportExpiry: cleanDate(body.passportExpiry),
      passportCountry: clean(body.passportCountry, 60),
      isLead: body.isLead ? 1 : 0,
      notes: clean(body.notes, 1000),
    },
  };
}

/**
 * A passport is a problem if it expires within six months of the return date.
 *
 * Six months is the rule most countries apply, and it is applied on arrival
 * rather than on booking, so a passport that is valid today can still be
 * refused. Reported as a warning against the trip's own dates rather than
 * against today.
 */
export function passportProblem(traveller, returnDate) {
  if (!traveller.passport_expiry || !returnDate) return null;
  const expiry = Date.parse(`${traveller.passport_expiry}T00:00:00Z`);
  const back = Date.parse(`${returnDate}T00:00:00Z`);
  if (!Number.isFinite(expiry) || !Number.isFinite(back)) return null;
  if (expiry < back) return 'expires before they get home';
  if (expiry < back + 182 * 86400000) return 'expires within six months of their return';
  return null;
}

export async function listTravellers(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT ${TRAVELLER_COLUMNS} FROM travellers
      WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY is_lead DESC, name ASC`
  ).bind(bookingId, ...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

export async function listAmenities(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT id, booking_id, user_id, description, amount_cents, source, status,
            requested_on, notes, created_at
       FROM amenities WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY created_at ASC`
  ).bind(bookingId, ...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

export async function handleAddTraveller(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  const { fields, error } = parseTraveller(await readJson(request));
  if (error) return badRequest(error);

  // One lead traveller: the vendor's confirmation names one person, and two
  // rows both claiming to be them is worse than none.
  if (fields.isLead) {
    await env.DB.prepare('UPDATE travellers SET is_lead = 0 WHERE booking_id = ?')
      .bind(bookingId).run();
  }

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO travellers (id, booking_id, user_id, name, dob, email, phone,
       passport_number, passport_expiry, passport_country, is_lead, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, user.id, fields.name, fields.dob, fields.email, fields.phone,
         fields.passportNumber, fields.passportExpiry, fields.passportCountry,
         fields.isLead, fields.notes, ts, ts).run();

  // The traveller count follows the people on the record rather than being
  // typed separately, so the two can never disagree.
  await syncTravellerCount(env, bookingId, user.id);
  return json({ ok: true, id }, 201);
}

export async function handleUpdateTraveller(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parseTraveller(await readJson(request));
  if (error) return badRequest(error);

  const existing = await env.DB.prepare(
    'SELECT booking_id FROM travellers WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return notFound('Traveller not found.');

  if (fields.isLead) {
    await env.DB.prepare('UPDATE travellers SET is_lead = 0 WHERE booking_id = ?')
      .bind(existing.booking_id).run();
  }

  await env.DB.prepare(
    `UPDATE travellers SET name = ?, dob = ?, email = ?, phone = ?, passport_number = ?,
       passport_expiry = ?, passport_country = ?, is_lead = ?, notes = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.name, fields.dob, fields.email, fields.phone, fields.passportNumber,
         fields.passportExpiry, fields.passportCountry, fields.isLead, fields.notes,
         now(), id, user.id).run();

  return json({ ok: true });
}

export async function handleDeleteTraveller(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await env.DB.prepare('SELECT booking_id FROM travellers WHERE id = ? AND user_id = ?')
    .bind(id, user.id).first();
  if (!row) return notFound('Traveller not found.');
  await env.DB.prepare('DELETE FROM travellers WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  await syncTravellerCount(env, row.booking_id, user.id);
  return json({ ok: true });
}

async function syncTravellerCount(env, bookingId, userId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM travellers WHERE booking_id = ?')
    .bind(bookingId).first();
  const n = row ? row.n : 0;
  if (!n) return;
  // The count drives the pricing grid's columns, so a stale one means a
  // traveller with no column to be priced in.
  await env.DB.prepare('UPDATE bookings SET travellers = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(n, now(), bookingId, userId).run();
}

export async function handleAddAmenity(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  const body = await readJson(request);
  const description = clean(body.description, 200);
  if (!description) return badRequest('What is the amenity?');

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO amenities (id, booking_id, user_id, description, amount_cents, source,
       status, requested_on, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, user.id, description, toCents(body.amount),
         oneOf(body.source, AMENITY_SOURCE), oneOf(body.status, AMENITY_STATUS),
         cleanDate(body.requestedOn), clean(body.notes, 1000), ts, ts).run();

  return json({ ok: true, id }, 201);
}

export async function handleUpdateAmenity(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  // Moving one along is the common case and should not need the whole record.
  if (Object.prototype.hasOwnProperty.call(body, 'status') && Object.keys(body).length === 1) {
    const res = await env.DB.prepare(
      'UPDATE amenities SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(oneOf(body.status, AMENITY_STATUS), now(), id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Amenity not found.');
    return json({ ok: true });
  }

  const description = clean(body.description, 200);
  if (!description) return badRequest('What is the amenity?');
  const res = await env.DB.prepare(
    `UPDATE amenities SET description = ?, amount_cents = ?, source = ?, status = ?,
       requested_on = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(description, toCents(body.amount), oneOf(body.source, AMENITY_SOURCE),
         oneOf(body.status, AMENITY_STATUS), cleanDate(body.requestedOn),
         clean(body.notes, 1000), now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Amenity not found.');
  return json({ ok: true });
}

export async function handleDeleteAmenity(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM amenities WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Amenity not found.');
  return json({ ok: true });
}

/**
 * Everyone whose documents will stop them travelling, across the whole book.
 *
 * passportProblem has been right about a passport since the day it was
 * written, and useless, because it only ran when somebody opened that one
 * reservation. An advisor with eighty trips on the go does not open eighty
 * reservations to check. So the same rule is applied across every upcoming
 * trip at once, which is the only form in which it can actually save a
 * holiday.
 *
 * Two kinds of problem, kept apart because they need different sentences:
 *
 *   A passport that will be refused. The six month rule, checked against the
 *   trip's own return date, so a passport valid today still fails if it runs
 *   out four months after they land.
 *
 *   A passport nobody has recorded. Silence is not evidence that a client
 *   holds a valid passport; it is evidence that nobody has asked. Only raised
 *   as the trip gets close, because an empty field eighteen months out is
 *   normal and flagging it would train the advisor to ignore the panel.
 */
export async function documentWatch(env, scope, { today, askWithinDays = 120 } = {}) {
  const scoped = db.scopeWhere(scope, 't.user_id');
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name, t.passport_number, t.passport_expiry,
            b.id AS booking_id, b.client_name, b.product_name, b.supplier,
            b.depart_date, b.return_date
       FROM travellers t
       JOIN bookings b ON b.id = t.booking_id
      WHERE ${scoped.sql}
        AND b.status = 'booked'
        AND b.depart_date IS NOT NULL AND b.depart_date >= ?
      ORDER BY b.depart_date ASC
      LIMIT 300`
  ).bind(...scoped.binds, today).all();

  const askBy = new Date(Date.parse(`${today}T00:00:00Z`) + askWithinDays * 86400000)
    .toISOString().slice(0, 10);

  const rows = [];
  for (const r of results || []) {
    const back = r.return_date || r.depart_date;
    const warning = passportProblem(r, back);

    if (warning) {
      rows.push({ ...r, kind: 'expiring', detail: warning });
      continue;
    }
    // Nothing recorded, and close enough that it is now a question worth
    // asking rather than a field nobody has filled in yet.
    if (!r.passport_expiry && r.depart_date <= askBy) {
      rows.push({
        ...r, kind: 'unknown',
        detail: r.passport_number ? 'no expiry date recorded' : 'no passport recorded',
      });
    }
  }

  return rows;
}

export async function handleDocumentWatch(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const today = new Date().toISOString().slice(0, 10);
  const rows = await documentWatch(env, scope, { today });

  return json({
    travellers: rows,
    today,
    counts: {
      expiring: rows.filter((r) => r.kind === 'expiring').length,
      unknown: rows.filter((r) => r.kind === 'unknown').length,
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * Birthdays coming up among people who have travelled with you.
 *
 * The date of birth has been collected since travellers became people rather
 * than a headcount, on the stated grounds that a birthday is a reason to make
 * contact that costs nothing and is welcome. It has been collected and never
 * once shown, which makes it a field an advisor fills in for nothing.
 *
 * Deduplicated by person, because someone who has sailed with you four times
 * has four traveller rows and one birthday, and a list that says their name
 * four times is a list nobody trusts.
 */
export async function upcomingBirthdays(env, scope, { today, days = 30, limit = 12 } = {}) {
  const scoped = db.scopeWhere(scope, 't.user_id');
  const byClient = db.scopeWhere(scope, 'c.user_id');

  // Two sources for the same fact. Most birthdays here were collected for a
  // passport and belong to whoever was on the reservation, which is right: the
  // husband travelling on his wife's booking has a birthday too. The second is
  // the date put on the client record by hand, for the client you know well
  // enough to know their birthday and have never sent on a trip.
  const [fromTravellers, fromClients] = await Promise.all([
    env.DB.prepare(
      `SELECT t.user_id, t.name, t.dob, t.email, t.phone, MAX(b.depart_date) AS last_trip,
              COUNT(DISTINCT b.id) AS trips,
              MAX(b.client_name) AS client_name, MAX(b.client_id) AS client_id
         FROM travellers t
         JOIN bookings b ON b.id = t.booking_id
        WHERE ${scoped.sql} AND t.dob IS NOT NULL AND t.dob != ''
          AND b.status IN ('booked','travelled')
        GROUP BY t.user_id, t.name, t.dob
        LIMIT 1000`
    ).bind(...scoped.binds).all(),
    env.DB.prepare(
      `SELECT c.user_id, c.name, c.birthday AS dob, c.email, c.phone, NULL AS last_trip,
              0 AS trips, c.name AS client_name, c.id AS client_id
         FROM clients c
        WHERE ${byClient.sql} AND c.birthday IS NOT NULL AND c.birthday != ''
        LIMIT 1000`
    ).bind(...byClient.binds).all(),
  ]);

  // The client record wins where both know a date: it was typed by somebody
  // who meant it, and a passport can be a scan of the wrong person's document.
  const rows = [...(fromClients.results || [])];
  const seen = new Set(rows.map((r) => `${r.user_id}|${String(r.name).trim().toLowerCase()}`));
  for (const r of fromTravellers.results || []) {
    const key = `${r.user_id}|${String(r.name).trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }

  const from = Date.parse(`${today}T00:00:00Z`);
  const out = [];

  for (const r of rows) {
    const dob = String(r.dob);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) continue;
    const md = dob.slice(5);

    // The next time this date comes round, which is this year's unless it has
    // already gone, and never February 29 in a year that has no such day.
    let next = null;
    for (const year of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
      const candidate = `${year}-${md}`;
      const at = Date.parse(`${candidate}T00:00:00Z`);
      if (!Number.isFinite(at)) continue;
      if (new Date(at).toISOString().slice(0, 10) !== candidate) continue;
      if (at >= from) { next = candidate; break; }
    }
    if (!next) continue;

    const inDays = Math.round((Date.parse(`${next}T00:00:00Z`) - from) / 86400000);
    if (inDays > days) continue;

    out.push({
      user_id: r.user_id,
      name: r.name, dob, email: r.email || null, phone: r.phone || null,
      client_name: r.client_name, client_id: r.client_id || null,
      trips: r.trips, last_trip: r.last_trip,
      on: next, in_days: inDays,
      // Only when the year is real. Ages are guessed often enough elsewhere
      // in the world without this adding to it.
      turning: Number(dob.slice(0, 4)) > 1900 ? Number(next.slice(0, 4)) - Number(dob.slice(0, 4)) : null,
    });
  }

  return out.sort((a, b) => a.in_days - b.in_days).slice(0, limit);
}
