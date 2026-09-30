// Norwegian Cruise Line's FS Group Agreement.
//
// Read exactly, from one real contract. The layout is the awkward kind: the
// values are drawn BEFORE their labels, so the page reads
//
//   ... Norwegian Escape Hopper Wedding SETH GRUNES 8132786555
//   FS GROUP ==> A3124647 USD  Ship: Sail Date: FS Group Name: Sales Manager: ...
//
// and no rule of the form "label, then its value" can find anything in it. Which
// is the reason a layout like this needs a reader of its own rather than the
// fallback.
//
// Unlike the Margaritaville form this one DOES carry a group number, so it is
// filled in; it stays editable like everything else.

import {
  DATE_SOURCE, parseDate, money, toCents, dollars, titleCase, nightsBetween, sayList,
} from './groupquote-util.js';

const FLEET = 'Norwegian (?:Aqua|Bliss|Breakaway|Dawn|Encore|Epic|Escape|Gem|Getaway|Jade|Jewel|Joy|Luna|Pearl|Prima|Sky|Spirit|Star|Sun|Viva)|Pride of America';

function matches(t) {
  return /FS GROUP AGREEMENT/.test(t) && /Norwegian Cruise Line/i.test(t);
}

/**
 * The cabin table.
 *
 * Every rate is per person on double occupancy, which the contract says in so
 * many words, so a category's guests are twice its cabins. That is checked
 * rather than assumed: the payments the contract asks for must add up to the
 * whole table, and the parser reports when they do not.
 */
function cabinRows(t) {
  const block = t.match(/Cabin Type\s+(.*?)\s+\*NCF/);
  if (!block) return [];
  const rows = [];
  const re = /([A-Z][A-Za-z ]+?)\s+([A-Z0-9]{2,3})\s+([A-Z0-9]{2,3})\s+(\d+)\s+([\d,]+\.\d{2})\s+(\d+\.\d)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/g;
  let m;
  while ((m = re.exec(block[1]))) {
    const cabins = Number(m[4]);
    const fare = money(m[5]);
    const fees = money(m[7]);
    const each = money(m[8]);
    const guests = cabins * 2;
    rows.push({
      roomType: `${m[1].trim()} (${m[3]})`,
      occupancy: 'Double',
      cabins,
      guests,
      perGuestCents: toCents(fare),
      taxesCents: toCents(fees),
      // The row's total is everybody in it, to match the other readers, so the
      // printed per guest figure is multiplied out.
      totalCents: toCents(each) * guests,
      // The fare and the fees really do make the printed total for one guest.
      reconciles: Math.abs(toCents(fare) + toCents(fees) - toCents(each)) <= 1,
    });
  }
  return rows;
}

/** "1,750.00FIRST DEPOSIT due on 11/15/2026": the amount comes first, unspaced. */
function paymentRows(t) {
  const block = t.match(/Payment Schedule\s+(.*?)\s+Please note/);
  if (!block) return [];
  const rows = [];
  const re = /([\d,]+\.\d{2})\s*([A-Z][A-Z ]*?)\s+due on\s+(\d{1,2}\/\d{1,2}\/\d{4})/g;
  let m;
  while ((m = re.exec(block[1]))) {
    rows.push({ what: titleCase(m[2]), due: parseDate(m[3]), amount: money(m[1]) });
  }
  return rows;
}

/** The ports of call, in order, with their dates. */
function itinerary(t) {
  const block = t.match(/Port of Call\s+(.*)$/);
  if (!block) return [];
  const calls = [];
  const re = /([A-Z][A-Z'\-]*(?: [A-Z][A-Z'\-]*)*)\s+(\d{2}\/\d{2}\/\d{4})/g;
  let m;
  while ((m = re.exec(block[1]))) calls.push({ port: m[1], date: parseDate(m[2]) });
  return calls;
}

