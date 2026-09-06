// Telling an advisor what is due, so the list does not have to be opened.
//
// A due date nobody is told about is a reminder you have to remember, which
// is the problem the date was meant to solve. Once a day each advisor gets
// one message: what is due today, and what is already late.
//
// One message, not one per task. Six emails at eight in the morning is not
// six reminders, it is noise somebody learns to archive unread, and the whole
// value of this is that it stays worth reading.
//
// Each task is stamped when it goes out so it cannot be sent twice, and the
// stamps are cleared when a task's date moves: a task pushed to next week
// should start chasing again then, and a reminder that fires once in a task's
// life is the failure people mind most.

import { now } from './util.js';
import { sendTaskDigestEmail } from './email.js';

// The hour, UTC, after which the day's message goes out. Eight in the morning
// on the east coast in summer, seven in winter. Set REMINDER_HOUR_UTC to move
// it; the point is that it is one predictable time, not that it is this one.
const DEFAULT_HOUR_UTC = 12;

const isoDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/**
 * One pass. Safe to call every five minutes: it does nothing before the hour,
 * and nothing for a task already stamped.
 */
export async function remindTasks(env, { at = now(), force = false } = {}) {
  const hour = Number(env.REMINDER_HOUR_UTC ?? DEFAULT_HOUR_UTC);
  const nowHour = new Date(at * 1000).getUTCHours();
  if (!force && nowHour < hour) return { sent: 0, skipped: 'too early' };

  const today = isoDay(at);

  // Due today and never mentioned, or overdue and never mentioned. Done tasks
  // are excluded here rather than filtered later: a task ticked off before the
  // morning message should not be in it.
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.user_id, t.title, t.due_date, t.due_time, t.priority, t.kind,
            b.client_name AS booking_client, c.name AS client_name, g.name AS group_name
       FROM tasks t
       LEFT JOIN bookings b ON b.id = t.booking_id
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN travel_groups g ON g.id = t.group_id
      WHERE t.done_at IS NULL AND t.due_date IS NOT NULL
        AND ((t.due_date = ? AND t.reminded_at IS NULL)
          OR (t.due_date < ? AND t.overdue_reminded_at IS NULL))
      ORDER BY t.due_date ASC, COALESCE(t.due_time, '99:99') ASC
      LIMIT 500`
  ).bind(today, today).all();

  if (!(results || []).length) return { sent: 0, tasks: 0 };

  const byUser = new Map();
  for (const t of results) {
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
    byUser.get(t.user_id).push(t);
  }

  let sent = 0;
  const stampToday = [];
  const stampLate = [];

  for (const [userId, tasks] of byUser) {
    const owner = await env.DB.prepare(
      'SELECT email, first_name, notify_email FROM users WHERE id = ?'
    ).bind(userId).first();

    const due = tasks.filter((t) => t.due_date === today);
    const late = tasks.filter((t) => t.due_date < today);

    // Stamped whether or not the message got out. An address that bounces
    // every morning would otherwise re-send the same list forever, and the
    // task is still on the screen where somebody can see it.
    for (const t of due) stampToday.push(t.id);
    for (const t of late) stampLate.push(t.id);

    const to = owner?.notify_email || owner?.email;
    if (!to) continue;

    try {
      await sendTaskDigestEmail(env, {
        to, firstName: owner.first_name, due, late,
      });
      sent += 1;
    } catch (e) {
      console.error('task digest', userId, e);
    }
  }

  await stamp(env, 'reminded_at', stampToday, at);
  await stamp(env, 'overdue_reminded_at', stampLate, at);

  return { sent, tasks: results.length, advisors: byUser.size };
}

async function stamp(env, column, ids, at) {
  if (!ids.length) return;
  // In batches, because a list of five hundred placeholders is a query nobody
  // wants to debug and D1 has opinions about statement size.
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    await env.DB.prepare(
      `UPDATE tasks SET ${column} = ? WHERE id IN (${slice.map(() => '?').join(',')})`
    ).bind(at, ...slice).run();
  }
}
