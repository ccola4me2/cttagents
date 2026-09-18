// The bell.
//
// Everything in this portal that needs somebody happens on a day, and until
// recently each kind was only visible on the screen that owned it. The morning
// email fixed that for people who read email at eight. This is the same list,
// in the portal, for the rest of the day.
//
// Two kinds of thing, deliberately mixed. Things that are due, which are a
// state rather than an event, and things that arrived, which are events. A
// bell that only carried events would be silent on the morning a follow-up
// went overdue, and a bell that only carried states would never tell you a
// form came back.
//
// "New" is answered with a timestamp on each item rather than a read flag per
// row. A due date is not an event and has no arrival time, so each item says
// when it became true: midnight of the day a task fell due, the hour an
// appointment starts, the moment a form was submitted. Anything later than
// when the bell was last cleared is unread. Clearing it is the only write.

import { json, now } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { pushReady, pushTo, devicesFor } from './push.js';
import { hasFinished, zoneOf } from './appointments.js';

/** Midnight UTC on a plain date, as seconds. When a due thing became due. */
function dayStart(iso) {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
}

/** The same, plus a clock time, for something that happens at an hour. */
function momentOf(iso, time) {
  const at = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time || '') ? time : '00:00';
  return Math.floor(Date.parse(`${iso}T${at}:00Z`) / 1000);
}

/**
 * Everything waiting for one advisor, newest first.
 *
 * Split out so the bell and the notification that wakes somebody up cannot
 * disagree. A push that says three things are waiting, followed by a bell
 * showing two, is the portal contradicting itself, and the next one is not
 * believed.
 */
export async function gather(env, user) {
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000)
    .toISOString().slice(0, 10);
  // Far enough back that a Monday still shows Friday's, and no further: a bell
  // is what has happened lately, not an archive.
  const since = now() - 14 * 86400;

  // The caller's own, always. A bell is a personal thing: an owner does not
  // want the agency's follow-ups pushed at them, and the agency view lives on
  // the screens built for it.
  const self = db.selfScope(user);
  const t = db.scopeWhere(self, 't.user_id');
  const c = db.scopeWhere(self, 'c.user_id');
  const a = db.scopeWhere(self, 'a.user_id');
  const f = db.scopeWhere(self, 'f.created_by');
  const sc = db.scopeWhere(self, 'cl.user_id');

  const [tasks, leads, appts, forms, mentions] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.due_time, t.priority, cl.name AS client_name
         FROM tasks t
         LEFT JOIN clients cl ON cl.id = t.client_id
        WHERE ${t.sql} AND t.done_at IS NULL
          AND t.due_date IS NOT NULL AND t.due_date <= ?
        ORDER BY t.due_date DESC LIMIT 50`
    ).bind(...t.binds, today).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT c.id, c.name, c.lead_next_step, c.lead_next_step_on
         FROM clients c
        WHERE ${c.sql} AND c.lead_stage IS NOT NULL
          AND c.lead_next_step_on IS NOT NULL AND c.lead_next_step_on <= ?
          AND NOT EXISTS (SELECT 1 FROM bookings b
                           WHERE b.client_id = c.id AND b.status IN ('booked','travelled'))
        ORDER BY c.lead_next_step_on DESC LIMIT 50`
    ).bind(...c.binds, today).all().catch(() => ({ results: [] })),

    // Ahead as well as behind. An appointment on Thursday is worth seeing on
    // Wednesday, which is not true of a task: a task can be done early and an
    // hour with somebody else in it cannot.
    env.DB.prepare(
      `SELECT a.id, a.title, a.on_date, a.start_time, a.end_time, a.location,
              cl.name AS client_name
         FROM appointments a
         LEFT JOIN clients cl ON cl.id = a.client_id
        WHERE ${a.sql} AND a.cancelled_at IS NULL AND a.done_at IS NULL
          AND a.on_date <= ?
        ORDER BY a.on_date DESC, a.start_time DESC LIMIT 50`
    ).bind(...a.binds, week).all().catch(() => ({ results: [] })),

    // A form coming back is the one genuine event here: somebody did
    // something, at a moment, and nothing else on the screen announces it.
    //
    // Whose it is, is whose client it became. A form belongs to the agency and
    // can be sent by anybody in it, so keying this to whoever built the form
    // would tell the wrong person. Where it produced nobody at all, it falls
    // back to the form's author, who is the only person left with a claim.
    env.DB.prepare(
      `SELECT s.id, s.name, s.email, s.created_at, s.contact_id, f.name AS form_name
         FROM form_submissions s
         JOIN forms f ON f.id = s.form_id
         LEFT JOIN clients cl ON cl.id = s.contact_id
        WHERE s.created_at >= ?
          AND (${sc.sql} OR (s.contact_id IS NULL AND ${f.sql}))
        ORDER BY s.created_at DESC LIMIT 25`
    ).bind(since, ...sc.binds, ...f.binds).all().catch(() => ({ results: [] })),

    // Being named by name. Matched on the ids written into the row when the
    // message was sent, not on the words: "@Sam" in a message is text, and who
    // it meant was decided once, by somebody who could see who was in the room.
    env.DB.prepare(
      `SELECT m.id, m.body, m.created_at, m.channel_id,
              ch.kind, ch.name AS room_name,
              au.first_name, au.last_name
         FROM messages m
         JOIN channels ch ON ch.id = m.channel_id
         LEFT JOIN users au ON au.id = m.user_id
        WHERE m.created_at >= ? AND m.deleted_at IS NULL AND m.user_id != ?
          AND m.mentions LIKE ?
        ORDER BY m.created_at DESC LIMIT 25`
    ).bind(since, user.id, `%"${user.id}"%`).all().catch(() => ({ results: [] })),
  ]);

  const items = [];

  for (const r of tasks.results || []) {
    items.push({
      id: `task:${r.id}`, kind: 'task',
      at: momentOf(r.due_date, r.due_time),
      title: r.title,
      detail: [r.client_name, r.due_date < today ? 'late' : 'due today']
        .filter(Boolean).join('  ·  '),
      late: r.due_date < today,
      href: '/app/tasks',
    });
  }
  for (const r of leads.results || []) {
    items.push({
      id: `lead:${r.id}`, kind: 'lead',
      at: dayStart(r.lead_next_step_on),
      title: r.lead_next_step || `Follow up with ${r.name}`,
      detail: [r.name, r.lead_next_step_on < today ? 'late' : 'due today']
        .filter(Boolean).join('  ·  '),
      late: r.lead_next_step_on < today,
      href: '/app/leads',
    });
  }
  const zone = zoneOf(env, user);
  for (const r of appts.results || []) {
    // Gone an hour after it finishes, the same as on the To do list. A bell
    // still offering this morning's meeting at four in the afternoon is a bell
    // people stop reading.
    if (hasFinished(r, zone)) continue;
    const when = [r.start_time, r.end_time].filter(Boolean).join(' to ');
    items.push({
      id: `appt:${r.id}`, kind: 'appointment',
      at: momentOf(r.on_date, r.start_time),
      title: r.title,
      detail: [when, r.client_name, r.location].filter(Boolean).join('  ·  '),
      late: false,
      href: '/app/calendar',
    });
  }
  for (const r of forms.results || []) {
    items.push({
      id: `form:${r.id}`, kind: 'form',
      at: r.created_at,
      title: `${r.name || r.email || 'Somebody'} filled in ${r.form_name}`,
      detail: r.email || '',
      late: false,
      href: r.contact_id
        ? `/app/client?id=${encodeURIComponent(r.contact_id)}`
        : '/app/formbuilder',
    });
  }

  for (const r of mentions.results || []) {
    const who = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Somebody';
    const where = r.kind === 'dm' ? 'a message' : (r.room_name || 'chat');
    items.push({
      id: `chat:${r.id}`, kind: 'mention',
      at: r.created_at,
      title: `${who} asked for you in ${where}`,
      // The words, shortened. A mention you cannot read the point of is a
      // mention you have to open the page to understand, which is the work the
      // bell exists to save.
      detail: String(r.body || '').replace(/\s+/g, ' ').slice(0, 120),
      late: false,
      href: `/app/chat?c=${encodeURIComponent(r.channel_id)}`,
    });
  }

  // Newest first, and a cap: a bell is read from the top, and the hundredth
  // line is one nobody will ever reach.
  items.sort((x, y) => y.at - x.at);
  return items;
}