function parse(t) {
  const head = t.match(new RegExp(
    'AGENCY ==>\\s*\\d+\\s+(.+?)\\s+FS GROUP ==>\\s*([A-Z]?\\d{5,})\\s+([A-Z]{3})\\s+Ship:\\s*Sail Date:'
    + `\\s*FS Group Name:\\s*Sales Manager:\\s*Currency:\\s*${DATE_SOURCE}`, 'i'));
  const groupCode = head ? head[2] : '';
  const sail = head ? parseDate(head[4]) : '';

  // Everything between the agency's address and the group number, in the order
  // the page draws it: ship, then the group's name, then the cruise line's sales
  // manager and their phone number. Cut from the ends inward, because the
  // manager is two capitalised words and a ten digit number, and the ship is one
  // of a known fleet; what is left in the middle is the name of the group.
  let ship = '';
  let name = '';
  let manager = '';
  let phone = '';
  if (head) {
    let mid = head[1];
    const tel = mid.match(/\s(\d{10})\s*$/);
    if (tel) { phone = tel[1]; mid = mid.slice(0, tel.index).trim(); }
    const named = mid.match(new RegExp(FLEET)) || mid.match(/Norwegian [A-Z][a-z]+/);
    if (named) {
      ship = named[0];
      const rest = mid.slice(mid.indexOf(ship) + ship.length).trim();
      const who = rest.match(/([A-Z][A-Z'.-]+ [A-Z][A-Z'.-]+)$/);
      manager = who ? who[1] : '';
      name = who ? rest.slice(0, rest.length - manager.length).trim() : rest;
    }
  }

  const calls = itinerary(t);
  const depart = sail || (calls[0] ? calls[0].date : '');
  const back = calls.length > 1 ? calls[calls.length - 1].date : '';
  const nights = nightsBetween(depart, back);
  const between = [...new Set(calls.slice(1, -1).map((c) => c.port).filter((p) => p !== 'AT SEA'))];
  const destination = nights && between.length
    ? `${nights}-Night ${sayList(between.map(titleCase))}` : '';

  const grades = cabinRows(t);
  const payments = paymentRows(t);
  const cabins = grades.reduce((n, g) => n + g.cabins, 0);

  const warnings = [];
  const rowsTotal = grades.reduce((n, g) => n + g.totalCents, 0);
  const paidTotal = payments.reduce((n, p) => n + toCents(p.amount), 0);
  // Whether the payments account for the whole table at two guests a cabin. When
  // they do, the number of guests is confirmed by the money and not merely
  // assumed from a sentence about occupancy.
  const confirmed = grades.length > 0 && payments.length > 0 && Math.abs(rowsTotal - paidTotal) <= 100;
  if (grades.length && payments.length && !confirmed) {
    warnings.push(`The payments in this contract add up to ${dollars(paidTotal)} but the cabin rates come `
      + `to ${dollars(rowsTotal)}. The contract says the final payment can vary with the bookings at `
      + 'finalisation, but check it against the paperwork.');
  }

  const lines = [];
  const booked = t.match(new RegExp(`Booking Date:\\s*${DATE_SOURCE}`, 'i'));
  const issued = t.match(new RegExp(`${DATE_SOURCE}\\s*Issue Date:`, 'i'));
  if (booked || issued) {
    lines.push(`Booked ${booked ? parseDate(booked[1]) : '?'}${issued ? `, issued ${parseDate(issued[1])}` : ''}.`);
  }
  if (manager) lines.push(`Sales manager: ${titleCase(manager)}${phone ? `, ${phone}` : ''}.`);
  if (payments.length) {
    lines.push('', 'Payment terms:');
    for (const p of payments) lines.push(`  ${p.what}: ${dollars(toCents(p.amount))} due ${p.due}`);
  }
  const amenity = t.match(/Amenity Value\s+([A-Z]{3}\d+)/);
  const ratio = t.match(/TC Ratio:\s*(\d+:\d+)/);
  if (amenity || ratio) {
    lines.push('');
    if (amenity) lines.push(`Amenity: ${amenity[1]}.`);
    if (ratio) lines.push(`Tour conductor ratio ${ratio[1]}.`);
  }

  return {
    fields: {
      name,
      vendor: 'Norwegian Cruise Line',
      productName: ship,
      destination,
      departDate: depart,
      returnDate: back,
      // The contract asks for deposits by date but names no date on which unsold
      // cabins are released, so there is nothing here to call an option date.
      optionDate: '',
      cabinsHeld: cabins,
      groupCode,
      proposalId: '',
      sailingId: '',
      vendorContact: manager ? titleCase(manager) : '',
      departurePort: calls[0] ? titleCase(calls[0].port) : '',
      // The contract prices everybody as a double. Filled in only when the
      // payments add up to exactly that many guests; otherwise left for a person,
      // because the number is an inference and not something the page says.
      passengers: confirmed ? cabins * 2 : 0,
      proposalExpires: '',
    },
    rates: grades.map((g, i) => ({ ...g, sortOrder: i })),
    notes: lines.join('\n'),
    payments,
    warnings,
  };
}

export const ncl = {
  id: 'ncl-fs',
  name: 'Norwegian Cruise Line group agreement',
  // A contract has no proposal number and no date after which a proposal lapses.
  // It does have a group number, and it names no option date, which is worth
  // telling somebody, so that one stays on the list of what was not found.
  never: ['proposalId', 'proposalExpires'],
  matches,
  parse,
};
