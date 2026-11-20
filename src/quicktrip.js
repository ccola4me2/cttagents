// The trip a quote describes: the same facts a reservation holds, kept inside the quote.
//
// A quote is not a reservation, so none of this is a booking row. It is one JSON document on the proposal: who is
// going, which sailing, the cabin, a price for each charge for each person, and what holds it. It is read back to
// the advisor, shown to the client on the proposal page, and copied onto a reservation only when the advisor says
// they accepted. Money is whole cents here; the editor works in dollars and sends them as typed.
//
// Nothing about commission is in here. This document is shown to the client.

import { clean, cleanDate, oneOf, oneOfOrNull } from './util.js';
import { PRODUCT_TYPES } from './producttypes.js';
import { PRICE_KINDS } from './pricing.js';

const MAX_TRAVELLERS = 12;
const MAX_LINES = 30;
const MAX_PROMOS = 12;
export const PROMO_SOURCES = ['vendor', 'agency', 'agent', 'tln'];
const KIND_KEYS = PRICE_KINDS.map((k) => k.kind);
const CREDIT = new Set(PRICE_KINDS.filter((k) => k.credit).map((k) => k.kind));
export const KIND_LABEL = Object.fromEntries(PRICE_KINDS.map((k) => [k.kind, k.label]));

/** Dollars as typed to whole cents. Anything that is not a positive amount is nothing. */
export function toCents(v) {
  const n = Math.round(parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')) * 100);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000000) : 0;
}

/**
 * What the editor sent, made safe to keep. Rows are kept by position so a price stays under the person it was typed
 * for; a person with no name and no money is dropped, and the prices follow them out.
 */
export function cleanTrip(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const rows = (Array.isArray(t.travellers) ? t.travellers : []).slice(0, MAX_TRAVELLERS)
    .map((x) => ({ name: clean(x && x.name, 120), email: clean(x && x.email, 254), phone: clean(x && x.phone, 40) }));
  const sent = (Array.isArray(t.lines) ? t.lines : []).slice(0, MAX_LINES)
    .map((l) => ({ kind: KIND_KEYS.includes(l && l.kind) ? l.kind : '', amounts: (Array.isArray(l && l.amounts) ? l.amounts : []).map(toCents) }))
    .filter((l) => l.kind);
  // Every extra traveller is kept, because somebody added the row on purpose. One whose name is not known yet is TBD, to be
  // determined, so the party is the right size on the quote and on the reservation. The first is kept when anyone else is,
  // so the prices below stay under the person they were typed for.
  const keep = [];
  rows.forEach((r, i) => {
    const data = r.name || r.email || r.phone || sent.some((l) => l.amounts[i] > 0);
    if (i > 0 || data || rows.length > 1) keep.push(i);
  });
  const travellers = keep.map((i) => (rows[i].name || i === 0 ? rows[i] : { ...rows[i], name: 'TBD' }));
  const lines = sent
    .map((l) => ({ kind: l.kind, amounts: keep.map((i) => l.amounts[i] || 0) }))
    .filter((l) => l.amounts.some((a) => a > 0));
  return {
    productType: oneOf(t.productType, PRODUCT_TYPES),
    supplier: clean(t.supplier, 120),
    productName: clean(t.productName, 120),
    itinerary: clean(t.itinerary, 160),
    destination: clean(t.destination, 120),
    departDate: cleanDate(t.departDate),
    returnDate: cleanDate(t.returnDate),
    cabinCategory: clean(t.cabinCategory, 80),
    cabin: clean(t.cabin, 80),
    travellers,
    lines,
    // Promotions and extras that go with the offer: onboard credit, a free drinks package, a reduced deposit. Each is
    // words and, if it has one, a value. They are not added to the price. The source says who is paying for it and is
    // for the advisor: it is not shown to the client.
    promotions: (Array.isArray(t.promotions) ? t.promotions : []).slice(0, MAX_PROMOS)
      .map((x) => ({
        description: clean(x && x.description, 160), amountCents: toCents(x && x.amount),
        source: oneOfOrNull(x && x.source, PROMO_SOURCES) || 'vendor',
      }))
      .filter((x) => x.description),
    depositCents: toCents(t.deposit),
    depositRefundable: oneOfOrNull(t.depositRefundable, ['refundable', 'nonrefundable']),
    depositDue: cleanDate(t.depositDue),
    finalPaymentDue: cleanDate(t.finalPaymentDue),
  };
}

/** The stored document, or null when there is nothing in it. */
export function readTrip(json) {
  if (!json) return null;
  try { const t = JSON.parse(json); return t && typeof t === 'object' ? t : null; } catch { return null; }
}

/** What a trip adds up to: a discount or a coupon comes off, everything else goes on. */
export function tripTotals(trip) {
  const lines = (trip && trip.lines) || [];
  const people = (trip && trip.travellers && trip.travellers.length) || 1;
  const perLine = lines.map((l) => ({
    kind: l.kind, label: KIND_LABEL[l.kind] || l.kind, credit: CREDIT.has(l.kind),
    cents: l.amounts.reduce((a, b) => a + (b || 0), 0), amounts: l.amounts,
  }));
  const totalCents = perLine.reduce((a, l) => a + (l.credit ? -l.cents : l.cents), 0);
  const perPersonCents = [];
  for (let i = 0; i < people; i++) {
    perPersonCents.push(lines.reduce((a, l) => a + (CREDIT.has(l.kind) ? -1 : 1) * (l.amounts[i] || 0), 0));
  }
  return { lines: perLine, totalCents: Math.max(0, totalCents), perPersonCents };
}

export const hasTrip = (trip) => Boolean(trip && (trip.supplier || trip.productName || trip.itinerary || trip.departDate
  || (trip.travellers || []).length || (trip.lines || []).length || (trip.promotions || []).length));
