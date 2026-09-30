// Reading a vendor's group proposal, so nobody types it twice.
//
// A group starts as a PDF from the cruise line. Somebody then copies eight
// fields out of it into the portal by hand, which is ten minutes and a
// transcription error waiting to happen on dates that decide whether the
// cabins are still held.
//
// This reads one vendor's form: Margaritaville at Sea's Group Proposal. That
// narrowness is deliberate and is stated on the screen. A parser that claims
// to read "a group quote" and silently half reads a Royal Caribbean one is
// worse than no parser, because the advisor saves the wrong dates believing
// they came out of the document. Anything it cannot read comes back empty and
// the advisor fills the form in as before, which is the same work they do
// today rather than a new failure.
//
// Nothing here writes. It returns fields for a form the advisor checks and
// corrects, because a number that decides a deposit deadline should be read by
// a person once before it is saved.

/**
 * The document text, tidied into something patterns can be written against.
 *
 * The PDF is drawn rather than written: language tags land between runs, dates
 * arrive as "2027 - 10 - 22" because the hyphen is kerned, and "Amenities"
 * comes out as "A menities" where the A is a different glyph. All three are
 * artefacts of the generator rather than anything the reader sees.
 */
export function tidy(text) {
  let t = String(text || '').replace(/ en-US/g, ' ');
  // A kerned hyphen inside a date, and inside "7 - Night".
  t = t.replace(/(\d{4})\s*-\s*(\d{2})\s*-\s*(\d{2})/g, '$1-$2-$3');
  t = t.replace(/(\d)\s+-\s+([A-Za-z])/g, '$1-$2');
  t = t.replace(/\bA\s+menities\b/g, 'Amenities');
  return t.replace(/\s+/g, ' ').trim();
}

const after = (t, label, pattern) => {
  const m = t.match(new RegExp(`${label}\\s*:?\\s*${pattern}`));
  return m ? m[1].trim() : '';
};

const money = (s) => {
  const n = Number(String(s || '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const dollars = (cents) => `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/**
 * Is this the form we know how to read.
 *
 * Two marks rather than one, and both from the letterhead rather than the
 * body, so a Margaritaville booking confirmation does not pass for a proposal.
 */
export function looksLikeMvas(t) {
  return /Margaritaville at Sea/i.test(t) && /Group Proposal Form/i.test(t);
}

/**
 * The cabin grid.
 *
 * Read as rows rather than by column position, because the middle columns
 * (extra adult, extra child) are blank on most proposals and counting commas
 * would slide every later figure one place left.
 */
export function cabinRows(t) {
  const block = t.match(/Total Fare\s+(.*?)\s+(?:Additional Amenities|Important Dates)/);
  if (!block) return [];
  const rows = [];
  const re = /([A-Z][A-Za-z'&\- ]+?)\s+(Double|Single|Triple|Quad)\s+(\d+)\s+(\d+)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/g;
  let m;
  while ((m = re.exec(block[1]))) {
    rows.push({
      roomType: m[1].trim(),
      occupancy: m[2],
      cabins: Number(m[3]),
      guests: Number(m[4]),
      perGuest: money(m[5]),
      taxes: money(m[6]),
      totalFare: money(m[7]),
    });
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
 * `groupCode` is deliberately absent. The document does not carry one: it has
 * a Proposal ID and a SailingID, and the group number only exists once the
 * vendor opens the group, which is usually after this is signed. Leaving it
 * empty is the true state rather than a gap to be filled in with something
 * that looks like it.
 */
export function parseGroupQuote(text) {
  const t = tidy(text);
  if (!looksLikeMvas(t)) return { read: false, fields: {}, notes: '', found: [] };

  const depart = after(t, 'Departure Date', '(\\d{4}-\\d{2}-\\d{2})');
  const back = after(t, 'Return Date', '(\\d{4}-\\d{2}-\\d{2})');
  const ship = after(t, 'Ship', '([A-Za-z][A-Za-z ]*?)\\s+(?:Cabin Fare|Return Date)');
  const itinerary = after(t, 'Itinerary', '(.+?)\\s+Number of Staterooms');
  const port = after(t, 'Departure Port', '([A-Za-z][A-Za-z .]*?)\\s+Total Passengers');
  const cabins = after(t, 'Number of Staterooms', '(\\d+)');
  const guests = after(t, 'Total Passengers', '(\\d+)');
  const proposalId = after(t, 'Proposal ID', '(\\d+)');
  const sailingId = after(t, 'SailingID', '(\\d+)');
  const specialist = after(t, 'MVAS Specialist', '([A-Za-z][A-Za-z .\'-]*?)\\s+(?:Margaritaville|Proposal|Agency)');
  const expires = after(t, 'Proposal Expires', '(\\d{4}-\\d{2}-\\d{2})');
  const nameMatch = t.match(/Proposal ID:\s*\d+\s*\.?\s*(.+?)\s+Proposal Date/);
  const name = nameMatch ? nameMatch[1].trim() : '';

  const cabinsList = cabinRows(t);
  const payments = paymentRows(t);
  // The date the cabins stop being held is the one that matters most, and it
  // is the rate hold rather than the first line: the countersign is the day
  // the paperwork is due, not the day the space goes.
  const hold = payments.find((p) => /rate hold/i.test(p.what)) || payments[0] || null;

  // Only what has nowhere better to go.
  //
  // Everything above used to be written here as prose, which is where facts go
  // to stop being facts: nothing can search a paragraph, total it, or warn
  // that a proposal expires on Tuesday, and an advisor correcting a rate ends
  // up editing a sentence rather than a number. They are columns and rows now.
  //
  // The payment ladder stays, for now, because it is a list of dates and
  // amounts that nothing else in a group reads yet. When something does, it
  // wants rows too.
  const lines = [];
  if (payments.length) {
    lines.push('Payment terms:');
    for (const p of payments) {
      lines.push(`  ${p.what}: ${dollars(Math.round(p.amount * 100))} due ${p.due}`);
    }
  }

  const fields = {
    name,
    vendor: 'Margaritaville at Sea',
    productName: ship,
    destination: itinerary,
    departDate: depart,
    returnDate: back,
    optionDate: hold ? hold.due : '',
    cabinsHeld: cabins ? Number(cabins) : 0,
    // References printed on paperwork rather than numbers anybody adds up, so
    // text: a vendor who starts writing 04589 keeps the leading nought.
    proposalId,
    sailingId,
    vendorContact: specialist,
    departurePort: port,
    passengers: guests ? Number(guests) : 0,
    proposalExpires: expires,
    // Never guessed. See the note on this function.
    groupCode: '',
  };

  // The grid, as rows, in the order the proposal lists them. Cents, like every
  // other amount in this portal, so nothing is ever a float.
  const rates = cabinsList.map((c, i) => ({
    roomType: c.roomType,
    occupancy: c.occupancy,
    cabins: c.cabins,
    guests: c.guests,
    perGuestCents: Math.round(c.perGuest * 100),
    taxesCents: Math.round(c.taxes * 100),
    totalCents: Math.round(c.totalFare * 100),
    sortOrder: i,
  }));

  const found = Object.entries(fields)
    .filter(([k, v]) => k !== 'groupCode' && v !== '' && v !== 0)
    .map(([k]) => k);

  return { read: true, fields, rates, notes: lines.join('\n'), found, cabins: cabinsList, payments };
}
