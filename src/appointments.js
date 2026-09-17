// A time set aside with somebody.
//
// Tasks already carry a date and a time, and an appointment is nearly one.
// What it is not is a due date. A task is due by a moment; an appointment
// occupies one, from a time until a time, somewhere, with a person who is
// expecting you. A calendar built on due dates is a list of deadlines drawn on
// a grid, which does not answer "am I free at two".
//
// A lead needs no separate column here. A lead is a client row with a stage on
// it, so client_id covers both, and an appointment made with a lead keeps
// pointing at the same person after they book.

import { json, badRequest, notFound, clean, cleanText, cleanDate, badDate, oneOf, uid, now, readJson }
  from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

// How it happens, which is worth knowing at a glance: a call and a lunch are
// not the same commitment. Order matters, since oneOf falls back to the first.
export const KINDS = ['call', 'video', 'in person', 'other'];

/**
 * A clock time, or nothing.
 *
 * The same shape tasks and the itinerary library use. Three copies of this now
 * live in this repository, which is two too many, but a shared one is a change
 * to two working modules and this one only needs to agree with them.
 */
function cleanTime(value) {
  const m = String(value ?? '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/**
 * What the request is asking to put in the diary.
 *
 * An end time is optional because "two o'clock" is how people book each other,
 * and refusing to save until somebody guesses an end is the portal asking for
 * precision it does not need. An end *before* the start is refused, because
 * that is a typo rather than a preference, and an hour that runs backwards
 * draws as a negative box on the calendar.
 */
function parse(body) {
  const title = clean(body.title, 160);
  if (!title) return { error: 'What is the appointment?' };

  if (badDate(body.onDate)) return { error: 'That date is not a real date. Check the year.' };
  const onDate = cleanDate(body.onDate);
  if (!onDate) return { error: 'Which day?' };

  const startTime = cleanTime(body.startTime);
  if (!startTime) return { error: 'What time? Use the 24 hour clock, like 14:30.' };

  const endTime = cleanTime(body.endTime);
  if (endTime && endTime < startTime) {
    return { error: 'That ends before it starts. Check the two times.' };
  }

  return {
    fields: {
      title,
      onDate,
      startTime,
      endTime,
      clientId: clean(body.clientId, 64) || null,
      bookingId: clean(body.bookingId, 64) || null,
      location: clean(body.location, 200) || null,
      kind: oneOf(body.kind, KINDS) || null,
      notes: cleanText(body.notes, 2000) || null,
    },
  };
}

/** The row as a page wants it, with the person's name rather than their id. */
function shape(r) {
  return {
    id: r.id,
    title: r.title,
    onDate: r.on_date,
    startTime: r.start_time,
    endTime: r.end_time || '',
    clientId: r.client_id || null,
    clientName: r.client_name || '',
    bookingId: r.booking_id || null,
    bookingName: r.booking_name || '',
    location: r.location || '',
    kind: r.kind || '',
    notes: r.notes || '',
    cancelledAt: r.cancelled_at || null,
    doneAt: r.done_at || null,
  };
}

const SELECT = `SELECT a.*, c.name AS client_name, b.product_name AS booking_name
                  FROM appointments a
                  LEFT JOIN clients c ON c.id = a.client_id
                  LEFT JOIN bookings b ON b.id = a.booking_id`;

/**
 * Everything in the diary between two days.
 *
 * Read through the ordinary visibility scope, so an owner sees the agency's
 * diary and can narrow to one advisor, the same as every other list here.
 * Writing is narrower and deliberately so: see below.
 */
export async function handleListAppointments(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const from = cleanDate(url.searchParams.get('from')) || new Date().toISOString().slice(0, 10);
  const to = cleanDate(url.searchParams.get('to')) || from;
  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'a.user_id');

  const { results } = await env.DB.prepare(
    `${SELECT}
      WHERE ${scoped.sql} AND a.on_date >= ? AND a.on_date <= ?
      ORDER BY a.on_date ASC, a.start_time ASC
      LIMIT 500`
  ).bind(...scoped.binds, from, to).all().catch(() => ({ results: [] }));

  return json({
    appointments: (results || []).map(shape),
    from,
    to,
    kinds: KINDS,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * A client this advisor actually has.
 *
 * An id is not a permission. Pointing an appointment at a client id that is
 * not yours would otherwise be a way to find out whether somebody else's
 * client id is real, and the name would then be read back out of the join.
 */
async function reachableClient(env, user, clientId) {
  if (!clientId) return { ok: true, id: null };
  const row = await db.getClient(env, db.selfScope(user), { id: clientId });
  return row ? { ok: true, id: row.id } : { ok: false };
}

async function reachableBooking(env, user, bookingId) {
  if (!bookingId) return { ok: true, id: null };
  const row = await env.DB.prepare(
    'SELECT id FROM bookings WHERE id = ? AND user_id = ?'
  ).bind(bookingId, user.id).first();
  return row ? { ok: true, id: row.id } : { ok: false };
}

export async function handleCreateAppointment(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const who = await reachableClient(env, user, fields.clientId);
  if (!who.ok) return notFound('That client is not on your books.');
  const trip = await reachableBooking(env, user, fields.bookingId);
  if (!trip.ok) return notFound('That reservation is not one of yours.');

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO appointments
       (id, user_id, title, client_id, booking_id, on_date, start_time, end_time,
        location, kind, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.title, who.id, trip.id, fields.onDate, fields.startTime,
         fields.endTime, fields.location, fields.kind, fields.notes, ts, ts).run();

  await db.logActivity(env, user.id, 'appointment.created',
    `${fields.title} on ${fields.onDate} at ${fields.startTime}`, { clientId: who.id });

  const row = await env.DB.prepare(`${SELECT} WHERE a.id = ? AND a.user_id = ?`)
    .bind(id, user.id).first();
  return json({ ok: true, appointment: shape(row) }, 201);
}

/**
 * Your own diary.
 *
 * Reading is scoped the wide way, because an owner wanting to see who is busy
 * on Thursday is a reasonable thing. Writing is not: nobody asked to be able
 * to move somebody else's two o'clock, and an appointment is a commitment the
 * person who made it is the one keeping.
 */
export async function handleUpdateAppointment(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const before = await env.DB.prepare(
    'SELECT * FROM appointments WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!before) return notFound('Appointment not found.');

  const body = await readJson(request);

  // Cancelling and un-cancelling say so on their own, without having to
  // re-send the whole appointment to do it.
  if (body.cancelled !== undefined || body.done !== undefined) {
    await env.DB.prepare(
      `UPDATE appointments
          SET cancelled_at = CASE WHEN ? IS NULL THEN cancelled_at ELSE ? END,
              done_at = CASE WHEN ? IS NULL THEN done_at ELSE ? END,
              updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(
      body.cancelled === undefined ? null : 1, body.cancelled ? now() : null,
      body.done === undefined ? null : 1, body.done ? now() : null,
      now(), id, user.id
    ).run();
    const after = await env.DB.prepare(`${SELECT} WHERE a.id = ? AND a.user_id = ?`)
      .bind(id, user.id).first();
    return json({ ok: true, appointment: shape(after) });
  }

  const { fields, error } = parse(body);
  if (error) return badRequest(error);

  const who = await reachableClient(env, user, fields.clientId);
  if (!who.ok) return notFound('That client is not on your books.');
  const trip = await reachableBooking(env, user, fields.bookingId);
  if (!trip.ok) return notFound('That reservation is not one of yours.');

  await env.DB.prepare(
    `UPDATE appointments
        SET title = ?, client_id = ?, booking_id = ?, on_date = ?, start_time = ?,
            end_time = ?, location = ?, kind = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(fields.title, who.id, trip.id, fields.onDate, fields.startTime, fields.endTime,
         fields.location, fields.kind, fields.notes, now(), id, user.id).run();

  const after = await env.DB.prepare(`${SELECT} WHERE a.id = ? AND a.user_id = ?`)
    .bind(id, user.id).first();
  return json({ ok: true, appointment: shape(after) });
}

export async function handleDeleteAppointment(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const row = await env.DB.prepare(
    'SELECT title FROM appointments WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!row) return notFound('Appointment not found.');

  await env.DB.prepare('DELETE FROM appointments WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  await db.logActivity(env, user.id, 'appointment.deleted', row.title, {});
  return json({ ok: true });
}

/**
 * Appointments coming up, shaped like the tasks they sit beside.
 *
 * The same trick the leads use: the drawer buckets by due_date, the badge
 * counts late and today, and the digest renders a title and a client, so an
 * appointment arriving in that shape needs none of them changed.
 *
 * Cancelled ones are not due. Neither are ones already marked done.
 */
export async function dueAppointments(env, scope, { until }) {
  const scoped = db.scopeWhere(scope, 'a.user_id');
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.user_id, a.title, a.on_date, a.start_time, a.end_time, a.location,
            c.name AS client_name
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE ${scoped.sql} AND a.on_date <= ?
        AND a.cancelled_at IS NULL AND a.done_at IS NULL
      ORDER BY a.on_date ASC, a.start_time ASC
      LIMIT 200`
  ).bind(...scoped.binds, until).all().catch(() => ({ results: [] }));

  return (results || []).map((r) => ({
    // Prefixed so nothing can tick, pin or push it as though it were a task.
    id: `appt:${r.id}`,
    appointment: true,
    appointment_id: r.id,
    user_id: r.user_id,
    title: r.title,
    client_name: r.client_name || '',
    location: r.location || '',
    due_date: r.on_date,
    due_time: r.start_time,
    end_time: r.end_time || '',
    done_at: null,
    pinned_at: null,
  }));
}
