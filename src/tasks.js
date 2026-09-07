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

// How often it comes back. Nothing is the first entry for the same reason as
// above: a task with no rule chosen must not quietly become a daily one.
export const REPEATS = ['none', 'daily', 'weekly', 'fortnightly', 'monthly', 'yearly'];

const COLUMNS = `
  t.id, t.user_id, t.title, t.notes, t.due_date, t.due_time, t.priority, t.kind,
  t.repeat_rule, t.repeat_until, t.repeat_of,
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
  // Same again for repeating: "every week" from no particular day has no next
  // date to work out, so there is nothing to make when it is ticked off.
  if (oneOf(body.repeatRule, REPEATS) !== 'none' && !dueDate) {
    return { error: 'A repeating task needs a date to repeat from.' };
  }
  return {
    fields: {
      title,
      notes: cleanText(body.notes, 2000),
      dueDate,
      dueTime,
      priority: oneOf(body.priority, PRIORITIES),
      kind: oneOf(body.kind, KINDS),
      repeatRule: oneOf(body.repeatRule, REPEATS),
      repeatUntil: cleanDate(body.repeatUntil),
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
export async function listTasks(env, scope, { state = 'open', query, limit } = {}) {
  const scoped = db.scopeWhere(scope, 't.user_id');
  const where = [scoped.sql];
  if (state === 'open') where.push('t.done_at IS NULL');
  if (state === 'done') where.push('t.done_at IS NOT NULL');
  // By title or by who it is about, so a task can be found on a list longer
  // than the cap.
  const binds = [];
  if (query) {
    where.push('(t.title LIKE ? OR c.name LIKE ? OR b.client_name LIKE ?)');
    binds.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

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
            (SELECT COUNT(*) FROM task_items i WHERE i.task_id = t.id) AS steps,
            (SELECT COUNT(*) FROM task_items i WHERE i.task_id = t.id AND i.done_at IS NOT NULL)
              AS steps_done,
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
  ).bind(...scoped.binds, ...binds, db.takeWithProbe(limit)).all();
  return results || [];
}

export async function handleListTasks(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const state = oneOf(url.searchParams.get('state'), ['open', 'done', 'all']) || 'open';
  const scope = db.scopeFor(env, user, request);
  const found = await listTasks(env, scope, {
    state,
    query: clean(url.searchParams.get('q'), 80) || undefined,
    limit: url.searchParams.get('limit'),
  });
  // One row past the cap, so the page can say the list was cut.
  const { rows: tasks, truncated } = db.capped(found, url.searchParams.get('limit'));

  const today = new Date().toISOString().slice(0, 10);
  return json({
    tasks,
    truncated,
    cap: db.LIST_CAP,
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

/**
 * The day a repeating task next falls due.
 *
 * Counted from the last due date, not from today, so "every Monday" stays on
 * Mondays and the first of the month stays on the first. Then walked forward
 * until it is in the future: ticking off three weeks of Mondays in one sitting
 * should leave one task for next Monday, not three that are already late.
 *
 * Months are done by calendar rather than by thirty days, and a run off the
 * end of a short month is pulled back to its last day: the 31st of January
 * repeating monthly is the 28th of February, not the 3rd of March.
 */
export function nextDue(from, rule, today) {
  if (!from || !rule || rule === 'none') return null;

  const step = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    if (rule === 'daily') return shiftDays(iso, 1);
    if (rule === 'weekly') return shiftDays(iso, 7);
    if (rule === 'fortnightly') return shiftDays(iso, 14);
    const months = rule === 'monthly' ? 1 : 12;
    const target = new Date(Date.UTC(y, (m - 1) + months, 1));
    const lastOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0))
      .getUTCDate();
    const lastOfSource = new Date(Date.UTC(y, m, 0)).getUTCDate();
    // A task on the last day of the month means the last day of the month.
    // Without this, the 31st of January clamps to the 28th of February and
    // then stays on the 28th for ever: a final payment due at month end walks
    // three days earlier and never walks back.
    target.setUTCDate(d === lastOfSource ? lastOfTarget : Math.min(d, lastOfTarget));
    return target.toISOString().slice(0, 10);
  };

  let next = step(from);
  // Bounded, because a rule this does not understand would otherwise spin.
  for (let i = 0; i < 400 && next <= today; i += 1) next = step(next);
  return next;
}

function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Tick off a repeating task and the next one appears.
 *
 * Made at the moment of completion rather than scheduled in advance, so an
 * open list is a list of work rather than a calendar of everything the year
 * holds, and changing the task changes every future one by definition.
 *
 * The checklist comes with it, unticked. A weekly task whose six steps are
 * already crossed off is a task that looks done.
 */
async function repeatTask(env, task) {
  if (!task || !task.repeat_rule || task.repeat_rule === 'none') return null;
  const today = new Date().toISOString().slice(0, 10);
  const next = nextDue(task.due_date, task.repeat_rule, today);
  if (!next) return null;
  if (task.repeat_until && next > task.repeat_until) return null;

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO tasks (id, user_id, title, notes, due_date, due_time, priority, kind,
       booking_id, contact_id, client_id, group_id, assigned_by, repeat_rule, repeat_until,
       repeat_of, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, task.user_id, task.title, task.notes, next, task.due_time, task.priority,
         task.kind, task.booking_id, task.contact_id, task.client_id, task.group_id,
         task.assigned_by, task.repeat_rule, task.repeat_until, task.id, ts, ts).run();

  const { results } = await env.DB.prepare(
    `SELECT label, position FROM task_items WHERE task_id = ? AND user_id = ?
      ORDER BY position ASC`
  ).bind(task.id, task.user_id).all();
  for (const item of results || []) {
    await env.DB.prepare(
      `INSERT INTO task_items (id, task_id, user_id, label, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(uid(), id, task.user_id, item.label, item.position, ts).run();
  }

  return id;
}

