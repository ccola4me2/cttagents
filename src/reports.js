// Dashboard and reporting.
//
// Pulls the D1 booking numbers and, when GoHighLevel is connected, a live
// pipeline snapshot. A GHL outage degrades to booking-only numbers rather than
// failing the whole dashboard, because the D1 half is still useful on its own.

import { json, now } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { readLayout, PANELS } from './prefs.js';
import { listTasks } from './tasks.js';
import { documentWatch, upcomingBirthdays } from './travellers.js';
import { listGroups } from './groups.js';
import { listCredits } from './credits.js';
import { migrationHint } from './schema-drift.js';
import { goalProgress } from './goals.js';
import { BUCKETS } from './commissions.js';
import * as ghl from './ghl.js';

function isoDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * A dashboard panel that fails without taking the screen with it.
 *
 * Isolating each panel is right: one broken query should not blank a page that
 * answers a dozen questions. Doing it silently is not, because an empty panel
 * and a panel that could not load look identical, and the empty one reads as
 * "nothing to do today". The names of the ones that failed go back with the
 * payload so the page can say so.
 */
/**
 * One panel, and what to say when it will not build.
 *
 * A panel that breaks leaves the rest of the dashboard standing, which is
 * right: one bad query should not take down the screen somebody opens first
 * thing every morning.
 *
 * What was wrong with it, though, is that the reason went to the console and
 * the advisor got "could not be built". Every other page in the portal names
 * the migration to run when a column is missing, because a correct query
 * against a stale database looks exactly like a bug in the code. This one made
 * the person holding the screen do that reasoning themselves.
 */
async function panel(failed, name, work, fallback) {
  try {
    return await work;
  } catch (e) {
    console.error('dashboard panel', name, e);
    const hint = migrationHint(e && e.message);
    failed.push(hint ? { name, hint } : { name });
    return fallback;
  }
}

