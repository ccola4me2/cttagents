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

// Longest first: "grand total" must win before "total" sees the same line.
const LABELS = {
  confirmationNumber: ['booking id', 'confirmation number', 'reservation number', 'booking number',
    'booking reference', 'booking id', 'reservation id', 'confirmation code',
    'confirmation', 'conf #', 'conf no', 'res #', 'booking'],
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
function pick(lines, aliases) {
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
      if (value) return { value, line };
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
      hits += 1;
      if (!first) first = line;
      if (!all) break;
    }
    if (hits) return { cents: total, line: first, hits };
  }
  return null;
}

const fixed = (c) => (c / 100).toFixed(2);
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
function readPricing(lines, fields) {
  const fare = moneyRow(lines, ['cabin fare', 'cruise fare', 'stateroom fare', 'base fare', 'fare'], { all: true });
  if (!fare) return null;

  const discount = moneyRow(lines, ['discounts applied', 'total discounts'])
    || moneyRow(lines, ['discount(s)', 'discounts', 'discount'], { all: true });
  const govt = moneyRow(lines, ['govt. taxes & fees', 'govt taxes & fees', 'government taxes & fees',
    'government taxes and fees', 'taxes, fees & port expenses', 'taxes, fees and port expenses',
    'taxes & fees', 'taxes and fees', 'port charges and taxes', 'port charges', 'port fees', 'taxes'], { all: true });
  const required = moneyRow(lines, ['required cruise fees & expenses', 'required cruise fees',
    'cruise fees & expenses', 'port expenses', 'cruise fees'], { all: true });
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

export function parseConfirmation(text) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 400)
    .flatMap(splitColumns)
    .slice(0, 900);
  const fields = {};
  const from = {};

  const take = (key, aliases, transform) => {
    const hit = pick(lines, aliases);
    if (!hit) return;
    const value = transform ? transform(hit.value) : clean(hit.value, 200);
    if (value === null || value === undefined || value === '' || value === 0) return;
    fields[key] = value;
    from[key] = hit.line.slice(0, 160);
  };

  take('confirmationNumber', LABELS.confirmationNumber, (v) => clean(v.split(/\s{2,}/)[0], 80));
  take('supplier', LABELS.supplier);
  take('productName', LABELS.productName);
  take('departDate', LABELS.departDate, anyDate);
  take('returnDate', LABELS.returnDate, anyDate);
  take('destination', LABELS.destination);
  take('cabin', LABELS.cabin, (v) => clean(v, 40));
  take('cabinCategory', LABELS.cabinCategory, (v) => clean(v, 120));
  take('finalPaymentDue', LABELS.finalPaymentDue, anyDate);
  take('gross', LABELS.gross, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('deposit', LABELS.deposit, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('commission', LABELS.commission, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('commissionPackage', LABELS.commissionPackage,
    (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));

  // The primary guest is often printed at the top of the page with no label at
  // all, ahead of the booking number: "Angela Simic BOOKING ID: 54408822".
  // Only when nothing labelled was found, and only from the first few lines,
  // because further down a bare name is as likely to be the advisor's.
  if (!fields.clientName) {
    for (const line of lines.slice(0, 6)) {
      const m = /^([A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+){1,2})$/.exec(line.trim());
      if (m) {
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

  const people = guests(lines);
  if (people.length) {
    fields.travellers = people.length;
    // The lead guest is the client unless the advisor says otherwise. Named
    // rather than assumed silently: the page shows where it came from.
    fields.clientName = people[0].name;
    from.clientName = people[0].line.slice(0, 160);
    from.travellers = `${people.length} guest line${people.length === 1 ? '' : 's'}`;
  }

  // A return before a departure is a misread, not a trip. Dropped rather than
  // saved, because the advisor is more likely to accept a filled field than
  // to notice a wrong one.
  if (fields.departDate && fields.returnDate && fields.returnDate < fields.departDate) {
    delete fields.returnDate;
    delete from.returnDate;
  }

  const pricing = readPricing(lines, fields);

  return {
    fields,
    from,
    pricing,
    guests: people.map((g) => g.name),
    // Named so the page can say what it did not find rather than leaving the
    // advisor to notice the blanks.
    missing: Object.keys(LABELS).filter((k) => fields[k] === undefined),
  };
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
  if (!Object.keys(read.fields).length) {
    return badRequest('Nothing recognisable in that. It reads labelled lines like '
      + '"Confirmation Number: 12345", which is how most vendor confirmations are laid out.');
  }
  return json(read);
}
