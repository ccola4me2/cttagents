// The four group deadlines nothing was chasing.
//
// Every other date in this portal has something behind it. A final payment has
// a schedule and a reminder ten days in front of it. A task has a digest. A
// client who has gone quiet is on Monday's call list.
//
// A group had four dates and none of them had anything at all, which is the
// worst case rather than a gap, because all four are deadlines where nothing
// visible happens when they pass:
//
//   The option date. The cabins go back to the supplier. Nobody rings.
//   The proposal expiry. The quoted terms lapse and the price is no longer
//     the price, which is found out at the moment somebody tries to book.
//   The deposit date. Parties registered and never turned into reservations
//     are not held by anything.
//   The passport date. The one deadline a traveller can miss without any money
//     moving, and so the one nothing else notices.
//
// One digest per group per day, and only when there is something to act on. A
// group three weeks from its option date with every cabin sold gets nothing,
// because there is nothing to do about it.
//
// To the advisor who owns the group, never to a traveller. It carries names
// and counts from their own book, which is why it respects the same opt out as
// the morning task digest: that setting is "stop emailing me about what is
// due", and this is that.

import { json, escapeHtml as esc, usDate } from './util.js';
import { requireAdmin } from './auth.js';
import { sendHtml } from './email.js';

/** How close each deadline has to be before it is worth saying anything. */
export const WINDOWS = {
  option: 21,
  proposal: 10,
  deposit: 14,
  passport: 30,
};

function isoDay(offset = 0) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

/** Whole days from today to a date, negative once it has passed. */
export function daysTo(iso, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  return Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000
  );
}

function when(days) {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/**
 * What is worth telling this advisor about this group today.
 *
 * Pure, and exported so the checks can put a group in front of it rather than
 * driving the whole pass. Returns an empty list when there is nothing to do,
 * which is the common case and the reason this is cheap to run every day.
 *
 * A deadline that has already passed still counts, for a while. The option
 * date going by is exactly when somebody needs to know, and a reminder that
 * goes quiet the moment it matters most is worse than none.
 */
export function noticesFor(group, facts, today) {
  const out = [];
  const unsold = Math.max(0, (Number(group.cabins_held) || 0) - (Number(facts.sold) || 0));

  const option = daysTo(group.option_date, today);
  if (option !== null && option <= WINDOWS.option && option >= -7 && unsold > 0) {
    out.push({
      kind: 'option',
      text: `${unsold} of ${group.cabins_held} cabins are still unsold and the option date `
        + `is ${when(option)} (${usDate(group.option_date)}). After it the supplier takes `
        + 'back whatever is left.',
    });
  }

  const proposal = daysTo(group.proposal_expires, today);
  if (proposal !== null && proposal <= WINDOWS.proposal && proposal >= -3) {
    out.push({
      kind: 'proposal',
      text: `The quoted terms lapse ${when(proposal)} (${usDate(group.proposal_expires)}). `
        + 'Anything booked after that is at whatever the supplier says then.',
    });
  }

  const deposit = daysTo(group.deposit_due, today);
  if (deposit !== null && deposit <= WINDOWS.deposit && deposit >= -7 && facts.unbooked > 0) {
    out.push({
      kind: 'deposit',
      text: `${facts.unbooked} ${facts.unbooked === 1 ? 'party has' : 'parties have'} `
        + `registered and not been turned into a reservation. Deposits are due `
        + `${when(deposit)} (${usDate(group.deposit_due)}), and nothing holds a cabin `
        + 'until one exists.',
    });
  }

  const passport = daysTo(group.passport_due, today);
  if (passport !== null && passport <= WINDOWS.passport && passport >= -14
      && facts.missingPassport > 0) {
    out.push({
      kind: 'passport',
      text: `${facts.missingPassport} traveller${facts.missingPassport === 1 ? ' has' : 's have'} `
        + `no passport on file. They are due ${when(passport)} `
        + `(${usDate(group.passport_due)}).`,
    });
  }

  return out;
}

/** The counts each notice is decided on, in one query per group. */
async function factsFor(env, group) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM bookings b
         WHERE b.group_id = ? AND b.user_id = ?
           AND b.status IN ('quoted','booked','travelled')) AS sold,
       (SELECT COUNT(*) FROM group_registrations r
         WHERE r.group_id = ? AND r.user_id = ?
           AND r.booking_id IS NULL AND r.status <> 'cancelled') AS unbooked,
       (SELECT COUNT(*) FROM group_travellers t
         WHERE t.group_id = ? AND t.user_id = ?
           AND t.passport_number_enc IS NULL) AS missing_passport`
  ).bind(group.id, group.user_id, group.id, group.user_id, group.id, group.user_id)
    .first().catch(() => null);

  return {
    sold: Number(row?.sold) || 0,
    unbooked: Number(row?.unbooked) || 0,
    missingPassport: Number(row?.missing_passport) || 0,
  };
}

function body(group, notices, appUrl) {
  const link = `${(appUrl || 'https://cttagents.com').replace(/\/$/, '')}`
    + `/app/group?id=${encodeURIComponent(group.id)}`;
  return `<p>Three weeks before a group sails, the things that cost money are the ones
    nobody is looking at. These are this morning's, for <strong>${esc(group.name)}</strong>.</p>
    <ul>${notices.map((n) => `<li>${esc(n.text)}</li>`).join('')}</ul>
    <p><a href="${esc(link)}">Open the group</a></p>
    <p style="color:#5c7286;font-size:.9rem;">You are getting this because the group is yours
      and a deadline on it is close. It stops if you turn off the morning reminders in
      Settings.</p>`;
}

/**
 * The daily pass.
 *
 * Cheap on the days there is nothing to do: one query for the groups with any
 * deadline inside the widest window, then one query each for the counts. A
 * portal with no live groups costs a single statement.
 */
export async function remindGroups(env, { today = isoDay(0), force = false } = {}) {
  const horizon = isoDay(Math.max(...Object.values(WINDOWS)));
  const floor = isoDay(-14);

  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.cabins_held, g.option_date, g.proposal_expires,
            g.deposit_due, g.passport_due, g.reminded_on
       FROM travel_groups g
      WHERE g.status = 'open'
        AND ((g.option_date BETWEEN ? AND ?) OR (g.proposal_expires BETWEEN ? AND ?)
          OR (g.deposit_due BETWEEN ? AND ?) OR (g.passport_due BETWEEN ? AND ?))
      LIMIT 500`
  ).bind(floor, horizon, floor, horizon, floor, horizon, floor, horizon)
    .all().catch(() => ({ results: [] }));

  let sent = 0;
  let skipped = 0;
  const problems = [];

  for (const group of groups || []) {
    // One digest per group per day. Checked before the counts are read, so a
    // group already told about today costs nothing at all.
    if (!force && group.reminded_on === today) { skipped += 1; continue; }

    const facts = await factsFor(env, group);
    const notices = noticesFor(group, facts, today);
    if (!notices.length) { skipped += 1; continue; }

    const owner = await env.DB.prepare(
      'SELECT email, first_name, notify_email, task_digest FROM users WHERE id = ?'
    ).bind(group.user_id).first().catch(() => null);
    if (!owner) { skipped += 1; continue; }
    // The same opt out as the morning task digest, which is the same promise:
    // stop emailing me about what is due.
    if (owner.task_digest === 0) { skipped += 1; continue; }

    const to = owner.notify_email || owner.email;
    if (!to) { skipped += 1; continue; }

    try {
      await sendHtml(env, {
        to,
        subject: `${group.name}: ${notices.length} thing${notices.length === 1 ? '' : 's'} to look at`,
        html: body(group, notices, env.APP_URL),
      });
      // Stamped only after a send that worked. A failure that marked the group
      // as told would lose the notice for good, and the next pass is an hour
      // away rather than a year.
      await env.DB.prepare(
        'UPDATE travel_groups SET reminded_on = ? WHERE id = ? AND user_id = ?'
      ).bind(today, group.id, group.user_id).run();
      sent += 1;
    } catch (e) {
      problems.push(`${group.name}: ${e && e.message ? e.message : 'send failed'}`);
    }
  }

  return { today, considered: (groups || []).length, sent, skipped, problems };
}

