// Reading a vendor confirmation instead of retyping it.
//
// Booking a cruise produces a confirmation email with every fact the portal
// wants: the number, the ship, the dates, the cabin, the guests, the money.
// The advisor then types all of it in again from the other window. That
// retyping is the friction that decides whether a CRM gets used at all, and
// it is the one thing every advisor does after every booking.
//
// Deliberately a reader, not an importer. It fills a form and stops. Vendor
// confirmations have no standard shape, so this will misread some of them,
// and a parser that writes a reservation straight to the database on a guess
// is worse than typing: a wrong sail date somebody corrected is a nuisance, a
// wrong sail date nobody saw is a missed holiday.
//
// So every field comes back with the line it was read from, and the page
// shows both. The advisor is confirming what was read, not trusting it.

import { clean, toCents, json, badRequest, readJson } from './util.js';
import { requireUser } from './auth.js';
import { personName, splitVendor, anyDate } from './importer.js';
import { normKey } from './catalog.js';
import { verdict } from './autoimport.js';
import { looksLikeHeading } from './namecheck.js';

// Longest first: "grand total" must win before "total" sees the same line.
const LABELS = {
  confirmationNumber: ['booking id', 'confirmation number', 'reservation number', 'booking number',
    'booking reference', 'booking id', 'reservation id', 'confirmation code',
    'confirmation', 'conf #', 'conf no', 'res #', 'booking', 'reservation'],
  supplier: ['cruise line', 'travel supplier', 'supplier', 'vendor', 'carrier', 'operator'],
  productName: ['ship name', 'ship', 'vessel', 'resort', 'hotel', 'tour name', 'package'],
  departDate: ['embarkation date', 'embarkation', 'sailing date', 'sail date',
    'departure date', 'depart date', 'start date', 'check-in date', 'check in date',
    'departs', 'departure'],
  returnDate: ['disembarkation date', 'disembarkation', 'debarkation date', 'debarkation',
    'return date', 'end date', 'check-out date', 'check out date', 'returns'],
  destination: ['destination', 'itinerary', 'region', 'sailing'],
  cabin: ['stateroom number', 'cabin number', 'room number', 'stateroom(s)', 'stateroom',
    'cabin', 'room'],
  cabinCategory: ['stateroom category', 'cabin category', 'room type', 'category', 'grade'],
  gross: ['total booking amount', 'total stateroom amount', 'grand total', 'total price',
    'total cost', 'total amount', 'trip total', 'total due', 'total'],
  deposit: ['deposit amount', 'initial payment', 'deposit paid', 'deposit'],
  finalPaymentDue: ['final payment due date', 'final payment due', 'final payment date',
    'balance due date', 'final payment', 'balance due'],
  // The two an agent confirmation carries that this did not read. Commission
  // is the point of the document from the agency's side, and the client's name
  // is what the reservation gets filed under.
  // What the client has already paid, and the day the booking was made, which is when a deposit usually was.
  paid: ['total payments received', 'payments received', 'payments made', 'total payments', 'amount paid',
    'total paid', 'paid to date'],
  bookingDate: ['booking date', 'date booked'],
  commission: ['fare commission', 'agent commission', 'travel agent commission',
    'commission amount', 'commission due', 'commission earned', 'total commission',
    'commission'],
  // Paid on top of the fare commission and separately from it, which is the
  // package half of the split the reservation already holds.
  commissionPackage: ['enhancement commission', 'package commission', 'bonus commission'],
  clientName: ['guest name', 'passenger name', 'lead guest', 'lead passenger',
    'primary guest', 'guest 1', 'passenger 1', 'client name', 'booked for'],
};

const MONEY = /-?\$?\s*[\d,]+(?:\.\d{2})?/;

/**
 * Finds "Label: value" at the start of a line.
 *
 * Anchored to the line start on purpose. A label found mid-sentence is
 * usually prose about the label rather than the value, and "your total is due
 * on the date shown below" is not a total.
 */
function pick(lines, aliases, accept) {
  for (const alias of aliases) {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (!lower.startsWith(alias)) continue;

      const rest = line.slice(alias.length);
      // Something has to separate the label from the value, or "Categories of
      // cabin" reads as the category "of cabin".
      const m = rest.match(/^\s*[:\-–—]\s*(.+)$/) || rest.match(/^\s{2,}(.+)$/) || rest.match(/^\t+(.+)$/);
      if (!m) continue;
      const value = m[1].trim();
      if (value && (!accept || accept(value))) return { value, line };
    }
  }
  return null;
}

/**
 * "COLE/DEBORAH" becomes "Deborah Cole".
 *
 * Cruise lines write names in capitals. A client record that keeps them ends
 * up greeting somebody as "Hello DEBORAH COLE" in every email they get.
 *
 * Only applied to input that is entirely upper case, so a name already cased
 * properly is never touched. It gets McDonald wrong, and O'Brien and
 * Smith-Jones right. That is a visible error in a form the advisor is about to
 * read, which is a better place for it than in a client's inbox.
 */
function fixCaps(name) {
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'\-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Guest and passenger lines, in the order the confirmation lists them. */
function guests(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(?:guest|passenger|traveler|traveller)\s*#?\s*\d*\s*[:\-]\s*(.+)$/i);
    if (!m) continue;
    // "SMITH/JOHN" is how a cruise line writes a name and not how a person does.
    const name = fixCaps(personName(m[1].replace(/\//g, ', ').replace(/\s+/g, ' ').trim()));
    if (name && !out.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      out.push({ name, line });
    }
  }
  return out;
}

const money = (v) => {
  const m = String(v).match(MONEY);
  return m ? toCents(m[0].replace(/[$,\s]/g, '')) : 0;
};

/**
 * What could be read, and what it was read from.
 *
 * Returns fields and provenance side by side. Nothing is filled in that was
 * not on the page: a confirmation with no return date comes back with no
 * return date, rather than one worked out from a sailing length nobody stated.
 */
// Labels that only ever appear as the right hand column, so they are worth
// splitting on even though nothing is read from them. Without these the left
// column's value runs on and swallows them.
const COLUMN_LABELS = [
  'remaining due', 'remaining balance due', 'payments made', 'booking date',
  'status', 'advisor id', 'advisor email', 'advisor phone', 'total guests',
  'departure port', 'fare commission rate', 'enhancement commission rate',
  'gross amount of reservation', 'discounts applied', 'insurance amount',
  'travel advisor name', 'agency', 'stateroom subtotal',
  'discounts applied', 'remaining balance due', 'final payment due date',
];

/**
 * Two columns on a page are one line in its text.
 *
 * A real agent confirmation lays its facts out side by side, so what comes out
 * reads "Departure Date: Nov 30, 2026 Return Date: Dec 05, 2026" and
 * "Ship: Margaritaville at Sea Islander Stateroom(s): 5235". Labels are only
 * matched at the start of a line, so the left column swallowed the right and
 * the right was never seen: of thirteen fields on a real confirmation, two
 * were found.
 *
 * Split before a label, and only before a label this file actually knows.
 * Guessing at the shape of one instead cut "Margaritaville at Sea Islander"
 * in half, because a ship's name looks exactly like a run of capitalised words
 * in front of a colon.
 */
const ALL_LABELS = [...new Set([...Object.values(LABELS).flat(), ...COLUMN_LABELS])]
  .sort((a, b) => b.length - a.length);

/**
 * A few labels that are printed with no colon after them, "Booking Status Booked" and "Stateroom Obstructed View Percentage 0%". The
 * line is cut before them, so the value in front of them does not run on and take them in: the ship was read as
 * "OASIS OF THE SEAS Booking Status Booked".
 */
function splitNoColon(line) {
  return String(line).split(/\s+(?=booking status\b|stateroom obstructed view percentage\b)/i).filter((p) => p.trim());
}

/**
 * Break a line where the next column's label begins.
 *
 * Worked colon by colon, taking the longest label that ends at each one. The
 * first attempt matched any known label anywhere and split "Enhancement
 * Commission: $107.70" into "Enhancement" and "Commission: $107.70", because
 * "commission" is itself a label and it is a suffix of the real one. Longest
 * wins, so the whole label survives.
 */
function splitColumns(line) {
  const text = line.trim();
  const lower = text.toLowerCase();
  const cuts = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ':') continue;
    const before = lower.slice(0, i).replace(/\s+$/, '');
    const label = ALL_LABELS.find((a) => before.endsWith(a)
      // Preceded by a space or the start of the line, so "ship" does not match
      // inside "flagship".
      && (before.length === a.length || /\s/.test(before[before.length - a.length - 1])));
    if (!label) continue;
    const at = before.length - label.length;
    if (at > 0) cuts.push(at);
  }

  if (!cuts.length) return [text];

  const out = [];
  let from = 0;
  for (const cut of cuts) {
    const piece = text.slice(from, cut).trim();
    if (piece) out.push(piece);
    from = cut;
  }
  const tail = text.slice(from).trim();
  if (tail) out.push(tail);
  return out;
}

// ---------------------------------------------------------------------------
// The price, line by line
// ---------------------------------------------------------------------------

const MONEY_TOKEN = /-?\$?\s*\d[\d,]*\.\d{2}\b/g;

const cents = (token) => toCents(String(token).replace(/[$,\s]/g, ''));

/**
 * A row that is a label and then only money: "Cabin Fare $1,768.00 $1,768.00".
 *
 * An agent copy prices each guest in a column, so one line carries a figure per
 * guest and the line's amount is their sum. Only a line that is nothing but the
 * label and money counts: "Fare Commission Rate: 15%" starts with "fare" and is
 * not a fare, and a label with prose after it is not a row of figures.
 *
 * With `all`, every matching line is added up, which is how a trip with two
 * staterooms is priced. Without it the first is the answer, which is how a
 * summary line such as "Insurance Amount" is read.
 */
function moneyRow(lines, aliases, { all = false } = {}) {
  for (const alias of aliases) {
    let total = 0;
    let first = null;
    let hits = 0;
    const values = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.toLowerCase().startsWith(alias)) continue;
      const rest = line.slice(alias.length);
      // The label ends where it ends: "faresheet" is not "fare".
      if (/^[a-z]/i.test(rest)) continue;
      const body = rest.replace(/^\s*[:\-–—]?\s*/, '');
      const tokens = body.match(MONEY_TOKEN);
      if (!tokens || body.replace(MONEY_TOKEN, '').replace(/[\s$]/g, '')) continue;
      total += tokens.reduce((n, t) => n + cents(t), 0);
      tokens.forEach((t) => values.push(cents(t)));
      hits += 1;
      if (!first) first = line;
      if (!all) break;
    }
    // `values` is every figure in the order printed: a column per guest, and one more
    // run of columns for each further stateroom.
    if (hits) return { cents: total, line: first, hits, values };
  }
  return null;
}

