// The tasks that follow every trip, written once.
//
// The same four things happen after every cruise: chase the deposit, take the
// final payment, get documents out, welcome them home. Typing those per
// booking is not the cost; forgetting one on the trip that mattered is.
//
// A template hangs off a date on the reservation rather than a date of its
// own, because it is written today for a trip booked next year. Departure
// minus fourteen means documents go out a fortnight before, whenever that is.
//
// Nothing fires retroactively and nothing chases the dates afterwards: the
// tasks are made when the reservation is, from the dates it had then. A
// booking whose departure moves is a conversation with the client, and a task
// list that quietly rewrites itself underneath that is worse than one that
// does not.

import { json, badRequest, notFound, clean, cleanText, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { KINDS } from './tasks.js';
import { PRODUCT_TYPES } from './producttypes.js';

// Which date on the reservation the task hangs off. Booked is the day the
// reservation was made, which is the only one every trip has.
export const ANCHORS = [
  { key: 'booked', label: 'the day it was booked', column: null },
  { key: 'depart_date', label: 'departure', column: 'depart_date' },
  { key: 'return_date', label: 'the return', column: 'return_date' },
  { key: 'deposit_due', label: 'the deposit due date', column: 'deposit_due' },
  { key: 'final_payment_due', label: 'final payment', column: 'final_payment_due' },
];

const ANCHOR_KEYS = ANCHORS.map((a) => a.key);
const PRIORITIES = ['normal', 'high', 'low'];

const COLUMNS = `id, user_id, title, kind, priority, notes, anchor, offset_days,
                 product_type, active, position, created_at, updated_at`;

function parse(body) {
  const title = clean(body.title, 200);
  if (!title) return { error: 'Give the task a title.' };
  const offset = Number(body.offsetDays);
  if (!Number.isFinite(offset) || Math.abs(offset) > 730) {
    return { error: 'The offset has to be a number of days within two years.' };
  }
  return {
    fields: {
      title,
      kind: oneOf(body.kind, KINDS),
      priority: oneOf(body.priority, PRIORITIES),
      notes: cleanText(body.notes, 2000),
      anchor: oneOf(body.anchor, ANCHOR_KEYS),
      offsetDays: Math.round(offset),
      // Blank means every kind of trip. Stored as null rather than an empty
      // string so "any" is one value and not two.
      productType: PRODUCT_TYPES.includes(clean(body.productType, 40))
        ? clean(body.productType, 40) : null,
      active: body.active === false ? 0 : 1,
    },
  };
}

export async function listTemplates(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM task_templates WHERE user_id = ?
      ORDER BY position ASC, created_at ASC`
  ).bind(userId).all();
  return results || [];
}

export async function handleListTemplates(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  return json({
    templates: await listTemplates(env, user.id),
    anchors: ANCHORS,
    kinds: KINDS,
    productTypes: PRODUCT_TYPES,
  });
}

export async function handleSaveTemplate(request, env, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);
  const ts = now();

  if (id) {
    const res = await env.DB.prepare(
      `UPDATE task_templates SET title = ?, kind = ?, priority = ?, notes = ?, anchor = ?,
         offset_days = ?, product_type = ?, active = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(fields.title, fields.kind, fields.priority, fields.notes || null, fields.anchor,
           fields.offsetDays, fields.productType, fields.active, ts, id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Template not found.');
    return json({ ok: true, templates: await listTemplates(env, user.id) });
  }

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM task_templates WHERE user_id = ?'
  ).bind(user.id).first();
  if ((count?.n || 0) >= 40) {
    return badRequest('Forty templates is plenty. Turn some off rather than adding more.');
  }

  await env.DB.prepare(
    `INSERT INTO task_templates
       (id, user_id, title, kind, priority, notes, anchor, offset_days,
        product_type, active, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uid(), user.id, fields.title, fields.kind, fields.priority, fields.notes || null,
         fields.anchor, fields.offsetDays, fields.productType, fields.active,
         count?.n || 0, ts, ts).run();

  return json({ ok: true, templates: await listTemplates(env, user.id) }, 201);
}

export async function handleDeleteTemplate(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM task_templates WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Template not found.');
  return json({ ok: true, templates: await listTemplates(env, user.id) });
}

function shift(iso, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Make a new reservation's standard tasks.
 *
 * Best effort and never fatal: a template that cannot work out its date is
 * skipped rather than blocking the booking, because losing a reservation to a
 * task list would be the wrong way round entirely.
 *
 * A template whose anchor the reservation has no date for produces nothing. A
 * hotel stay with no final payment date recorded has no "chase the final
 * payment" task, which is right: a task due on a date nobody knows is a task
 * that sits undated for ever.
 */
export async function applyTemplates(env, userId, booking) {
  if (!booking || !booking.id) return { made: 0 };

  let templates;
  try {
    templates = await listTemplates(env, userId);
  } catch (e) {
    console.error('task templates', e);
    return { made: 0 };
  }

  const today = new Date().toISOString().slice(0, 10);
  const ts = now();
  const rows = [];

  for (const t of templates) {
    if (!t.active) continue;
    if (t.product_type && t.product_type !== booking.product_type) continue;

    const anchor = ANCHORS.find((a) => a.key === t.anchor);
    if (!anchor) continue;
    const base = anchor.column ? booking[anchor.column] : today;
    let due = shift(base, t.offset_days);
    if (!due) continue;

    // "Twenty-one days before the day it was booked" is a date in the past by
    // construction: the booking is being made now. Rather than refusing the
    // template, the task lands today, which is the earliest it could ever have
    // been done. Only for this anchor: a documents task dated before departure
    // on a trip booked late really is overdue, and should say so.
    if (!anchor.column && due < today) due = today;

    rows.push({ id: uid(), t, due });
  }

  if (!rows.length) return { made: 0 };

  const stmt = env.DB.prepare(
    `INSERT INTO tasks (id, user_id, title, notes, due_date, priority, kind,
       booking_id, client_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    await env.DB.batch(rows.map(({ id, t, due }) => stmt.bind(
      id, userId, t.title, t.notes || null, due, t.priority, t.kind,
      booking.id, booking.client_id || null, ts, ts
    )));
  } catch (e) {
    console.error('task templates insert', e);
    return { made: 0 };
  }

  return { made: rows.length };
}

/** What a new advisor starts with, so the feature is visible rather than empty. */
export const STARTER_TEMPLATES = [
  { title: 'Chase the deposit', kind: 'payment', anchor: 'deposit_due', offsetDays: -3 },
  { title: 'Take the final payment', kind: 'payment', anchor: 'final_payment_due', offsetDays: -7,
    priority: 'high' },
  { title: 'Send documents', kind: 'document', anchor: 'depart_date', offsetDays: -14 },
  { title: 'Welcome home call', kind: 'call', anchor: 'return_date', offsetDays: 2 },
];

export async function handleSeedTemplates(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const existing = await listTemplates(env, user.id);
  if (existing.length) {
    return badRequest('You already have templates. Add or edit them instead.');
  }

  const ts = now();
  await env.DB.batch(STARTER_TEMPLATES.map((t, i) => env.DB.prepare(
    `INSERT INTO task_templates
       (id, user_id, title, kind, priority, notes, anchor, offset_days,
        product_type, active, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uid(), user.id, t.title, t.kind, t.priority || 'normal', null,
         t.anchor, t.offsetDays, null, 1, i, ts, ts)));

  return json({ ok: true, templates: await listTemplates(env, user.id) }, 201);
}
