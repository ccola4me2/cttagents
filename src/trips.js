// Several reservations, one trip.
//
// An advisor picks the reservations that are one holiday and gives it a name. The
// reservations stay what they were, with their own money, documents and page; each
// one just says which trip it is part of. The trip is what the client is sent: one
// link, the whole itinerary in date order (see tripplan.js).
//
// A reservation is in at most one trip, because a holiday is one holiday. Only
// booked and travelled reservations go in: a quote that has not been accepted is
// not part of the plan, and putting it on a page a client reads would be offering
// a price by accident.

import { json, badRequest, notFound, clean, cleanText, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { shareCode, appUrl } from './share.js';

const TRIP_COLUMNS = 'id, user_id, client_id, name, intro, tips, share_code, shared_at, created_at, updated_at';

// Named, and short on purpose: what the picker and the trip screen need to say
// which reservation is which.
const ROW_COLUMNS = `id, client_name, status, supplier, product_type, product_name, destination,
  confirmation_number, depart_date, return_date, gross_cents, share_code, itinerary_shared`;

const OK_STATUS = ['booked', 'travelled'];

const link = (env, code) => (code ? `${appUrl(env)}/i/${code}` : null);

const shape = (env, t) => ({
  id: t.id,
  name: t.name,
  intro: t.intro || '',
  tips: t.tips || '',
  shared: Boolean(t.share_code),
  url: link(env, t.share_code),
  clientId: t.client_id || null,
});

/**
 * Give every booked or travelled reservation in a trip its own page.
 *
 * The trip page lists them and each row opens the reservation's page, so a row that
 * could not be opened would be a list of things the client is told they cannot look
 * at. Quotes are never minted here: a quote reaches a client when somebody presses
 * send on that quote and at no other time.
 */
async function shareReservations(env, tripId, ownerId) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM bookings
      WHERE trip_id = ? AND user_id = ? AND share_code IS NULL AND status IN ('booked','travelled')`
  ).bind(tripId, ownerId).all().catch(() => ({ results: [] }));
  const ts = now();
  const writes = (results || []).map((b) => env.DB.prepare(
    'UPDATE bookings SET share_code = ?, shared_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(shareCode(), ts, ts, b.id, ownerId));
  if (writes.length) await env.DB.batch(writes);
  return writes.length;
}

/** What a reservation being put in a trip has to be, or why it cannot be. */
async function checkPick(env, bookingId, ownerId, tripId) {
  const b = await env.DB.prepare(
    `SELECT id, client_id, client_name, product_name, status, trip_id
       FROM bookings WHERE id = ? AND user_id = ?`
  ).bind(bookingId, ownerId).first();
  if (!b) return { error: 'One of those reservations was not found.' };
  const what = `${b.client_name}'s ${b.product_name || 'reservation'}`;
  if (!OK_STATUS.includes(b.status)) {
    return { error: `${what} is ${b.status}. Only booked or travelled reservations go in a trip.` };
  }
  if (b.trip_id && b.trip_id !== tripId) {
    const other = await env.DB.prepare('SELECT name FROM trips WHERE id = ? AND user_id = ?')
      .bind(b.trip_id, ownerId).first();
    return { error: `${what} is already in ${other ? `"${other.name}"` : 'another trip'}. Take it out of that trip first.` };
  }
  return { booking: b };
}

export async function handleListTrips(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 't.user_id');
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name, t.share_code,
            (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.user_id = t.user_id) AS parts,
            (SELECT MIN(b.depart_date) FROM bookings b WHERE b.trip_id = t.id AND b.user_id = t.user_id) AS first_day,
            (SELECT MAX(COALESCE(b.return_date, b.depart_date)) FROM bookings b
              WHERE b.trip_id = t.id AND b.user_id = t.user_id) AS last_day
       FROM trips t WHERE ${scoped.sql} ORDER BY t.created_at DESC LIMIT 500`
  ).bind(...scoped.binds).all();
  return json({
    trips: (results || []).map((t) => ({
      id: t.id, name: t.name, shared: Boolean(t.share_code), parts: t.parts,
      from: t.first_day || null, to: t.last_day || null,
    })),
  });
}

export async function handleCreateTrip(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const ids = [...new Set((Array.isArray(body.bookingIds) ? body.bookingIds : []).map(String))].slice(0, 60);
  if (ids.length < 2) return badRequest('Pick at least two reservations to make one trip.');

  // Whose they are: see db.writerFor. A trip belongs to one advisor, so picks from
  // two advisors are refused rather than quietly filed under one of them.
  let owner = null;
  for (const id of ids) {
    const who = await db.writerForBooking(env, user, id);
    if (!who) return notFound('One of those reservations was not found.');
    if (owner && who.id !== owner.id) {
      return badRequest('A trip belongs to one advisor. Pick reservations that are all the same advisor\'s.');
    }
    owner = who;
  }

  const picked = [];
  for (const id of ids) {
    const r = await checkPick(env, id, owner.id, null);
    if (r.error) return badRequest(r.error);
    picked.push(r.booking);
  }

  const tripId = uid();
  const ts = now();
  const name = clean(body.name, 120) || `${picked[0].client_name}'s trip`;
  const writes = [env.DB.prepare(
    `INSERT INTO trips (id, user_id, client_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(tripId, owner.id, picked[0].client_id || null, name, ts, ts)];
  for (const b of picked) {
    writes.push(env.DB.prepare(
      'UPDATE bookings SET trip_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(tripId, ts, b.id, owner.id));
  }
  await env.DB.batch(writes);

  await db.logActivity(env, owner.id, 'trip.create',
    db.byHand(`Put ${picked.length} reservations together as "${name}"`, user, owner), { tripId });
  return json({ ok: true, id: tripId }, 201);
}

export async function handleGetTrip(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'user_id');
  const trip = await env.DB.prepare(
    `SELECT ${TRIP_COLUMNS} FROM trips WHERE id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).first();
  if (!trip) return notFound('Trip not found.');

  const { results: parts } = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM bookings WHERE trip_id = ? AND user_id = ?
      ORDER BY COALESCE(depart_date, '9999-12-31') ASC, created_at ASC`
  ).bind(id, trip.user_id).all();

  // What could be added: the same client's other booked reservations that are not
  // in a trip yet.
  const first = (parts || [])[0];
  const { results: more } = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM bookings
      WHERE user_id = ? AND trip_id IS NULL AND status IN ('booked','travelled')
        AND (client_id = ? OR client_name = ?)
      ORDER BY COALESCE(depart_date, '9999-12-31') ASC LIMIT 100`
  ).bind(trip.user_id, trip.client_id || '', first ? first.client_name : '').all();

  return json({ trip: shape(env, trip), bookings: parts || [], candidates: more || [] });
}

