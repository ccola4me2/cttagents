// Celebrity Cruises' Group Quote.
//
// Read exactly, from one real quote. It is seven pages, and the part an advisor
// needs is on the second: a summary block of labelled facts, a cruise itinerary
// laid out as a column of dates, then a column of ports, then a column of times,
// and the deposit, final payment and cancellation terms.
//
// A category on this quote is the room type: the codes under "Category" (A2, C4,
// I1) are what the grid calls a room type, and they go in it as printed. The
// quote draws its stateroom table as separate runs of numbers, so nothing is
// matched by position alone. The cabins in each category are counted from the
// allocated room numbers and must agree with the "Allocated" column and with the
// cabin total, and the fares must come out as one for each category in each of
// the two fare columns. When any of that fails the grid is left empty and the
// fares go in the notes as printed, for a person to read.

import {
  DATE_SOURCE, parseDate, money, toCents, dollars, titleCase, lastFirst, nightsBetween,
} from './groupquote-util.js';

function matches(t) {
  return /Celebrity Cruises/i.test(t) && /Group Quote Summary/i.test(t) && /Group ID:\s*\d+/.test(t);
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * "22 MAR" with no year, on a sailing that began in March 2027.
 *
 * The itinerary prints day and month and leaves the year to be understood. A
 * sailing that crosses New Year has a January date in it that is next year's, so
 * a month earlier than the sailing's own means the year has turned.
 */
function withYear(day, month, sailIso) {
  const m = MONTHS.indexOf(month) + 1;
  if (!m || !sailIso) return '';
  const year = Number(sailIso.slice(0, 4));
  const from = Number(sailIso.slice(5, 7));
  return parseDate(`${year + (m < from ? 1 : 0)}-${m}-${day}`);
}

const dateOf = (s, re) => {
  const m = s.match(new RegExp(`${re}\\s*${DATE_SOURCE}`, 'i'));
  return m ? parseDate(m[1]) : '';
};

function parse(t) {
  // The first summary page. The letter before it names the group too, but with
  // the ship tacked on the end, and later pages repeat the header.
  const from = t.indexOf('Group Quote Summary');
  const end = t.indexOf('Please note itineraries may change', from);
  const s = t.slice(from, end > from ? end : from + 1800);

  const groupCode = (s.match(/Group ID:\s*(\d+)/) || [])[1] || '';
  const name = (s.match(/Group Name:\s*(.+?)\s+Partner Advocate:/) || [])[1] || '';
  const ship = titleCase((s.match(/Ship:\s*(.+?)\s+Extension:/) || [])[1] || '');
  const sail = dateOf(s, 'Sailing Date:');
  const issued = dateOf(s, 'Issue Date:');
  const itin = titleCase((s.match(/Itinerary:\s*(.+?)\s+Rep:/) || [])[1] || '');
  const rep = lastFirst((s.match(/Rep:\s*([A-Z][A-Z' .-]*,\s*[A-Z][A-Z' .-]*?)(?=\s+Cruise Itinerary|\s+[A-Z][a-z]|$)/) || [])[1] || '');

  // Dates, then ports, then times: three columns drawn one after another.
  let back = '';
  let port = '';
  const col = s.match(/Cruise Itinerary Date Port Location Arrive Depart\s+((?:\d{1,2} [A-Z]{3}\s+)+)(.+?)\s+\d{1,2}:\d{2} [AP]M/);
  if (col) {
    const days = [...col[1].matchAll(/(\d{1,2}) ([A-Z]{3})/g)].map((d) => withYear(d[1], d[2], sail));
    back = days.length > 1 ? days[days.length - 1] : '';
    // "CITY, REGION" for each port, and the first is where the ship sails from.
    const first = col[2].match(/^([A-Z][A-Z .'-]*?, [A-Z][A-Z .'-]*?)(?=\s+[A-Z][A-Z .'-]*?,|$)/);
    port = first ? titleCase(first[1]) : '';
  }

  // Money and dates. "Full Names and deposits are due as option dates are
  // reached" is the contract's own wording, so the first deposit date is the
  // option date rather than something inferred.
  const dep = t.match(new RegExp(`Cumulative Deposit Due\\s+${DATE_SOURCE}\\s+([\\d,]+\\.\\d{2})\\s+([\\d,]+\\.\\d{2})`, 'i'));
  const option = dep ? parseDate(dep[1]) : '';
  const final = dateOf(t, 'Final payment due:');

  // Three columns of a table, drawn as three runs. Used only if all three came
  // out the same length, because otherwise there is no telling which goes with which.
  const cancelAt = t.indexOf('Cancellation Schedule');
  const tail = cancelAt >= 0 ? t.slice(cancelAt, cancelAt + 900) : '';
  const ranges = [...tail.matchAll(/(\d+) to (\d+)/g)];
  const pcts = [...tail.matchAll(/(\d+)% per Guest/g)];
  const known = new Set([
    (s.match(new RegExp(`Issue Date:\\s*(${DATE_SOURCE.slice(1, -1)})`, 'i')) || [])[1],
    (s.match(new RegExp(`Sailing Date:\\s*(${DATE_SOURCE.slice(1, -1)})`, 'i')) || [])[1],
  ]);
  const dates = [...tail.matchAll(/(\d{1,2} [A-Z]{3} \d{4})/g)].map((d) => d[1]).filter((d) => !known.has(d));

  // Rooms are four digits each and are listed under their categories, so the
  // count is the digits divided by four. Anything that does not divide is left
  // alone: a cabin count that is wrong by one is the kind that goes unnoticed.
  const block = t.match(/Allocated Staterooms Category Staterooms(?: [A-Z0-9]+\([A-Za-z]+\))+\s+(.+?)\s+Air Inventory/);
  const digits = block ? block[1].replace(/\D/g, '').length : 0;
  const cabins = digits > 0 && digits % 4 === 0 ? digits / 4 : 0;

  // The categories, and the fares as printed: two runs, guests 1 and 2 then 3 and 4.
  const cats = t.match(/Guest 3 & 4\s+((?:[A-Z]\d\s+)+)((?:Double\s+|Single\s+|Triple\s+|Quad\s+)+)/);
  const codes = cats ? cats[1].trim().split(/\s+/) : [];
  const occupancies = cats ? cats[2].trim().split(/\s+/) : [];
  const price = codes.length
    ? t.match(new RegExp(`GROUPX(?:\\s+GROUPX)*\\s+((?:\\d+\\.\\d{2}\\s+){${codes.length * 2}})`)) : null;
  const fares = price ? price[1].trim().split(/\s+/).map(money) : [];

  // Cabins in each category. Rooms in one category are separated by commas, and
  // the next category begins where a room number has no comma before it. That
  // count must match the Allocated column, which prints the same numbers
  // a second way, ahead of a total.
  const roomTokens = block ? block[1].split(/\s+/).filter(Boolean) : [];
  const perCat = [];
  roomTokens.forEach((tok, i) => {
    if (tok === ',') return;
    if (i > 0 && roomTokens[i - 1] === ',') perCat[perCat.length - 1] += 1;
    else perCat.push(1);
  });
  const allocated = codes.length
    ? t.match(new RegExp(`((?:\\d+\\s+){${codes.length + 1}})GROUPX`)) : null;
  const printed = allocated ? allocated[1].trim().split(/\s+/).map(Number) : [];
  const rateOk = codes.length > 0 && fares.length === codes.length * 2
    && occupancies.length === codes.length && perCat.length === codes.length
    && perCat.reduce((a, n) => a + n, 0) === cabins
    && printed.length === codes.length + 1 && printed[codes.length] === cabins
    && codes.every((_, i) => printed[i] === perCat[i]);
  const PEOPLE = { Single: 1, Double: 2, Triple: 3, Quad: 4 };
  const rates = rateOk ? codes.map((c, i) => {
    const guests = perCat[i] * (PEOPLE[occupancies[i]] || 0);
    const perGuest = toCents(fares[i]);
    const more = toCents(fares[codes.length + i]);
    return {
      roomType: c,
      occupancy: occupancies[i],
      cabins: perCat[i],
      guests,
      perGuestCents: perGuest,
      extraAdultCents: more !== perGuest ? more : 0,
      taxesCents: 0,
      totalCents: perGuest * guests,
      sortOrder: i,
    };
  }) : [];

  const lines = [];
  if (issued) lines.push(`Issued ${issued}.`);
  if (rep) lines.push(`Celebrity sales rep: ${rep}.`);
  if (dep || final) {
    lines.push('', 'Payment terms:');
    if (dep) lines.push(`  Deposit: ${dollars(toCents(money(dep[2])))} due ${option}`);
    if (final) lines.push(`  Final payment due ${final}`);
  }
  if (ranges.length === 3 && pcts.length === 3 && dates.length === 3) {
    lines.push('', 'Cancellation charges:');
    for (let i = 0; i < 3; i += 1) {
      lines.push(`  ${pcts[i][1]}% per guest from ${parseDate(dates[i])} (${ranges[i][1]} to ${ranges[i][2]} days before sailing)`);
    }
  }
  if (!rateOk && codes.length && fares.length === codes.length * 2) {
    lines.push('', 'Fare per guest, as printed (check against the quote):');
    codes.forEach((c, i) => {
      const a = fares[i];
      const b = fares[codes.length + i];
      lines.push(`  Category ${c}: ${dollars(toCents(a))} for the 1st and 2nd guest, ${dollars(toCents(b))} for the 3rd and 4th`);
    });
  }
  if (rateOk) lines.push('', 'The quote prints no taxes and fees, so the rates are the fare only.');
  const berths = t.match(/Earned Ratio:\s*(\d+) for (\d+)/);
  const comp = t.match(/N\/A\s+(\d+)\s+-[\d.]+/);
  if (berths) {
    lines.push('', `Complimentary berths: ${comp ? `${comp[1]}, ` : ''}1 for every ${berths[2]} guests.`);
  }

  return {
    fields: {
      name,
      vendor: 'Celebrity Cruises',
      productName: ship,
      destination: itin,
      departDate: sail,
      returnDate: back,
      optionDate: option,
      cabinsHeld: cabins,
      groupCode,
      proposalId: '',
      sailingId: '',
      vendorContact: rep,
      departurePort: port,
      // Not stated anywhere on the quote. Two guests a cabin would fit the
      // complimentary berths, but fitting is not the page saying so.
      passengers: 0,
      proposalExpires: '',
    },
    rates,
    notes: lines.join('\n'),
    payments: [],
    warnings: [],
  };
}

export const celebrity = {
  id: 'celebrity-group-quote',
  name: 'Celebrity Cruises group quote',
  never: ['proposalId', 'proposalExpires'],
  matches,
  parse,
};
