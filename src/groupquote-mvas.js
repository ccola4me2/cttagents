// Margaritaville at Sea's Group Proposal Form.
//
// One layout, read exactly. This is the only reader here that knows where
// everything is, which is why it can fill in the rate grid and the payment
// terms and the others cannot: it has been checked against real proposals
// rather than written from what a proposal is supposed to look like.

import { after, money, toCents, dollars } from './groupquote-util.js';
import { portName } from './ports.js';

/**
 * Is this the form.
 *
 * Two marks rather than one, both from the letterhead, so a Margaritaville
 * booking confirmation does not pass for a proposal.
 */
function matches(t) {
  return /Margaritaville at Sea/i.test(t) && /Group Proposal Form/i.test(t);
}

/**
 * One grade's figures, checked against the total printed beside them.
 *
 * The first two guests in a cabin pay the main rate; anybody beyond that pays
 * the extra adult or extra child rate; everybody pays the tax. So the total is
 * fully determined by the other figures, and a row that does not add up was
 * misread, most likely by taking the wrong column for the extra. Saying so is
 * better than saving a number that looks right and is not.
 *
 * `extra` is tried as an adult rate and then as a child rate, because a row with
 * four amounts does not say which of the two it carries.
 */
export function reconcile(row) {
  const capacity = row.occupancy === 'Single' ? row.cabins : 2 * row.cabins;
  const base = Math.min(row.guests, capacity);
  const beyond = Math.max(0, row.guests - capacity);
  const expected = (extra) =>
    toCents(row.guests * row.taxes + base * row.perGuest + beyond * extra);
  const total = toCents(row.totalFare);
  return { expected, total, fits: (extra) => Math.abs(expected(extra) - total) <= 1 };
}

/**
 * The cabin grid.
 *
 * Read row by row rather than by column position, because the extra adult and
 * extra child columns are blank on most rows and counting would slide every
 * later figure one place left. A row has three to five dollar amounts: the
 * main rate and the tax and the total always, with an extra in between when
 * there is one.
 */
