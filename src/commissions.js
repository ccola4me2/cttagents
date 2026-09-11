// Commission the agency is owed, and how long it has been owed.
//
// This is the money the business actually lives on, and until now the portal
// held it as a single field on a reservation with three possible values and no
// way to see the whole picture. The questions an owner asks are: who owes us,
// how much, and how long has it been. None of them could be answered.
//
// Commission becomes claimable when the client travels, not when they book, so
// ageing runs from the return date. A trip that has not departed is not late,
// however long ago it was sold, and mixing the two makes everything look
// overdue and the report worth ignoring.

import { json, badRequest, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { SPLIT_PCT_SQL, ADVISOR_SHARE_SQL, UNSPLIT_SQL, EARNED_SQL, NO_COMMISSION } from './split.js';
import { settlement, SETTLEMENT_STATES, COMMISSION_KINDS } from './reconcile.js';

// What a batch may be moved to. "No commission" is not on it on purpose:
// waiving a commission is a decision about one reservation, made where the
// figures are, not a thing to apply to two hundred rows with one button.
const STATUSES = ['pending', 'invoiced', 'paid'];

// What the list may be filtered by, which is wider. A reservation marked as
// earning nothing is off this page by default, since the page exists to chase
// money and there is none to chase, but one marked that way in error has to be
// findable or it is simply gone.
const FILTER_STATUSES = [...STATUSES, NO_COMMISSION];

function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** Which ageing bucket a returned trip falls into. */
function bucketFor(daysSince) {
  if (daysSince === null) return 'travelling';
  if (daysSince < 0) return 'travelling';
  if (daysSince <= 30) return 'd30';
  if (daysSince <= 60) return 'd60';
  if (daysSince <= 90) return 'd90';
  return 'older';
}

export const BUCKETS = [
  { key: 'travelling', label: 'Not yet travelled', hint: 'Nothing to claim until they are back' },
  { key: 'd30', label: 'Up to 30 days', hint: 'Normal vendor turnaround' },
  { key: 'd60', label: '31 to 60 days', hint: 'Worth a look' },
  { key: 'd90', label: '61 to 90 days', hint: 'Chase the vendor' },
  { key: 'older', label: 'Over 90 days', hint: 'Money that may quietly never arrive' },
];

export async function handleListCommissions(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const status = FILTER_STATUSES.includes(url.searchParams.get('status'))
    ? url.searchParams.get('status') : null;
  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'b.user_id');
  const today = isoDay(0);

  const where = [scoped.sql, "b.status IN ('booked','travelled')", 'b.commission_cents > 0'];
  const binds = [...scoped.binds];
  if (status) {
    where.push('b.commission_status = ?');
    binds.push(status);
  } else {
    // A reservation marked "no commission" pays nobody: not the advisor and
    // not the agency. It has no place on the page whose whole purpose is
    // chasing money, and leaving it there put a figure in the owed column
    // that nobody was ever going to collect. Still reachable by filtering the
    // status deliberately, so a trip marked that way by mistake can be found.
    where.push(`b.commission_status != '${NO_COMMISSION}'`);
  }

  // The vendor pays the agency the whole commission; the advisor who booked it
  // keeps their agreed share. Both are selected because both are real: the
  // agency chases the first and pays out the second.
  const pct = SPLIT_PCT_SQL('b.advisor_split_pct', 'u.default_split_pct',
    'b.lead_source', 'u.lead_split_pct');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date, b.return_date,
            b.gross_cents, b.commission_cents, b.commission_status, b.confirmation_number,
            b.user_id, ${pct} AS split_pct,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id), 0) AS received_cents,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id AND r.kind = 'base'), 0) AS received_base_cents,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id AND r.kind = 'package'), 0) AS received_package_cents,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id AND r.kind IN ('bonus','bonus_shared')), 0)
              AS received_bonus_cents,
            COALESCE((SELECT SUM(p.commission_cents) FROM booking_pricing p
                       WHERE p.booking_id = b.id AND p.commission_kind = 'base'), 0) AS expected_base_cents,
            COALESCE((SELECT SUM(p.commission_cents) FROM booking_pricing p
                       WHERE p.booking_id = b.id AND p.commission_kind = 'package'), 0) AS expected_package_cents,
            COALESCE((SELECT SUM(p.commission_cents) FROM booking_pricing p
                       WHERE p.booking_id = b.id AND p.commission_kind IN ('bonus','bonus_shared')), 0)
              AS expected_bonus_cents,
            (SELECT MAX(r.received_on) FROM commission_receipts r
              WHERE r.booking_id = b.id) AS last_received_on,
            ${ADVISOR_SHARE_SQL(EARNED_SQL('b.commission_cents', 'b.commission_status'),
              pct, UNSPLIT_SQL('b.id'))} AS advisor_cents,
            ${UNSPLIT_SQL('b.id')} AS unsplit_cents,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
              AS advisor_name
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(b.return_date, b.depart_date, '9999-12-31') ASC
      LIMIT 500`
  ).bind(...binds).all();

  const rows = (results || []).map((r) => {
    const back = r.return_date || r.depart_date;
    const daysSince = back
      ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${back}T00:00:00Z`)) / 86400000)
      : null;
    // The agency's share is the remainder, so the two halves always add back
    // up to the commission rather than drifting a cent apart.
    // Expected against received, rather than a status somebody ticked. A
    // vendor paying short used to leave the reservation looking settled.
    const { state, variance } = settlement(r.commission_cents, r.received_cents);
    // Which parts are still out. A reservation whose base has arrived and
    // whose bonus has not used to read as simply part-paid, with nothing to
    // say which part to chase or who to chase it from.
    const outstandingByKind = {};
    for (const k of ['base', 'package', 'bonus']) {
      const owed = (r[`expected_${k}_cents`] || 0) - (r[`received_${k}_cents`] || 0);
      if (owed > 0) outstandingByKind[k] = owed;
    }

    return {
      ...r, back, daysSince, bucket: bucketFor(daysSince),
      outstanding_by_kind: outstandingByKind,
      // Read through the same rule as the advisor's half, so a waived
      // commission leaves the agency nothing either rather than leaving it
      // the whole of a figure nobody is paying.
      agency_cents: (r.commission_status === 'none' ? 0 : (r.commission_cents || 0))
        - (r.advisor_cents || 0),
      settlement: state,
      variance_cents: variance,
      outstanding_cents: Math.max((r.commission_cents || 0) - (r.received_cents || 0), 0),
    };
  });

  // Only unpaid commission ages. Once it has arrived, how long it took is
  // history rather than a thing to act on.
  // Owed is now a fact about money rather than about a status: anything the
  // vendor has not fully paid, including the part-paid ones that used to
  // disappear from this list the moment somebody marked them paid.
  const owed = rows.filter((r) => r.outstanding_cents > 0);
  const ageing = Object.fromEntries(BUCKETS.map((b) => [b.key, { cents: 0, count: 0 }]));
  for (const r of owed) {
    ageing[r.bucket].cents += r.outstanding_cents || 0;
    ageing[r.bucket].count += 1;
  }

  const byVendor = {};
  for (const r of owed) {
    const key = r.supplier || 'Unrecorded vendor';
    byVendor[key] = byVendor[key] || { vendor: key, cents: 0, count: 0, oldestDays: null };
    byVendor[key].cents += r.outstanding_cents || 0;
    byVendor[key].count += 1;
    if (r.daysSince !== null && r.daysSince > (byVendor[key].oldestDays ?? -1)) {
      byVendor[key].oldestDays = r.daysSince;
    }
  }

  return json({
    rows,
    buckets: BUCKETS,
    settlementStates: SETTLEMENT_STATES,
    commissionKinds: COMMISSION_KINDS,
    ageing,
    byVendor: Object.values(byVendor).sort((a, b) => b.cents - a.cents),
    totals: {
      owedCents: owed.reduce((n, r) => n + (r.outstanding_cents || 0), 0),
      // What the advisors are owed out of it, and what the agency keeps. An
      // associate reading their own page wants the first; an owner reading the
      // combined one is looking at the difference.
      owedAdvisorCents: owed.reduce((n, r) => n + (r.advisor_cents || 0), 0),
      owedAgencyCents: owed.reduce((n, r) => n + (r.agency_cents || 0), 0),
      owedCount: owed.length,
      // Claimable means they are home and it has not been paid: the number to
      // act on, as opposed to everything that will eventually be due.
      claimableCents: owed.filter((r) => r.bucket !== 'travelling')
        .reduce((n, r) => n + (r.outstanding_cents || 0), 0),
      // Money actually received, summed from the receipts. This used to be the
      // expected figure on everything somebody had marked paid, which is a
      // different number whenever a vendor pays short.
      paidCents: rows.reduce((n, r) => n + (r.received_cents || 0), 0),
      paidAdvisorCents: rows.filter((r) => r.settlement === 'settled' || r.settlement === 'over')
        .reduce((n, r) => n + (r.advisor_cents || 0), 0),
      lateCents: owed.filter((r) => r.bucket === 'older')
        .reduce((n, r) => n + (r.outstanding_cents || 0), 0),
      // Reservations the vendor has paid something towards and then stopped.
      // Not late, not unpaid, and previously invisible.
      shortCents: rows.filter((r) => r.settlement === 'short')
        .reduce((n, r) => n + Math.abs(r.variance_cents || 0), 0),
      shortCount: rows.filter((r) => r.settlement === 'short').length,
      overCount: rows.filter((r) => r.settlement === 'over').length,
      // What is still owed, by the part a vendor pays it in. A bonus nobody
      // has chased is invisible in a single total.
      owedBaseCents: rows.reduce((n, r) => n + (r.outstanding_by_kind.base || 0), 0),
      owedPackageCents: rows.reduce((n, r) => n + (r.outstanding_by_kind.package || 0), 0),
      owedBonusCents: rows.reduce((n, r) => n + (r.outstanding_by_kind.bonus || 0), 0),
    },
    today,
    // Whether any of this is actually split. A sole advisor keeping all of it
    // should not be shown two identical columns.
    anySplit: rows.some((r) => Number(r.split_pct) !== 100),
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * Move several reservations along at once.
 *
 * Commission is invoiced and chased in batches, one vendor statement at a
 * time, so doing it one reservation at a time is the kind of friction that
 * ends with nobody doing it at all. Scoped to the caller's own reservations:
 * an owner may read an associate's commission but not declare it paid.
 */
export async function handleSetCommissionStatus(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const status = oneOf(body.status, STATUSES);
  if (!STATUSES.includes(String(body.status || ''))) {
    return badRequest('Pick pending, invoiced or paid.');
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 200) : [];
  if (!ids.length) return badRequest('Nothing was selected.');

  const marks = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `UPDATE bookings SET commission_status = ?, updated_at = ?
      WHERE user_id = ? AND id IN (${marks})`
  ).bind(status, now(), user.id, ...ids).run();

  const changed = res.meta ? res.meta.changes || 0 : 0;

  // Marking a reservation paid has to move money, not just a label.
  //
  // Since commission is reconciled against what the vendor actually sent, a
  // status on its own no longer settles anything: the reservation would still
  // read as owed, and the next receipt would flip the label back to invoiced.
  // So marking paid records the outstanding amount as received. That is what
  // the person clicking it means, it keeps the one-click batch workflow, and
  // the figure lands somewhere it can later be corrected line by line.
  let recorded = 0;
  if (status === 'paid') recorded = await recordExpectedAsReceived(env, user.id, ids);
  await db.logActivity(env, user.id, 'commission.status',
    `Marked ${changed} reservation${changed === 1 ? '' : 's'} ${status}`, { status, count: changed });

  // Says how many actually moved rather than how many were asked for, so
  // selecting somebody else's reservation is visible rather than silent.
  return json({ ok: true, status, requested: ids.length, changed, recorded });
}

/**
 * Book the outstanding balance on each reservation as money received.
 *
 * Only the shortfall, so marking an already part-paid reservation paid tops it
 * up rather than double counting what has already arrived. A reservation with
 * nothing outstanding is skipped rather than given a zero receipt.
 */
async function recordExpectedAsReceived(env, userId, ids) {
  const marks = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.commission_cents,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id), 0) AS received_cents
       FROM bookings b
      WHERE b.user_id = ? AND b.id IN (${marks})`
  ).bind(userId, ...ids).all();

  const ts = now();
  const today = isoDay(0);
  const writes = [];
  for (const b of results || []) {
    const outstanding = (b.commission_cents || 0) - (b.received_cents || 0);
    if (outstanding <= 0) continue;
    writes.push(env.DB.prepare(
      `INSERT INTO commission_receipts
         (id, user_id, booking_id, statement_id, amount_cents, received_on,
          reference, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`
    ).bind(uid(), userId, b.id, outstanding, today,
      'Recorded by marking the commission paid', ts, ts));
  }

  if (writes.length) await env.DB.batch(writes);
  return writes.length;
}