export async function handleUpdateTrip(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'trips', id);
  if (!owner) return notFound('Trip not found.');
  const trip = await env.DB.prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE id = ? AND user_id = ?`)
    .bind(id, owner.id).first();
  if (!trip) return notFound('Trip not found.');

  const body = await readJson(request);
  const ts = now();
  const writes = [];

  // A field left out of the request is left alone. Only a field that is sent, even
  // as an empty string, is changed, so the screen can save the welcome without
  // knowing the tips.
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const name = has('name') ? clean(body.name, 120) : trip.name;
  if (!name) return badRequest('Give the trip a name.');
  const intro = has('intro') ? (cleanText(body.intro, 4000) || null) : trip.intro;
  const tips = has('tips') ? (cleanText(body.tips, 6000) || null) : trip.tips;
  writes.push(env.DB.prepare(
    'UPDATE trips SET name = ?, intro = ?, tips = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(name, intro, tips, ts, id, owner.id));

  const add = [...new Set((Array.isArray(body.add) ? body.add : []).map(String))].slice(0, 60);
  for (const bid of add) {
    const r = await checkPick(env, bid, owner.id, id);
    if (r.error) return badRequest(r.error);
    writes.push(env.DB.prepare(
      'UPDATE bookings SET trip_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(id, ts, bid, owner.id));
  }
  const remove = [...new Set((Array.isArray(body.remove) ? body.remove : []).map(String))].slice(0, 60);
  for (const bid of remove) {
    writes.push(env.DB.prepare(
      'UPDATE bookings SET trip_id = NULL, updated_at = ? WHERE id = ? AND trip_id = ? AND user_id = ?'
    ).bind(ts, bid, id, owner.id));
  }

  await env.DB.batch(writes);
  // A trip that is already being shared gets the same treatment for what was just
  // added to it, or the new row on the client's page would not open.
  if (trip.share_code && add.length) await shareReservations(env, id, owner.id);

  await db.logActivity(env, owner.id, 'trip.update',
    db.byHand(`Changed the trip "${name}"`, user, owner), { tripId: id, added: add.length, removed: remove.length });
  return json({ ok: true });
}

export async function handleShareTripPlan(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'trips', id);
  if (!owner) return notFound('Trip not found.');
  const trip = await env.DB.prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE id = ? AND user_id = ?`)
    .bind(id, owner.id).first();
  if (!trip) return notFound('Trip not found.');

  const on = (await readJson(request)).on !== false;
  const ts = now();

  if (!on) {
    // Dropped rather than hidden. A link that stops and then works again months
    // later, pointing at a trip that has moved on, is worse than one that is gone.
    await env.DB.prepare(
      'UPDATE trips SET share_code = NULL, shared_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(ts, id, owner.id).run();
    await db.logActivity(env, owner.id, 'trip.unshare',
      db.byHand(`Stopped sharing the trip "${trip.name}"`, user, owner), { tripId: id });
    return json({ ok: true, shared: false, url: null });
  }

  const code = trip.share_code || shareCode();
  await env.DB.prepare(
    'UPDATE trips SET share_code = ?, shared_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(code, trip.shared_at || ts, ts, id, owner.id).run();
  const opened = await shareReservations(env, id, owner.id);

  await db.logActivity(env, owner.id, 'trip.share',
    db.byHand(`Shared the trip "${trip.name}"`, user, owner), { tripId: id, opened });
  return json({ ok: true, shared: true, url: link(env, code), shared_reservations: opened });
}

export async function handleDeleteTrip(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'trips', id);
  if (!owner) return notFound('Trip not found.');
  const trip = await env.DB.prepare('SELECT id, name FROM trips WHERE id = ? AND user_id = ?')
    .bind(id, owner.id).first();
  if (!trip) return notFound('Trip not found.');

  // The reservations are not touched beyond forgetting the trip: each keeps its
  // own money, documents and page. Only the combined page and its link go.
  await env.DB.batch([
    env.DB.prepare('UPDATE bookings SET trip_id = NULL WHERE trip_id = ? AND user_id = ?').bind(id, owner.id),
    env.DB.prepare('DELETE FROM trips WHERE id = ? AND user_id = ?').bind(id, owner.id),
  ]);
  await db.logActivity(env, owner.id, 'trip.delete',
    db.byHand(`Took apart the trip "${trip.name}"`, user, owner), { tripId: id });
  return json({ ok: true });
}