/**
 * Of those, the ones that have happened and have not been seen.
 *
 * Both halves matter. An appointment on Thursday is always later than any
 * moment the bell could have been read, so without the first test it would sit
 * there unread for ever and the bell could never be silenced.
 */
export function unseen(items, since, at = now()) {
  return items.filter((i) => i.at > (since || 0) && i.at <= at);
}

export async function handleAlerts(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Switched off means off, and says so rather than coming back empty: a bell
  // that is quiet because you turned it off and a bell that is quiet because
  // nothing needs you should not look the same.
  if (user.alerts_feed === 0) {
    return json({ off: true, items: [], unread: 0, seenAt: user.alerts_seen_at || null });
  }

  const items = await gather(env, user);
  const at = now();
  return json({
    off: false,
    items: items.slice(0, 60),
    unread: unseen(items, user.alerts_seen_at, at).length,
    seenAt: user.alerts_seen_at || null,
    now: at,
  });
}

/**
 * The bell has been read.
 *
 * One timestamp rather than a flag per item, because most of these are not
 * rows that could carry one: a task falling due is a date passing, not a
 * record being created. Stamped to now rather than to the newest item, so
 * something that arrives in the same second is not swallowed.
 */
export async function handleAlertsSeen(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const at = now();
  await env.DB.prepare('UPDATE users SET alerts_seen_at = ?, updated_at = ? WHERE id = ?')
    .bind(at, at, user.id).run();
  return json({ ok: true, seenAt: at });
}

/**
 * Knock on the devices of anybody who has something waiting.
 *
 * Safe on every tick. It is a no-op for an advisor with nothing new, for a
 * device knocked within the hour, and for the whole portal while VAPID is not
 * configured.
 */
export async function pushWaiting(env, { at = now(), quietFor = 3600 } = {}) {
  if (!pushReady(env)) return { sent: 0, skipped: 'no vapid' };

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT u.id FROM users u
       JOIN push_subscriptions s ON s.user_id = u.id AND s.failed_at IS NULL
      WHERE u.push_alerts = 1 AND u.alerts_feed = 1 AND u.status = 'active'
        AND (s.last_sent_at IS NULL OR s.last_sent_at < ?)
      LIMIT 200`
  ).bind(at - quietFor).all().catch(() => ({ results: [] }));

  let sent = 0;
  for (const row of results || []) {
    const user = await db.getUserById(env, row.id);
    if (!user) continue;

    const devices = (await devicesFor(env, user.id))
      .filter((d) => !d.last_sent_at || d.last_sent_at < at - quietFor);
    if (!devices.length) continue;

    // The watermark is the later of the two: something read in the bell is not
    // something to wake somebody for, and something already pushed to this
    // device is not worth pushing twice.
    const items = await gather(env, user);
    for (const device of devices) {
      const since = Math.max(user.alerts_seen_at || 0, device.last_sent_at || 0);
      if (!unseen(items, since, at).length) continue;
      const res = await pushTo(env, device).catch(() => ({ failed: true }));
      if (res && res.sent) sent += 1;
    }
  }
  return { sent };
}
