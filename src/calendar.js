// The month, with everything on it.
//
// Five things in this portal happen on a day and, until this, each was only
// visible on the screen that owned it: appointments in the diary, tasks on the
// To do list, a lead's next step on the lead board, departures and returns on
// the reservation, and a vendor deadline on the payment schedule. Every one of
// them is a reason Thursday is not free, and there was nowhere that said so.
//
// Merged rather than joined. These are genuinely different things and a union
// in SQL would flatten them into a shape that suits none of them; five small
// scoped reads cost five queries a month view, which is the right trade for
// each one keeping its own columns and its own fence.
//
// Everything here is read-only. Acting on any of it happens on the screen that
// owns it, which is where the words for doing so already are.

import { json, cleanDate } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

/** A day that many days after the given one, as a plain date. */
function dayOffset(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export async function handleCalendar(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const from = cleanDate(url.searchParams.get('from')) || today;
  // A window rather than whatever was asked for. A month view wants about six
  // weeks; a request for five years would be five years of five queries.
  const askedTo = cleanDate(url.searchParams.get('to')) || dayOffset(from, 41);
  const limit = dayOffset(from, 120);
  const to = askedTo > limit ? limit : askedTo;

  const scope = db.scopeFor(env, user, request);
  const where = (column) => db.scopeWhere(scope, column);

  const appts = where('a.user_id');
  const tasks = where('t.user_id');
  const leads = where('c.user_id');
  const trips = where('b.user_id');
  const pays = where('p.user_id');

  const [appointments, taskRows, leadRows, tripRows, payRows] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.title, a.on_date, a.start_time, a.end_time, a.location, a.kind,
              a.cancelled_at, a.done_at, c.name AS client_name
         FROM appointments a
         LEFT JOIN clients c ON c.id = a.client_id
        WHERE ${appts.sql} AND a.on_date >= ? AND a.on_date <= ?
        ORDER BY a.on_date, a.start_time LIMIT 400`
    ).bind(...appts.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.due_time, t.priority, t.done_at,
              c.name AS client_name
         FROM tasks t
         LEFT JOIN clients c ON c.id = t.client_id
        WHERE ${tasks.sql} AND t.done_at IS NULL
          AND t.due_date >= ? AND t.due_date <= ?
        ORDER BY t.due_date LIMIT 400`
    ).bind(...tasks.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT c.id, c.name, c.lead_next_step, c.lead_next_step_on, c.lead_stage
         FROM clients c
        WHERE ${leads.sql} AND c.lead_stage IS NOT NULL
          AND c.lead_next_step_on >= ? AND c.lead_next_step_on <= ?
          AND NOT EXISTS (SELECT 1 FROM bookings b
                           WHERE b.client_id = c.id AND b.status IN ('booked','travelled'))
        ORDER BY c.lead_next_step_on LIMIT 400`
    ).bind(...leads.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT b.id, b.product_name, b.client_name, b.depart_date, b.return_date, b.status
         FROM bookings b
        WHERE ${trips.sql} AND b.status IN ('booked','travelled')
          AND ((b.depart_date >= ? AND b.depart_date <= ?)
            OR (b.return_date >= ? AND b.return_date <= ?))
        LIMIT 400`
    ).bind(...trips.binds, from, to, from, to).all().catch(() => ({ results: [] })),

    // Only what is genuinely owed. A soft row is the internal buffer beside a
    // real deadline, and drawing both puts two deadlines on a calendar where
    // the client has one.
    env.DB.prepare(
      `SELECT p.id, p.booking_id, p.due_date, p.amount_cents, p.kind,
              b.client_name, b.product_name
         FROM booking_payments p
         JOIN bookings b ON b.id = p.booking_id
        WHERE ${pays.sql} AND p.paid_date IS NULL AND p.payment_class = 'hard'
          AND p.due_date >= ? AND p.due_date <= ?
        ORDER BY p.due_date LIMIT 400`
    ).bind(...pays.binds, from, to).all().catch(() => ({ results: [] })),
  ]);

  // One shape out, because the grid draws days and does not want to know five
  // ways of saying "this is on the 14th". The kind is what colours it.
  const events = [];

  for (const a of appointments.results || []) {
    events.push({
      kind: 'appointment', id: a.id, date: a.on_date,
      time: a.start_time, endTime: a.end_time || '',
      title: a.title, who: a.client_name || '', where: a.location || '',
      note: a.kind || '',
      muted: Boolean(a.cancelled_at), done: Boolean(a.done_at),
      href: `/app/calendar?open=${encodeURIComponent(a.id)}`,
    });
  }
  for (const t of taskRows.results || []) {
    events.push({
      kind: 'task', id: t.id, date: t.due_date, time: t.due_time || '',
      title: t.title, who: t.client_name || '',
      note: t.priority === 'high' ? 'high' : '',
      href: '/app/tasks',
    });
  }
  for (const l of leadRows.results || []) {
    events.push({
      kind: 'lead', id: l.id, date: l.lead_next_step_on, time: '',
      title: l.lead_next_step || `Follow up with ${l.name}`,
      who: l.name, note: l.lead_stage || '', href: '/app/leads',
    });
  }
  for (const b of tripRows.results || []) {
    if (b.depart_date >= from && b.depart_date <= to) {
      events.push({
        kind: 'departure', id: `${b.id}:out`, date: b.depart_date, time: '',
        title: `${b.product_name} departs`, who: b.client_name || '',
        href: `/app/reservation?id=${encodeURIComponent(b.id)}`,
      });
    }
    if (b.return_date && b.return_date >= from && b.return_date <= to) {
      events.push({
        kind: 'return', id: `${b.id}:back`, date: b.return_date, time: '',
        title: `${b.product_name} returns`, who: b.client_name || '',
        href: `/app/reservation?id=${encodeURIComponent(b.id)}`,
      });
    }
  }
  for (const p of payRows.results || []) {
    events.push({
      kind: 'payment', id: p.id, date: p.due_date, time: '',
      title: `${p.kind === 'deposit' ? 'Deposit' : 'Payment'} due`,
      who: p.client_name || '', note: p.product_name || '',
      amountCents: p.amount_cents || 0,
      href: `/app/reservation?id=${encodeURIComponent(p.booking_id)}`,
    });
  }

  events.sort((x, y) => x.date.localeCompare(y.date)
    || (x.time || '99:99').localeCompare(y.time || '99:99')
    || x.title.localeCompare(y.title));

  return json({
    events, from, to, today,
    // Said out loud rather than silently showing less than was asked for.
    truncated: to !== askedTo,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}
