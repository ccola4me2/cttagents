// What the client loses if they cancel.
//
// One of the few questions every client asks, and the portal had no answer.
// The advisor reads the tiers off a vendor's confirmation, counts the days in
// their head, and hopes. Getting it wrong in the client's favour costs the
// agency; getting it wrong the other way costs the client, and then the
// agency.
//
// The answer is only as good as what somebody typed in. Where no tier covers
// today, this says so rather than returning zero, because "nothing recorded"
// and "nothing to pay" are answers a client would react to very differently.

import { json, badRequest, notFound, clean, toCents, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const COLUMNS = `
  id, user_id, vendor_id, booking_id, from_days, pct, amount_cents, note,
  created_at, updated_at
`;

export async function listTiers(env, scope, { vendorId, bookingId } = {}) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const binds = [...scoped.binds];
  // The scope clause is written into the statement rather than joined in from
  // an array, so that reading this query tells you it is scoped. The same
  // shape built through where.join() reads as unscoped to anything looking,
  // human or otherwise.
  let extra = '';
  if (vendorId) { extra += ' AND vendor_id = ?'; binds.push(vendorId); }
  if (bookingId) { extra += ' AND booking_id = ?'; binds.push(bookingId); }

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM penalty_tiers
      WHERE ${scoped.sql}${extra} ORDER BY from_days DESC`
  ).bind(...binds).all();
  return results || [];
}

function parse(body) {
  const fromDays = Number(body.fromDays);
  if (!Number.isFinite(fromDays) || fromDays < 0 || fromDays > 3650) {
    return { error: 'How many days before departure does this tier start?' };
  }

  const hasPct = body.pct !== undefined && body.pct !== null && String(body.pct).trim() !== '';
  const hasAmount = body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== '';
  // "50% or $500" is not a term anybody wrote, and storing both would leave
  // the reader to guess which one the vendor meant.
  if (hasPct === hasAmount) {
    return { error: 'Give a percentage or an amount, not both and not neither.' };
  }

  const pct = hasPct ? Number(body.pct) : null;
  if (hasPct && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
    return { error: 'A percentage is between 0 and 100.' };
  }

  return {
    fields: {
      fromDays: Math.round(fromDays),
      pct: hasPct ? Math.round(pct * 10) / 10 : null,
      amountCents: hasAmount ? toCents(body.amount) : null,
      note: clean(body.note, 160),
    },
  };
}

/**
 * The tier that applies today, and what it costs.
 *
 * Tiers are read from the earliest period inwards: the one that applies is the
 * closest tier whose window has already opened. Departure in fifty days, with
 * tiers at 120, 89 and 29 days, is inside the 89 day tier and not yet inside
 * the 29 day one.
 *
 * A trip with no departure date, or with no tier covering this far out, gets
 * null rather than a comfortable zero.
 */
export function penaltyToday(booking, tiers, today) {
  if (!booking.depart_date || !tiers.length) return null;

  const from = Date.parse(`${today}T00:00:00Z`);
  const off = Date.parse(`${booking.depart_date}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(off)) return null;

  const daysUntil = Math.ceil((off - from) / 86400000);

  // Windows that have opened, closest first.
  const open = tiers
    .filter((t) => t.from_days >= daysUntil)
    .sort((a, b) => a.from_days - b.from_days);

  if (!open.length) {
    return {
      daysUntil,
      tier: null,
      // Named rather than left as a zero. The client is owed an answer and
      // "nobody has written the terms down that far out" is one.
      problem: 'No tier covers a cancellation this far ahead.',
    };
  }

  const tier = open[0];
  const gross = booking.gross_cents || 0;
  const penaltyCents = tier.pct !== null && tier.pct !== undefined
    ? Math.round(gross * (tier.pct / 100))
    : (tier.amount_cents || 0);

  return {
    daysUntil,
    tier: {
      fromDays: tier.from_days, pct: tier.pct,
      amountCents: tier.amount_cents, note: tier.note || '',
    },
    penaltyCents,
    // Only meaningful against a trip total somebody has entered.
    refundCents: gross > 0 ? Math.max(0, gross - penaltyCents) : null,
    ofGrossCents: gross,
    problem: gross > 0 || tier.pct === null ? null
      : 'This tier is a percentage and the trip has no total to apply it to.',
  };
}

