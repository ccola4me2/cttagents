// Corporate targets: what the whole agency sets out to do this year, and whether it is on course.
//
// The advisor's own targets are in goals.js and stay theirs. These are the agency's, set by an owner and
// seen by an owner, and measured over everybody in the agency: what was sold, the commission it earned,
// what the agency itself keeps of that after its advisors' shares, and how many reservations. The pace is
// the same idea as an advisor's: how much should have been done by today to be on course, and how far
// ahead or behind that is.

import { json, badRequest, clean, oneOf, toCents, now, readJson } from './util.js';
import { requireAdmin } from './auth.js';
import * as db from './db.js';
import { line, yearProgress } from './goals.js';

const BASES = ['purchase', 'departure'];

const isoToday = () => new Date().toISOString().slice(0, 10);

function yearOf(value, today) {
  const asked = Number(value);
  return Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : Number(today.slice(0, 4));
}

async function progress(env, user, year, today) {
  const agencyId = user.agency_id || '';
  const row = await env.DB.prepare('SELECT * FROM agency_goals WHERE agency_id = ? AND year = ?')
    .bind(agencyId, year).first();
  const basis = oneOf(row && row.basis, BASES);
  const includePersonal = Boolean(row && row.count_personal);
  const through = year === Number(today.slice(0, 4)) ? today : `${year}-12-31`;

  const advisors = await db.productionByAdvisor(env, db.agencyScope(user), `${year}-01-01`,
    { includePersonal, until: through, basis });
  const sum = (key) => advisors.reduce((n, a) => n + (a[key] || 0), 0);
  const elapsed = yearProgress(today, year);

  return {
    year, basis, set: Boolean(row), countPersonal: includePersonal,
    aim: (row && row.aim) || '',
    elapsed: Math.round(elapsed * 1000) / 10,
    sales: line(sum('gross_cents'), (row && row.sales_goal_cents) || 0, elapsed),
    commission: line(sum('commission_cents'), (row && row.commission_goal_cents) || 0, elapsed),
    agency: line(sum('agency_share_cents'), (row && row.agency_goal_cents) || 0, elapsed),
    bookings: line(sum('bookings'), (row && row.bookings_goal) || 0, elapsed),
    // Who the figures are made of, biggest first.
    advisors: advisors.filter((a) => a.bookings > 0).map((a) => ({
      name: a.advisor_name, bookings: a.bookings, grossCents: a.gross_cents,
      commissionCents: a.commission_cents, agencyCents: a.agency_share_cents,
    })),
  };
}

/** GET /api/corporate-targets?year= : an owner's, and nobody else's. */
export async function handleGetCorporate(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const today = isoToday();
  const year = yearOf(new URL(request.url).searchParams.get('year'), today);
  return json({ targets: await progress(env, user, year, today), today });
}

/** PUT /api/corporate-targets { year, salesGoal, commissionGoal, agencyGoal, bookingsGoal, basis, countPersonal, aim } */
export async function handleSaveCorporate(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const body = await readJson(request);
  const today = isoToday();
  const year = yearOf(body.year, today);
  const agencyId = user.agency_id || '';

  await env.DB.prepare(
    `INSERT INTO agency_goals (agency_id, year, sales_goal_cents, commission_goal_cents, agency_goal_cents,
       bookings_goal, basis, count_personal, aim, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agency_id, year) DO UPDATE SET
       sales_goal_cents = excluded.sales_goal_cents,
       commission_goal_cents = excluded.commission_goal_cents,
       agency_goal_cents = excluded.agency_goal_cents,
       bookings_goal = excluded.bookings_goal,
       basis = excluded.basis,
       count_personal = excluded.count_personal,
       aim = excluded.aim,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).bind(agencyId, year, toCents(body.salesGoal), toCents(body.commissionGoal), toCents(body.agencyGoal),
    Math.max(0, Math.min(Number(body.bookingsGoal) || 0, 1000000)),
    oneOf(body.basis, BASES), body.countPersonal ? 1 : 0, clean(body.aim, 500), user.id, now()).run();

  await db.logActivity(env, user.id, 'corporate.targets', `Set the agency's targets for ${year}`, { year });
  return json({ ok: true, targets: await progress(env, user, year, today) });
}
