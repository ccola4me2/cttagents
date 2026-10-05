// When advisors are paid, and what an advisor is allowed to see before then.
//
// The agency pays on the 1st and the 15th. A commission arrives from a vendor on
// some other day, and it is paid out on whichever pay date the owner assigns it to:
// normally the first one after the traveller is back, because commission is
// paid on travel that has happened, not on a booking that might still change.
//
// The rule an advisor lives under follows from that. They see the commission that
// has arrived AND is assigned to the next pay date or one already past. Money that
// has arrived but is assigned further out is the agency's business until its
// turn comes, and showing it early only starts conversations about money that has
// not been decided yet.
//
// Pure and import-free so the pay calendar can be checked by itself, and so db.js,
// which every other module imports, can use it without a cycle.

/** The days of the month the agency pays on. */
export const PAY_DAYS = [1, 15];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');

function parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** Today, as the rest of the portal reads it. */
export function todayIso(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** The day after, for a date that is not itself allowed to count. */
export function dayAfter(iso) {
  if (!ISO.test(String(iso || ''))) return null;
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/**
 * The first pay date on or after a day.
 *
 * On the pay date itself that is the day: money recorded on the 15th for the 15th
 * goes out the same day, which is a thing that happens.
 */
export function nextPayDate(fromIso) {
  const from = ISO.test(String(fromIso || '')) ? fromIso : todayIso();
  const { y, m, d } = parts(from);
  for (const day of PAY_DAYS) {
    if (d <= day) return `${y}-${pad(m)}-${pad(day)}`;
  }
  const next = new Date(Date.UTC(y, m, 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(PAY_DAYS[0])}`;
}

/** The next few pay dates, soonest first, for a list to choose from. */
export function payDatesFrom(fromIso, count = 8) {
  const out = [];
  let at = nextPayDate(fromIso);
  while (out.length < count) {
    out.push(at);
    at = nextPayDate(dayAfter(at));
  }
  return out;
}

/**
 * The pay date to suggest for money that has just arrived.
 *
 * The first pay date strictly after the traveller is back, and not before the day
 * the money arrived. "Strictly after" is deliberate: someone back on October 31
 * is paid on November 1, and someone leaving on November 15 is not paid on the
 * 15th, because they have not been anywhere yet.
 *
 * With no dates on the reservation there is nothing to wait for and the answer is
 * the next pay date.
 */
export function suggestPayDate({ receivedOn, returnDate, departDate } = {}, today = todayIso()) {
  const travelEnd = [returnDate, departDate].find((d) => ISO.test(String(d || '')));
  const earliest = [
    ISO.test(String(receivedOn || '')) ? receivedOn : today,
    travelEnd ? dayAfter(travelEnd) : null,
  ].filter(Boolean).sort().pop();
  return nextPayDate(earliest);
}

/**
 * The last pay date an advisor may see money for: the next one.
 *
 * Null for anybody who sees everything. An owner reading an advisor's book is
 * reading the agency's, and gets the whole picture.
 */
export function hideAfterFor(user, today = todayIso()) {
  if (!user || user.role === 'admin') return null;
  return nextPayDate(today);
}

/** A date that is safe to write into SQL, or the one that shows nothing. */
function safe(iso) {
  return ISO.test(String(iso || '')) ? iso : '0000-00-00';
}

/**
 * The part of a statement that keeps a receipt from view until its pay date.
 *
 * Written into the SQL rather than bound, because it is composed into queries that
 * already have their own bind lists, and a date that matched the pattern above is
 * not anything an attacker chose. A receipt with no pay date is one from before
 * pay dates existed, and is shown, which is what it always was.
 */
export function receiptShown(alias, hideAfter) {
  if (!hideAfter) return '1 = 1';
  return `(${alias}.payout_on IS NULL OR ${alias}.payout_on <= '${safe(hideAfter)}')`;
}

/**
 * A reservation's commission status as the reader is allowed to see it.
 *
 * Received while some of what arrived is still waiting for its pay date reads as
 * pending to an advisor: they are not told the money is in until it is theirs.
 */
export function statusShown(alias, hideAfter) {
  if (!hideAfter) return `${alias}.commission_status`;
  return `(CASE WHEN ${alias}.commission_status = 'received' AND EXISTS (
            SELECT 1 FROM commission_receipts h
             WHERE h.booking_id = ${alias}.id AND h.payout_on > '${safe(hideAfter)}')
          THEN 'pending' ELSE ${alias}.commission_status END)`;
}