export async function handleDashboard(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const today = isoDay(0);

  const scope = db.scopeFor(env, user, request);

  // Filled in by panel() as it goes, and returned with the payload.
  const failed = [];

  const [stats, payStats, payments, activity, recentAdded, recentModified,
         upcoming, traveling, returned] = await Promise.all([
    db.bookingStats(env, scope),
    // Two windows, because the two dates ask different questions. Hard dates
    // look out a fortnight: that is what could cancel shortly. Soft dates look
    // out a week, because a reminder is only useful while there is still time
    // to act on it. Neither is sixty days, which catches so much that the
    // number stops reading as urgent. The Deadlines panel below still lists
    // sixty, because a list is a horizon and a headline is not.
    db.paymentStats(env, scope, { today, soonThrough: isoDay(14), softThrough: isoDay(7) }),
    db.upcomingPayments(env, scope, isoDay(60)),
    db.recentActivity(env, scope, 8),
    db.recentReservations(env, scope, { by: 'added' }),
    db.recentReservations(env, scope, { by: 'modified' }),
    db.currentReservations(env, scope, { view: 'upcoming', today }),
    db.currentReservations(env, scope, { view: 'traveling', today }),
    db.currentReservations(env, scope, { view: 'returned', today }),
  ]);

  // Live pipeline, best effort. A CRM outage should cost one widget, not the
  // whole dashboard.
  let pipeline = null;
  let ghlStatus = 'ok';
  if (!ghl.ghlConfigured(env)) {
    ghlStatus = 'not_configured';
  } else {
    try {
      const locationId = ghl.locationFor(env, user);
      const pipelines = await db.localPipelines(env, locationId);
      if (pipelines.length) {
        const first = pipelines[0];
        const opps = await db.localOpportunities(env, locationId, {
          pipelineId: first.id, status: 'open',
        });
        // Grouped by stage, the way Sales Opportunities reads in CP Maxx.
        const byStage = first.stages.map((st) => {
          const items = opps.filter((o) => o.stageId === st.id);
          return { name: st.name, count: items.length,
                   value: items.reduce((n, o) => n + o.monetaryValue, 0) };
        }).filter((st) => st.count > 0);
        pipeline = {
          name: first.name,
          openCount: opps.length,
          openValue: opps.reduce((n, o) => n + o.monetaryValue, 0),
          stages: byStage,
          closed: await db.localOpportunityOutcomes(
            env, locationId, new Date(Date.now() - 365 * 86400000).toISOString()),
        };
      } else {
        pipeline = {
          name: null, openCount: 0, openValue: 0, stages: [],
          closed: await db.localOpportunityOutcomes(
            env, locationId, new Date(Date.now() - 365 * 86400000).toISOString()),
        };
      }
    } catch (e) {
      ghlStatus = 'error';
      console.error('dashboard pipeline', e);
    }
  }

  return json({
    user: { name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email },
    stats,
    payStats,
    upcomingPayments: payments,
    activity,
    reservations: { added: recentAdded, modified: recentModified },
    current: { upcoming, traveling, returned },
    pipeline,
    ghlStatus,
    today,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
    layout: await readLayout(env, user.id),
    panels: PANELS,
    notices: await noticesFor(env, user, scope),
    trend: await db.productionByMonth(env, scope, isoDay(-365)),
    // The next twelve months, not the last: what you are selling is a
    // forward looking question, and departures are in the future.
    byType: await db.productionBreakdown(env, scope, isoDay(0), 'type'),
    byVendor: await db.productionBreakdown(env, scope, isoDay(0), 'vendor'),
    tasks: await panel(failed, 'tasks', listTasks(env, scope, { state: 'open', limit: 25 }), []),
    groups: await panel(failed, 'groups', listGroups(env, scope, { status: 'open', limit: 12 }), []),
    rebook: await panel(failed, 'rebook', db.rebookCandidates(env, scope, { today, limit: 12 }), []),
    // Quotes nobody has answered, and quotes nobody has sent. Neither shows up
    // in production, on the to do list, or anywhere else on this screen.
    quotes: await panel(failed, 'quotes', db.quoteFollowUps(env, scope, { limit: 12 }), []),
    // A date of birth collected on every traveller and shown nowhere is a
    // field an advisor fills in for nothing.
    birthdays: await panel(failed, 'birthdays', upcomingBirthdays(env, scope, { today }), []),
    // Back from a trip and not yet rung. The one contact in the whole arc that
    // nothing goes wrong when you skip, which is why it gets skipped.
    welcome: await panel(failed, 'welcome', db.welcomeHomeCandidates(env, scope, { today }), []),
    // Trips where nobody has asked about insurance. Declined is a different
    // fact from not asked, and the difference is the advisor's position if
    // something goes wrong.
    insurance: await panel(failed, 'insurance', db.insuranceExposure(env, scope, { today }), []),
    pinned: await panel(failed, 'pinned', db.listClients(env, scope, { pinnedOnly: true, limit: 12 }), []),
    // Always the reader's own target, whatever scope the rest of the screen
    // is showing. A target you did not set is not your target.
    goal: await panel(failed, 'goal',
      goalProgress(env, user, db.selfScope(user), Number(today.slice(0, 4)), today), null),
    commission: await panel(failed, 'commission', commissionSummary(env, scope, today), null),
    credits: await panel(failed, 'credits', listCredits(env, scope, { state: 'open', limit: 25 }), []),
    // The rule that decides whether somebody gets on the plane, applied to
    // every upcoming trip rather than only to the one you happen to have open.
    documents: await panel(failed, 'documents', documentWatch(env, scope, { today }), []),
    // Which panels could not be built. An empty list is the normal answer; a
    // name in it means that panel is blank because it broke, not because
    // there is nothing to do.
    failed,
  });
}

/**
 * A month of everything with a date on it.
 *
 * Its own endpoint rather than part of the dashboard payload, because moving
 * between months should fetch one month rather than the whole dashboard again.
 */
export async function handleMonth(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const raw = url.searchParams.get('month') || '';
  // yyyy-mm or today's month. Anything else is a typo, not a request.
  const month = /^\d{4}-\d{2}$/.test(raw) ? raw : isoDay(0).slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const scope = db.scopeFor(env, user, request);
  return json({
    month, from, to, today: isoDay(0),
    events: await db.calendarMonth(env, scope, { from, to }),
    scope: db.scopeLabel(scope, user),
  });
}

