// What an advisor pays on the day they join, and when the clocks next strike.
//
// A leaf that imports nothing, so it can be read on its own and checked
// against the agreement without following anything. Every amount is in cents,
// because a fee worked out in floating point is a fee that is a penny wrong
// often enough for somebody to notice.
//
// The agreement:
//
//   $29.95 a month for the CRM and platform, billed on the 1st. A partial
//   first month is prorated by day, which Stripe does itself.
//
//   $250 a year, the Annual Program Fee, renewing every 1 October. It is two
//   things in one number: $180 of errors and omissions cover, which is
//   prorated when somebody joins mid-year, and $70 which is not.

export const MONTHLY_CENTS = 2995;
export const ANNUAL_TOTAL_CENTS = 25000;
/** The insurance half, which prorates. */
export const EO_CENTS = 18000;
/** The remainder, which does not. */
export const PROGRAM_CENTS = ANNUAL_TOTAL_CENTS - EO_CENTS;

/**
 * Whole months of cover left in the year that ends on 30 September.
 *
 * Counted inclusive of the month somebody joins, because they are covered for
 * the month they join in. Joining any time in March is seven months: March
 * through September. Joining in October is a full twelve, which is why the
 * agreement says the insurance prorates only "if you're joining after October
 * 1" -- in October there is nothing to prorate.
 */
export function monthsOfCover(date) {
  const m = date.getUTCMonth() + 1; // 1-12
  return m >= 10 ? 22 - m : 10 - m;
}

/**
 * The Annual Program Fee due today.
 *
 * $70 in full plus the insurance for the months remaining. Rounded once, at
 * the end, so the figure on the invoice is the figure the arithmetic gives.
 */
export function annualDueCents(date) {
  const months = monthsOfCover(date);
  if (months >= 12) return ANNUAL_TOTAL_CENTS;
  return PROGRAM_CENTS + Math.round((EO_CENTS * months) / 12);
}

/** Midnight UTC on the next 1st of a month, which is when the monthly bills. */
export function nextMonthStart(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return Math.floor(Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1) / 1000);
}

/**
 * Midnight UTC on the next 1 October, when the annual renews.
 *
 * Joining exactly on 1 October is a full year from that day, not a renewal the
 * same afternoon, so today counts as the start of the year rather than the end
 * of one.
 */
export function nextOctoberFirst(date) {
  const y = date.getUTCFullYear();
  const thisOct = Date.UTC(y, 9, 1);
  const startOfDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((startOfDay < thisOct ? thisOct : Date.UTC(y + 1, 9, 1)) / 1000);
}

/** Everything the join-day invoice needs, in one place for the page to show. */
export function joiningToday(date = new Date()) {
  const months = monthsOfCover(date);
  return {
    monthsOfCover: months,
    programCents: PROGRAM_CENTS,
    eoCents: months >= 12 ? EO_CENTS : Math.round((EO_CENTS * months) / 12),
    annualDueCents: annualDueCents(date),
    monthlyCents: MONTHLY_CENTS,
    nextMonthlyAt: nextMonthStart(date),
    nextAnnualAt: nextOctoberFirst(date),
  };
}