export function cabinRows(t) {
  const block = t.match(/Total Fare\s+(.*?)\s+(?:Additional Amenities|Important Dates)/);
  if (!block) return [];
  const rows = [];
  const re = /([A-Z][A-Za-z'&\- ]+?)\s+(Single|Double|Triple|Quad)(?:\s*\(([^)]*)\))?\s+(\d+)\s+(\d+)\s+((?:\$[\d,]+\.\d{2}\s*){3,5})/g;
  let m;
  // Amounts left over by the row before. Some files hand the extra adult and extra child prices back on the line above or below the row
  // they belong to, so a row's own three figures can be followed by the next row's extras.
  let carried = [];
  while ((m = re.exec(block[1]))) {
    const amounts = m[6].match(/\$[\d,]+\.\d{2}/g).map(money);
    const row = {
      roomType: m[1].trim(),
      occupancy: m[3] ? `${m[2]} (${m[3].trim()})` : m[2],
      basis: m[2],
      cabins: Number(m[4]),
      guests: Number(m[5]),
      perGuest: amounts[0],
      extraAdult: 0,
      extraChild: 0,
      taxes: amounts[amounts.length - 2],
      totalFare: amounts[amounts.length - 1],
    };
    const words = m[3] || '';
    const middle = amounts.slice(1, -2);
    if (middle.length === 2) {
      [row.extraAdult, row.extraChild] = middle;
    } else if (middle.length === 1) {
      // One extra, and the row does not say whose. Only the words can: adult and
      // child extras add up to the same total, so the arithmetic below cannot
      // tell them apart, only confirm that the figure belongs on the row at all.
      if (/child/i.test(words) && !/adult/i.test(words)) row.extraChild = middle[0];
      else row.extraAdult = middle[0];
    }
    row.reconciles = reconcile({ ...row, occupancy: m[2] })
      .fits(row.extraAdult || row.extraChild);
    let leftover = [];
    if (!row.reconciles) {
      // The row as read does not add up. Try it as the main rate, the tax and the total, with whatever amounts were left lying about
      // (the row before's, or the ones after this row's own three) standing in for the extras.
      const own = { ...row, perGuest: amounts[0], taxes: amounts[1], totalFare: amounts[2], extraAdult: 0, extraChild: 0 };
      const trailing = amounts.slice(3);
      const loose = [...carried, ...trailing];
      const capacity = m[2] === 'Single' ? own.cabins : 2 * own.cabins;
      const beyond = Math.max(0, own.guests - capacity);
      // Who the extra guests are, from the words: "3 Adults, 1 Child" in a cabin is one extra adult and one extra child, "2 Adults,
      // 2 Child" is two extra children, "2 Adult, 1 Child" one. The first two in a cabin are the adults who pay the main rate.
      const adults = Number((/(\d+)\s*adult/i.exec(words) || [])[1]);
      const children = Number((/(\d+)\s*child/i.exec(words) || [])[1]);
      let exAdult = 0;
      let exChild = 0;
      if (Number.isFinite(adults) || Number.isFinite(children)) {
        exAdult = Math.max(0, (adults || 0) - 2) * own.cabins;
        exChild = (children || 0) * own.cabins;
      }
      if (exAdult + exChild !== beyond) { exAdult = beyond; exChild = 0; }
      const total = (a, c) => own.guests * own.taxes + Math.min(own.guests, capacity) * own.perGuest + exAdult * a + exChild * c;
      const fits = (a, c) => Math.abs(total(a, c) - own.totalFare) <= 0.01;
      let found = null;
      if (beyond === 0) {
        if (fits(0, 0)) found = { adult: 0, child: 0, used: [] };
      } else {
        for (let i = 0; i < loose.length && !found; i += 1) {
          for (let j = 0; j < loose.length && !found; j += 1) {
            if (exAdult > 0 && exChild > 0) {
              // Both kinds: one price each, or one price that serves both when only one was printed.
              if ((i === j || loose[i] !== loose[j] || i < j) && fits(loose[i], loose[j])) found = { adult: loose[i], child: loose[j], used: i === j ? [i] : [i, j] };
            } else if (j === i) {
              if (exAdult > 0 && fits(loose[i], 0)) found = { adult: loose[i], child: 0, used: [i] };
              if (!found && exChild > 0 && fits(0, loose[i])) found = { adult: 0, child: loose[i], used: [i] };
            }
          }
        }
      }
      if (found) {
        Object.assign(row, own, { extraAdult: found.adult, extraChild: found.child, reconciles: true });
        // Only what this row's own line carried after its three figures can belong to the row after; the rest was the row before's.
        leftover = trailing.filter((_v, idx) => !found.used.includes(carried.length + idx));
      }
    }
    carried = leftover;
    rows.push(row);
  }
  return rows;
}

/** The payment ladder, which is where the dates that matter live. */
export function paymentRows(t) {
  const block = t.match(/Payment Amount\s+(.*?)\s+ALL TERMS/);
  if (!block) return [];
  const rows = [];
  const re = /([A-Za-z][A-Za-z ()/$\d\-.]*?)\s+(\d{4}-\d{2}-\d{2})\s+\$([\d,]+\.\d{2})/g;
  let m;
  while ((m = re.exec(block[1]))) {
    rows.push({ what: m[1].replace(/\s+/g, ' ').trim(), due: m[2], amount: money(m[3]) });
  }
  return rows;
}

/**
 * A proposal, as the fields of a group.
 *
 * `groupCode` is deliberately absent. The document does not carry one: it has a
 * Proposal ID and a SailingID, and the group number only exists once the vendor
 * opens the group, which is usually after this is signed. Leaving it empty is
 * the true state rather than a gap to be filled in with something that looks
 * like it.
 */
function parse(t) {
  const depart = after(t, 'Departure Date', '(\\d{4}-\\d{2}-\\d{2})');
  const back = after(t, 'Return Date', '(\\d{4}-\\d{2}-\\d{2})');
  const ship = after(t, 'Ship', '([A-Za-z][A-Za-z ]*?)\\s+(?:Cabin Fare|Return Date)');
  const itinerary = after(t, 'Itinerary', '(.+?)\\s+Number of Staterooms');
  const port = after(t, 'Departure Port', '([A-Za-z][A-Za-z .]*?)\\s+Total Passengers');
  const cabins = after(t, 'Number of Staterooms', '(\\d+)');
  const guests = after(t, 'Total Passengers', '(\\d+)');
  const sailingId = after(t, 'SailingID', '(\\d+)');
  const specialist = after(t, 'MVAS Specialist', '([A-Za-z][A-Za-z .\'-]*?)\\s+(?:Margaritaville|Proposal|Agency)');
  const expires = after(t, 'Proposal Expires', '(\\d{4}-\\d{2}-\\d{2})');
  const updated = after(t, 'Proposal Update Date', '(\\d{4}-\\d{2}-\\d{2})');

  // "Proposal ID: 4589 . Beasley's Group" on one and "Proposal ID: 3178 - 2 Jim C
  // Friends & Family" on the next. The "- 2" is a revision of the same proposal
  // and reads as part of the number, not the start of the name, which is how it
  // came out as a group called "- 2 Jim C Friends & Family".
  const head = t.match(/Proposal ID:\s*(\d+(?:\s*-\s*\d+)?)\s*\.?\s*(.+?)\s+Proposal Date/);
  const proposalId = head ? head[1].replace(/\s+/g, '') : '';
  const name = head ? head[2].trim() : '';

  const grades = cabinRows(t);
  const payments = paymentRows(t);
  // The date the cabins stop being held is the one that matters most, and it is
  // the rate hold rather than the first line: the countersign is the day the
  // paperwork is due, not the day the space goes.
  const hold = payments.find((p) => /rate hold/i.test(p.what)) || payments[0] || null;

  // Only what has nowhere better to go. The payment ladder is a list of dates and
  // amounts that nothing else in a group reads yet; when something does, it
  // wants rows too.
  const lines = [];
  if (updated) lines.push(`Updated ${updated}.`);
  if (payments.length) {
    if (lines.length) lines.push('');
    lines.push('Payment terms:');
    for (const p of payments) {
      lines.push(`  ${p.what}: ${dollars(toCents(p.amount))} due ${p.due}`);
    }
  }

  // The booking deposit: "Booking Deposit $100 p/Full Fare Guest ($300 for Suites)". The first amount per guest is the standard
  // deposit and the amount in brackets is the suite deposit. The line after the last is the final payment.
  const bookingRow = payments.find((p) => /\b(?:booking|full) deposit\b/i.test(p.what));
  const finalRow = payments.find((p) => /^final\b/i.test(p.what));
  const dollarsOf = (x) => (x ? Number(String(x).replace(/,/g, '')).toFixed(2) : '');
  const standardDeposit = bookingRow ? dollarsOf((/\$\s*([\d,]+(?:\.\d{2})?)\s*p\/(?:full fare )?(?:guest|person)/i.exec(bookingRow.what) || [])[1]) : '';
  const suiteDeposit = bookingRow ? dollarsOf((/\(\s*\$\s*([\d,]+(?:\.\d{2})?)\s*for suites?\s*\)/i.exec(bookingRow.what) || [])[1]) : '';

  const rates = grades.map((c, i) => ({
    roomType: c.roomType,
    occupancy: c.occupancy,
    cabins: c.cabins,
    guests: c.guests,
    perGuestCents: toCents(c.perGuest),
    extraAdultCents: toCents(c.extraAdult),
    extraChildCents: toCents(c.extraChild),
    taxesCents: toCents(c.taxes),
    totalCents: toCents(c.totalFare),
    sortOrder: i,
    reconciles: c.reconciles,
  }));

  return {
    fields: {
      name,
      vendor: 'Margaritaville at Sea',
      productName: ship,
      destination: itinerary,
      departDate: depart,
      returnDate: back,
      optionDate: hold ? hold.due : '',
      cabinsHeld: cabins ? Number(cabins) : 0,
      proposalId,
      sailingId,
      vendorContact: specialist,
      departurePort: portName(port),
      passengers: guests ? Number(guests) : 0,
      proposalExpires: expires,
      depositPerGuest: standardDeposit,
      suiteDepositPerGuest: suiteDeposit,
      depositDue: bookingRow ? bookingRow.due : '',
      finalPaymentDue: finalRow ? finalRow.due : '',
      groupCode: '',
    },
    rates,
    notes: lines.join('\n'),
    payments,
  };
}

export const mvas = {
  id: 'mvas',
  name: 'Margaritaville at Sea group proposal',
  // This form never carries a group number, so its absence is not a gap.
  never: ['groupCode'],
  matches,
  parse,
};