async function ownsTarget(env, userId, { vendorId, bookingId }) {
  if (bookingId) return Boolean(await db.getBooking(env, bookingId, userId));
  if (vendorId) {
    const row = await env.DB.prepare('SELECT id FROM vendors WHERE id = ? AND user_id = ?')
      .bind(vendorId, userId).first();
    return Boolean(row);
  }
  return false;
}

export async function handleAddTier(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const vendorId = clean(body.vendorId, 64) || null;
  const bookingId = clean(body.bookingId, 64) || null;
  // Exactly one owner. A tier belonging to both a vendor and a trip would be
  // applied twice and edited in two places.
  if (Boolean(vendorId) === Boolean(bookingId)) {
    return badRequest('A tier belongs to a vendor or to a reservation, not both.');
  }
  if (!(await ownsTarget(env, user.id, { vendorId, bookingId }))) {
    return notFound('That vendor or reservation is not yours.');
  }

  const { fields, error } = parse(body);
  if (error) return badRequest(error);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO penalty_tiers
       (id, user_id, vendor_id, booking_id, from_days, pct, amount_cents, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, vendorId, bookingId, fields.fromDays, fields.pct,
         fields.amountCents, fields.note, ts, ts).run();
  return json({ ok: true, id }, 201);
}

export async function handleUpdateTier(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'penalty_tiers', id);
  if (!owner) return notFound('Tier not found.');

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const res = await env.DB.prepare(
    `UPDATE penalty_tiers SET from_days = ?, pct = ?, amount_cents = ?, note = ?,
            updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(fields.fromDays, fields.pct, fields.amountCents, fields.note, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Tier not found.');
  return json({ ok: true });
}

export async function handleDeleteTier(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'penalty_tiers', id);
  if (!owner) return notFound('Tier not found.');
  const res = await env.DB.prepare('DELETE FROM penalty_tiers WHERE id = ? AND user_id = ?')
    .bind(id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Tier not found.');
  return json({ ok: true });
}

/**
 * Copy a vendor's standard terms onto one reservation.
 *
 * Copied rather than followed. A cancellation penalty is a term of a contract
 * the client already signed; a vendor changing their standard terms next year
 * must not silently rewrite what this client agreed to. That is the opposite
 * of how the commission split behaves, and deliberately so.
 *
 * Replaces whatever the reservation had, because a half-copied schedule read
 * as one schedule is worse than either.
 */
export async function handleApplyVendorTerms(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');

  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');
  if (!booking.vendor_id) {
    return badRequest('This reservation is not linked to a vendor, so there are no terms to copy.');
  }

  const self = db.selfScope(owner);
  const tiers = await listTiers(env, self, { vendorId: booking.vendor_id });
  if (!tiers.length) return badRequest('That vendor has no cancellation terms recorded yet.');

  await env.DB.prepare('DELETE FROM penalty_tiers WHERE booking_id = ? AND user_id = ?')
    .bind(bookingId, owner.id).run();

  const ts = now();
  for (const t of tiers) {
    await env.DB.prepare(
      `INSERT INTO penalty_tiers
         (id, user_id, vendor_id, booking_id, from_days, pct, amount_cents, note, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uid(), owner.id, bookingId, t.from_days, t.pct, t.amount_cents, t.note, ts, ts).run();
  }

  await db.logActivity(env, owner.id, 'penalty.apply',
    db.byHand(
      `Copied ${booking.supplier || 'the vendor'}'s cancellation terms onto ${booking.client_name}'s trip`,
      user, owner),
    { bookingId, tiers: tiers.length });
  return json({ ok: true, copied: tiers.length }, 201);
}

export async function handleListTiers(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const vendorId = clean(url.searchParams.get('vendor'), 64) || null;
  const bookingId = clean(url.searchParams.get('booking'), 64) || null;
  if (Boolean(vendorId) === Boolean(bookingId)) {
    return badRequest('Ask for a vendor\'s terms or a reservation\'s, not both.');
  }

  const scope = db.scopeFor(env, user, request);
  return json({ tiers: await listTiers(env, scope, { vendorId, bookingId }) });
}
