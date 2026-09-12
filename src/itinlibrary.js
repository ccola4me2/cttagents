// Pieces of an itinerary, written once.
//
// The builder works and is a retyping exercise. The same advisor describes the
// same Palancar Reef snorkelling every time they sell it, in slightly
// different words, with the meeting time wrong on one of them. That is where a
// tool like this gets abandoned: not because it cannot do the job, but because
// doing the job twice is slower than the email it replaced.
//
// A saved piece is one line rather than a whole trip: an excursion, a hotel, a
// transfer, a note about what to pack for Alaska. Trips are assembled from
// them.
//
// Copied on use, never linked. Correcting the saved wording next year must not
// rewrite an itinerary a client was shown last year, and an advisor who tweaks
// the meeting time for one trip must not be editing everybody's copy.

import {
  json, badRequest, notFound, clean, cleanText, oneOf, uid, now, readJson,
} from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { ITEM_KINDS } from './itinerary.js';

const KIND_KEYS = ITEM_KINDS.map((k) => k.kind);

const COLUMNS = `l.id, l.user_id, l.name, l.kind, l.title, l.location, l.detail,
                 l.image_url, l.start_time, l.end_time, l.used_count,
                 l.created_at, l.updated_at`;

/** HH:MM or nothing. Mirrors the builder, so a saved time lands as a real one. */
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

function parse(body) {
  const title = clean(body.title, 200);
  if (!title) return { error: 'Give it a title, which is what the client reads.' };

  const imageUrl = clean(body.imageUrl, 500);
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
    return { error: 'A picture address has to start with https://.' };
  }
  const startTime = cleanTime(body.startTime);
  if (body.startTime && !startTime) return { error: 'A time reads like 09:30, or leave it blank.' };
  const endTime = cleanTime(body.endTime);
  if (body.endTime && !endTime) return { error: 'A time reads like 09:30, or leave it blank.' };

  return {
    fields: {
      // Falls back to the title, because being made to name a thing twice
      // before saving it is exactly the friction this exists to remove.
      name: clean(body.name, 120) || title,
      kind: oneOf(body.kind, KIND_KEYS),
      title,
      location: clean(body.location, 200) || null,
      detail: cleanText(body.detail, 4000) || null,
      imageUrl: imageUrl || null,
      startTime,
      endTime,
    },
  };
}

/**
 * The agency's pieces, most used first.
 *
 * Shared like the supplier directory and for the same reason: how a shore
 * excursion actually runs is the agency's knowledge of it, not one person's
 * note. Most used first because a list of two hundred is only useful if the
 * eight anybody reaches for are at the top of it.
 */
