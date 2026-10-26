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
import { announceEvent } from './agencyeventmail.js';
import { inZone, zoneOfUser } from './eventzone.js';

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
  if (!startTime) return { error: 'What time does it start?' };
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
    announcedAt: r.announced_at || null,
    audience: r.audience === 'some' ? 'some' : 'all',
    remind: r.remind !== 0,
    remindedAt: r.reminded_at || null,
    going: Boolean(going),
    goingCount: goingCount || 0,
  };
}

/**
 * The agency's events between two days, as the reader sees them: whether they are going, and how
 * many are. Never throws: a page that shows this beside other things must not fail with them.
 */
export async function agencyEventsBetween(env, user, from, to, { raw = false } = {}) {
  const agencyId = user.agency_id || '';
  // Each event is read in the reader's own zone, so a late one can land on the next or the previous day. The search is a
  // day wider each way for that, and the answer is trimmed back to what was asked for. An owner editing sees them as entered.
  const zone = zoneOfUser(env, user);
  const wideFrom = raw ? from : dayOffset(from, -1);
  const wideTo = raw ? to : dayOffset(to, 1);
  // An owner sees every event. An advisor sees the ones for everybody and the ones they are invited to.
  const everything = user.role === 'admin';
  const [rows, mine, counts, invites] = await Promise.all([
    env.DB.prepare(
      `SELECT id, kind, title, vendor, on_date, start_time, end_time, tz, link, notes, cancelled_at,
              announced_at, remind, reminded_at, audience
         FROM agency_events
        WHERE agency_id = ? AND on_date >= ? AND on_date <= ?
        ORDER BY on_date, start_time LIMIT 300`
    ).bind(agencyId, wideFrom, wideTo).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT event_id FROM agency_event_going WHERE agency_id = ? AND user_id = ?`
    ).bind(agencyId, user.id).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT event_id, COUNT(*) AS n FROM agency_event_going WHERE agency_id = ? GROUP BY event_id`
    ).bind(agencyId).all().catch(() => ({ results: [] })),
    // The events an advisor was picked for. Read on its own and applied below, so the list needs no clever SQL.
    everything ? Promise.resolve({ results: [] }) : env.DB.prepare(
      'SELECT event_id FROM agency_event_invites WHERE agency_id = ? AND user_id = ?'
    ).bind(agencyId, user.id).all().catch(() => ({ results: [] })),
  ]);
  const invitedTo = new Set((invites.results || []).map((r) => r.event_id));
  const going = new Set((mine.results || []).map((r) => r.event_id));
  const count = new Map((counts.results || []).map((r) => [r.event_id, r.n]));
  const visible = (rows.results || []).filter((r) => everything || r.audience !== 'some' || invitedTo.has(r.id));
  const read = visible.map((r) => {
    if (raw) return r;
    const shown = inZone(r, zone);
    return { ...r, on_date: shown.onDate, start_time: shown.startTime, end_time: shown.endTime, tz: shown.tz };
  });
  return read
    .filter((r) => r.on_date >= from && r.on_date <= to)
    .sort((a, b) => (a.on_date + a.start_time < b.on_date + b.start_time ? -1 : 1))
    .map((r) => shape(r, going.has(r.id), count.get(r.id)));
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
  // Whether this reader may put an event on the calendar, so the dashboard can offer the button to the people it is for.
  return json({ events, today, canManage: user.role === 'admin' && !borrowedSeat(user), kinds: KINDS.map((k) => [k, KIND_LABELS[k]]) });
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
  const events = await agencyEventsBetween(env, user, dayOffset(today, -30), dayOffset(today, 400), { raw: true });

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
  const people = await db.listUsers(env, { status: 'active', agencyId: agencyId || undefined });
  const advisors = people.length;
  const invited = new Map();
  const inv = await env.DB.prepare(
    'SELECT event_id, user_id FROM agency_event_invites WHERE agency_id = ?'
  ).bind(agencyId).all().catch(() => ({ results: [] }));
  for (const r of inv.results || []) {
    const list = invited.get(r.event_id) || [];
    list.push(r.user_id);
    invited.set(r.event_id, list);
  }
  return json({
    events: events.map((e) => {
      const ids = invited.get(e.id) || [];
      return { ...e, attendees: names.get(e.id) || [], invitees: ids, invitedCount: e.audience === 'some' ? ids.length : advisors };
    }),
    advisors,
    people: people.map((u) => ({
      id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email, role: u.role,
    })),
    today,
    kinds: KINDS.map((k) => [k, KIND_LABELS[k]]),
  });
}

/**
 * Who an event is for, from what the owner sent: "all", or a list of advisors. Only people who are active in this agency
 * are kept, so a stale or made up id cannot put an event in front of somebody outside it. Undefined means "leave it as it
 * is", which is how a change to the time does not quietly widen a short list.
 */
async function audienceFrom(env, agencyId, invitees) {
  if (invitees === undefined) return { keep: true };
  if (invitees === 'all' || invitees === null) return { audience: 'all', ids: [] };
  if (!Array.isArray(invitees)) return { error: 'Who is invited: everyone, or pick advisors.' };
  const people = await db.listUsers(env, { status: 'active', agencyId: agencyId || undefined });
  const known = new Set(people.map((u) => u.id));
  const ids = [...new Set(invitees.map(String))].filter((x) => known.has(x));
  if (!ids.length) return { error: 'Pick at least one advisor, or invite everyone.' };
  return { audience: 'some', ids };
}

