// Things the whole agency does together: a vendor training, a webinar, an office meeting.
//
// An appointment is one advisor's. An agency event is made by an owner and shows up on every
// advisor's calendar and on their dashboard, so a training an owner has arranged does not depend
// on each advisor having been told. Advisors can say they are going and the owner sees who did.
//
// Advisors only read these. Making, changing, cancelling and deleting are an owner's, and the
// agency on every statement is the signed-in person's own, never one named in the request.

import { json, badRequest, notFound, forbidden, clean, cleanText, cleanDate, badDate, oneOf, uid, now, readJson }
  from './util.js';
import { requireUser, requireAdmin, borrowedSeat } from './auth.js';
import * as db from './db.js';

export const KINDS = ['training', 'webinar', 'meeting', 'other'];
export const KIND_LABELS = {
  training: 'Training', webinar: 'Vendor webinar', meeting: 'Agency meeting', other: 'Event',
};

function cleanTime(value) {
  const m = String(value ?? '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/** A join link must be a web address; anything else is dropped rather than put in front of every advisor. */
function cleanLink(value) {
  const text = clean(value, 500);
  if (!text) return null;
  try {
    const u = new URL(text);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : false;
  } catch { return false; }
}

function parse(body) {
  const title = clean(body.title, 160);
  if (!title) return { error: 'What is the event called?' };
  if (badDate(body.onDate)) return { error: 'That date is not a real date. Check the year.' };
  const onDate = cleanDate(body.onDate);
  if (!onDate) return { error: 'Which day?' };
  const startTime = cleanTime(body.startTime);
  if (!startTime) return { error: 'What time does it start? Use the 24 hour clock, like 14:30.' };
  const endTime = cleanTime(body.endTime);
  if (endTime && endTime < startTime) return { error: 'That ends before it starts. Check the two times.' };
  const link = cleanLink(body.link);
  if (link === false) return { error: 'The join link has to be a web address starting with https://.' };
  return {
    fields: {
      kind: oneOf(body.kind, KINDS) || 'training',
      title,
      vendor: clean(body.vendor, 120) || null,
      onDate,
      startTime,
      endTime,
      tz: clean(body.tz, 12) || null,
      link,
      notes: cleanText(body.notes, 2000) || null,
    },
  };
}

function shape(r, going, goingCount) {
  return {
    id: r.id,
    kind: r.kind,
    kindLabel: KIND_LABELS[r.kind] || 'Event',
    title: r.title,
    vendor: r.vendor || '',
    onDate: r.on_date,
    startTime: r.start_time,
    endTime: r.end_time || '',
    tz: r.tz || '',
    link: r.link || '',
    notes: r.notes || '',
    cancelledAt: r.cancelled_at || null,
    going: Boolean(going),
    goingCount: goingCount || 0,
  };
}

/**
 * The agency's events between two days, as the reader sees them: whether they are going, and how
 * many are. Never throws: a page that shows this beside other things must not fail with them.
 */
export async function agencyEventsBetween(env, user, from, to) {
  const agencyId = user.agency_id || '';
  const [rows, mine, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT id, kind, title, vendor, on_date, start_time, end_time, tz, link, notes, cancelled_at
         FROM agency_events
        WHERE agency_id = ? AND on_date >= ? AND on_date <= ?
        ORDER BY on_date, start_time LIMIT 300`
    ).bind(agencyId, from, to).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT event_id FROM agency_event_going WHERE agency_id = ? AND user_id = ?`
    ).bind(agencyId, user.id).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT event_id, COUNT(*) AS n FROM agency_event_going WHERE agency_id = ? GROUP BY event_id`
    ).bind(agencyId).all().catch(() => ({ results: [] })),
  ]);
  const going = new Set((mine.results || []).map((r) => r.event_id));
  const count = new Map((counts.results || []).map((r) => [r.event_id, r.n]));
  return (rows.results || []).map((r) => shape(r, going.has(r.id), count.get(r.id)));
}

const dayOffset = (iso, days) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** GET /api/agency-events?upcoming=1 or ?from=&to= : everybody in the agency may read. */
export async function handleListAgencyEvents(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const params = new URL(request.url).searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = cleanDate(params.get('from')) || today;
  const to = cleanDate(params.get('to')) || dayOffset(from, 120);
  const events = (await agencyEventsBetween(env, user, from, to > dayOffset(from, 400) ? dayOffset(from, 400) : to))
    .filter((e) => !e.cancelledAt);
  return json({ events, today, kinds: KINDS.map((k) => [k, KIND_LABELS[k]]) });
}

/**
 * GET /api/admin/agency-events : the owner's list, with who is going on each.
 * Everything from a month ago on, so last week's attendance can still be looked back at.
 */
export async function handleAdminAgencyEvents(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const agencyId = user.agency_id || '';
  const today = new Date().toISOString().slice(0, 10);
  const events = await agencyEventsBetween(env, user, dayOffset(today, -30), dayOffset(today, 400));

  const { results } = await env.DB.prepare(
    `SELECT g.event_id, u.first_name, u.last_name, u.email
       FROM agency_event_going g JOIN users u ON u.id = g.user_id
      WHERE g.agency_id = ? ORDER BY u.first_name, u.last_name`
  ).bind(agencyId).all().catch(() => ({ results: [] }));
  const names = new Map();
  for (const r of results || []) {
    const list = names.get(r.event_id) || [];
    list.push(`${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email);
    names.set(r.event_id, list);
  }
  const advisors = (await db.listUsers(env, { status: 'active', agencyId: agencyId || undefined })).length;
  return json({
    events: events.map((e) => ({ ...e, attendees: names.get(e.id) || [] })),
    advisors,
    today,
    kinds: KINDS.map((k) => [k, KIND_LABELS[k]]),
  });
}

/** POST /api/agency-events, and PUT /api/agency-events/:id (also { cancelled } to cancel or restore). */
export async function handleSaveAgencyEvent(request, env, id = null) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const agencyId = user.agency_id || '';
  const body = await readJson(request);
  const ts = now();

  if (id && typeof body.cancelled === 'boolean' && body.title === undefined) {
    const res = await env.DB.prepare(
      'UPDATE agency_events SET cancelled_at = ?, updated_at = ? WHERE id = ? AND agency_id = ?'
    ).bind(body.cancelled ? ts : null, ts, id, agencyId).run();
    if (!res.meta || !res.meta.changes) return notFound('Event not found.');
    return json({ ok: true });
  }

  const parsed = parse(body);
  if (parsed.error) return badRequest(parsed.error);
  const f = parsed.fields;

  if (!id) {
    const newId = uid();
    await env.DB.prepare(
      `INSERT INTO agency_events (id, agency_id, kind, title, vendor, on_date, start_time, end_time,
                                  tz, link, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(newId, agencyId, f.kind, f.title, f.vendor, f.onDate, f.startTime, f.endTime,
      f.tz, f.link, f.notes, user.id, ts, ts).run();
    await db.logActivity(env, user.id, 'agency_event.create', `Put "${f.title}" on everyone's calendar`, { id: newId });
    return json({ ok: true, id: newId }, 201);
  }

  const res = await env.DB.prepare(
    `UPDATE agency_events SET kind = ?, title = ?, vendor = ?, on_date = ?, start_time = ?, end_time = ?,
            tz = ?, link = ?, notes = ?, updated_at = ?
      WHERE id = ? AND agency_id = ?`
  ).bind(f.kind, f.title, f.vendor, f.onDate, f.startTime, f.endTime, f.tz, f.link, f.notes, ts,
    id, agencyId).run();
  if (!res.meta || !res.meta.changes) return notFound('Event not found.');
  return json({ ok: true, id });
}

/** DELETE /api/agency-events/:id : gone from every calendar, and the answers with it. */
export async function handleDeleteAgencyEvent(request, env, id) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const agencyId = user.agency_id || '';
  const res = await env.DB.prepare('DELETE FROM agency_events WHERE id = ? AND agency_id = ?')
    .bind(id, agencyId).run();
  if (!res.meta || !res.meta.changes) return notFound('Event not found.');
  await env.DB.prepare('DELETE FROM agency_event_going WHERE event_id = ? AND agency_id = ?')
    .bind(id, agencyId).run();
  await db.logActivity(env, user.id, 'agency_event.delete', 'Removed an agency event', { id });
  return json({ ok: true });
}

/**
 * PUT /api/agency-events/:id/going { going } : say you are going, or take it back.
 * Your own answer only. Working as somebody else may not answer for them.
 */
export async function handleGoing(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return forbidden('Stop working as an advisor to answer for yourself.');
  const agencyId = user.agency_id || '';

  const event = await env.DB.prepare(
    'SELECT id FROM agency_events WHERE id = ? AND agency_id = ?'
  ).bind(id, agencyId).first();
  if (!event) return notFound('Event not found.');

  const going = (await readJson(request)).going !== false;
  if (going) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agency_event_going (event_id, agency_id, user_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(id, agencyId, user.id, now()).run();
  } else {
    await env.DB.prepare(
      'DELETE FROM agency_event_going WHERE event_id = ? AND agency_id = ? AND user_id = ?'
    ).bind(id, agencyId, user.id).run();
  }
  return json({ ok: true, going });
}
