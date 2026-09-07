// How a commission is divided between the advisor who booked it and the agency.
//
// `advisor_split_pct` is the percentage the booking advisor keeps. The agency
// keeps the rest. A reservation with no split recorded falls back to the
// advisor's standing agreement, and an advisor with no standing agreement
// keeps all of it.
//
// NULL is not zero, and this is the whole reason the module exists. No split
// agreed means the advisor keeps what they earned; a deliberate 0 means the
// agency keeps everything, which is a real arrangement for a house account.
// `pct || 100` collapses one into the other and silently pays somebody.

/**
 * The commission the agency takes no share of, whatever the split says.
 *
 * A tour conductor credit and a vendor bonus are not earned by the agency's
 * terms with the vendor; they are earned by the advisor filling a group or
 * hitting a target, and the agreement here is that they keep the lot. A casino
 * deal is the exception, which is why there are two bonus kinds rather than a
 * rule: running casino rates through the agency is using the agency's licence
 * and its risk, so that one is split like anything else.
 *
 * Kept in this module rather than with the other commission kinds because
 * pricing.js imports db.js which imports this, and the list has to sit at the
 * bottom of the pile for both sides to read it.
 */
export const UNSPLIT_COMMISSION_KINDS = ['bonus'];

/** The percentage the advisor keeps, given a reservation's value and their standing one. */
export function splitPct(bookingPct, advisorDefaultPct) {
  for (const v of [bookingPct, advisorDefaultPct]) {
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) {
      return Math.max(0, Math.min(Number(v), 100));
    }
  }
  return 100;
}

/**
 * Splits a commission in two.
 *
 * The agency's share is the remainder rather than its own rounded figure, so
 * the two halves always add back up to the commission. Two independent
 * roundings are how a report ends up a cent short of itself.
 */
export function shareOf(commissionCents, pct, unsplitCents = 0) {
  const cents = commissionCents || 0;
  const kept = Math.max(0, Math.min(Number(pct), 100));
  // Clamped, because the two figures come from different places: the total is
  // a column on the reservation and the exempt part is summed from its pricing
  // lines. Editing the total down by hand could otherwise leave the advisor
  // owed more than the vendor paid.
  const whole = Math.max(0, Math.min(unsplitCents || 0, cents));
  const advisorCents = Math.round((cents - whole) * kept / 100) + whole;
  return { advisorCents, agencyCents: cents - advisorCents, unsplitCents: whole };
}

// The same arithmetic in SQLite, for the grouped reports that cannot pull
// rows into JavaScript. Kept next to shareOf so the two are read together, and
// checked against each other by the smoke test on a worked example.
//
// The split is resolved at read time rather than stamped onto a reservation
// when it is created. Changing an advisor's standing agreement then applies to
// every trip that has not been given its own figure, which is what changing an
// agreement means; a stamped copy would need a backfill and would silently
// disagree with the agreement it came from.
export const SPLIT_PCT_SQL = (bookingPct, advisorPct) =>
  `COALESCE(${bookingPct}, ${advisorPct}, 100)`;

/**
 * The exempt commission on one reservation, summed from its pricing lines.
 *
 * A reservation with no breakdown has no exempt part: there is nowhere on it
 * to say which commission was a bonus, so it all splits, which is what it did
 * before any of this existed.
 */
export const UNSPLIT_SQL = (bookingIdExpr) =>
  `COALESCE((SELECT SUM(p.commission_cents) FROM booking_pricing p
              WHERE p.booking_id = ${bookingIdExpr} AND p.commission_kind IN (${
  UNSPLIT_COMMISSION_KINDS.map((k) => `'${k}'`).join(', ')})), 0)`;

// MIN with two arguments is SQLite's scalar minimum, not the aggregate. It is
// the same clamp shareOf applies, and for the same reason.
export const ADVISOR_SHARE_SQL = (commission, pctExpr, unsplitExpr = '0') =>
  `(MIN(${unsplitExpr}, ${commission})`
  + ` + CAST(ROUND(((${commission}) - MIN(${unsplitExpr}, ${commission}))`
  + ` * (${pctExpr}) / 100.0) AS INTEGER))`;
