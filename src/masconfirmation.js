// A Margaritaville at Sea agent confirmation, read.
//
// The cruise line sends the agent a confirmation with every fact about a booking: its number, the ship and the
// sailing, each stateroom and who is in it, what the booking costs and what has been paid. The agent then types it all
// onto a sheet. This reads it instead, so uploading the document is the whole job, and uploading the next one
// after a payment brings the figures up to date.
//
// Read by its labels, with the whitespace folded away (so "$ 1,140.44" and "$1,140.44" are the same figure), and not by where anything sits on the page. The same
// document comes out of a PDF reader with its lines in different places depending on the reader, and a label
// followed by its value is what survives that. Anything it cannot find is left out and said so, never guessed:
// a cabin number or a payment that is wrong looks exactly like one that is right.
//
// What it keeps is the booking, the sailing, the cabins, the guests' names, the enhancements and the money. It does not keep dates
// of birth, email addresses or phone numbers, which are the guests' own. The agent's commission is read so it can be checked
// against the reservation, and is never shown to the client.

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "Dec 28, 2026" as 2026-12-28, or null. */
export function isoOf(text) {
  const m = /([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/.exec(String(text || ''));
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${String(m[2]).padStart(2, '0')}`;
}

/** "$1,818.00" as 181800, or null. */
export function centsOf(text) {
  const m = /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(String(text || ''));
  if (!m) return null;
  return Math.round(Number(m[1].replace(/,/g, '')) * 100);
}

const word = (w) => (w.length <= 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase());
/** RACHEL KAREN K as Rachel Karen K, and McDonald-like names are left to whoever typed them. */
const title = (s) => String(s || '').trim().split(/\s+/).map((w) => w.split('-').map(word).join('-')).join(' ');

/**
 * The guests in a stateroom, from the two rows the document prints them in: a row of first names and a row of last
 * names, one column a guest. Columns are lost when the text is read, so they are put back by counting: a single letter
 * is a middle initial and belongs to the name before it, and when the number of first and last names then matches
 * the number of guests, they are paired up. When it does not, the lead guest is named and the rest are left to be
 * filled in, with a warning, because a wrong name on a manifest is worse than a blank.
 */
function guestsIn(block, expected, warnings) {
  const firsts = /First Name (.+?) Last Name/.exec(block);
  const lasts = /Last Name (.+?) (?:Date of Birth|Cabin Fare|Passenger|$)/.exec(block);
  if (!firsts || !lasts) return [];
  const merge = (tokens) => {
    const out = [];
    for (const t of tokens) {
      if (out.length && /^[A-Za-z]\.?$/.test(t)) out[out.length - 1] += ` ${t.replace('.', '')}`;
      else out.push(t);
    }
    return out;
  };
  const f = merge(firsts[1].trim().split(/\s+/));
  const l = lasts[1].trim().split(/\s+/);
  if (f.length === expected && l.length === expected) return f.map((x, i) => title(`${x} ${l[i]}`));
  if (l.length === 1) return f.map((x) => title(`${x} ${l[0]}`));
  warnings.push('The guests\' names could not be told apart with certainty. Check them.');
  return [title(`${f[0]} ${l.join(' ')}`), ...f.slice(1).map((_, i) => `Guest ${i + 2}`)];
}

/**
 * Reads the document's text. Returns { ok: false, reason } for a document that is not one of these, and otherwise
 * { ok: true, ... } with whatever was found.
 */
export function parseMasAgentCopy(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const bookingId = (/BOOKING ID:\s*(\d{5,})/i.exec(t) || [])[1];
  if (!bookingId || !/Margaritaville at Sea|MARGARITAVILLE AT SEA|cruisemvas/i.test(t)) {
    return { ok: false, reason: 'This does not look like a Margaritaville at Sea booking confirmation.' };
  }

  const warnings = [];
  const grab = (re) => (re.exec(t) || [])[1];
  const status = grab(/\bStatus:\s*([A-Za-z]+)/);
  const advisorRaw = grab(/Travel Advisor Name:\s*(.+?)\s+(?:Advisor ID:|Fare Commission Rate:)/) || '';
  // "Cruise Planners - Brent Beasley" is the agency and the person. The person is who booked it.
  const bookedBy = advisorRaw.includes(' - ') ? advisorRaw.split(' - ').slice(1).join(' - ').trim() : advisorRaw.trim();

  const departDate = isoOf(grab(/Departure Date:\s*([A-Za-z]{3,9}\.? \d{1,2}, \d{4})/));
  const returnDate = isoOf(grab(/Return Date:\s*([A-Za-z]{3,9}\.? \d{1,2}, \d{4})/));
  const itinerary = (grab(/Itinerary:\s*(.+?)\s+(?:Stateroom Category:|Ship:)/) || '').trim();
  const ship = (grab(/\bShip:\s*(.+?)\s+(?:Stateroom\(s\):|Departure Port:)/) || '').trim();
  const totalCents = centsOf(grab(/Total Booking Amount:\s*(\$\s*[\d,.]+)/));
  const paidCents = centsOf(grab(/Payments Made:\s*(\$\s*[\d,.]+)/));
  let dueCents = centsOf(grab(/Remaining (?:Balance )?Due:\s*(\$\s*[\d,.]+)/));
  if (dueCents === null && totalCents !== null && paidCents !== null) dueCents = Math.max(0, totalCents - paidCents);
  const guestsTotal = Number(grab(/Total Guests:\s*(\d+)/)) || 0;

  // One block for each stateroom: "BREEZY BALCONY - STATEROOM: 6225" and what follows it.
  const heads = [...t.matchAll(/([A-Z][A-Z0-9&'/ ]{2,40}?) - STATEROOM:\s*([A-Za-z0-9]+)/g)];
  const rooms = heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : t.length;
    const block = t.slice(h.index, end);
    const count = Math.max(0, ...[...block.matchAll(/\bGuest (\d+)\b/g)].map((g) => Number(g[1])));
    const names = guestsIn(block, count || guestsTotal, warnings);
    return {
      // The heading above the first stateroom is all capitals too, and comes just before it.
      category: title(h[1].replace(/^(?:RESERVATION DETAIL|RESERVATION SUMMARY|DETAIL)\s+/, '')), cabin: h[2],
      guests: names, subtotalCents: centsOf((/Stateroom Subtotal:\s*(\$\s*[\d,.]+)/.exec(block) || [])[1]),
    };
  });
  if (!rooms.length) {
    // No stateroom blocks, but the summary names them.
    const cat = grab(/Stateroom Category:\s*(.+?)\s+Stateroom\(s\):/);
    const cabins = (grab(/Stateroom\(s\):\s*([A-Za-z0-9, ]+?)\s+Total Guests:/) || '').split(/[ ,]+/).filter(Boolean);
    for (const c of cabins) rooms.push({ category: title(cat || ''), cabin: c, guests: [], subtotalCents: null });
  }
  if (!rooms.length) warnings.push('No stateroom was found in it.');
  if (guestsTotal && rooms.length === 1 && rooms[0].guests.length && rooms[0].guests.length !== guestsTotal) {
    warnings.push(`It says ${guestsTotal} guests but ${rooms[0].guests.length} names were read. Check them.`);
  }
  // The enhancements table: "PREPAID GRATUITIES 7-NIGHT $154.00 1 $154.00", one row each, between its heading and the
  // stateroom total. A row is a name, a price, a quantity and a total, and one that does not add up is left out and said so.
  const enhancements = [];
  const table = /Cruise Enhancements\s+Price\s+Qnty\s+Total\s+(.*?)\s+TOTAL STATEROOM AMOUNT/i.exec(t);
  if (table) {
    for (const m of table[1].matchAll(/([A-Za-z][A-Za-z0-9&'\/\-., ]*?)\s+\$\s*([\d,]+\.\d{2})\s+(\d+)\s+\$\s*([\d,]+\.\d{2})/g)) {
      const price = centsOf(`$${m[2]}`);
      const qty = Number(m[3]);
      const total = centsOf(`$${m[4]}`);
      if (price === null || total === null || !qty) continue;
      if (price * qty !== total) { warnings.push(`The enhancement "${m[1].trim()}" does not add up, so it was left out.`); continue; }
      enhancements.push({ name: title(m[1]), priceCents: price, qty, totalCents: total });
    }
  }
  const insuranceCents = centsOf(grab(/Insurance Amount:\s*(\$\s*[\d,.]+)/));
  const commissionCents = centsOf(grab(/Fare Commission:\s*(\$\s*[\d,.]+)/));
  if (totalCents === null) warnings.push('The booking total was not found.');
  if (paidCents === null) warnings.push('What has been paid was not found.');
  if (!departDate) warnings.push('The sailing date was not found.');

  return {
    ok: true, bookingId, bookingDate: isoOf(grab(/Booking Date:\s*([A-Za-z]{3,9}\.? \d{1,2}, \d{4})/)),
    cancelled: /cancel/i.test(status || ''), bookedBy, itinerary, ship, departDate, returnDate,
    totalCents, paidCents, dueCents, guestsTotal, rooms, enhancements, insuranceCents, commissionCents, warnings,
  };
}