export async function handleProduction(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const months = Math.min(Math.max(Number(url.searchParams.get('months')) || 12, 1), 36);
  const since = isoDay(-months * 31);
  // Off unless asked for. An advisor's own holiday earns real commission and
  // is real production, and it is also not the client selling a target is
  // usually about, so the report shows one view at a time and names which.
  const includePersonal = url.searchParams.get('personal') === '1';

  const scope = db.scopeFor(env, user, request);

  const [byMonth, stats, cashflow, payStats, byAdvisor] = await Promise.all([
    db.productionByMonth(env, scope, since, { includePersonal }),
    db.bookingStats(env, scope),
    db.paymentsByMonth(env, scope, since),
    db.paymentStats(env, scope, { today: isoDay(0), soonThrough: isoDay(30), urgentThrough: isoDay(14) }),
    // An owner's combined report is only useful if it breaks down. An advisor
    // sees a one row version of this, which is their own line.
    db.productionByAdvisor(env, scope, since, { includePersonal }),
  ]);

  // Collection rate: of everything that has already fallen due, how much has
  // actually been posted. A low number here is the early warning that a
  // booking is about to be cancelled by its supplier.
  const dueSoFar = (payStats.postedCents || 0) + (payStats.pastDueCents || 0);
  const collectionRate = dueSoFar > 0
    ? Math.round((payStats.postedCents / dueSoFar) * 1000) / 10
    : null;

  const today = isoDay(0);
  const [comparison, mix] = await Promise.all([
    db.salesComparison(env, scope, today, { includePersonal }),
    db.salesMix(env, scope, { from: `${today.slice(0, 4)}-01-01`, to: today, includePersonal }),
  ]);

  return json({
    months, since, byMonth, stats, cashflow, payments: payStats, collectionRate,
    comparison, mix, today,
    byAdvisor,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * Things that need a person to do something.
 *
 * The rule for what belongs here: a notice must be actionable and specific.
 * "Nothing is wrong" is not a notice, and neither is a number you can already
 * read off the panel above. Everything here either blocks work or is quietly
 * costing money, and each one links to the screen where it gets fixed.
 *
 * A failed automation is the reason this panel exists. Until now a run that
 * failed for good was visible only if you happened to open the Automations
 * screen and notice a red count, which meant a revoked API key could go unseen
 * for a week while follow ups silently stopped going out.
 */
async function noticesFor(env, user, scope) {
  const out = [];
  const isOwner = user.role === 'admin';

  const scoped = db.scopeWhere(scope, 'b.user_id');
  const [failed, pending, undated, pastDue] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(r.last_error) AS last_error
         FROM automation_runs r JOIN automations a ON a.id = r.automation_id
        WHERE a.location_id = ? AND r.status = 'failed'
          AND r.updated_at > ?`
    ).bind(ghl.locationFor(env, user), now() - 7 * 86400).first().catch(() => null),

    isOwner
      ? env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first().catch(() => null)
      : Promise.resolve(null),

    // A booked trip with no vendor deadline recorded is the quiet one. Nothing
    // will warn anybody, because there is no date to warn about.
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bookings b
        WHERE ${scoped.sql} AND b.status = 'booked' AND b.final_payment_due IS NULL`
    ).bind(...scoped.binds).first().catch(() => null),

    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM booking_payments p
        WHERE ${db.scopeWhere(scope, 'p.user_id').sql}
          AND p.paid_date IS NULL AND p.payment_class = 'hard'
          AND p.due_date IS NOT NULL AND p.due_date < ?`
    ).bind(...db.scopeWhere(scope, 'p.user_id').binds, isoDay(0)).first().catch(() => null),
  ]);

  if (pastDue && pastDue.n) {
    out.push({
      tone: 'urgent',
      title: `${pastDue.n} vendor deadline${pastDue.n === 1 ? '' : 's'} passed`,
      detail: 'Confirm with the vendor whether the reservation still stands.',
      href: '/app/payments', label: 'Open payments',
    });
  }

  if (failed && failed.n) {
    out.push({
      tone: 'urgent',
      title: `${failed.n} automation run${failed.n === 1 ? '' : 's'} failed this week`,
      detail: failed.last_error || 'Open the automation to see why.',
      href: '/app/automations', label: 'Open automations',
    });
  }

  const releasing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM travel_groups g
      WHERE ${db.scopeWhere(scope, 'g.user_id').sql} AND g.status = 'open'
        AND g.option_date IS NOT NULL AND g.option_date <= ?
        AND g.cabins_held > (SELECT COUNT(*) FROM bookings b
                              WHERE b.group_id = g.id AND b.status IN ('quoted','booked','travelled'))`
  ).bind(...db.scopeWhere(scope, 'g.user_id').binds, isoDay(21)).first().catch(() => null);

  if (releasing && releasing.n) {
    out.push({
      tone: 'warn',
      title: `${releasing.n} group${releasing.n === 1 ? '' : 's'} releasing unsold space within three weeks`,
      detail: 'Cabins you have not sold go back to the vendor on the option date.',
      href: '/app/groups', label: 'Open group space',
    });
  }

  const lapsing = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM client_credits c
      WHERE ${db.scopeWhere(scope, 'c.user_id').sql} AND c.used_on IS NULL
        AND c.expires_on IS NOT NULL AND c.expires_on <= ? AND c.expires_on >= ?`
  ).bind(...db.scopeWhere(scope, 'c.user_id').binds, isoDay(90), isoDay(0))
   .first().catch(() => null);

  if (lapsing && lapsing.n) {
    out.push({
      tone: 'warn',
      title: `${lapsing.n} client credit${lapsing.n === 1 ? '' : 's'} expiring within 90 days`,
      detail: 'Money your clients have already paid, which the vendor keeps if nobody uses it.',
      href: '/app/credits', label: 'Open credits',
    });
  }

  const staleCommission = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(b.commission_cents), 0) AS cents FROM bookings b
      WHERE ${db.scopeWhere(scope, 'b.user_id').sql}
        AND b.status IN ('booked','travelled') AND b.commission_status != 'paid'
        AND b.commission_cents > 0
        AND COALESCE(b.return_date, b.depart_date) IS NOT NULL
        AND COALESCE(b.return_date, b.depart_date) < ?`
  ).bind(...db.scopeWhere(scope, 'b.user_id').binds, isoDay(-90)).first().catch(() => null);

  if (staleCommission && staleCommission.n) {
    out.push({
      tone: 'urgent',
      title: `Commission unpaid on ${staleCommission.n} trip${staleCommission.n === 1 ? '' : 's'} home over 90 days`,
      detail: 'Money the agency has earned and not been paid. Vendors do not chase themselves.',
      href: '/app/commissions', label: 'Open commission',
    });
  }

  if (undated && undated.n) {
    out.push({
      tone: 'warn',
      title: `${undated.n} booked trip${undated.n === 1 ? '' : 's'} with no final payment date`,
      detail: 'Nothing can warn you about a deadline that was never recorded.',
      href: '/app/reservations', label: 'Open reservations',
    });
  }

  if (pending && pending.n) {
    out.push({
      tone: 'info',
      title: `${pending.n} advisor${pending.n === 1 ? '' : 's'} waiting for approval`,
      detail: 'They cannot sign in until someone approves them.',
      href: '/admin/', label: 'Review',
    });
  }

  if (isOwner && !env.RESEND_API_KEY) {
    out.push({
      tone: 'warn',
      title: 'Email is not configured',
      detail: 'Approvals, resets and automation emails cannot be sent until RESEND_API_KEY is set.',
      href: '/app/settings', label: 'Settings',
    });
  }

  return out;
}

