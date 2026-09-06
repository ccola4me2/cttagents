// The advisor's own task list.
//
// Kept local rather than mirrored from the CRM for three reasons: it has to
// stay writable when the upstream API is slow, it links to reservations, which
// the CRM knows nothing about, and a working list that disappears during an
// outage is worse than no list at all.
//
// Reads use the visibility scope, so an owner sees the agency's workload and
// an associate sees their own. Writes always use selfScope: seeing someone
// else's task is not the same as ticking it off for them.

import { json, badRequest, notFound, clean, cleanText, cleanDate, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

// Order matters: oneOf falls back to the first entry, so normal has to lead or
// every task created without an explicit priority comes out as high.
const PRIORITIES = ['normal', 'high', 'low'];

// What sort of work it is. Same rule about order: the first entry is what a
// task with nothing chosen becomes, and "other" is the honest default.
export const KINDS = ['other', 'call', 'email', 'document', 'payment', 'meeting'];

const COLUMNS = `
  t.id, t.user_id, t.title, t.notes, t.due_date, t.due_time, t.priority, t.kind,
  t.booking_id, t.contact_id, t.client_id, t.group_id, t.assigned_by,
  t.reminded_at, t.overdue_reminded_at,
  t.done_at, t.pinned_at, t.created_at, t.updated_at
`;

/** A time of day, or nothing. Stored as HH:MM so it sorts as it reads. */
function cleanTime(value) {
  const m = String(value ?? '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function parse(body) {
  const title = clean(body.title, 200);
  if (!title) return { error: 'Give the task a title.' };
  const dueDate = cleanDate(body.dueDate);
  const dueTime = cleanTime(body.dueTime);
  // A time with no date is a time on no particular day, which is not a thing
  // anybody can act on. Said rather than silently dropped.
  if (dueTime && !dueDate) return { error: 'A time needs a day to go with it.' };
  return {
    fields: {
      title,
      notes: cleanText(body.notes, 2000),
      dueDate,
      dueTime,
      priority: oneOf(body.priority, PRIORITIES),
      kind: oneOf(body.kind, KINDS),
      bookingId: clean(body.bookingId, 64) || null,
      contactId: clean(body.contactId, 64) || null,
      clientId: clean(body.clientId, 64) || null,
      groupId: clean(body.groupId, 64) || null,
      assignTo: clean(body.assignTo, 64) || null,
    },
  };
}

/**
 * Open tasks, soonest first, with undated ones last.
 *
 * A task with no date is a someday task, not an urgent one, and sorting NULL
 * to the top would put the whole "one day" pile above this afternoon's work.
 */
export async function listTasks(env, scope, { state = 'open', limit = 200 } = {}) {
  const scoped = db.scopeWhere(scope, 't.user_id');
  const where = [scoped.sql];
  if (state === 'open') where.push('t.done_at IS NULL');
  if (state === 'done') where.push('t.done_at IS NOT NULL');

  // Pinned first, then by date. A pin means "this is what I am on now", which
  // outranks any date, and it is the whole reason for pinning.
  const order = state === 'done'
    ? 't.done_at DESC'
    : "t.pinned_at IS NULL ASC, t.pinned_at ASC, COALESCE(t.due_date, '9999-12-31') ASC, "
      + "CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC";

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            b.client_name AS booking_client, b.supplier AS booking_supplier,
            c.name AS client_name, g.name AS group_name,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
              AS advisor_name,
            COALESCE(NULLIF(TRIM(COALESCE(ab.first_name,'') || ' ' || COALESCE(ab.last_name,'')), ''), ab.email)
              AS assigned_by_name
       FROM tasks t
       LEFT JOIN bookings b ON b.id = t.booking_id
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN travel_groups g ON g.id = t.group_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users ab ON ab.id = t.assigned_by
      WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT ?`
  ).bind(...scoped.binds, Math.min(Number(limit) || 200, 500)).all();
  return results || [];
}

export async function handleListTasks(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const state = oneOf(url.searchParams.get('state'), ['open', 'done', 'all']) || 'open';
  const scope = db.scopeFor(env, user, request);
  const tasks = await listTasks(env, scope, { state });

  const today = new Date().toISOString().slice(0, 10);
  return json({
    tasks,
    kinds: KINDS,
    advisors: await db.advisorOptions(env, user),
    counts: {
      overdue: tasks.filter((t) => !t.done_at && t.due_date && t.due_date < today).length,
      today: tasks.filter((t) => !t.done_at && t.due_date === today).length,
      open: tasks.filter((t) => !t.done_at).length,
      pinned: tasks.filter((t) => !t.done_at && t.pinned_at).length,
      thisWeek: tasks.filter((t) => !t.done_at && t.due_date
        && t.due_date > today && t.due_date <= weekFrom(today)).length,
    },
    today,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/** The end of the seventh day from today, so "this week" means the week ahead. */
function weekFrom(today) {
  return new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
}

/**
 * Check everything the task points at, and say who it is for.
 *
 * A link to a record is a claim that the record exists, so each one is looked
 * up as the person making it: pointing a task at somebody else's reservation
 * would otherwise be a way to find out whether their booking id is real.
 *
 * Assigning is the exception, and deliberately so. An owner can put a task on
 * an advisor's list, which means writing a row whose user_id is not theirs.
 * That is the only write in the system that does, so it checks the target is
 * an active advisor rather than any id at all, and stamps who did it.
 */
async function resolveLinks(env, user, fields) {
  if (fields.bookingId && !(await db.getBooking(env, fields.bookingId, user.id))) {
    return { error: 'That reservation is not yours.' };
  }
  if (fields.clientId) {
    const row = await env.DB.prepare('SELECT id FROM clients WHERE id = ? AND user_id = ?')
      .bind(fields.clientId, user.id).first();
    if (!row) return { error: 'That client is not on your books.' };
  }
  if (fields.groupId) {
    const row = await env.DB.prepare('SELECT id FROM travel_groups WHERE id = ? AND user_id = ?')
      .bind(fields.groupId, user.id).first();
    if (!row) return { error: 'That group is not yours.' };
  }

  let owner = user.id;
  let assignedBy = null;
  if (fields.assignTo && fields.assignTo !== user.id) {
    if (user.role !== 'admin') return { error: 'Only an owner can put a task on somebody else.' };
    const row = await env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND status = 'active'"
    ).bind(fields.assignTo).first();
    if (!row) return { error: 'No such advisor.' };
    owner = fields.assignTo;
    assignedBy = user.id;

    // The links were checked against the person assigning. A reservation of
    // theirs is not on the other advisor's books, and a task pointing at a
    // record its owner cannot open is a dead link on somebody else's list.
    if (fields.bookingId || fields.clientId || fields.groupId) {
      return { error: 'A task for somebody else cannot be tied to your own records.' };
    }
  }

  return { owner, assignedBy };
}

export async function handleCreateTask(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const links = await resolveLinks(env, user, fields);
  if (links.error) return badRequest(links.error);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO tasks (id, user_id, title, notes, due_date, due_time, priority, kind,
       booking_id, contact_id, client_id, group_id, assigned_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, links.owner, fields.title, fields.notes || null, fields.dueDate, fields.dueTime,
         fields.priority, fields.kind, fields.bookingId, fields.contactId,
         fields.clientId, fields.groupId, links.assignedBy, ts, ts).run();

  await db.logActivity(env, user.id, 'task.create',
    links.assignedBy ? `Put a task on another advisor: ${fields.title}`
      : `Added task: ${fields.title}`, { id });
  return json({ ok: true, task: await getTask(env, id, links.owner) }, 201);
}

async function getTask(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${COLUMNS}, b.client_name AS booking_client, b.supplier AS booking_supplier,
            c.name AS client_name, g.name AS group_name
       FROM tasks t
       LEFT JOIN bookings b ON b.id = t.booking_id
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN travel_groups g ON g.id = t.group_id
      WHERE t.id = ? AND t.user_id = ?`
  ).bind(id, userId).first();
}

export async function handleUpdateTask(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);

  // Pinning is its own request shape for the same reason as ticking off: it
  // happens constantly and should not need the whole record sent back.
  if (Object.prototype.hasOwnProperty.call(body, 'pinned')) {
    const res = await env.DB.prepare(
      'UPDATE tasks SET pinned_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(body.pinned ? now() : null, now(), id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');
    return json({ ok: true, task: await getTask(env, id, user.id) });
  }

  // Ticking a task off is its own request shape, because it is the thing
  // people do most and should not require sending the whole record back.
  if (Object.prototype.hasOwnProperty.call(body, 'done')) {
    const res = await env.DB.prepare(
      'UPDATE tasks SET done_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(body.done ? now() : null, now(), id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');
    return json({ ok: true, task: await getTask(env, id, user.id) });
  }

  const { fields, error } = parse(body);
  if (error) return badRequest(error);
  const links = await resolveLinks(env, user, fields);
  if (links.error) return badRequest(links.error);

  // Moving a task's date puts it back in the queue to be chased. Without this
  // a task rescheduled after its reminder went out is never mentioned again,
  // which is the failure mode people notice least and mind most.
  const res = await env.DB.prepare(
    `UPDATE tasks SET title = ?, notes = ?, due_date = ?, due_time = ?, priority = ?,
       kind = ?, booking_id = ?, contact_id = ?, client_id = ?, group_id = ?,
       reminded_at = CASE WHEN due_date IS ? THEN reminded_at ELSE NULL END,
       overdue_reminded_at = CASE WHEN due_date IS ? THEN overdue_reminded_at ELSE NULL END,
       updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.title, fields.notes || null, fields.dueDate, fields.dueTime, fields.priority,
         fields.kind, fields.bookingId, fields.contactId, fields.clientId, fields.groupId,
         fields.dueDate, fields.dueDate, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');

  return json({ ok: true, task: await getTask(env, id, user.id) });
}

export async function handleDeleteTask(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');
  return json({ ok: true });
}
