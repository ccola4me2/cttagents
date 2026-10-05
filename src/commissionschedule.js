// What an advisor will be paid on each pay date, for one reservation.
//
// Money arrives as check lines, each assigned to a pay date. The advisor's share
// is a percentage of what has arrived, and what has already been handed to them is
// subtracted, so working out one pay date's amount means working out the share of
// everything assigned to it or earlier and taking away the share of everything
// before. Doing it as running totals rather than line by line is what keeps the
// cents honest: the shares of three lines each rounded on their own do not always
// add up to the share of the three together, and a payout that is a cent off from
// the check it came from is the kind of difference that makes people stop trusting
// the page.
//
// Pure, and importing only the split rules, so it can be checked on its own.

import { shareOf, UNSPLIT_COMMISSION_KINDS } from './split.js';

/**
 * The amount owed to the advisor for each pay date, oldest first.
 *
 * `receipts` are the lines against the reservation, each with an amount, a kind
 * and a pay date (null for money from before pay dates, which is payable now).
 * `paidCents` is what the advisor has already been paid on this reservation, and
 * is taken off the earliest dates first, since those are the ones that were paid.
 *
 * `nowDate` is the date to file the undated and the overdue under: anything that
 * should already have been paid is simply waiting for the next run.
 */
export function owedByDate(receipts, pct, paidCents, nowDate) {
  const lines = [...receipts].sort((a, b) => {
    const x = a.payout_on && a.payout_on > nowDate ? a.payout_on : nowDate;
    const y = b.payout_on && b.payout_on > nowDate ? b.payout_on : nowDate;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const buckets = [];
  let cum = 0;
  let exempt = 0;
  let before = 0;
  for (const r of lines) {
    const date = r.payout_on && r.payout_on > nowDate ? r.payout_on : nowDate;
    cum += r.amount_cents || 0;
    if (UNSPLIT_COMMISSION_KINDS.includes(r.kind)) exempt += r.amount_cents || 0;
    const share = shareOf(cum, pct, exempt).advisorCents;
    const last = buckets[buckets.length - 1];
    if (last && last.date === date) last.cents += share - before;
    else buckets.push({ date, cents: share - before });
    before = share;
  }

  // What has gone out comes off the earliest dates.
  let paid = Math.max(0, paidCents || 0);
  for (const b of buckets) {
    const take = Math.min(paid, Math.max(b.cents, 0));
    b.cents -= take;
    paid -= take;
  }
  return buckets.filter((b) => b.cents !== 0);
}
