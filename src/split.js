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

// The status that means the money is in. Written down here for the same
// reason the one above it is: it appears in the status list, in five
// aggregates and in three reports, and a status this one disagreed with would
// quietly leave commission off a payout.
//
// It replaced two, 'invoiced' and 'paid'. Invoiced was a claim about
// paperwork and went stale the day it was set; what an owner actually asks
// twice a month is whether the vendor has paid, and that has two answers.
export const COMMISSION_RECEIVED = 'received';

/**
 * The percentage the advisor keeps.
 *
 * Five answers in order, and the order is the whole point:
 *
 *   0. Their own travel, which is not split at all. An advisor booking their
 *      own holiday through the agency earns real commission, and the
 *      agreement they signed is about the business they bring in. This beats
 *      even a figure typed onto the trip: a split on a reservation marked
 *      "My own travel" is a contradiction, and paying the figure while the
 *      screen says own travel is the resolution that pays somebody wrong.
 *   1. A figure written on this one reservation by hand.
 *   2. What the agreement said when the reservation was taken, stamped onto it
 *      then and never touched since.
 *   3. The advisor's agreement as it stands now, for reservations taken before
 *      there was a stamp. See 0074_agreed_split.sql.
 *   4. All of it.
 *
 * Two is what stops a change to an agreement restating money already earned.
 * Three exists only for rows that predate the stamp and has no other job; once
 * the backfill has run nothing reaches it.
 *
 * Which agreement applies depends on where the booking came from, because the
 * advisor agreement has two rates: one for what an advisor generates
 * themselves and a lower one for leads the company provides. Both are stamped,
 * so moving a trip between them afterwards picks what was agreed rather than
 * what is agreed today. A company lead with no company rate recorded falls
 * back to the personal rate rather than to 100, since the agency having agreed
 * one number and not the other is a gap in the record, not an agreement to
 * take nothing.
 */
export function splitPct(booking, personalPct, leadPct) {
  // Their own holiday, ahead of every agreement and of any figure typed onto
  // the trip. See the note above SPLIT_PCT_SQL, which says the same in SQL.
  if (booking.personal) return 100;
  const company = booking.lead_source === COMPANY_LEAD;
  const agreed = company
    ? [booking.agreed_lead_split_pct, booking.agreed_split_pct]
    : [booking.agreed_split_pct];
  const standing = company ? [leadPct, personalPct] : [personalPct];
  for (const v of [booking.advisor_split_pct, ...agreed, ...standing]) {
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

// The same arithmetic in SQLite, for the grouped reports that cannot pull rows
// into JavaScript. Kept next to shareOf so the two are read together, checked
// against each other by the smoke test on a worked example, and written in the
// same four steps as splitPct above.
//
// Takes the two table aliases rather than six column expressions: every caller
// joins bookings as b to users as u, and a list of six is a list somebody gets
// out of order.
//
// It does disagree with the agreement on the advisor's record, and that is the
// point rather than a flaw in it. The record says what is agreed now; a
// reservation says what was agreed when it was taken. A report that reads the
// first is restating March from September.
export const SPLIT_PCT_SQL = (b = 'b', u = 'u') =>
  `(CASE WHEN ${b}.personal = 1 THEN 100 ELSE COALESCE(${b}.advisor_split_pct,
     CASE WHEN ${b}.lead_source = '${COMPANY_LEAD}'
          THEN COALESCE(${b}.agreed_lead_split_pct, ${b}.agreed_split_pct)
          ELSE ${b}.agreed_split_pct END,
     CASE WHEN ${b}.lead_source = '${COMPANY_LEAD}'
          THEN COALESCE(${u}.lead_split_pct, ${u}.default_split_pct)
          ELSE ${u}.default_split_pct END,
     100) END)`;

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
