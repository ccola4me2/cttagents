// The trip, day by day.
//
// A reservation records what was sold. This records what happens: the flight
// at 6:40, the transfer that meets it, which night is the captain's dinner,
// and the free afternoon somebody should be told is free. Until now the client
// was handed a receipt and the actual plan lived in an email thread.
//
// Days are numbers, not dates. Day 1 is departure and every date is worked out
// at read time from the reservation, so a sailing that moves a week moves the
// whole itinerary with it. Stored as dates, every line would need retyping the
// moment the supplier changed the date, which is precisely when nobody has
// time to retype anything.

import {
  json, badRequest, notFound, clean, cleanText, oneOf, uid, now, readJson,
} from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

// What a line on an itinerary is. Order is the order they are offered.
export const ITEM_KINDS = [
  { kind: 'flight', label: 'Flight' },
  { kind: 'cruise', label: 'Cruise' },
  { kind: 'hotel', label: 'Hotel' },
  { kind: 'transfer', label: 'Transfer' },
  { kind: 'activity', label: 'Activity' },
  { kind: 'meal', label: 'Meal' },
  { kind: 'free', label: 'Free time' },
  { kind: 'note', label: 'Note' },
];

const KIND_KEYS = ITEM_KINDS.map((k) => k.kind);

const COLUMNS = `id, booking_id, user_id, day_number, start_time, end_time, kind,
                 title, location, detail, confirmation, image_url, sort_order,
                 created_at, updated_at`;

/** HH:MM or nothing. A time nobody can read is worse than no time at all. */
function cleanTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  const suffix = (m[3] || '').toLowerCase();
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** The date a day number falls on, given where the trip starts. */
export function dateForDay(departDate, dayNumber) {
  if (!dayNumber || !/^\d{4}-\d{2}-\d{2}$/.test(departDate || '')) return null;
  const d = new Date(`${departDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (dayNumber - 1));
  return d.toISOString().slice(0, 10);
}

/** How many days the trip runs, so the builder knows what to offer. */
export function dayCount(booking) {
  const { depart_date: a, return_date: b } = booking || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a || '')) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b || '')) return 1;
  const days = Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000
  ) + 1;
  // A return before departure is somebody's typo, not a trip of minus three
  // days. One day is the honest answer until it is corrected.
  return days > 0 && days < 400 ? days : 1;
}

function parse(body) {
  const title = clean(body.title, 200);
  if (!title) return { error: 'Give the item a title.' };

  const rawDay = body.dayNumber;
  let dayNumber = null;
  if (rawDay !== null && rawDay !== undefined && String(rawDay).trim() !== '') {
    const n = Number(rawDay);
    if (!Number.isInteger(n) || n < 1 || n > 399) {
      return { error: 'A day is a whole number from 1 upwards.' };
    }
    dayNumber = n;
  }

  const startTime = cleanTime(body.startTime);
  if (body.startTime && !startTime) {
    return { error: 'A time reads like 09:30, or leave it blank.' };
  }
  const endTime = cleanTime(body.endTime);
  if (body.endTime && !endTime) {
    return { error: 'A time reads like 09:30, or leave it blank.' };
  }

  const imageUrl = clean(body.imageUrl, 500);
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
    // It loads on a page a client opens over https, and a http image on one of
    // those is a browser warning on their screen.
    return { error: 'A picture address has to start with https://.' };
  }

  return {
    fields: {
      dayNumber,
      startTime,
      endTime,
      kind: oneOf(body.kind, KIND_KEYS),
      title,
      location: clean(body.location, 200) || null,
      detail: cleanText(body.detail, 4000) || null,
      confirmation: clean(body.confirmation, 80) || null,
      imageUrl: imageUrl || null,
    },
  };
}

export async function listItems(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM itinerary_items
      WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY day_number IS NULL ASC, day_number ASC,
               start_time IS NULL ASC, start_time ASC, sort_order ASC, rowid ASC`
  ).bind(bookingId, ...scoped.binds).all();
  return results || [];
}

