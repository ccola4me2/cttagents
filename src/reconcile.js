// Reconciling commission: what the vendor paid against what was expected.
//
// The old model had one figure and a tickbox. Marking a reservation paid meant
// the report counted the full expected commission, whether or not that is what
// arrived. Vendors pay short. They pay late, they pay a base rate and hold the
// bonus, they net off a chargeback from six months ago, and none of that was
// visible in a system where "paid" was a state rather than an amount.
//
// So money received is recorded as its own rows. Expected commission still
// lives on the reservation, received is the sum of the receipts against it, and
// the difference between the two is the number worth looking at. A reservation
// is settled when the money has actually arrived, not when somebody said so.
//
// Statements exist because that is how vendors pay: one payment covering many
// reservations, with a list. The statement total is entered from the vendor's
// own document and the lines are matched to reservations underneath it. When
// the matched lines and the stated total agree, the statement is reconciled.
// When they do not, the gap is either a line nobody has matched yet or money
// the vendor has not actually sent, and both are worth knowing.

import { json, badRequest, notFound, clean, cleanDate, toCents, oneOf, uid, now, readJson } from './util.js';
import { COMMISSION_KINDS, COMMISSION_KIND_KEYS } from './pricing.js';
import { requireUser } from './auth.js';
import { COMMISSION_RECEIVED } from './split.js';
import * as db from './db.js';

const STATEMENT_COLUMNS = `
  s.id, s.user_id, s.vendor_id, s.vendor_name, s.reference, s.statement_date,
  s.total_cents, s.notes, s.created_at, s.updated_at
`;

const RECEIPT_COLUMNS = `
  r.id, r.user_id, r.booking_id, r.statement_id, r.amount_cents, r.received_on,
  r.reference, r.notes, r.kind, r.created_at, r.updated_at
`;

// ---------------------------------------------------------------------------
// How a reservation stands
// ---------------------------------------------------------------------------

/**
 * Settlement from the two figures, rather than a stored status.
 *
 * A stored status is a claim about money that goes stale the moment a receipt
 * is added or removed. This is derived every time it is asked for, so it
 * cannot disagree with the receipts it describes.
 *
 * The tolerance is deliberate. Commission arrives rounded to the cent by a
 * vendor working from their own numbers, and a reservation one cent short is
 * settled by any sane reading. Anything larger is a real difference.
 */
export function settlement(expectedCents, receivedCents) {
  const expected = Number(expectedCents) || 0;
  const received = Number(receivedCents) || 0;
  const variance = received - expected;

  if (received === 0) return { state: 'unpaid', variance };
  if (Math.abs(variance) <= 1) return { state: 'settled', variance };
  if (variance < 0) return { state: 'short', variance };
  return { state: 'over', variance };
}

export { COMMISSION_KINDS };

export const SETTLEMENT_STATES = [
  { key: 'unpaid', label: 'Nothing received', hint: 'Expected, not yet arrived' },
  { key: 'short', label: 'Paid short', hint: 'Less arrived than was expected' },
  { key: 'settled', label: 'Settled', hint: 'The money is in' },
  { key: 'over', label: 'Overpaid', hint: 'More arrived than expected, worth checking' },
];