/**
 * The commission panel's figures, without the row by row detail the page
 * needs. Aged from the return date, because commission is earned when the
 * client travels rather than when they book.
 */
async function commissionSummary(env, scope, today) {
  const scoped = db.scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.supplier, b.commission_cents,
            COALESCE(b.return_date, b.depart_date) AS back
       FROM bookings b
      WHERE ${scoped.sql} AND b.status IN ('booked','travelled')
        AND b.commission_status != 'paid' AND b.commission_cents > 0
      LIMIT 1000`
  ).bind(...scoped.binds).all();

  const ageing = Object.fromEntries(BUCKETS.map((b) => [b.key, { cents: 0, count: 0 }]));
  const vendors = {};
  let owed = 0;
  let claimable = 0;

  for (const r of results || []) {
    const days = r.back
      ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.back}T00:00:00Z`)) / 86400000)
      : null;
    const key = days === null || days < 0 ? 'travelling'
      : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'older';
    ageing[key].cents += r.commission_cents || 0;
    ageing[key].count += 1;
    owed += r.commission_cents || 0;
    if (key !== 'travelling') claimable += r.commission_cents || 0;

    const vendor = r.supplier || 'Unrecorded vendor';
    vendors[vendor] = vendors[vendor] || { vendor, cents: 0, count: 0 };
    vendors[vendor].cents += r.commission_cents || 0;
    vendors[vendor].count += 1;
  }

  return {
    owedCents: owed,
    claimableCents: claimable,
    ageing,
    buckets: BUCKETS,
    byVendor: Object.values(vendors).sort((a, b) => b.cents - a.cents),
  };
}