/**
 * Every advisor's notices for today, for the morning email to carry.
 *
 * Reads the same groups the pass above does and says the same things, but sends nothing and
 * stamps nothing: the morning email is one message for everything an advisor has to act on, and
 * it marks these as told (markGroupsTold) once it has gone.
 */
export async function groupNoticesByUser(env, { today = isoDay(0), force = false } = {}) {
  const horizon = isoDay(Math.max(...Object.values(WINDOWS)));
  const floor = isoDay(-14);
  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.cabins_held, g.option_date, g.proposal_expires,
            g.deposit_due, g.passport_due, g.reminded_on
       FROM travel_groups g
      WHERE g.status = 'open'
        AND ((g.option_date BETWEEN ? AND ?) OR (g.proposal_expires BETWEEN ? AND ?)
          OR (g.deposit_due BETWEEN ? AND ?) OR (g.passport_due BETWEEN ? AND ?))
      LIMIT 500`
  ).bind(floor, horizon, floor, horizon, floor, horizon, floor, horizon)
    .all().catch(() => ({ results: [] }));

  const byUser = new Map();
  for (const group of groups || []) {
    if (!force && group.reminded_on === today) continue;
    const notices = noticesFor(group, await factsFor(env, group), today);
    if (!notices.length) continue;
    if (!byUser.has(group.user_id)) byUser.set(group.user_id, []);
    byUser.get(group.user_id).push({ group: { id: group.id, name: group.name, user_id: group.user_id }, notices });
  }
  return byUser;
}

/** Groups the morning email has now told their advisor about, so a pass that runs again today skips them. */
export async function markGroupsTold(env, groups, today = isoDay(0)) {
  for (const { group } of groups) {
    await env.DB.prepare('UPDATE travel_groups SET reminded_on = ? WHERE id = ? AND user_id = ?')
      .bind(today, group.id, group.user_id).run();
  }
}

/**
 * Run it now, ignoring the hour and whether a group was already told today.
 *
 * Sends for real, so the stamps it writes are the real stamps. The agency
 * owner, like every other run-now button on this portal: there is one agency
 * here and no separate portal operator to hold the button instead.
 */
export async function handleRunGroupReminders(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  return json({ ...await remindGroups(env, { force: true }), by: user.email });
}