/**
 * Take back the task that ticking this one off created.
 *
 * Only while it is untouched: not ticked off itself, and with no step crossed
 * off. Once somebody has started on next week's, it is their task and undoing
 * a tick here has no business deleting it.
 */
async function undoRepeat(env, parentId, userId) {
  // Found first, then deleted, so the number returned is a number of tasks.
  // Counting the delete's own changes reported two for one task with one step,
  // because the cascade to its checklist counts as a change as well.
  const { results } = await env.DB.prepare(
    `SELECT id FROM tasks
      WHERE repeat_of = ? AND user_id = ? AND done_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM task_items i
                         WHERE i.task_id = tasks.id AND i.done_at IS NOT NULL)`
  ).bind(parentId, userId).all();

  const ids = (results || []).map((r) => r.id);
  for (const id of ids) {
    await env.DB.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
      .bind(id, userId).run();
  }
  return ids.length;
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
       booking_id, contact_id, client_id, group_id, assigned_by, repeat_rule, repeat_until,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, links.owner, fields.title, fields.notes || null, fields.dueDate, fields.dueTime,
         fields.priority, fields.kind, fields.bookingId, fields.contactId,
         fields.clientId, fields.groupId, links.assignedBy,
         fields.repeatRule, fields.repeatUntil, ts, ts).run();

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

    const task = await getTask(env, id, user.id);
    // Only on the way to done, and un-ticking takes it back: a mis-click that
    // makes next week's task and leaves it there is litter somebody has to
    // notice. Only if nothing has been done to it, because a task somebody has
    // started working is theirs now, whatever made it.
    const repeated = body.done ? await repeatTask(env, task) : null;
    const undone = body.done ? 0 : await undoRepeat(env, id, user.id);
    return json({ ok: true, task, repeated, undone });
  }

  // Moving the date on its own, the way done and pinned move on their own.
  // Pushing an overdue task to tomorrow is the commonest edit there is, and
  // sending the whole record back to change one field means the drawer has to
  // hold a copy of everything just to move a day.
  if (Object.prototype.hasOwnProperty.call(body, 'dueDate')
      && !Object.prototype.hasOwnProperty.call(body, 'title')) {
    const due = cleanDate(body.dueDate);
    const res = await env.DB.prepare(
      `UPDATE tasks SET due_date = ?,
         reminded_at = CASE WHEN due_date IS ? THEN reminded_at ELSE NULL END,
         overdue_reminded_at = CASE WHEN due_date IS ? THEN overdue_reminded_at ELSE NULL END,
         updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(due, due, due, now(), id, user.id).run();
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
       kind = ?, repeat_rule = ?, repeat_until = ?,
       booking_id = ?, contact_id = ?, client_id = ?, group_id = ?,
       reminded_at = CASE WHEN due_date IS ? THEN reminded_at ELSE NULL END,
       overdue_reminded_at = CASE WHEN due_date IS ? THEN overdue_reminded_at ELSE NULL END,
       updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.title, fields.notes || null, fields.dueDate, fields.dueTime, fields.priority,
         fields.kind, fields.repeatRule, fields.repeatUntil,
         fields.bookingId, fields.contactId, fields.clientId, fields.groupId,
         fields.dueDate, fields.dueDate, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');

  return json({ ok: true, task: await getTask(env, id, user.id) });
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------
//
// "Prepare the Simic documents" is six things. A task that cannot say so is
// either ticked off while three of them are outstanding, or sits there looking
// untouched while five are done.
//
// Deliberately flat: items have a label and a tick, and no dates, owners or
// items of their own. A checklist item that can hold all of that is a task,
// and there is already somewhere to put those.

async function ownTask(env, taskId, userId) {
  return env.DB.prepare('SELECT id FROM tasks WHERE id = ? AND user_id = ?')
    .bind(taskId, userId).first();
}

/**
 * The steps on one task.
 *
 * Takes the task's owner, not the caller: an owner reading an advisor's task
 * should see its checklist, and the rows belong to the advisor. Naming the
 * owner keeps the query honest about whose rows it touches rather than
 * trusting that whoever called it checked first.
 */
export async function listTaskItems(env, taskId, ownerId) {
  const { results } = await env.DB.prepare(
    `SELECT id, label, done_at, position FROM task_items
      WHERE task_id = ? AND user_id = ? ORDER BY position ASC, created_at ASC`
  ).bind(taskId, ownerId).all();
  return results || [];
}

export async function handleListTaskItems(request, env, taskId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  // Read at the viewing scope, because an owner can see an advisor's task and
  // a task whose checklist is hidden reads as a task with nothing in it.
  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 't.user_id');
  const owned = await env.DB.prepare(
    `SELECT t.id, t.user_id FROM tasks t WHERE t.id = ? AND ${scoped.sql}`
  ).bind(taskId, ...scoped.binds).first();
  if (!owned) return notFound('Task not found.');
  return json({ items: await listTaskItems(env, taskId, owned.user_id) });
}

export async function handleCreateTaskItem(request, env, taskId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!(await ownTask(env, taskId, user.id))) return notFound('Task not found.');

  const body = await readJson(request);
  const label = clean(body.label, 200);
  if (!label) return badRequest('Give the step a name.');

  // Twenty is not a technical limit, it is the point at which a checklist has
  // become a project and wants to be tasks of its own.
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM task_items WHERE task_id = ? AND user_id = ?'
  ).bind(taskId, user.id).first();
  if ((count?.n || 0) >= 20) {
    return badRequest('Twenty steps is enough. Anything longer wants to be its own tasks.');
  }

  const id = uid();
  await env.DB.prepare(
    `INSERT INTO task_items (id, task_id, user_id, label, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, taskId, user.id, label, count?.n || 0, now()).run();

  return json({ ok: true, items: await listTaskItems(env, taskId, user.id) }, 201);
}

export async function handleUpdateTaskItem(request, env, itemId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const sets = [];
  const binds = [];
  if (Object.prototype.hasOwnProperty.call(body, 'done')) {
    sets.push('done_at = ?');
    binds.push(body.done ? now() : null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'label')) {
    const label = clean(body.label, 200);
    if (!label) return badRequest('A step needs a name.');
    sets.push('label = ?');
    binds.push(label);
  }
  if (!sets.length) return badRequest('Nothing to change.');

  const res = await env.DB.prepare(
    `UPDATE task_items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...binds, itemId, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Step not found.');

  const row = await env.DB.prepare('SELECT task_id FROM task_items WHERE id = ? AND user_id = ?')
    .bind(itemId, user.id).first();
  return json({ ok: true, items: await listTaskItems(env, row.task_id, user.id) });
}

export async function handleDeleteTaskItem(request, env, itemId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await env.DB.prepare('SELECT task_id FROM task_items WHERE id = ? AND user_id = ?')
    .bind(itemId, user.id).first();
  if (!row) return notFound('Step not found.');
  await env.DB.prepare('DELETE FROM task_items WHERE id = ? AND user_id = ?')
    .bind(itemId, user.id).run();
  return json({ ok: true, items: await listTaskItems(env, row.task_id, user.id) });
}

export async function handleDeleteTask(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');
  return json({ ok: true });
}