/**
 * The itinerary as days, which is how it is read and never how it is stored.
 *
 * Every day between departure and return gets an entry whether or not anything
 * is on it, because a gap in a numbered list is a question ("what happened to
 * Tuesday?") and an empty day that says "at sea" is an answer.
 */
export function groupByDay(items, booking) {
  const total = dayCount(booking);
  const depart = booking?.depart_date || null;
  const days = [];
  for (let n = 1; n <= total; n += 1) {
    days.push({
      dayNumber: n,
      date: dateForDay(depart, n),
      items: items.filter((i) => i.day_number === n),
    });
  }
  return {
    days,
    // Items with no day: things true of the whole trip rather than of a
    // morning. Kept apart rather than dumped on day one.
    anytime: items.filter((i) => !i.day_number),
  };
}

export async function handleListItinerary(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const booking = await db.getBookingInScope(env, bookingId, scope);
  if (!booking) return notFound('Reservation not found.');

  const items = await listItems(env, bookingId, scope);
  return json({
    ...groupByDay(items, booking),
    items,
    kinds: ITEM_KINDS,
    dayCount: dayCount(booking),
    departDate: booking.depart_date || null,
    returnDate: booking.return_date || null,
    shared: Boolean(booking.itinerary_shared),
    editable: booking.user_id === user.id,
  });
}

export async function handleSaveItem(request, env, bookingId, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Own reservation only. Seeing somebody's trip is not the same as writing
  // the plan for it.
  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);
  const ts = now();

  if (id) {
    const res = await env.DB.prepare(
      `UPDATE itinerary_items SET day_number = ?, start_time = ?, end_time = ?, kind = ?,
         title = ?, location = ?, detail = ?, confirmation = ?, image_url = ?, updated_at = ?
       WHERE id = ? AND booking_id = ? AND user_id = ?`
    ).bind(fields.dayNumber, fields.startTime, fields.endTime, fields.kind, fields.title,
           fields.location, fields.detail, fields.confirmation, fields.imageUrl, ts,
           id, bookingId, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Item not found.');
    return json({ ok: true, items: await listItems(env, bookingId, db.selfScope(user)) });
  }

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM itinerary_items WHERE booking_id = ? AND user_id = ?'
  ).bind(bookingId, user.id).first();
  if ((count?.n || 0) >= 400) {
    return badRequest('Four hundred items is enough for any trip.');
  }

  await env.DB.prepare(
    `INSERT INTO itinerary_items (id, booking_id, user_id, day_number, start_time, end_time,
       kind, title, location, detail, confirmation, image_url, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(uid(), bookingId, user.id, fields.dayNumber, fields.startTime, fields.endTime,
         fields.kind, fields.title, fields.location, fields.detail, fields.confirmation,
         fields.imageUrl, count?.n || 0, ts, ts).run();

  return json({ ok: true, items: await listItems(env, bookingId, db.selfScope(user)) }, 201);
}

export async function handleDeleteItem(request, env, bookingId, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare(
    'DELETE FROM itinerary_items WHERE id = ? AND booking_id = ? AND user_id = ?'
  ).bind(id, bookingId, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Item not found.');
  return json({ ok: true, items: await listItems(env, bookingId, db.selfScope(user)) });
}

/**
 * Show the itinerary to the client, or stop showing it.
 *
 * Off by default and its own switch, because a half-written itinerary is worse
 * than none: three days filled in and four blank reads as a trip with nothing
 * planned after Wednesday.
 */
export async function handleShareItinerary(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const on = body.shared === true || body.shared === 'on';
  const res = await env.DB.prepare(
    'UPDATE bookings SET itinerary_shared = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(on ? 1 : 0, now(), bookingId, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Reservation not found.');

  return json({ ok: true, shared: on });
}