/** Received per booking, for a set of booking ids. */
export async function receivedByBooking(env, scope, bookingIds) {
  if (!bookingIds.length) return new Map();

  // Chunked because SQLite has a bound-parameter limit and a busy advisor's
  // commission page asks about every open reservation at once.
  const out = new Map();
  const scoped = db.scopeWhere(scope, 'r.user_id');
  for (let i = 0; i < bookingIds.length; i += 200) {
    const chunk = bookingIds.slice(i, i + 200);
    const holes = chunk.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(
      `SELECT r.booking_id, SUM(r.amount_cents) AS received_cents, COUNT(*) AS receipts,
              MAX(r.received_on) AS last_received_on
         FROM commission_receipts r
        WHERE ${scoped.sql} AND r.booking_id IN (${holes})
        GROUP BY r.booking_id`
    ).bind(...scoped.binds, ...chunk).all();
    for (const row of results || []) out.set(row.booking_id, row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function parseReceipt(body) {
  const bookingId = clean(body.bookingId, 64);
  if (!bookingId) return { error: 'Which reservation is this money for?' };

  // Negative is allowed and meant: a vendor clawing back a commission already
  // paid is a real event, and recording it as a negative receipt keeps the
  // running total honest. Zero is not, because it says nothing.
  const amountCents = toCents(body.amount);
  if (!amountCents) return { error: 'Enter an amount.' };

  return {
    fields: {
      bookingId,
      statementId: clean(body.statementId, 64) || null,
      // Which part of the commission this money is. A vendor settling the base
      // and holding the bonus is the normal case, not an exception.
      kind: oneOf(body.kind, COMMISSION_KIND_KEYS),
      amountCents,
      receivedOn: cleanDate(body.receivedOn),
      reference: clean(body.reference, 80),
      notes: clean(body.notes, 1000),
    },
  };
}

export async function handleListReceipts(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const bookingId = clean(url.searchParams.get('bookingId'), 64);
  const statementId = clean(url.searchParams.get('statementId'), 64);

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'r.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (bookingId) { where.push('r.booking_id = ?'); binds.push(bookingId); }
  if (statementId) { where.push('r.statement_id = ?'); binds.push(statementId); }

  const { results } = await env.DB.prepare(
    `SELECT ${RECEIPT_COLUMNS},
            b.client_name, b.product_name, b.supplier, b.depart_date,
            b.commission_cents AS expected_cents
       FROM commission_receipts r
       -- The receipt is scoped; tying the booking to the same advisor makes
       -- the join say so too, rather than resting on the ownership check that
       -- happened when the receipt was written.
       JOIN bookings b ON b.id = r.booking_id AND b.user_id = r.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(r.received_on, '0000-00-00') DESC, r.created_at DESC
      LIMIT 500`
  ).bind(...binds).all();

  return json({ receipts: results || [] });
}

export async function handleAddReceipt(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const { fields, error } = parseReceipt(body);
  if (error) return badRequest(error);

  // Money lands on the book the reservation is on. An owner filing a cheque
  // that covers an advisor's trip files it against that advisor, because it is
  // their commission: filing it under the owner would take the money off the
  // advisor's statement and leave the trip looking unpaid forever.
  const owner = await db.writerForBooking(env, user, fields.bookingId);
  if (!owner) return notFound('No such reservation.');

  const booking = await env.DB.prepare(
    'SELECT id FROM bookings WHERE id = ? AND user_id = ?'
  ).bind(fields.bookingId, owner.id).first();
  if (!booking) return notFound('No such reservation.');

  if (fields.statementId) {
    const stmt = await env.DB.prepare(
      'SELECT id FROM commission_statements WHERE id = ? AND user_id = ?'
    ).bind(fields.statementId, owner.id).first();
    if (!stmt) return notFound('No such statement.');
  }

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO commission_receipts
       (id, user_id, booking_id, statement_id, amount_cents, received_on,
        reference, notes, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, owner.id, fields.bookingId, fields.statementId, fields.amountCents,
    fields.receivedOn, fields.reference, fields.notes, fields.kind, ts, ts
  ).run();

  await syncCommissionStatus(env, owner.id, fields.bookingId);
  await db.logActivity(env, owner.id, 'commission.receipt',
    db.byHand('Recorded commission received',
      user, owner), { bookingId: fields.bookingId, amountCents: fields.amountCents });

  return json({ ok: true, id });
}

export async function handleDeleteReceipt(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'commission_receipts', id);
  if (!owner) return notFound('Receipt not found.');

  const row = await env.DB.prepare(
    'SELECT booking_id FROM commission_receipts WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!row) return notFound('No such receipt.');

  await env.DB.prepare(
    'DELETE FROM commission_receipts WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).run();

  await syncCommissionStatus(env, owner.id, row.booking_id);
  return json({ ok: true });
}

/**
 * Keep the reservation's own status in step with the money.
 *
 * commission_status predates receipts and is still what the reservation page
 * and the older reports read, so it cannot simply be ignored. It is driven by
 * the receipts rather than set by hand: received when the money is actually
 * there, and back to pending when the receipt that settled it is removed.
 *
 * There is nothing left for a person to set by hand in the middle. The old
 * 'invoiced' sat between the two and said the paperwork had gone out, which
 * is not a question anybody was answering, and a status that can only be
 * wrong is worse than one fewer status.
 */
async function syncCommissionStatus(env, userId, bookingId) {
  const booking = await env.DB.prepare(
    'SELECT commission_cents, commission_status FROM bookings WHERE id = ? AND user_id = ?'
  ).bind(bookingId, userId).first();
  if (!booking) return;

  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS received FROM commission_receipts WHERE booking_id = ? AND user_id = ?'
  ).bind(bookingId, userId).first();

  const { state } = settlement(booking.commission_cents, row?.received);
  const settled = state === 'settled' || state === 'over';
  const next = settled ? COMMISSION_RECEIVED
    : (booking.commission_status === COMMISSION_RECEIVED ? 'pending' : booking.commission_status);

  if (next !== booking.commission_status) {
    await env.DB.prepare(
      'UPDATE bookings SET commission_status = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(next, now(), bookingId, userId).run();
  }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function parseStatement(body) {
  const vendorName = clean(body.vendorName, 120);
  if (!vendorName) return { error: 'Which vendor sent it?' };

  return {
    fields: {
      vendorId: clean(body.vendorId, 64) || null,
      vendorName,
      reference: clean(body.reference, 80),
      statementDate: cleanDate(body.statementDate),
      totalCents: toCents(body.total),
      notes: clean(body.notes, 2000),
    },
  };
}

export async function handleListStatements(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 's.user_id');

  // The matched total comes from the receipts, the stated total from the
  // vendor's document. Reconciled means they agree.
  const { results } = await env.DB.prepare(
    `SELECT ${STATEMENT_COLUMNS},
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.statement_id = s.id), 0) AS matched_cents,
            (SELECT COUNT(*) FROM commission_receipts r WHERE r.statement_id = s.id) AS lines
       FROM commission_statements s
      WHERE ${scoped.sql}
      ORDER BY COALESCE(s.statement_date, '0000-00-00') DESC, s.created_at DESC
      LIMIT 200`
  ).bind(...scoped.binds).all();

  const statements = (results || []).map((s) => ({
    ...s,
    unmatched_cents: (s.total_cents || 0) - (s.matched_cents || 0),
    reconciled: Math.abs((s.total_cents || 0) - (s.matched_cents || 0)) <= 1,
  }));

  return json({ statements });
}

export async function handleCreateStatement(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const { fields, error } = parseStatement(body);
  if (error) return badRequest(error);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO commission_statements
       (id, user_id, vendor_id, vendor_name, reference, statement_date,
        total_cents, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, user.id, fields.vendorId, fields.vendorName, fields.reference,
    fields.statementDate, fields.totalCents, fields.notes, ts, ts
  ).run();

  return json({ ok: true, id });
}

export async function handleUpdateStatement(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'commission_statements', id);
  if (!owner) return notFound('Statement not found.');

  const body = await readJson(request);
  const { fields, error } = parseStatement(body);
  if (error) return badRequest(error);

  const result = await env.DB.prepare(
    `UPDATE commission_statements
        SET vendor_id = ?, vendor_name = ?, reference = ?, statement_date = ?,
            total_cents = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(
    fields.vendorId, fields.vendorName, fields.reference, fields.statementDate,
    fields.totalCents, fields.notes, now(), id, owner.id
  ).run();

  if (!result.meta.changes) return notFound('No such statement.');
  return json({ ok: true });
}

export async function handleDeleteStatement(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'commission_statements', id);
  if (!owner) return notFound('Statement not found.');

  // The receipts survive, detached. Money that arrived did arrive; deleting the
  // paperwork it came with does not unmake it, and silently deleting the
  // receipts would take real money off the books to tidy up a filing mistake.
  await env.DB.prepare(
    'UPDATE commission_receipts SET statement_id = NULL, updated_at = ? WHERE statement_id = ? AND user_id = ?'
  ).bind(now(), id, owner.id).run();

  const result = await env.DB.prepare(
    'DELETE FROM commission_statements WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).run();

  if (!result.meta.changes) return notFound('No such statement.');
  return json({ ok: true });
}

/**
 * Reservations that could plausibly be lines on this statement.
 *
 * Same vendor, travelled, commission expected, and not already fully settled.
 * Matching by hand from a list of every reservation ever made is the part of
 * reconciliation that makes people stop doing it.
 */
export async function handleStatementCandidates(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const stmt = await env.DB.prepare(
    'SELECT vendor_name FROM commission_statements WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!stmt) return notFound('No such statement.');

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.product_name, b.supplier, b.depart_date, b.return_date,
            b.confirmation_number, b.commission_cents AS expected_cents,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id), 0) AS received_cents
       FROM bookings b
      WHERE b.user_id = ?
        AND b.status IN ('booked', 'travelled')
        AND b.commission_cents > 0
        AND LOWER(COALESCE(b.supplier, '')) = LOWER(?)
      ORDER BY COALESCE(b.return_date, b.depart_date, '9999-12-31') ASC
      LIMIT 200`
  ).bind(user.id, stmt.vendor_name).all();

  const candidates = (results || [])
    .map((b) => ({ ...b, ...settlement(b.expected_cents, b.received_cents) }))
    .filter((b) => b.state !== 'settled' && b.state !== 'over');

  return json({ candidates });
}
