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

  // Leads whose next step is due or past, every morning until it is dealt
  // with. No stamp: a task nags once because a daily task nag is noise, and an
  // overdue follow-up is the opposite, still undone and still worth a line.
  // Somebody who has booked is off the lead board and so is off this.
  const { results: leadRows } = await env.DB.prepare(
    `SELECT c.id, c.user_id, c.name AS client_name, c.lead_next_step, c.lead_next_step_on
       FROM clients c
      WHERE c.lead_stage IS NOT NULL
        AND c.lead_next_step_on IS NOT NULL
        AND c.lead_next_step_on <= ?
        AND NOT EXISTS (SELECT 1 FROM bookings b
                         WHERE b.client_id = c.id AND b.status IN ('booked','travelled'))
      ORDER BY c.lead_next_step_on ASC
      LIMIT 500`
  ).bind(today).all().catch(() => ({ results: [] }));

  const leads = (leadRows || []).map((r) => ({
    id: `lead:${r.id}`,
    lead: true,
    user_id: r.user_id,
    title: r.lead_next_step || `Follow up with ${r.client_name}`,
    client_name: r.client_name,
    due_date: r.lead_next_step_on,
  }));

  // Today's diary. Not stamped either: a meeting this afternoon belongs in
  // this morning's message whether or not yesterday's mentioned it, and it
  // leaves on its own when the day passes.
  const { results: apptRows } = await env.DB.prepare(
    `SELECT a.id, a.user_id, a.title, a.on_date, a.start_time, a.end_time, a.location,
            c.name AS client_name
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.on_date = ? AND a.cancelled_at IS NULL AND a.done_at IS NULL
      ORDER BY a.start_time ASC
      LIMIT 500`
  ).bind(today).all().catch(() => ({ results: [] }));

  const appts = (apptRows || []).map((r) => ({
    id: `appt:${r.id}`,
    appointment: true,
    user_id: r.user_id,
    title: r.title,
    client_name: [r.client_name, r.location].filter(Boolean).join('  ·  '),
    due_date: r.on_date,
    due_time: [r.start_time, r.end_time].filter(Boolean).join(' to '),
  }));

  // Being asked for by name, still unread. No stamp, for the same reason the
  // follow-ups above carry none: reading the conversation is what stops it,
  // which is a better signal than "we mentioned this once in an email".
  //
  // Across every advisor at once, so the LIKE has to be built against each
  // membership row rather than against one id bound in from outside.
  const { results: mentionRows } = await env.DB.prepare(
    `SELECT m.id, m.body, m.channel_id, mem.user_id,
            ch.kind, ch.name AS room_name,
            au.first_name, au.last_name, au.email AS author_email
       FROM messages m
       JOIN channel_members mem ON mem.channel_id = m.channel_id
       JOIN channels ch ON ch.id = m.channel_id
       LEFT JOIN users au ON au.id = m.user_id
      WHERE m.deleted_at IS NULL AND m.user_id != mem.user_id
        AND m.created_ms > mem.last_read_ms
        AND mem.muted = 0 AND ch.archived_at IS NULL
        AND m.mentions LIKE '%"' || mem.user_id || '"%'
      ORDER BY m.created_ms DESC
      LIMIT 200`
  ).bind().all().catch(() => ({ results: [] }));

  const mentions = (mentionRows || []).map((r) => {
    const who = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.author_email || 'Somebody';
    return {
      id: `chat:${r.id}`,
      mention: true,
      user_id: r.user_id,
      title: r.kind === 'dm' ? `${who} sent you a message` : `${who} asked for you in ${r.room_name || 'chat'}`,
      client_name: String(r.body || '').replace(/\s+/g, ' ').slice(0, 110),
      channel_id: r.channel_id,
      due_date: today,
    };
  });

  if (!(results || []).length && !leads.length && !appts.length && !mentions.length) {
    return { sent: 0, tasks: 0 };
  }

  const byUser = new Map();
  for (const t of [...(results || []), ...leads, ...appts, ...mentions]) {
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
    byUser.get(t.user_id).push(t);
  }

  let sent = 0;
  const stampToday = [];
  const stampLate = [];

  for (const [userId, tasks] of byUser) {
    const owner = await env.DB.prepare(
      'SELECT email, first_name, notify_email, task_digest FROM users WHERE id = ?'
    ).bind(userId).first();

    // Its own block in the message. A mention is not a task that fell due, and
    // filing it under "due today" beside three phone calls says the wrong
    // thing about both.
    const chat = tasks.filter((t) => t.mention);
    const jobs = tasks.filter((t) => !t.mention);
    const due = jobs.filter((t) => t.due_date === today);
    const late = jobs.filter((t) => t.due_date < today);

    // Stamped whether or not the message got out, and whether or not this
    // advisor wants one. An address that bounces every morning would otherwise
    // re-send the same list forever, and somebody who switches the email back
    // on should get today's list rather than a month of mornings at once.
    // Leads and appointments carry no stamp, so neither is in this.
    for (const t of due) if (!t.lead && !t.appointment) stampToday.push(t.id);
    for (const t of late) if (!t.lead && !t.appointment) stampLate.push(t.id);

    // Their own choice, and off means off. A message nobody asked for is the
    // one they learn to ignore, and an advisor who has learned to ignore one
    // of these has learned to ignore all of them.
    if (owner && owner.task_digest === 0) continue;

    const to = owner?.notify_email || owner?.email;
    if (!to) continue;

    try {
      await sendTaskDigestEmail(env, {
        to, firstName: owner.first_name, due, late, chat,
      });
      sent += 1;
    } catch (e) {
      console.error('task digest', userId, e);
    }
  }

  await stamp(env, 'reminded_at', stampToday, at);
  await stamp(env, 'overdue_reminded_at', stampLate, at);

  // Mentions counted separately, because they are not tasks and because a
  // number nobody can see is a number nobody can test.
  return { sent, tasks: results.length, mentions: mentions.length, advisors: byUser.size };
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
