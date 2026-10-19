// Annual targets, and whether you are on course for them.
//
// A goal on its own is a number you glance at in January and again in
// December. What makes it useful is pace: how much you should have done by
// today to be on track, and whether you are ahead or behind that. Everything
// here exists to answer that second question.
//
// The basis is stored with the goal. "Sell $200,000 this year" means one thing
// counted by when reservations were taken and another counted by when people
// travel, and those can differ by a whole quarter. Purchase is the default
// because it measures what you did rather than what is arriving.

import { json, clean, oneOf, toCents, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const BASES = ['purchase', 'departure'];

function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** How far through the year today is, as a fraction. */
export function yearProgress(today, year) {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const at = Date.parse(`${today}T00:00:00Z`);
  if (at <= start) return 0;
  if (at >= end) return 1;
  return (at - start) / (end - start);
}

export function line(actual, goal, elapsed) {
  if (!goal) return { goal: 0, actual, pace: 0, ahead: null, percent: null };
  const pace = Math.round(goal * elapsed);
  return {
    goal,
    actual,
    pace,
    // Positive means ahead of where you should be by today.
    ahead: actual - pace,
    percent: Math.round((actual / goal) * 1000) / 10,
  };
}

async function readGoal(env, userId, year) {
  const row = await env.DB.prepare(
    'SELECT * FROM goals WHERE user_id = ? AND year = ?'
    // No catch: .first() already answers null when there is no goal set, so
    // catching here could only ever hide a real failure. It did. With the
    // goals table missing in production this read returned null and the page
    // showed a blank target, which reads as "no goal yet" rather than "this
    // cannot be read".
  ).bind(userId, year).first();
  return row || null;
}

export async function goalProgress(env, user, scope, year, today) {
  const row = await readGoal(env, user.id, year);
  const basis = oneOf(row?.basis, BASES);
  // Whether the advisor's own trips count towards this target. Stored with the
  // goal, because it is a decision about what the target means.
  const includePersonal = Boolean(row?.count_personal);
  // Progress is measured against this advisor's own production even for an
  // owner looking at the agency: a personal target is personal.
  const totals = await db.periodTotals(env, scope, basis, `${year}-01-01`,
    year === Number(today.slice(0, 4)) ? today : `${year}-12-31`, { includePersonal });

  const elapsed = yearProgress(today, year);
  return {
    year,
    basis,
    set: Boolean(row),
    countPersonal: includePersonal,
    aim: row?.aim || '',
    edge: row?.edge || '',
    elapsed: Math.round(elapsed * 1000) / 10,
    sales: line(totals.grossCents, row?.sales_goal_cents || 0, elapsed),
    commission: line(totals.commissionCents, row?.commission_goal_cents || 0, elapsed),
    bookings: line(totals.bookings, row?.bookings_goal || 0, elapsed),
  };
}

export async function handleGetGoals(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const today = isoDay(0);
  const asked = Number(url.searchParams.get('year'));
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100
    ? asked : Number(today.slice(0, 4));

  // Always the advisor's own figures, never the agency's. A target you did not
  // set and cannot influence is not your target.
  const scope = db.selfScope(user);
  return json({ goals: await goalProgress(env, user, scope, year, today), today });
}

export async function handleSaveGoals(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const today = isoDay(0);
  const asked = Number(body.year);
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100
    ? asked : Number(today.slice(0, 4));

  await env.DB.prepare(
    `INSERT INTO goals (user_id, year, sales_goal_cents, commission_goal_cents,
       bookings_goal, basis, aim, edge, count_personal, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, year) DO UPDATE SET
       sales_goal_cents = excluded.sales_goal_cents,
       commission_goal_cents = excluded.commission_goal_cents,
       bookings_goal = excluded.bookings_goal,
       basis = excluded.basis,
       aim = excluded.aim,
       edge = excluded.edge,
       count_personal = excluded.count_personal,
       updated_at = excluded.updated_at`
  ).bind(user.id, year, toCents(body.salesGoal), toCents(body.commissionGoal),
         Math.max(0, Math.min(Number(body.bookingsGoal) || 0, 100000)),
         oneOf(body.basis, BASES), clean(body.aim, 500), clean(body.edge, 500),
         body.countPersonal ? 1 : 0, now()).run();

  await db.logActivity(env, user.id, 'goal.save', `Set targets for ${year}`, { year });
  return json({ ok: true, goals: await goalProgress(env, user, db.selfScope(user), year, today) });
}