export async function listLibrary(env, scope, { query } = {}) {
  const scoped = db.scopeWhere(scope, 'l.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (query) {
    where.push('(l.name LIKE ? OR l.title LIKE ? OR l.location LIKE ?)');
    const like = `%${query}%`;
    binds.push(like, like, like);
  }
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''),
                     u.email) AS written_by
       FROM itinerary_library l LEFT JOIN users u ON u.id = l.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.used_count DESC, l.name ASC LIMIT 500`
  ).bind(...binds).all();
  return results || [];
}

export async function handleListLibrary(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const url = new URL(request.url);
  return json({
    pieces: await listLibrary(env, db.agencyScope(user), {
      query: clean(url.searchParams.get('q'), 80),
    }),
    kinds: ITEM_KINDS,
  });
}

export async function handleSaveLibraryPiece(request, env, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);

  // Saved straight off a trip, which is where a good description is actually
  // written: somebody has just described it properly for one client.
  let source = body;
  if (body.fromItem) {
    const scope = db.agencyScope(user);
    const scoped = db.scopeWhere(scope, 'user_id');
    const item = await env.DB.prepare(
      `SELECT kind, title, location, detail, image_url, start_time, end_time
         FROM itinerary_items WHERE id = ? AND ${scoped.sql}`
    ).bind(clean(body.fromItem, 64), ...scoped.binds).first();
    if (!item) return notFound('That itinerary item is not there.');
    source = {
      name: body.name || item.title,
      kind: item.kind,
      title: item.title,
      location: item.location,
      detail: item.detail,
      imageUrl: item.image_url,
      startTime: item.start_time,
      endTime: item.end_time,
    };
  }

  const { fields, error } = parse(source);
  if (error) return badRequest(error);
  const ts = now();

  if (id) {
    // Anybody in the agency may correct it. The directory is shared rather
    // than lent, and a wrong meeting time is worth fixing by whoever finds it.
    const scoped = db.scopeWhere(db.agencyScope(user), 'user_id');
    const res = await env.DB.prepare(
      `UPDATE itinerary_library SET name = ?, kind = ?, title = ?, location = ?, detail = ?,
         image_url = ?, start_time = ?, end_time = ?, updated_at = ?
       WHERE id = ? AND ${scoped.sql}`
    ).bind(fields.name, fields.kind, fields.title, fields.location, fields.detail,
           fields.imageUrl, fields.startTime, fields.endTime, ts, id, ...scoped.binds).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Not in your library.');
    return json({ ok: true, pieces: await listLibrary(env, db.agencyScope(user)) });
  }

  const newId = uid();
  await env.DB.prepare(
    `INSERT INTO itinerary_library (id, user_id, name, kind, title, location, detail,
       image_url, start_time, end_time, used_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`
  ).bind(newId, user.id, fields.name, fields.kind, fields.title, fields.location,
         fields.detail, fields.imageUrl, fields.startTime, fields.endTime, ts, ts).run();

  await db.logActivity(env, user.id, 'library.save', `Saved ${fields.name} to the library`,
    { id: newId });
  return json({ ok: true, id: newId, pieces: await listLibrary(env, db.agencyScope(user)) }, 201);
}

export async function handleDeleteLibraryPiece(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const scoped = db.scopeWhere(db.agencyScope(user), 'user_id');
  const res = await env.DB.prepare(
    `DELETE FROM itinerary_library WHERE id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Not in your library.');
  // The trips built from it keep what they were given. A piece is a starting
  // point, not a parent.
  return json({ ok: true, pieces: await listLibrary(env, db.agencyScope(user)) });
}

/**
 * Drop a saved piece onto a day of a trip.
 *
 * Copied, not referenced, which is the whole design. Editing the library entry
 * next year must not rewrite an itinerary a client was shown last year.
 */
export async function handleUseLibraryPiece(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  const body = await readJson(request);
  const scoped = db.scopeWhere(db.agencyScope(user), 'user_id');
  const piece = await env.DB.prepare(
    `SELECT * FROM itinerary_library WHERE id = ? AND ${scoped.sql}`
  ).bind(clean(body.pieceId, 64), ...scoped.binds).first();
  if (!piece) return notFound('Not in your library.');

  let dayNumber = null;
  if (body.dayNumber !== null && body.dayNumber !== undefined
      && String(body.dayNumber).trim() !== '') {
    const n = Number(body.dayNumber);
    if (!Number.isInteger(n) || n < 1 || n > 399) {
      return badRequest('A day is a whole number from 1 upwards.');
    }
    dayNumber = n;
  }

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM itinerary_items WHERE booking_id = ? AND user_id = ?'
  ).bind(bookingId, user.id).first();

  const ts = now();
  await env.DB.prepare(
    `INSERT INTO itinerary_items (id, booking_id, user_id, day_number, start_time, end_time,
       kind, title, location, detail, confirmation, image_url, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(uid(), bookingId, user.id, dayNumber, piece.start_time, piece.end_time,
         piece.kind, piece.title, piece.location, piece.detail,
         // Deliberately not copied. A confirmation number belongs to one
         // booking, and carrying one across would put another client's
         // reference on this trip.
         null,
         piece.image_url, count?.n || 0, ts, ts).run();

  // So the ones actually reached for rise to the top of a long list. Bounded
  // by the same scope that fetched it rather than by id alone: the row is
  // already proven reachable, and a bare id would stop being safe the moment
  // this moved away from the lookup above.
  await env.DB.prepare(
    `UPDATE itinerary_library SET used_count = used_count + 1 WHERE id = ? AND ${scoped.sql}`
  ).bind(piece.id, ...scoped.binds).run();

  return json({ ok: true }, 201);
}
