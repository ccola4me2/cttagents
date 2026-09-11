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

/** A reservation the agency handed the advisor, rather than one they found. */
export const COMPANY_LEAD = 'company';

// The commission status that means nobody earns: not the advisor, not the
// agency. Named rather than typed out, because it appears in SQL, in the
// status list and in the totals, and a typo in any one of those pays somebody
// money they are not owed.
export const NO_COMMISSION = 'none';

/**
 * The percentage the advisor keeps.
 *
 * Three answers in order: a figure written on this reservation, the standing
 * agreement that applies to it, then all of it.
 *
 * Which standing agreement applies depends on where the booking came from,
 * because the advisor agreement has two: one rate for what an advisor
 * generates themselves and a lower one for leads the company provides. A
 * company lead with no company rate recorded falls back to the advisor's
 * personal rate rather than to 100, since the agency having agreed one number
 * and not the other is a gap in the record, not an agreement to take nothing.
 */
export function splitPct(bookingPct, leadSource, personalPct, leadPct) {
  const standing = leadSource === COMPANY_LEAD ? [leadPct, personalPct] : [personalPct];
  for (const v of [bookingPct, ...standing]) {
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
export const SPLIT_PCT_SQL = (bookingPct, personalPct, leadSource, leadPct) =>
  `COALESCE(${bookingPct}, CASE WHEN ${leadSource} = '${COMPANY_LEAD}'
     THEN COALESCE(${leadPct}, ${personalPct}) ELSE ${personalPct} END, 100)`;

/**
 * The commission a reservation actually earns.
 *
 * "No commission" is not a workflow state like pending or invoiced; it is a
 * statement that this trip pays nobody. A charity booking, a friend's cruise
 * written at net, a group berth taken as a comp: the agency is not owed and
 * so the advisor is not owed either. The figure typed in the commission box
 * stays on the reservation, because a quoted commission that was then waived
 * is worth being able to see, but every total reads through this and gets
 * zero.
 *
 * Applied once, at the number, so the advisor's share and the agency's
 * remainder both fall out of it rather than each needing to remember.
 */
export const EARNED_SQL = (centsExpr, statusExpr) =>
  `(CASE WHEN ${statusExpr} = '${NO_COMMISSION}' THEN 0 ELSE COALESCE(${centsExpr}, 0) END)`;

/**
 * The exempt commission on one reservation, summed from its pricing lines./**
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
