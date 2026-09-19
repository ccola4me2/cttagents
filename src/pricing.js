// The parts of a price, and which of them earn commission.
//
// The one idea worth holding on to: a client pays a total, and a vendor pays
// commission on a fraction of it. Cruise fare earns; port taxes, government
// fees and non-commissionable fare do not; gratuities and packages depend on
// the vendor. An agency that does not track the split cannot tell an
// underpayment from a normal one, because every reservation's apparent rate is
// dragged down by money nobody was ever going to pay on.

import { json, badRequest, notFound, clean, oneOf, toCents, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { UNSPLIT_COMMISSION_KINDS } from './split.js';

// Order is the order they appear on the screen. Whether each earns commission
// by default is the industry norm, not a rule: any line can be flipped.
// `credit` marks the lines that come off the total rather than adding to it,
// so a discount is typed as a positive number and subtracted here. Asking
// anybody to type a negative into a form is asking for the sign to be wrong
// half the time.
export const PRICE_KINDS = [
  { kind: 'fare', label: 'Fare', commissionable: true },
  { kind: 'ncf', label: 'Non-commissionable fare', commissionable: false },
  { kind: 'taxes', label: 'Taxes and port fees', commissionable: false },
  { kind: 'gratuities', label: 'Gratuities', commissionable: false },
  { kind: 'beverage', label: 'Drinks package', commissionable: false },
  { kind: 'dining', label: 'Speciality dining', commissionable: false },
  { kind: 'spa', label: 'Spa', commissionable: false },
  { kind: 'internet', label: 'Internet', commissionable: false },
  { kind: 'extra', label: 'Package or amenity', commissionable: true },
  { kind: 'air', label: 'Air', commissionable: false },
  { kind: 'insurance', label: 'Travel insurance', commissionable: true },
  { kind: 'transfers', label: 'Transfers', commissionable: false },
  { kind: 'excursion', label: 'Excursions', commissionable: false },
  { kind: 'lodging', label: 'Lodging', commissionable: true },
  { kind: 'fuel', label: 'Fuel surcharge', commissionable: false },
  { kind: 'admin_fee', label: 'Administrative fee', commissionable: false },
  { kind: 'service_fee', label: 'Service fee', commissionable: false },
  { kind: 'visa_fee', label: 'Visa fee', commissionable: false },
  { kind: 'other', label: 'Other charges', commissionable: false },
  { kind: 'markup', label: 'Mark up', commissionable: false },
  { kind: 'coupon', label: 'Vendor coupon', commissionable: false, credit: true },
  { kind: 'discount', label: 'Discount', commissionable: false, credit: true },
];

// Which kinds come off the total. Read from the list above rather than named
// twice, so adding a credit kind cannot leave it counting the wrong way.
/**
 * The parts a vendor pays commission in.
 *
 * Base is the normal rate on the fare. Package is an override on an amenity or
 * a promotion, settled with the base or just after. The last two are what a
 * vendor pays for filling a group or hitting a target: a tour conductor credit
 * or a bonus, landing a quarter later if it lands at all, which is exactly why
 * they cannot be one number with the rest.
 *
 * The two bonus kinds are the same money and differ only in who ends up with
 * it. A TC credit or a vendor bonus is the advisor's in full. A casino deal is
 * split like anything else, because running casino rates through the agency
 * uses its licence and its risk. `agencyShares` is read by nothing here: the
 * arithmetic lives in split.js, and this says which is which for the screen.
 *
 * base leads because oneOf falls back to the first entry, and a commission
 * figure entered without saying which part it is has always meant the base.
 */
export const COMMISSION_KINDS = [
  { kind: 'base', label: 'Base', agencyShares: true },
  { kind: 'package', label: 'Package or override', agencyShares: true },
  { kind: 'bonus', label: 'TC or bonus, yours in full', agencyShares: false },
  { kind: 'bonus_shared', label: 'TC or bonus on a casino deal, split', agencyShares: true },
];

export const COMMISSION_KIND_KEYS = COMMISSION_KINDS.map((k) => k.kind);

const CREDIT_KINDS = new Set(PRICE_KINDS.filter((k) => k.credit).map((k) => k.kind));

const KINDS = PRICE_KINDS.map((k) => k.kind);

export async function listPricing(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT id, booking_id, user_id, traveller_id, component_id, kind, label,
            amount_cents, commissionable, commission_cents, commission_pct,
            commission_kind, sort_order
       FROM booking_pricing WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY sort_order ASC, rowid ASC`
  ).bind(bookingId, ...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

/**
 * The figures that come out of a breakdown.
 *
 * A discount is stored as a positive amount and subtracted here, because
 * asking anybody to type a negative number into a form is asking for the sign
 * to be wrong half the time.
 */
export function summarise(lines, vendorPct) {
  let clientTotal = 0;
  let commissionable = 0;
  let commission = 0;

  for (const l of lines) {
    const amount = l.amount_cents || 0;
    if (CREDIT_KINDS.has(l.kind)) { clientTotal -= amount; continue; }
    clientTotal += amount;
    if (l.commissionable) commissionable += amount;
    commission += l.commission_cents || 0;
  }

  // The same total, broken into the parts a vendor pays it in, so a
  // reservation whose base has arrived and whose bonus has not can say so.
  const byKind = { base: 0, package: 0, bonus: 0, bonus_shared: 0 };
  for (const l of lines) {
    if (!l.commission_cents) continue;
    const k = byKind[l.commission_kind] === undefined ? 'base' : l.commission_kind;
    byKind[k] += l.commission_cents;
  }

  const expected = vendorPct ? Math.round(commissionable * (vendorPct / 100)) : null;
  return {
    clientTotalCents: clientTotal,
    commissionableCents: commissionable,
    commissionCents: commission,
    commissionByKind: byKind,
    // The part of the commission the agency takes no share of, so the split
    // shown on the reservation is the one that will actually be paid out.
    unsplitCents: UNSPLIT_COMMISSION_KINDS.reduce((n, k) => n + (byKind[k] || 0), 0),
    expectedCents: expected,
    // The gap worth looking at. A vendor paying less than their own rate on
    // the commissionable part is the thing an agency never notices.
    varianceCents: expected === null ? null : commission - expected,
    // Two rates, because they answer different questions. The effective rate
    // is what the trip earned against what the client paid; the true rate is
    // what the vendor paid against what they pay on.
    effectivePct: clientTotal > 0 ? Math.round((commission / clientTotal) * 1000) / 10 : null,
    truePct: commissionable > 0 ? Math.round((commission / commissionable) * 1000) / 10 : null,
  };
}

function parseLine(body) {
  const kind = oneOf(body.kind, KINDS);
  const amount = toCents(body.amount);
  if (amount < 0) return { error: 'Enter the amount as a positive number.' };
  const commission = toCents(body.commission);
  if (commission > amount && kind !== 'discount') {
    return { error: 'Commission on a line cannot exceed the line itself.' };
  }
  return {
    fields: {
      kind,
      label: clean(body.label, 120),
      amountCents: amount,
      // A discount never earns commission, whatever the box says.
      commissionable: kind === 'discount' ? 0 : (body.commissionable ? 1 : 0),
      commissionCents: commission,
      sortOrder: Math.max(0, Math.min(Number(body.sortOrder) || 0, 999)),
    },
  };
}

/**
 * Saves the whole pricing grid at once.
 *
 * The grid is rows of charges against a column per traveller, which is how
 * anybody who has priced a cruise thinks about it: two people in one cabin do
 * not pay the same thing, one takes the drinks package and the other does not.
 * A single column for the whole reservation forces the advisor to average it,
 * and every per person figure after that is wrong.
 *
 * Replaces rather than merges. The grid holds every kind there is, so a
 * partial update would leave lines behind that the screen said were gone, and
 * a total nobody could reconcile against what they were looking at.
 *
 * Commission is one figure per traveller and is carried on that person's fare
 * line, because that is where a vendor pays it. A traveller with commission
 * and no fare gets a fare line of zero to hang it on rather than losing it.
 */
export async function handleSavePricingGrid(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');

  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');

  const body = await readJson(request);
  const cells = Array.isArray(body.cells) ? body.cells.slice(0, 400) : [];
  const commissions = Array.isArray(body.commissions) ? body.commissions.slice(0, 50) : [];

  // The rate each kind of charge earns. Stored so it comes back next time and
  // so the grid can work the money out again when an amount changes; the
  // commission itself still arrives as cash above, because a vendor who pays
  // an odd number that matches no rate has to be recordable exactly.
  const rates = new Map();
  for (const r of (Array.isArray(body.rates) ? body.rates.slice(0, 50) : [])) {
    const kind = oneOf(r.kind, KINDS);
    const pct = Number(r.pct);
    // Nought is a real answer and null is "not said", so they are kept apart.
    if (r.pct === '' || r.pct === null || r.pct === undefined) continue;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    rates.set(kind, Math.round(pct * 100) / 100);
  }

  // Whose columns these are, checked once. A traveller id from another
  // reservation would price somebody who is not on this trip.
  const { results: people } = await env.DB.prepare(
    'SELECT id FROM travellers WHERE booking_id = ? AND user_id = ?'
  ).bind(bookingId, owner.id).all().catch(() => ({ results: [] }));
  const mine = new Set((people || []).map((p) => p.id));
  const column = (v) => {
    const id = clean(v, 64);
    return id && mine.has(id) ? id : null;
  };

  const order = new Map(PRICE_KINDS.map((k, i) => [k.kind, i]));
  const rows = [];
  for (const cell of cells) {
    const kind = oneOf(cell.kind, KINDS);
    const amountCents = toCents(cell.amount);
    if (amountCents <= 0) continue;
    rows.push({
      travellerId: column(cell.travellerId),
      kind,
      commissionable: cell.commissionable ? 1 : 0,
      amountCents,
      commissionCents: 0,
      commissionPct: rates.has(kind) ? rates.get(kind) : null,
      sortOrder: order.get(kind) || 0,
      commissionKind: 'base',
    });
  }

  for (const c of commissions) {
    const cents = toCents(c.amount);
    if (cents <= 0) continue;
    const travellerId = column(c.travellerId);
    const commissionKind = oneOf(c.kind, COMMISSION_KIND_KEYS);

    // The base rides on the fare row it was earned from, which is where it has
    // always lived. A package override or a bonus gets its own row: they are
    // paid separately and have to be settled separately.
    const fare = commissionKind === 'base' && rows.find((r) => r.kind === 'fare'
      && r.travellerId === travellerId && r.commissionKind === 'base');
    if (fare) { fare.commissionCents = cents; continue; }
    rows.push({
      travellerId, kind: 'fare', commissionable: 1,
      amountCents: 0, commissionCents: cents, commissionPct: null, sortOrder: 0,
      commissionKind,
    });
  }

  // Every line on the reservation, because the grid now holds every line on
  // the reservation. It used to save one vendor's at a time, and leaving that
  // in after the vendor switcher went would have stranded any charge tagged to
  // a component: out of the grid, still in the trip total, and deleted by
  // nothing. They are read back into the grid and written out untagged.
  await env.DB.prepare(
    'DELETE FROM booking_pricing WHERE booking_id = ? AND user_id = ?'
  ).bind(bookingId, owner.id).run();

  const ts = now();
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO booking_pricing (id, booking_id, user_id, traveller_id, component_id,
         kind, label, amount_cents, commissionable, commission_cents, commission_pct,
         commission_kind, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uid(), bookingId, owner.id, r.travellerId, r.kind, r.amountCents,
           r.commissionable, r.commissionCents,
           r.commissionPct === undefined ? null : r.commissionPct,
           r.commissionKind || 'base', r.sortOrder, ts, ts).run();
  }

  await syncBookingTotals(env, bookingId, owner.id);
  await db.logActivity(env, owner.id, 'pricing.grid',
    db.byHand(`Priced ${booking.client_name}'s trip`, user, owner), { bookingId });
  return json({ ok: true, lines: rows.length });
}

export async function handleAddPriceLine(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');

  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');

  const { fields, error } = parseLine(await readJson(request));
  if (error) return badRequest(error);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO booking_pricing (id, booking_id, user_id, kind, label, amount_cents,
       commissionable, commission_cents, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, owner.id, fields.kind, fields.label, fields.amountCents,
         fields.commissionable, fields.commissionCents, fields.sortOrder, ts, ts).run();

  await syncBookingTotals(env, bookingId, owner.id);
  return json({ ok: true, id }, 201);
}

export async function handleUpdatePriceLine(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'booking_pricing', id);
  if (!owner) return notFound('Price line not found.');

  const row = await env.DB.prepare(
    'SELECT booking_id FROM booking_pricing WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!row) return notFound('Price line not found.');

  const { fields, error } = parseLine(await readJson(request));
  if (error) return badRequest(error);

  await env.DB.prepare(
    `UPDATE booking_pricing SET kind = ?, label = ?, amount_cents = ?, commissionable = ?,
       commission_cents = ?, sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(fields.kind, fields.label, fields.amountCents, fields.commissionable,
         fields.commissionCents, fields.sortOrder, now(), id, owner.id).run();

  await syncBookingTotals(env, row.booking_id, owner.id);
  return json({ ok: true });
}

export async function handleDeletePriceLine(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'booking_pricing', id);
  if (!owner) return notFound('Price line not found.');
  const row = await env.DB.prepare(
    'SELECT booking_id FROM booking_pricing WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!row) return notFound('Price line not found.');
  await env.DB.prepare('DELETE FROM booking_pricing WHERE id = ? AND user_id = ?')
    .bind(id, owner.id).run();
  await syncBookingTotals(env, row.booking_id, owner.id);
  return json({ ok: true });
}

/**
 * The reservation's headline totals follow the breakdown once one exists.
 *
 * Every other screen reads gross_cents and commission_cents, and two sets of
 * figures that can disagree eventually will. A reservation with no breakdown
 * keeps whatever was typed, so nothing is lost by never using this.
 */
async function syncBookingTotals(env, bookingId, userId) {
  const lines = await listPricing(env, bookingId, { all: false, userId });
  if (!lines.length) return;
  const s = summarise(lines, null);
  await env.DB.prepare(
    'UPDATE bookings SET gross_cents = ?, commission_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    // Not caught. This is the write that puts the price and the commission on
    // the reservation, so swallowing it leaves the screen showing one figure
    // and the database holding another, with the save reported as a success.
  ).bind(s.clientTotalCents, s.commissionCents, now(), bookingId, userId).run();
}

/**
 * Puts the headline totals back when they have drifted from the breakdown.
 *
 * The rule above only runs when somebody saves the grid, which is fine while
 * nothing else can write those two columns. Something else could: the
 * whole-record save wrote a zero over both for ten days, and a reservation
 * left that way stays wrong until somebody happens to open its grid and press
 * save. Nothing tells them to. What they see is a trip with no money on it and
 * a breakdown underneath that adds up perfectly, which reads as the portal
 * losing figures rather than as one column being stale.
 *
 * So the record puts it right on the way past. Only when there is a breakdown,
 * because then the breakdown is the arithmetic and the columns are a cache of
 * it; a reservation with no breakdown keeps whatever was typed and is not
 * touched. Only when they actually disagree, so an ordinary read writes
 * nothing. And as the advisor who owns the reservation, not whoever is
 * looking, so an owner opening somebody's trip repairs it without taking it.
 *
 * Returns the corrected figures so the page can render them rather than the
 * stale pair it was handed, and never throws: a reservation that will not
 * self-repair should still open.
 */
export async function reconcileBookingTotals(env, booking, summary) {
  if (!booking || !summary) return null;
  const gross = summary.clientTotalCents;
  const commission = summary.commissionCents;
  if ((booking.gross_cents || 0) === gross && (booking.commission_cents || 0) === commission) {
    return null;
  }
  try {
    await env.DB.prepare(
      `UPDATE bookings SET gross_cents = ?, commission_cents = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(gross, commission, now(), booking.id, booking.user_id).run();
  } catch (e) {
    console.error('reconcile totals', e);
    return null;
  }
  return { grossCents: gross, commissionCents: commission };
}