function inviteWrites(env, agencyId, eventId, aud, ts) {
  if (aud.keep) return [];
  return [
    env.DB.prepare('UPDATE agency_events SET audience = ? WHERE id = ? AND agency_id = ?').bind(aud.audience, eventId, agencyId),
    env.DB.prepare('DELETE FROM agency_event_invites WHERE event_id = ? AND agency_id = ?').bind(eventId, agencyId),
    ...aud.ids.map((uid_) => env.DB.prepare(
      'INSERT OR IGNORE INTO agency_event_invites (event_id, agency_id, user_id, created_at) VALUES (?, ?, ?, ?)'
    ).bind(eventId, agencyId, uid_, ts)),
  ];
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
  const aud = await audienceFrom(env, agencyId, body.invitees);
  if (aud.error) return badRequest(aud.error);

  if (!id) {
    const newId = uid();
    await env.DB.prepare(
      `INSERT INTO agency_events (id, agency_id, kind, title, vendor, on_date, start_time, end_time,
                                  tz, link, notes, remind, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(newId, agencyId, f.kind, f.title, f.vendor, f.onDate, f.startTime, f.endTime,
      f.tz, f.link, f.notes, body.remind === false ? 0 : 1, user.id, ts, ts).run();
    const writes = inviteWrites(env, agencyId, newId, aud.keep ? { audience: 'all', ids: [] } : aud, ts);
    if (writes.length) await env.DB.batch(writes);
    await db.logActivity(env, user.id, 'agency_event.create',
      aud.audience === 'some' ? `Put "${f.title}" on ${aud.ids.length} advisors' calendars` : `Put "${f.title}" on everyone's calendar`,
      { id: newId });
    // Told on the way in, when the owner asked: one save, one announcement, and the answer says how it went.
    let told = null;
    if (body.notify === true) {
      try {
        const ev = await loadEvent(env, newId, agencyId);
        told = await announceEvent(env, user, ev, 'new');
      } catch (e) { told = { sent: 0, failed: [], total: 0, error: String(e.message || e).slice(0, 160) }; }
    }
    return json({ ok: true, id: newId, told }, 201);
  }

  const res = await env.DB.prepare(
    `UPDATE agency_events SET kind = ?, title = ?, vendor = ?, on_date = ?, start_time = ?, end_time = ?,
            tz = ?, link = ?, notes = ?, remind = COALESCE(?, remind), updated_at = ?
      WHERE id = ? AND agency_id = ?`
  ).bind(f.kind, f.title, f.vendor, f.onDate, f.startTime, f.endTime, f.tz, f.link, f.notes,
    typeof body.remind === 'boolean' ? (body.remind ? 1 : 0) : null, ts, id, agencyId).run();
  if (!res.meta || !res.meta.changes) return notFound('Event not found.');
  const writes = inviteWrites(env, agencyId, id, aud, ts);
  if (writes.length) await env.DB.batch(writes);
  // A date that moved is a reminder that has not been sent for the new date.
  await env.DB.prepare('UPDATE agency_events SET reminded_at = NULL WHERE id = ? AND agency_id = ? AND on_date >= ?')
    .bind(id, agencyId, new Date().toISOString().slice(0, 10)).run();
  return json({ ok: true, id });
}

async function loadEvent(env, id, agencyId) {
  return env.DB.prepare(
    `SELECT id, agency_id, kind, title, vendor, on_date, start_time, end_time, tz, link, notes, cancelled_at,
            updated_at, announced_at, audience
       FROM agency_events WHERE id = ? AND agency_id = ?`
  ).bind(id, agencyId).first();
}

/**
 * POST /api/agency-events/:id/announce { mode: 'new' | 'update' | 'cancel' } : email every advisor in the agency.
 * An owner's, and always the owner's own agency: the event is looked up by the agency on their session.
 */
export async function handleAnnounceAgencyEvent(request, env, id) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return forbidden('Stop working as an advisor to email the agency.');
  const ev = await loadEvent(env, id, user.agency_id || '');
  if (!ev) return notFound('Event not found.');
  const mode = oneOf((await readJson(request)).mode, ['new', 'update', 'cancel']) || 'new';
  try {
    const told = await announceEvent(env, user, ev, mode);
    await db.logActivity(env, user.id, 'agency_event.announce',
      `Emailed the advisors about "${ev.title}" (${mode})`, { id, sent: told.sent });
    return json({ ok: true, ...told });
  } catch (e) {
    return badRequest(String(e.message || 'The emails could not be sent.').slice(0, 200));
  }
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
  await env.DB.prepare('DELETE FROM agency_event_invites WHERE event_id = ? AND agency_id = ?')
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
    'SELECT id, audience FROM agency_events WHERE id = ? AND agency_id = ?'
  ).bind(id, agencyId).first();
  if (!event) return notFound('Event not found.');
  // An event for somebody else is not one this person can answer.
  if (event.audience === 'some' && user.role !== 'admin') {
    const invited = await env.DB.prepare(
      'SELECT user_id FROM agency_event_invites WHERE event_id = ? AND agency_id = ? AND user_id = ?'
    ).bind(id, agencyId, user.id).first();
    if (!invited) return notFound('Event not found.');
  }

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
