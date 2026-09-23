// What the agency actually paid the advisor.
//
// The last step of the money, and the one the portal had nothing for. It
// could say what a vendor owed, what the vendor had paid, and what the
// advisor was owed out of it, and then stopped. So the payout run was a list
// that looked identical on the 15th and the 30th, and the only record that
// somebody had been paid was a bank statement and somebody's memory.
//
// The same shape as the vendor half in reconcile.js, deliberately. Money
// expected, money arrived, and the gap between them is the thing worth
// looking at; here it is the advisor's share of what arrived, what has gone
// out to them, and the gap. One payment covers many reservations, and what
// makes it a record rather than a number is knowing which.
//
// Only an owner writes one. An advisor who could record a payout could
// declare themselves paid, which is the same class of hole as an advisor
// setting their own split, and that one was real.

import { json, badRequest, notFound, clean, cleanDate, oneOf, uid, now, readJson } from './util.js';
import { requireUser, requireAdmin, isAdmin } from './auth.js';
import * as db from './db.js';
import {
  SPLIT_PCT_SQL, ADVISOR_SHARE_SQL, NO_COMMISSION, UNSPLIT_COMMISSION_KINDS,
} from './split.js';

export const PAYOUT_METHODS = [
  { key: 'check', label: 'Check' },
  { key: 'ach', label: 'Bank transfer' },
  { key: 'cash', label: 'Cash' },
  { key: 'other', label: 'Something else' },
];

const METHOD_KEYS = PAYOUT_METHODS.map((m) => m.key);

/**
 * What an advisor has earned out of money that has actually arrived, per
 * reservation, and how much of it has already gone out to them.
 *
 * The share is worked out from the receipts rather than from the expected
 * commission, for the reason the commission page says at length: paying a
 * share of money the vendor has not sent pays somebody out of the agency's
 * own pocket.
 *
 * The exempt part is summed from the receipts too. A tour conductor credit is
 * the advisor's in full, and applying that to the money promised rather than
 * the money received would owe them their bonus before the vendor had sent
 * it.
 */
const EXEMPT_RECEIPTS = UNSPLIT_COMMISSION_KINDS.map((k) => `'${k}'`).join(', ');

export function dueSql(alias = 'b') {
  const received = `COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                               WHERE r.booking_id = ${alias}.id), 0)`;
  const exempt = `COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                              WHERE r.booking_id = ${alias}.id
                                AND r.kind IN (${EXEMPT_RECEIPTS})), 0)`;
  // A waived trip pays nobody, the same rule every other total reads through.
  const share = `(CASE WHEN ${alias}.commission_status = '${NO_COMMISSION}' THEN 0
                       ELSE ${ADVISOR_SHARE_SQL(received, SPLIT_PCT_SQL(alias), exempt)} END)`;
  const paid = `COALESCE((SELECT SUM(l.amount_cents) FROM advisor_payout_lines l
                            WHERE l.booking_id = ${alias}.id), 0)`;
  return { share, paid, due: `(${share} - ${paid})` };
}

/**
 * Every reservation with something still to pay the advisor who sold it.
 *
 * Scoped like everything else, so an advisor asking sees their own and an
 * owner asking sees the agency's. Reservations are grouped by advisor,
 * because that is the shape of the job: one payment per person, not one per
 * trip.
 */