/** Everything after a label on every line that starts with it, joined in order. */
function afterLabel(lines, aliases) {
  const parts = [];
  for (const raw of lines) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    const alias = aliases.find((a) => lower.startsWith(a) && !/^[a-z]/i.test(line.slice(a.length)));
    if (!alias) continue;
    const rest = line.slice(alias.length).replace(/^\s*[:\-–—]?\s*/, '').trim();
    if (rest) parts.push(rest);
  }
  return parts.join(' ');
}

const fixed = (c) => (c / 100).toFixed(2);

/** A total cut into n parts that add back up to it, the odd cent going to the first. */
function spread(total, n) {
  const each = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? total - each * (n - 1) : each));
}

/** A total shared in proportion to weights, adding back up to it exactly. */
function shareBy(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return spread(total, weights.length);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[0] += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

/**
 * The people the price columns belong to.
 *
 * An agent copy has a header of first names and one of last names, each a run of words
 * in guest order, and a date of birth beside each. Those only separate cleanly when there
 * is one word per guest, which is the ordinary case; a two word first name or last name
 * makes the counts disagree and the names are left for a person to fill in, rather than
 * guessed at and filed against the wrong traveller.
 */
function guestsFromColumns(lines, n, listed) {
  const first = afterLabel(lines, ['first name', 'first names', 'given name']).split(/\s+/).filter(Boolean);
  const last = afterLabel(lines, ['last name', 'last names', 'surname']).split(/\s+/).filter(Boolean);
  const born = [...afterLabel(lines, ['date of birth, age', 'date of birth', 'dob'])
    .matchAll(/([A-Za-z]{3,9}\.? \d{1,2},? \d{4})/g)].map((m) => anyDate(m[1]) || null);

  let names = null;
  if (first.length === n && last.length === n) {
    names = first.map((f, i) => `${fixCaps(f)} ${fixCaps(last[i])}`.trim());
  } else if (listed.length === n) {
    names = listed.map((g) => g.name);
  }
  return Array.from({ length: n }, (_, i) => ({
    name: names ? names[i] : '',
    dob: born.length === n ? born[i] : null,
  }));
}
const said = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What the client was charged, split into the parts the Pricing grid holds.
 *
 * A confirmation prints a fare, a discount, taxes and fees, sometimes insurance and
 * gratuities, and a total. The total alone was all that came across, which left the
 * Pricing tab empty and the trip looking like one lump with a commission on it. Here
 * each part is read where it is printed, and the sum is checked against the total
 * the document itself states: a trip that does not add up is shown as not adding up,
 * and is never saved as though it did.
 *
 * Fare is taken after the discount. A vendor pays commission on the fare the client
 * actually paid, so fifteen per cent of the discounted fare is the figure printed
 * as the commission, and putting the undiscounted fare in the grid would make a
 * correct commission look like half of what was expected.
 *
 * Taxes and fees are the government taxes plus the cruise's own required fees. A
 * label that wraps over two lines can lose its figures, so when the document states a
 * gross amount, whatever is left once fare and insurance are taken out of it is
 * counted as fees rather than dropped, and the page says so.
 */
function readPricing(lines, fields, listed) {
  const fare = moneyRow(lines, ['cabin fare', 'cruise fare', 'stateroom fare', 'base fare', 'fare'], { all: true });
  if (!fare) return null;

  // Per guest rows first: a discount printed for each guest is that guest's, and the
  // summary total beneath is only the same money added up.
  const discount = moneyRow(lines, ['discount(s)', 'discounts', 'discount'], { all: true })
    || moneyRow(lines, ['discounts applied', 'total discounts']);
  const govt = moneyRow(lines, ['govt. taxes & fees', 'govt taxes & fees', 'government taxes & fees',
    'government taxes and fees', 'taxes, fees & port expenses', 'taxes, fees and port expenses',
    'taxes & fees', 'taxes and fees', 'port charges and taxes', 'port charges', 'port fees', 'taxes'], { all: true });
  // The label wraps over two lines on some documents, with the figures on either one.
  const required = moneyRow(lines, ['required cruise fees & expenses', 'required cruise fees &',
    'required cruise fees', 'cruise fees & expenses', 'port expenses', 'cruise fees'], { all: true })
    || moneyRow(lines.filter((l, i) => /^required cruise fees/i.test((lines[i - 1] || '').trim())), ['expenses'], { all: true });
  const insurance = moneyRow(lines, ['insurance amount', 'travel insurance', 'insurance premium', 'insurance']);
  const gratuities = moneyRow(lines, ['prepaid gratuities', 'gratuities', 'service charges']);
  const gross = moneyRow(lines, ['gross amount of reservation']);

  const notes = [];
  const off = discount && discount.cents <= fare.cents ? discount.cents : 0;
  const netFare = fare.cents - off;
  let taxes = (govt ? govt.cents : 0) + (required ? required.cents : 0);
  const insured = insurance ? insurance.cents : 0;
  const tips = gratuities ? gratuities.cents : 0;

  if (off) notes.push(`Fare is the cabin fare ${said(fare.cents)} less discounts ${said(off)}.`);
  if (gross) {
    const gap = gross.cents - fare.cents - insured - tips - taxes;
    if (gap > 0) {
      taxes += gap;
      notes.push(`${said(gap)} of the gross amount had no label I could read, so it is counted as taxes and fees.`);
    }
  }

  // ---- Each guest's own column ------------------------------------------------------
  const n = fare.values.length > 1 ? fare.values.length : (listed.length > 1 ? listed.length : 1);
  const columnOf = (row, total) => (row && row.values.length === n ? row.values
    : spread(total, n));
  const perGuest = n > 1 ? (() => {
    const fares = columnOf(fare, fare.cents);
    const offs = off ? columnOf(discount, off) : new Array(n).fill(0);
    const govts = govt ? columnOf(govt, govt.cents) : new Array(n).fill(0);
    const reqs = required ? columnOf(required, required.cents) : new Array(n).fill(0);
    // Fees that had no readable label are spread evenly: nothing says whose they are.
    const owed = taxes - (govt ? govt.cents : 0) - (required ? required.cents : 0);
    const gap = spread(Math.max(owed, 0), n);
    const cover = spread(insured, n);
    const tipCols = gratuities ? columnOf(gratuities, tips) : new Array(n).fill(0);
    const people = guestsFromColumns(lines, n, listed);
    const netFares = fares.map((f, i) => f - offs[i]);
    const comm = fields.commission ? shareBy(toCents(fields.commission), netFares) : new Array(n).fill(0);
    const pack = fields.commissionPackage ? shareBy(toCents(fields.commissionPackage), netFares) : new Array(n).fill(0);
    return people.map((who, i) => ({
      name: who.name, dob: who.dob,
      fare: fixed(netFares[i]), taxes: fixed(govts[i] + reqs[i] + gap[i]),
      insurance: fixed(cover[i]), gratuities: fixed(tipCols[i]),
      commission: fixed(comm[i]), commissionPackage: fixed(pack[i]),
    }));
  })() : null;
  if (perGuest && insured) notes.push('Insurance is not printed per guest, so it is shared equally between them.');
  if (perGuest && perGuest.some((g) => !g.name)) notes.push('The guest names could not be told apart, so type each one in.');

  const out = [];
  if (netFare > 0) out.push({ kind: 'fare', label: 'Fare', amount: fixed(netFare), from: fare.line });
  if (taxes > 0) {
    out.push({ kind: 'taxes', label: 'Taxes and port fees', amount: fixed(taxes),
      from: [govt && govt.line, required && required.line].filter(Boolean).join(' | ') || 'the rest of the gross amount' });
  }
  if (insured > 0) out.push({ kind: 'insurance', label: 'Travel insurance', amount: fixed(insured), from: insurance.line });
  if (tips > 0) out.push({ kind: 'gratuities', label: 'Gratuities', amount: fixed(tips), from: gratuities.line });

  const sum = netFare + taxes + insured + tips;
  const stated = fields.gross ? toCents(fields.gross) : null;
  const rate = pick(lines, ['fare commission rate', 'commission rate']);
  const pct = rate ? Number(String(rate.value).replace(/[^0-9.]/g, '')) : NaN;

  return {
    lines: out,
    // One entry per traveller when the document prices each guest, else null and the
    // price stays a single column for the trip.
    guests: perGuest,
    totalCents: sum,
    statedCents: stated,
    // Only a trip whose lines add up to the total the document gives is offered as
    // priced. One that does not is shown with the gap, for somebody to settle.
    balanced: stated !== null && Math.abs(sum - stated) <= 1,
    differenceCents: stated === null ? null : stated - sum,
    ratePct: Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : null,
    notes,
  };
}

/**
 * A label on one line and its value on the next, put back together.
 *
 * Some confirmations lay a block out as a column of labels with the values beneath
 * them, so the text comes out as "RESERVATION:" and then "65387883" on a line of its
 * own. Labels are only read with their value in front of them, so the whole block was
 * invisible. A line that is nothing but a label with a colon, followed by one that is
 * not itself a label, is one line.
 */
function stackLabels(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const here = lines[i].trim();
    const next = (lines[i + 1] || '').trim();
    if (/^[A-Za-z][A-Za-z /#&.()-]{1,40}:$/.test(here) && next && !/:$/.test(next)
        && !/^[A-Za-z][A-Za-z /#&.()-]{1,40}:\s/.test(next)) {
      out.push(`${here} ${next}`);
      i += 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Norwegian, which prints the price a different way
// ---------------------------------------------------------------------------

const NCL_DATE = /\b(\d{1,2}-[A-Za-z]{3}-\d{4})\b/;

/** Surname first, as Norwegian prints a guest: "MITCHENER LORA CHRISTINE" is Lora Christine Mitchener. */
function nclName(raw) {
  const words = raw.trim().split(/\s+/);
  if (words.length < 2) return fixCaps(raw.trim());
  return fixCaps(`${words.slice(1).join(' ')} ${words[0]}`);
}

/** The guests, one numbered line each with a protection yes or no at the end. */
function nclGuests(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^(\d{1,2})\s+([A-Z][A-Z'.-]+(?:\s+[A-Z][A-Z'.-]*)+?)\s+(?:YES|NO)\b/.exec(line);
    if (!m) continue;
    const name = nclName(m[2]);
    if (name && !out.some((g) => g.name === name)) out.push({ name, line });
  }
  return out;
}

/** A row of money after a label, each figure as cents, a minus sign kept. */
function nclRow(lines, re) {
  for (const raw of lines) {
    const line = raw.trim();
    const m = re.exec(line);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    const tokens = rest.match(/-?\$?\s*\d[\d,]*\.\d{2}\b/g);
    if (!tokens || rest.replace(/-?\$?\s*\d[\d,]*\.\d{2}\b/g, '').replace(/[\s$]/g, '')) continue;
    // Not toCents, which refuses a minus sign: savings are printed as negatives.
    return { line, values: tokens.map((x) => Math.round(Number(x.replace(/[$,\s]/g, '')) * 100)) };
  }
  return null;
}

/** The figures of a Norwegian row: a total and then one column per guest. */
function nclColumns(row, n) {
  if (!row) return null;
  const v = row.values;
  if (v.length === n + 1 && v.slice(1).reduce((a, b) => a + b, 0) === v[0]) return v.slice(1);
  if (v.length === n) return v;
  if (v.length === 1) return spread(v[0], n);
  return null;
}

/**
 * Norwegian's "booking components per guest" table, as the same pricing the other readers return.
 *
 * Each row carries the trip's figure and then one for each guest: Guest Fare, Taxes/Fees/Port
 * Exp, Savings, and a charge for each package such as drinks or dining. Savings are taken off
 * the fare, which is what the commission is paid on, and the package charges are counted as
 * gratuities because they are the service charge on something prepaid. The guest copy shows
 * no commission, so none is invented.
 */
function readNclPricing(lines, fields, listed) {
  const gross = nclRow(lines, /^gross total\s+/i);
  const fareRow = nclRow(lines, /^guest fare\s+/i);
  if (!gross || !fareRow) return null;

  const n = Math.max(1, listed.length || fareRow.values.length - 1);
  const fare = nclColumns(fareRow, n);
  const taxRow = nclRow(lines, /^taxes\/fees(?:\/port exp(?:enses)?)?\s+/i);
  const taxes = taxRow ? nclColumns(taxRow, n) : null;
  const saveRow = nclRow(lines, /^(?:savings|discounts?)\s+/i);
  const savings = saveRow ? nclColumns(saveRow, n) : null;
  if (!fare) return null;

  const services = lines.map((l) => nclRow([l], /^(?:[A-Za-z' &.-]+?)\s+(?:service|srv)\s+charge\s+/i))
    .filter(Boolean).map((r) => nclColumns(r, n)).filter(Boolean);

  const zero = new Array(n).fill(0);
  const off = savings ? savings.map((x) => Math.abs(x)) : zero;
  const netFare = fare.map((f, i) => f - off[i]);
  const tax = taxes || zero;
  const tips = services.reduce((acc, col) => acc.map((x, i) => x + col[i]), zero);

  const people = listed.length === n ? listed.map((g) => ({ name: g.name, dob: null }))
    : Array.from({ length: n }, () => ({ name: '', dob: null }));
  const perGuest = n > 1 ? people.map((who, i) => ({
    name: who.name, dob: who.dob,
    fare: fixed(netFare[i]), taxes: fixed(tax[i]), insurance: '0.00', gratuities: fixed(tips[i]),
    commission: '0.00', commissionPackage: '0.00',
  })) : null;

  const sum = (col) => col.reduce((a, b) => a + b, 0);
  const out = [];
  if (sum(netFare) > 0) out.push({ kind: 'fare', label: 'Fare', amount: fixed(sum(netFare)), from: fareRow.line });
  if (sum(tax) > 0) out.push({ kind: 'taxes', label: 'Taxes and port fees', amount: fixed(sum(tax)), from: taxRow.line });
  if (sum(tips) > 0) out.push({ kind: 'gratuities', label: 'Gratuities', amount: fixed(sum(tips)), from: 'the service charges' });

  const total = sum(netFare) + sum(tax) + sum(tips);
  const stated = gross.values[0];
  const notes = [];
  if (off.some(Boolean)) notes.push(`Fare is the guest fare ${said(sum(fare))} less savings ${said(sum(off))}.`);
  if (tips.some(Boolean)) notes.push('Dining and drinks service charges are shown as gratuities.');
  if (lines.some((l) => /^shore excursion/i.test(l.trim()))) {
    notes.push('Shore excursions are printed separately and are not part of this price.');
  }
  notes.push('The guest copy shows no commission, so none is filled in.');
  if (perGuest && perGuest.some((g) => !g.name)) notes.push('The guest names could not be told apart, so type each one in.');

  return {
    lines: out,
    guests: perGuest,
    totalCents: total,
    statedCents: stated,
    balanced: Math.abs(total - stated) <= 1,
    differenceCents: stated - total,
    ratePct: null,
    notes,
  };
}

/** Everything Norwegian prints in its own way, applied over what the general reader found. */
function readNcl(lines, fields, from) {
  const set = (key, value, line) => {
    if (value === null || value === undefined || value === '' || fields[key] !== undefined) return;
    fields[key] = value;
    from[key] = String(line).trim().slice(0, 160);
  };

  // "SAILING: 25-Oct-2026 to 1-Nov-2026": the dates, which no other line carries on its own.
  for (const raw of lines) {
    const m = /^(?:sailing|vacation)\s*:\s*(\d{1,2}-[A-Za-z]{3}-\d{4})\s*(?:to|-|–)\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(raw.trim());
    if (!m) continue;
    set('departDate', anyDate(m[1]), raw);
    set('returnDate', anyDate(m[2]), raw);
    break;
  }

  // "BF / 9806": the category code and then the cabin.
  const cab = /^([A-Za-z0-9]{1,5})\s*\/\s*(\d{3,5}[A-Za-z]?)$/.exec(String(fields.cabin || '').trim());
  if (cab) {
    const was = from.cabin;
    fields.cabin = cab[2];
    if (!fields.cabinCategory) { fields.cabinCategory = cab[1]; from.cabinCategory = was; }
  }

  // The payment schedule: only the dates are printed, not the amounts.
  for (const raw of lines) {
    const line = raw.trim();
    const dep = /^first deposit due on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(line);
    if (dep) set('depositDue', anyDate(dep[1]), line);
    const fin = /^final payment due on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(line);
    if (fin) set('finalPaymentDue', anyDate(fin[1]), line);
  }

  const gross = nclRow(lines, /^gross total\s+/i);
  if (gross) set('gross', fixed(gross.values[0]), gross.line);

  if (!fields.supplier && /^norwegian\b|\bncl\b/i.test(`${fields.productName || ''} ${lines.join(' ')}`)) {
    fields.supplier = 'Norwegian Cruise Line';
    from.supplier = fields.productName ? `the ship, ${fields.productName}` : 'Norwegian';
  }
}

// ---------------------------------------------------------------------------
// Royal Caribbean and Celebrity: "Booking Confirmation - Agent Copy"
// ---------------------------------------------------------------------------

const RC_MONEY = /-?\$?\s*\d[\d,]*\.\d{2}\b/g;
const cleanMoney = (x) => Math.round(Number(x.replace(/[$,\s]/g, '')) * 100);

/** A charges row: a label, a figure for each guest and the total, and a commission rate after. */
function rcRow(lines, re) {
  for (const raw of lines) {
    const line = raw.trim();
    const m = re.exec(line);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    const tokens = rest.match(RC_MONEY);
    if (!tokens) continue;
    const left = rest.replace(RC_MONEY, '').replace(/\d{1,3}%/g, '').replace(/[\s$]/g, '');
    if (left) continue;
    return { line, values: tokens.map(cleanMoney) };
  }
  return null;
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Whether a document is one of this family's agent copies. */
function isRoyalFamily(text) {
  const title = /booking confirmation\s*[-\u2013\u2014]?\s*agent copy/i.test(text);
  // This family's own grids: the two headings and the row of guest names. A copy with the title cut off, an offer, or one with the
  // commission left off still has these, and an advisor whose copy lacks one phrase should not get a reader that finds nothing.
  const grids = /general information/i.test(text) && /guest information/i.test(text)
    && /(?:reservation|booking) id/i.test(text) && /^\s*guest name\b/im.test(text);
  return grids || (title && /total comm\/admin/i.test(text));
}

/**
 * The people: a row of first names and a row of surnames, one word each, a column a guest.
 *
 * `n` is how many guests the price columns say there are; when the charges could not be read it is 0, and the names are
 * taken as they stand, since a guest list is worth having whether or not the money could be read.
 */
function rcGuests(lines, n) {
  const at = lines.findIndex((l) => /^guest name\b/i.test(l.trim()));
  if (at < 0) return [];
  const first = lines[at].trim().replace(/^guest name\s*/i, '').split(/\s+/).filter(Boolean);
  let next = at + 1;
  while (next < lines.length && !lines[next].trim()) next += 1;
  const last = (lines[next] || '').trim().split(/\s+/).filter(Boolean);
  if (!first.length || first.length > 12 || last.length !== first.length) return [];
  if (n > 0 && first.length !== n) return [];
  // A row of surnames is words and nothing else: a figure or a label there means the next line is not the surnames.
  if (last.some((w) => /\d/.test(w) || /^(?:crown|age|dining|departure|special)$/i.test(w))) return [];
  return first.map((f, i) => ({ name: fixCaps(`${f} ${last[i]}`), line: lines[at].trim() }));
}

/**
 * The charges table, as the pricing the other readers return.
 *
 * One column a guest and a total, and every promotion on a line of its own with a figure under
 * only the guest it applies to. Which guest that is is not on the line, so it is worked out from
 * what is: each guest's gross charges less their fare and taxes is what promotions took off
 * them. The commission is printed as a figure for each guest, and is read as printed rather than
 * worked out from a rate, because a promotion can move it. Commission is paid on the fare after
 * promotions, and the non-commissionable fare is part of the price like any other.
 */
function readRoyalPricing(lines, fields, listed) {
  const fare = rcRow(lines, /^cruise fare\s+/i);
  const gross = rcRow(lines, /^gross charges\s+/i);
  if (!fare || !gross) return null;
  const n = gross.values.length - 1;
  if (n < 1) return null;

  const nonComm = rcRow(lines, /^non comm cruise fare\s+/i);
  const taxes = rcRow(lines, /^taxes, fees,? and port expenses\s+/i);
  const comm = rcRow(lines, /^comm\/admin\s+/i);
  const whole = (row) => (row && row.values.length === n + 1 ? row.values.slice(0, n) : null);
  const tx = whole(taxes) || new Array(n).fill(0);
  const gr = gross.values.slice(0, n);
  // A row with a figure for only some of the guests does not say which. The guests who pay a fare are the ones whose gross is more than their
  // taxes, so when the count of figures matches the count of those guests, that is where they go.
  const paying = gr.map((x, i) => i).filter((i) => gr[i] - tx[i] > 0.005);
  const col = (row) => {
    const full = whole(row);
    if (full) return full;
    const out = new Array(n).fill(0);
    if (row && row.values.length - 1 === paying.length) paying.forEach((guest, k) => { out[guest] = row.values[k]; });
    return out;
  };
  const f = col(fare); const nc = col(nonComm); const cm = col(comm);

  const netFare = f.map((x, i) => x + nc[i] + (gr[i] - x - nc[i] - tx[i]));
  const sum = (a) => a.reduce((s, x) => s + x, 0);

  // The promotions, for the note: any line between the fare and the taxes that is a name and negative figures.
  const promos = [];
  const from = lines.findIndex((l) => /^non comm cruise fare/i.test(l.trim()));
  const to = lines.findIndex((l) => /^taxes, fees/i.test(l.trim()));
  for (const raw of lines.slice(from + 1, to > from ? to : from + 1)) {
    const m = /^(.+?)\s+(-?\d[\d,]*\.\d{2}(?:\s+-?\d[\d,]*\.\d{2})*)(?:\s+\d{1,3}%)?\s*$/.exec(raw.trim());
    if (m) {
      const figs = m[2].match(RC_MONEY).map(cleanMoney);
      if (figs.some((x) => x < 0)) promos.push(`${m[1].replace(/\s+NRD$/i, '')} ${said(Math.abs(figs[figs.length - 1]))}`);
    }
  }

  const people = listed.length === n ? listed.map((g) => ({ name: g.name, dob: null }))
    : Array.from({ length: n }, () => ({ name: '', dob: null }));
  const perGuest = n > 1 ? people.map((who, i) => ({
    name: who.name, dob: who.dob,
    fare: fixed(netFare[i]), taxes: fixed(tx[i]), insurance: '0.00', gratuities: '0.00',
    commission: fixed(cm[i]), commissionPackage: '0.00',
  })) : null;

  const out = [];
  if (sum(netFare) > 0) out.push({ kind: 'fare', label: 'Fare', amount: fixed(sum(netFare)), from: fare.line });
  if (sum(tx) > 0) out.push({ kind: 'taxes', label: 'Taxes and port fees', amount: fixed(sum(tx)), from: taxes.line });

  const total = sum(netFare) + sum(tx);
  const stated = gross.values[n];
  const notes = [];
  if (promos.length) notes.push(`Fare is the cruise fare plus the non commissionable fare, less promotions (${promos.join(', ')}).`);
  const net = rcRow(lines, /^net balance due\s+/i);
  if (net) {
    notes.push(`The cruise line's balance, ${said(net.values[0])}, is after your commission. The trip total here is what the client pays.`);
  }
  if (perGuest && perGuest.some((g) => !g.name)) notes.push('The guest names could not be told apart, so type each one in.');

  return {
    lines: out, guests: perGuest, totalCents: total, statedCents: stated,
    balanced: Math.abs(total - stated) <= 1, differenceCents: stated - total,
    ratePct: null, notes, commissionTotalCents: sum(cm),
  };
}

/** Everything this family prints in its own way, applied over what the general reader found. */
function readRoyal(lines, text, fields, from) {
  const set = (key, value, line) => {
    if (value === null || value === undefined || value === '') return;
    fields[key] = value;
    from[key] = String(line).trim().slice(0, 160);
  };
  const pickLine = (re) => { for (const l of lines) { const m = re.exec(l.trim()); if (m) return { m, line: l }; } return null; };

  // Reservation ID, not the dining booking id that sits further down the page.
  const res = pickLine(/^reservation id\s*:\s*(\d+)/i);
  if (res) set('confirmationNumber', res.m[1], res.line);
  const grp = /\(group id\s+(\d+)\)/i.exec(text);
  if (grp) set('groupNumber', grp[1], `Group ID ${grp[1]}`);

  const ship = pickLine(/^ship\s*:\s*(.+?)(?:\s+booking status\b.*)?$/i);
  // HARMONY OF THE SEAS, in the case a ship is written: the small words stay small.
  if (ship) {
    const name = fixCaps(ship.m[1].trim()).split(/\s+/)
      .map((w, i) => (i > 0 && ['Of', 'The', 'At', 'And'].includes(w) ? w.toLowerCase() : w)).join(' ');
    set('productName', name, ship.line);
  }
  if (/celebrity/i.test(fields.productName || '')) set('supplier', 'Celebrity Cruises', fields.productName);
  else set('supplier', 'Royal Caribbean', 'Royal Caribbean agent copy');
  fields.supplier = fields.supplier || 'Royal Caribbean';

  // "4D-11688 Ocean View Balcony" is a category and a cabin. "NQ-GTY ..." has no cabin yet:
  // GTY and WLT mean the line has not assigned one.
  const room = pickLine(/^stateroom\s*:\s*([A-Z0-9]{1,4})-(\d{3,5}|GTY|WLT)\b\s*(.*)$/i);
  if (room) {
    if (/^\d/.test(room.m[2])) {
      fields.cabin = room.m[2];
      set('cabinCategory', `${room.m[1]} ${fixCaps(room.m[3].trim())}`.trim(), room.line);
      from.cabin = room.line.trim().slice(0, 160);
    } else {
      delete fields.cabin; delete from.cabin;
      set('cabinCategory', `${room.m[1]}-${room.m[2]} ${room.m[3]}`.trim(), room.line);
    }
  }

  // No return date is printed, but the length is: "7 NIGHT".
  const nights = pickLine(/^itinerary\s*:\s*(\d+)\s*night\b/i);
  if (nights && fields.departDate && !fields.returnDate) {
    set('returnDate', addDays(fields.departDate, Number(nights.m[1])),
      `${nights.line.trim()} from ${fields.departDate}`);
  }

  const dep = pickLine(/deposit of \$?\s*([\d,]+\.\d{2}) is due by\s+(\d{1,2} [A-Za-z]{3} \d{4})/i);
  if (dep) {
    set('deposit', fixed(cleanMoney(dep.m[1])), dep.line);
    set('depositDue', anyDate(dep.m[2]), dep.line);
  }
  const fin = pickLine(/final payment is due by\s+(\d{1,2} [A-Za-z]{3} \d{4})/i);
  if (fin) set('finalPaymentDue', anyDate(fin.m[1]), fin.line);

  // Said outright, so it is read rather than asked: "the minimum deposit ... is non-refundable".
  const kind = pickLine(/minimum deposit[^.]*?\b(non[-\s]?refundable|refundable)/i);
  if (kind) set('depositRefundable', /non/i.test(kind.m[1]) ? 'nonrefundable' : 'refundable', kind.line);

  const gross = rcRow(lines, /^gross charges\s+/i);
  if (gross) set('gross', fixed(gross.values[gross.values.length - 1]), gross.line);
  const comm = rcRow(lines, /^total comm\/admin\s+/i);
  if (comm) set('commission', fixed(comm.values[0]), comm.line);
  fields.productType = 'cruise'; from.productType = 'a cruise line agent copy';

  // "Booking Status Offer" is a quote and not a booking. Said, so it is not filed as booked.
  const status = pickLine(/booking status\s*:?\s*(offer|booked|confirmed|option|cancel)/i);
  if (status) set('status', /^(offer|option)/i.test(status.m[1]) ? 'quoted' : (/^cancel/i.test(status.m[1]) ? 'cancelled' : 'booked'), status.line);
}

// ---------------------------------------------------------------------------
// Carnival: the travel advisor copy of a booking confirmation email
// ---------------------------------------------------------------------------

/** Whether a document is Carnival's advisor copy. */
function isCarnival(text) {
  return /travel advisor copy/i.test(text) && /itemized charges/i.test(text);
}

/** One figure after a label, the label and the amount separated by a tab or spaces. */
function cvMoney(lines, re) {
  for (const raw of lines) {
    const line = raw.trim();
    const m = re.exec(line);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    const fig = /^\s*\$\s*([\d,]+\.\d{2})\b/.exec(rest);
    if (fig) return { line, cents: cleanMoney(fig[1]) };
  }
  return null;
}

/** "Biggs, Darbi" is Darbi Biggs. Only the lines between the guest header and the port table. */
function cvGuests(lines) {
  const start = lines.findIndex((l) => /^guest details\b/i.test(l.trim()));
  if (start < 0) return [];
  const out = [];
  for (const raw of lines.slice(start + 1)) {
    // The first cell, and without the loyalty tier that follows the name when the cells have been
    // run together by a plain text version of the email: "Biggs, Darbi GOLD".
    const line = raw.split('\t')[0].trim()
      .replace(/\s+(?:RED|BLUE|GOLD|PLATINUM|DIAMOND|SAPPHIRE|EMERALD)\b.*$/i, '');
    if (/^day\s+date\b/i.test(raw.trim())) break;
    const m = /^([A-Za-z][A-Za-z'.-]*(?: [A-Za-z'.-]+)*),\s*([A-Za-z][A-Za-z'.-]*(?: [A-Za-z'.-]+)*)$/.exec(line);
    if (m) out.push({ name: `${m[2].trim()} ${m[1].trim()}`, line });
  }
  return out;
}

/**
 * Carnival prints one set of totals for the booking and none for each guest, so the price is a single
 * column: the cruise rate and the non commissionable amount are the fare, the required fees and the
 * government taxes are the taxes, and the prepaid gratuities are their own line.
 */
function readCarnivalPricing(lines, fields) {
  const total = cvMoney(lines, /^total\s+/i);
  const rate = cvMoney(lines, /^cruise rate\s+/i);
  if (!total || !rate) return null;
  const nonComm = cvMoney(lines, /^non-?commission amount\s+/i);
  const fees = cvMoney(lines, /^required cruise fees(?: & expenses)?\s+/i);
  const taxes = cvMoney(lines, /^government taxes(?: & fees)?\s+/i);
  const tips = cvMoney(lines, /^pre-?paid gratuities\s+/i);

  const fare = rate.cents + (nonComm ? nonComm.cents : 0);
  const tax = (fees ? fees.cents : 0) + (taxes ? taxes.cents : 0);
  const gratuities = tips ? tips.cents : 0;
  const out = [];
  if (fare > 0) out.push({ kind: 'fare', label: 'Fare', amount: fixed(fare), from: rate.line });
  if (tax > 0) {
    out.push({ kind: 'taxes', label: 'Taxes and port fees', amount: fixed(tax),
      from: [fees && fees.line, taxes && taxes.line].filter(Boolean).join(' | ') });
  }
  if (gratuities > 0) out.push({ kind: 'gratuities', label: 'Gratuities', amount: fixed(gratuities), from: tips.line });

  const sum = fare + tax + gratuities;
  const notes = [];
  const net = cvMoney(lines, /^net balance due\s+/i);
  const comm = cvMoney(lines, /^total commission\s+/i);
  if (net && comm) {
    notes.push(`Carnival's net balance, ${said(net.cents)}, is after your ${said(comm.cents)} commission. The trip total here is what the client pays.`);
  }
  if (nonComm) notes.push('The non commissionable amount is counted as part of the fare.');
  notes.push('Carnival prints one price for the booking and none for each guest, so the price stays as one column.');
  return {
    lines: out, guests: null, totalCents: sum, statedCents: total.cents,
    balanced: Math.abs(sum - total.cents) <= 1, differenceCents: total.cents - sum,
    ratePct: null, notes,
  };
}

/** Everything Carnival prints in its own way, applied over what the general reader found. */
function readCarnival(lines, text, fields, from) {
  const set = (key, value, line) => {
    if (value === null || value === undefined || value === '') return;
    fields[key] = value;
    from[key] = String(line).trim().slice(0, 160);
  };
  const find = (re) => { for (const l of lines) { const m = re.exec(l.trim()); if (m) return { m, line: l }; } return null; };

  const booking = find(/booking #\s*:\s*([A-Z0-9]+)/i);
  if (booking) set('confirmationNumber', booking.m[1], booking.line);

  // "Ship / Room View" is a header, the ship is on the next line, and the sailing date and the room
  // view share the one after.
  const at = lines.findIndex((l) => /^ship\b.*\broom view\b/i.test(l.trim()));
  if (at >= 0) {
    const ship = (lines[at + 1] || '').trim();
    if (ship && !/\d/.test(ship)) set('productName', ship, ship);
    const second = /^([A-Za-z]{3}\/\d{1,2}\/\d{4})\s+(.+)$/.exec((lines[at + 2] || '').trim());
    if (second) {
      set('departDate', anyDate(second[1]), lines[at + 2]);
      set('cabinCategory', second[2].trim(), lines[at + 2]);
    }
  }
  if (/^carnival\b/i.test(fields.productName || '') || /carnival/i.test(text.slice(0, 600))) {
    set('supplier', 'Carnival Cruise Line', fields.productName || 'Carnival');
  }

  const room = find(/^room #\s*([A-Z0-9]+)\b/i);
  if (room) set('cabin', room.m[1], room.line);

  const trip = find(/booking your client on their\s+(\d+)\s*day\s+(.+?)\s+itinerary/i);
  if (trip) set('destination', `${trip.m[1]} Day ${trip.m[2]}`, trip.line);

  // The port table gives the first and last day.
  const days = lines.map((l) => /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+([A-Za-z]{3}\/\d{1,2}\/\d{4})/i.exec(l.trim()))
    .filter(Boolean);
  if (days.length >= 2) {
    set('departDate', anyDate(days[0][1]), days[0][0]);
    set('returnDate', anyDate(days[days.length - 1][1]), days[days.length - 1][0]);
  }

  const gross = cvMoney(lines, /^total\s+/i);
  if (gross) set('gross', fixed(gross.cents), gross.line);
  const comm = cvMoney(lines, /^total commission\s+/i);
  if (comm) set('commission', fixed(comm.cents), comm.line);
  const fin = find(/^final payment due date\s+([A-Za-z]{3}\/\d{1,2}\/\d{4})/i);
  if (fin) set('finalPaymentDue', anyDate(fin.m[1]), fin.line);

  const kind = find(/deposit is\s+(non[-\s]?refundable|refundable)/i);
  if (kind) set('depositRefundable', /non/i.test(kind.m[1]) ? 'nonrefundable' : 'refundable', kind.line);
  if (/booking confirmed/i.test(text)) set('status', 'booked', 'Booking Confirmed');
  fields.productType = 'cruise'; from.productType = 'a Carnival advisor copy';
}

// Words that mark a contact line as somebody else's: the agent's own, the vendor's, a hotel's.
const NOT_THE_GUEST = /^(?:travel\s+)?(?:advisor|agent|agency|consultant|supplier|vendor|hotel|resort|support|customer\s+service|reservations?|sales)\b/i;

/** The guest's own email and phone, where the confirmation prints them under a plain label. */
export function readClientContact(lines) {
  const out = {};
  const who = '(?:(?:primary|lead|main)?\\s*(?:guest|passenger|client|customer|booker|contact)\\s+)?';
  const mail = new RegExp(`^${who}e-?mail(?:\\s+address)?\\s*[:\\-]\\s*([^\\s@<>]+@[^\\s@<>]+\\.[A-Za-z]{2,})`, 'i');
  const tel = new RegExp(`^${who}(?:phone|mobile|cell|telephone|tel)(?:\\s*(?:number|no\\.?))?\\s*[:\\-]\\s*(\\+?[\\d(][\\d\\s().+-]{6,24}\\d)`, 'i');
  for (const raw of lines) {
    const line = raw.trim();
    if (NOT_THE_GUEST.test(line)) continue;
    let m = !out.email && mail.exec(line);
    if (m) out.email = m[1].toLowerCase();
    m = !out.phone && tel.exec(line);
    if (m) out.phone = m[1].trim();
  }
  return out;
}

/**
 * The cancellation schedule printed on a cruise line's confirmation: each window of days before sailing, what is
 * lost in it, and the date it begins.
 *
 * Read off the document rather than assumed, because the dates and the percentages are the line's own and differ by
 * line, by sailing length and by promotion. Windows, amounts and dates are matched in the order they are printed, and
 * a schedule whose three lists do not line up is read without its dates rather than guessed at.
 */
function readCancellationSchedule(text) {
  const t = String(text || '');
  const start = t.search(/cancellation schedule/i);
  if (start < 0) return [];
  const section = t.slice(start, start + 1600);
  const ranges = [...section.matchAll(/(\d{1,3})\s+to\s+(\d{1,3})\s+days\s+prior\s+to\s+sailing/gi)];
  if (!ranges.length) return [];
  const amounts = [...section.matchAll(/(\d+(?:\.\d+)?)\s*%\s*per\s*guest|(\d+(?:,\d{3})*\.\d{2})\s*deposit\s*amount\s*per\s*guest/gi)];
  const dates = [...section.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\b/g)]
    .map((m) => anyDate(`${m[1]} ${m[2]} ${m[3]}`)).filter(Boolean);
  const aligned = amounts.length === ranges.length;
  return ranges.map((r, i) => {
    const a = aligned ? amounts[i] : null;
    return {
      fromDays: Number(r[1]), toDays: Number(r[2]),
      pct: a && a[1] ? Number(a[1]) : null,
      perGuestCents: a && a[2] ? Math.round(Number(a[2].replace(/,/g, '')) * 100) : null,
      date: dates.length === ranges.length ? dates[i] : null,
    };
  }).filter((x) => x.fromDays >= x.toDays);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TIME_PART = '\\d{1,2}:\\d{2}\\s*[AP]M';

/**
 * The day by day table some cruise lines print: a date, the weekday, the port, its code, and when the ship arrives and
 * leaves. Read into itinerary lines, one a day, so the client's page shows where they will be without anybody typing it.
 *
 * Only rows that carry a date and a weekday are read, so the paragraphs around the table are never mistaken for it. The
 * first row has one time, which is when the ship leaves, and the last has one, which is when it arrives back.
 */
export function readItineraryTable(lines) {
  const rows = [];
  for (const raw of lines || []) {
    const m = String(raw).trim().match(/^([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4}) (SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY) (.+)$/);
    if (!m || !MONTHS[m[1].toLowerCase()]) continue;
    let rest = m[5].trim();
    const times = [];
    const tail = rest.match(new RegExp(`((?:${TIME_PART}\\s*){1,2})$`, 'i'));
    if (tail) {
      for (const t of tail[1].match(new RegExp(TIME_PART, 'gi')) || []) times.push(t.replace(/\s+/g, ' ').trim());
      rest = rest.slice(0, tail.index).trim();
    }
    // The port's own code, three or four capitals at the end, is left off the name.
    const code = rest.match(/^(.*\S)\s+([A-Z]{2,4})$/);
    const place = code ? code[1] : rest;
    if (!place) continue;
    const iso = `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    rows.push({ iso, place, times });
  }
  if (rows.length < 2) return [];
  const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
  const first = day(rows[0].iso);
  return rows.map((r, i) => {
    const sea = /^at sea$/i.test(r.place);
    const at = (t) => {
      const mm = String(t).match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
      if (!mm) return null;
      let h = Number(mm[1]) % 12;
      if (mm[3].toUpperCase() === 'P') h += 12;
      return `${String(h).padStart(2, '0')}:${mm[2]}`;
    };
    let title = sea ? 'At sea' : r.place;
    let start = null;
    let end = null;
    if (!sea && r.times.length === 2) { start = at(r.times[0]); end = at(r.times[1]); }
    if (!sea && r.times.length === 1) {
      if (i === 0) { title = `Sail from ${r.place}`; start = at(r.times[0]); }
      else if (i === rows.length - 1) { title = `Arrive back in ${r.place}`; start = at(r.times[0]); }
      else start = at(r.times[0]);
    }
    return { dayNumber: Math.round(day(r.iso) - first) + 1, kind: 'cruise', title, location: sea ? null : r.place, startTime: start, endTime: end };
  });
}

export function parseConfirmation(text) {
  const lines = stackLabels(String(text || '').split(/\r?\n/).slice(0, 400))
    .flatMap(splitNoColon)
    .flatMap(splitColumns)
    .slice(0, 900);
  const fields = {};
  const from = {};

  const take = (key, aliases, transform, accept) => {
    const hit = pick(lines, aliases, accept);
    if (!hit) return;
    const value = transform ? transform(hit.value) : clean(hit.value, 200);
    if (value === null || value === undefined || value === '' || value === 0) return;
    fields[key] = value;
    from[key] = hit.line.slice(0, 160);
  };

  // A number followed by a note in brackets, "2237244 (Group ID Not Applicable)", is the number.
  // Only something short: "Booking ID" is also how a page introduces a paragraph of terms, and a sentence is
  // not a confirmation number. A line that fails is passed over, so a real number further down is still found.
  const numberLike = (v) => {
    const first = clean(String(v).split(/\s{2,}/)[0], 80).replace(/\s*\(.*$/, '').trim();
    return Boolean(first) && first.length <= 30 && first.split(/\s+/).length <= 3;
  };
  take('confirmationNumber', LABELS.confirmationNumber, (v) => {
    const first = clean(v.split(/\s{2,}/)[0], 80);
    return first.replace(/\s*\(.*$/, '').trim() || first;
  }, numberLike);
  take('supplier', LABELS.supplier);
  take('productName', LABELS.productName);
  take('departDate', LABELS.departDate, anyDate);
  take('returnDate', LABELS.returnDate, anyDate);
  // A sailing's date range is not a destination.
  take('destination', LABELS.destination, (v) => (NCL_DATE.test(v) ? null : clean(v, 200)));
  take('cabin', LABELS.cabin, (v) => clean(v, 40));
  take('cabinCategory', LABELS.cabinCategory, (v) => clean(v, 120));
  take('finalPaymentDue', LABELS.finalPaymentDue, anyDate);
  take('gross', LABELS.gross, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('deposit', LABELS.deposit, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('commission', LABELS.commission, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('commissionPackage', LABELS.commissionPackage,
    (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('paid', LABELS.paid, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('paidOn', LABELS.bookingDate, anyDate);

  // The primary guest is often printed at the top of the page with no label at
  // all, ahead of the booking number: "Angela Simic BOOKING ID: 54408822".
  // Only when nothing labelled was found, and only from the first few lines,
  // because further down a bare name is as likely to be the advisor's.
  if (!fields.clientName) {
    for (const line of lines.slice(0, 6)) {
      const m = /^([A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+){1,2})$/.exec(line.trim());
      // A heading is the same shape as a name: "General Information" is not a guest.
      if (m && !looksLikeHeading(m[1])) {
        fields.clientName = fixCaps(m[1]);
        from.clientName = line;
        break;
      }
    }
  }
  // Confirmations write a name as SURNAME/FORENAME, which is not how anybody
  // files a client. Turned round, and only when it is written that way.
  take('clientName', LABELS.clientName, (v) => {
    const one = clean(String(v).split(/\s{2,}/)[0], 80);
    const m = /^([A-Za-z' -]+)\/([A-Za-z' -]+)$/.exec(one);
    return m ? fixCaps(`${m[2].trim()} ${m[1].trim()}`) : fixCaps(one);
  });

  // "Margaritaville at Sea (Islander)" on one line is a vendor and a ship.
  if (fields.supplier && !fields.productName) {
    const split = splitVendor(fields.supplier);
    if (split.productName) {
      fields.supplier = split.supplier;
      fields.productName = split.productName;
    }
  }

  // Some confirmations count the guests rather than listing them in a way this
  // can read, and a count is better than nothing when the pricing grid needs
  // to know how many columns to draw.
  const counted = pick(lines, ['total guests', 'number of guests', 'guests', 'passengers']);
  if (counted) {
    const n = Number(String(counted.value).match(/\d+/)?.[0]);
    if (n > 0 && n < 100) {
      fields.travellers = n;
      from.travellers = counted.line;
    }
  }

  // Norwegian: dates, cabin, schedule, guests and price in its own layout.
  const nclPeople = /booking components per guest/i.test(text) || /^\s*sailing\s*:\s*\d{1,2}-[A-Za-z]{3}-\d{4}/im.test(text)
    ? nclGuests(lines) : [];
  readNcl(lines, fields, from);

  // Royal Caribbean and Celebrity agent copies, which print the price a column a guest.
  const royal = isRoyalFamily(String(text || ''));
  let royalPeople = [];
  if (royal) {
    readRoyal(lines, String(text || ''), fields, from);
    // Every guest has a gross charge, so that row says how many there are. The fare row does not: a guest who pays only the port taxes has
    // a blank under the fare, and counting from it came up one short and dropped every name.
    const grossRow = rcRow(lines, /^gross charges\s+/i);
    const fareRow = rcRow(lines, /^cruise fare\s+/i);
    royalPeople = rcGuests(lines, grossRow ? grossRow.values.length - 1 : (fareRow ? fareRow.values.length - 1 : 0));
  }

  // Carnival's advisor copy, an email with the labels and figures separated by tabs.
  const carnival = isCarnival(String(text || ''));
  let carnivalPeople = [];
  if (carnival) {
    const rawLines = String(text || '').split(/\r?\n/);
    readCarnival(rawLines, String(text || ''), fields, from);
    carnivalPeople = cvGuests(rawLines);
  }

  const people = guests(lines).length ? guests(lines)
    : (royalPeople.length ? royalPeople : (carnivalPeople.length ? carnivalPeople : nclPeople));
  if (people.length) {
    fields.travellers = people.length;
    // The lead guest is the client unless the advisor says otherwise. Named
    // rather than assumed silently: the page shows where it came from.
    fields.clientName = people[0].name;
    from.clientName = people[0].line.slice(0, 160);
    from.travellers = `${people.length} guest line${people.length === 1 ? '' : 's'}`;
  }

  // Payments already made, in the layouts that have no "Payments Made" label of their own: a line that says
  // payments or deposits were received, with an amount after it. Only a plain figure, never a guess.
  if (!fields.paid) {
    for (const line of lines) {
      const m = /^(?:total )?(?:payments?|deposits?) (?:received|made|paid)\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})\b/i.exec(line.trim());
      if (m && money(m[1])) {
        fields.paid = (money(m[1]) / 100).toFixed(2);
        from.paid = line.trim().slice(0, 160);
        break;
      }
    }
  }

  // A return before a departure is a misread, not a trip. Dropped rather than
  // saved, because the advisor is more likely to accept a filled field than
  // to notice a wrong one.
  if (fields.departDate && fields.returnDate && fields.returnDate < fields.departDate) {
    delete fields.returnDate;
    delete from.returnDate;
  }

  // A return date the document never prints, worked out from a stated length: "4 NIGHT BAHAMAS" from 25 January comes back on the
  // 29th. Said to be worked out, so it is looked at and not trusted, and an automatic reservation is never made from it.
  const derived = [];
  if (fields.departDate && !fields.returnDate) {
    const stay = /(?:^|\b)(\d{1,2})[\s-]*nights?\b/i.exec(fields.destination || '');
    if (stay && Number(stay[1]) > 0 && Number(stay[1]) < 60) {
      fields.returnDate = addDays(fields.departDate, Number(stay[1]));
      from.returnDate = `worked out from the ${stay[1]} night itinerary`;
      derived.push('returnDate');
    }
  }

  // Royal Caribbean prints no day by day table worth reading (the dates, ports and times come out of the PDF in separate lists), but it
  // does print the itinerary line at the top, such as "5 NIGHT WESTERN CARIBBEAN CRUISE". That line is the reservation's itinerary.
  if (royal && fields.destination && !fields.itinerary) {
    fields.itinerary = fields.destination;
    from.itinerary = from.destination;
  }

  const pricing = (carnival ? readCarnivalPricing(String(text || '').split(/\r?\n/), fields) : null)
    || (royal ? readRoyalPricing(lines, fields, people) : null)
    || (/booking components per guest/i.test(text) ? readNclPricing(lines, fields, people) : null)
    || readPricing(lines, fields, people);

  // The charges row, when the table was run together and the figures could not be read by label: the total is the figure after the
  // guests' own, in the first line under "Gross Charges" with a figure for each guest and a total.
  if (royal && !fields.gross && royalPeople.length) {
    const g = lines.findIndex((l) => /gross charges/i.test(l));
    for (let k = g; g >= 0 && k < Math.min(lines.length, g + 3); k += 1) {
      const figs = (lines[k].match(RC_MONEY) || []).map(cleanMoney);
      if (figs.length > royalPeople.length) {
        const n = royalPeople.length;
        fields.gross = fixed(figs[n]); from.gross = lines[k].trim().slice(0, 160);
        // The same row carries the commission after the charges, a figure for each guest and a total, when it is not printed on its own.
        if (!fields.commission && figs.length === 2 * n + 2 && figs[2 * n + 1] > 0) {
          fields.commission = fixed(figs[2 * n + 1]); from.commission = lines[k].trim().slice(0, 160);
        }
        break;
      }
    }
  }

  // The guest copy has no "Gross Charges" label: its total is the last row of figures above "Amount Paid", a figure for each guest and then
  // the total.
  if (royal && !fields.gross && royalPeople.length) {
    const paidAt = lines.findIndex((l) => /^amount paid\b/i.test(l.trim()));
    for (let k = paidAt - 1; paidAt > 0 && k >= Math.max(0, paidAt - 4); k -= 1) {
      const text = lines[k].trim();
      const figs = text.match(RC_MONEY) || [];
      if (figs.length === royalPeople.length + 1 && !text.replace(RC_MONEY, '').trim()) {
        fields.gross = fixed(cleanMoney(figs[figs.length - 1])); from.gross = text.slice(0, 160);
        break;
      }
    }
  }

  // Said once it is plain, so it does not depend on a reservation form's default.
  if (fields.productName || fields.cabin || /\b(?:cruise|stateroom|sailing|embark)/i.test(text)) {
    fields.productType = 'cruise';
    from.productType = fields.productName ? `a ship, ${fields.productName}` : 'cruise wording';
  }

  // What the document says about the lead guest as a person, for their client record. Only what is
  // printed: a confirmation that gives no email comes back with none.
  const client = readClientContact(lines);
  const lead = pricing && Array.isArray(pricing.guests) ? pricing.guests[0] : null;
  if (lead && lead.dob) client.birthday = lead.dob;

  // The cruise line's guest copy is a different document from the agent copy: it is what the client is sent, and it prints no commission
  // and no fare breakdown. Said, so the blanks are not taken for a reader that failed.
  const notice = royal && /booking confirmation\s*[-\u2013\u2014]?\s*guest copy/i.test(String(text || '')) && !/agent copy/i.test(String(text || ''))
    ? 'This is the cruise line\u2019s Guest Copy. It has no commission and no fare breakdown, so those are blank. Upload the Agent Copy for the same booking as well, or instead (you can drop both files together), or type the commission in.'
    : '';

  return {
    fields,
    from,
    pricing,
    client,
    notice,
    guests: people.map((g) => g.name),
    // What cancelling costs, window by window, as the confirmation prints it.
    penalties: readCancellationSchedule(text),
    // The day by day table of ports, where the confirmation prints one.
    itinerary: readItineraryTable(String(text || '').split(/\r?\n/)),
    // Fields the document did not print and that were worked out from something it did.
    derived,
    // Named so the page can say what it did not find rather than leaving the
    // advisor to notice the blanks.
    missing: Object.keys(LABELS).filter((k) => fields[k] === undefined),
  };
}

/**
 * The cruise line, from the ship, when the document names the ship and not the line. Shared by the page that reads a
 * pasted confirmation and by the forwarded ones, so both come out the same.
 */
export async function fillSupplierFromCatalog(env, read) {
  // The cruise line is often nowhere on the page: the ship is named and the
  // line is taken as read, because the person holding the document knows whose
  // it is. The catalog knows which line sails which ship, so it can be looked
  // up rather than typed.
  if (!read.fields.supplier && read.fields.productName && env.DB) {
    // Not an exact match: a confirmation writes the ship as "Margaritaville at
    // Sea Islander" where the catalog holds "Islander" under the line of that
    // name. So the catalog's ship has to appear inside what the document
    // calls it. Five characters minimum, or short names match everything.
    const ship = await env.DB.prepare(
      `SELECT cruise_line FROM sailings
        WHERE cruise_line IS NOT NULL AND LENGTH(ship_norm) >= 5
          AND (ship_norm = ?1 OR ?1 LIKE '%' || ship_norm || '%')
        ORDER BY LENGTH(ship_norm) DESC LIMIT 1`
    ).bind(normKey(read.fields.productName)).first();
    if (ship?.cruise_line) {
      read.fields.supplier = ship.cruise_line;
      read.from.supplier = `the catalog, from the ship ${read.fields.productName}`;
    }
  }
}

export async function handleReadConfirmation(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const text = String(body.text || '');
  if (text.trim().length < 20) {
    return badRequest('Paste the confirmation email or the booking summary from the vendor.');
  }

  const read = parseConfirmation(text);

  await fillSupplierFromCatalog(env, read);
  if (!Object.keys(read.fields).length) {
    return badRequest('Nothing recognisable in that. It reads labelled lines like '
      + '"Confirmation Number: 12345", which is how most vendor confirmations are laid out.');
  }
  // Whether this would be made into a reservation on its own if it arrived by email, and if not, why, so the page can say.
  read.auto = verdict(read, new Date().toISOString().slice(0, 10));
  return json(read);
}