export async function owedByAdvisor(env, scope) {
  const scoped = db.scopeWhere(scope, 'b.user_id');
  const { share, paid, due } = dueSql('b');
  const { results } = await env.DB.prepare(
    `SELECT b.user_id,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
              AS advisor_name,
            COUNT(*) AS trips,
            COALESCE(SUM(${share}), 0) AS share_cents,
            COALESCE(SUM(${paid}), 0) AS paid_cents,
            COALESCE(SUM(${due}), 0) AS due_cents
       FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql} AND b.status IN ('booked','travelled')
        AND ${due} > 0
      GROUP BY b.user_id
      ORDER BY due_cents DESC`
  ).bind(...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

/** The reservations behind one advisor's figure, newest trip first. */
async function owedTrips(env, advisorId) {
  const { due } = dueSql('b');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.return_date, ${due} AS due_cents
       FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.user_id = ? AND b.status IN ('booked','travelled') AND ${due} > 0
      ORDER BY COALESCE(b.return_date, b.depart_date, '9999-12-31') ASC
      LIMIT 500`
  ).bind(advisorId).all().catch(() => ({ results: [] }));
  return results || [];
}

/**
 * What each advisor has been paid, all time.
 *
 * The other half of owedByAdvisor: that one says what is waiting, this says
 * what has gone. Together they are the two figures a report about paying
 * people is made of.
 */
export async function paidByAdvisor(env, scope) {
  const scoped = db.scopeWhere(scope, 'p.user_id');
  const { results } = await env.DB.prepare(
    `SELECT p.user_id, COALESCE(SUM(p.amount_cents), 0) AS paid_cents,
            COUNT(*) AS payouts, MAX(p.paid_on) AS last_paid_on
       FROM advisor_payouts p
      WHERE ${scoped.sql}
      GROUP BY p.user_id`
  ).bind(...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

export async function handleListPayouts(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'p.user_id');

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.paid_on, p.amount_cents, p.method, p.reference,
            p.notes, p.created_at,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
              AS advisor_name,
            (SELECT COUNT(*) FROM advisor_payout_lines l WHERE l.payout_id = p.id) AS trips
       FROM advisor_payouts p JOIN users u ON u.id = p.user_id
      WHERE ${scoped.sql}
      ORDER BY COALESCE(p.paid_on, '0000-00-00') DESC, p.created_at DESC
      LIMIT 200`
  ).bind(...scoped.binds).all().catch(() => ({ results: [] }));

  return json({
    payouts: results || [],
    // What is waiting, so the page can offer the run rather than making
    // somebody add up the column themselves.
    owed: await owedByAdvisor(env, scope),
    methods: PAYOUT_METHODS,
    // Only an owner records one, and the page should not draw a button that
    // would be refused. Not while acting as an advisor either: requireAdmin
    // refuses for the whole of that, so offering it would be a lie.
    mayPay: isAdmin(user) && !user.acting_as,
    today: new Date().toISOString().slice(0, 10),
  });
}

/**
 * Record that an advisor has been paid.
 *
 * Covers everything outstanding for that advisor unless particular
 * reservations are named. Paying the whole of what is owed is the twice
 * monthly job and naming two hundred reservations to do it is the kind of
 * friction that ends in nobody recording anything.
 *
 * The amount is the sum of the lines rather than a figure typed alongside
 * them. A total that can disagree with its own lines is the bug the vendor
 * statement half of this exists to catch, and there is no reason to build it
 * again on this side.
 */
export async function handleCreatePayout(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const body = await readJson(request);
  const advisorId = clean(body.userId, 64);
  if (!advisorId) return badRequest('Who is being paid?');

  // Their agency, not the platform's. The same question every other admin
  // endpoint asks, and the same answer when it fails: not found.
  const target = await db.getUserById(env, advisorId);
  if (!target || (!admin.platform_owner
    && (!admin.agency_id || target.agency_id !== admin.agency_id))) {
    return notFound('Advisor not found.');
  }

  const wanted = Array.isArray(body.bookingIds)
    ? body.bookingIds.filter((x) => typeof x === 'string').slice(0, 500) : null;

  let trips = await owedTrips(env, advisorId);
  if (wanted) {
    const only = new Set(wanted);
    trips = trips.filter((t) => only.has(t.id));
  }
  if (!trips.length) return badRequest('There is nothing owed to them right now.');

  const paidOn = cleanDate(body.paidOn) || new Date().toISOString().slice(0, 10);
  // oneOf falls back to the first entry, which is a cheque. Every payout is
  // one of these four and none of them is a claim worth refusing a record
  // over, so an unrecognised method is filed rather than rejected.
  const method = oneOf(body.method, METHOD_KEYS);
  const reference = clean(body.reference, 80);
  const notes = clean(body.notes, 1000);
  const total = trips.reduce((n, t) => n + (t.due_cents || 0), 0);

  const id = uid();
  const ts = now();
  const writes = [env.DB.prepare(
    `INSERT INTO advisor_payouts
       (id, user_id, paid_on, amount_cents, method, reference, notes,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, advisorId, paidOn, total, method, reference, notes, admin.id, ts, ts)];
  for (const t of trips) {
    writes.push(env.DB.prepare(
      `INSERT INTO advisor_payout_lines
         (id, payout_id, booking_id, user_id, amount_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(uid(), id, t.id, advisorId, t.due_cents, ts));
  }
  await env.DB.batch(writes);

  const named = [target.first_name, target.last_name].filter(Boolean).join(' ') || target.email;
  await db.logActivity(env, admin.id, 'payout.create',
    `Paid ${named} ${(total / 100).toFixed(2)} across ${trips.length} `
    + `reservation${trips.length === 1 ? '' : 's'}`,
    { payoutId: id, userId: advisorId, amountCents: total, trips: trips.length });
  // On the advisor's own record too, because it is their money and they are
  // the one who needs to be able to find it later.
  await db.logActivity(env, advisorId, 'payout.received',
    `Commission paid out: ${(total / 100).toFixed(2)} across ${trips.length} `
    + `reservation${trips.length === 1 ? '' : 's'}`,
    { payoutId: id, amountCents: total });

  return json({ ok: true, id, amountCents: total, trips: trips.length });
}

/**
 * Take one back.
 *
 * The lines go with it, so what it covered returns to being owed. A payout
 * entered against the wrong advisor is the obvious case, and leaving it in
 * place while entering a second one would have the agency's books say it paid
 * twice.
 */
export async function handleDeletePayout(request, env, id) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const row = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.amount_cents FROM advisor_payouts p
       JOIN users u ON u.id = p.user_id
      WHERE p.id = ? AND (? = 1 OR u.agency_id = ?)`
  ).bind(id, admin.platform_owner ? 1 : 0, admin.agency_id || '').first();
  if (!row) return notFound('Payout not found.');

  await env.DB.batch([
    env.DB.prepare('DELETE FROM advisor_payout_lines WHERE payout_id = ? AND user_id = ?')
      .bind(id, row.user_id),
    env.DB.prepare('DELETE FROM advisor_payouts WHERE id = ? AND user_id = ?')
      .bind(id, row.user_id),
  ]);

  await db.logActivity(env, admin.id, 'payout.delete',
    `Removed a payout of ${((row.amount_cents || 0) / 100).toFixed(2)}`,
    { payoutId: id, userId: row.user_id });
  return json({ ok: true });
}
