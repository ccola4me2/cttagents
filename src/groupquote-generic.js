// A layout nobody has written a reader for yet.
//
// There is no pretending to read a document whose layout is unknown. What can be
// done is narrower and honest: a cruise line's proposal labels most of what it
// says ("Sail Date: ...", "Ship: ...", "Group Number: ..."), and a value that
// sits straight after a label that says what it is can be taken on the label's
// word. Anything without that is left for a person.
//
// The rules that keep this from becoming a guess:
//
//   - A field is filled only from an explicit label. Nothing is inferred from
//     position, from a number that looks like a date, or from what a proposal
//     is supposed to contain.
//   - One kind of reference is never read as another. A proposal number is not a
//     group number, and a group number is taken only from a label that says
//     group, because the group number is the address of a public page and a
//     wrong one sends people to somebody else's trip.
//   - The document has to earn the word "group quote". A single lucky label in a
//     brochure is not a proposal, so a minimum number of fields must be found
//     before anything is offered at all.
//   - What was found is reported as found, and the screen says the layout was
//     not recognised. The advisor is checking, not confirming.
//
// This is the reader for the first proposal from a cruise line. The second one
// should have a module of its own, written from the first.

import { DATE_SOURCE, parseDate } from './groupquote-util.js';

// The lines a proposal might come from, most specific pattern first. Matched on
// the words a letterhead uses, not on a ship or a port, which appear in every
// other line's marketing too.
const LINES = [
  ['Royal Caribbean', /Royal\s+Caribbean/i],
  ['Celebrity Cruises', /Celebrity\s+Cruises/i],
  ['Carnival Cruise Line', /Carnival\s+Cruise/i],
  ['Norwegian Cruise Line', /Norwegian\s+Cruise|\bNCL\b/i],
  ['Princess Cruises', /Princess\s+Cruises/i],
  ['Holland America Line', /Holland\s+America/i],
  ['MSC Cruises', /\bMSC\s+Cruises/i],
  ['Disney Cruise Line', /Disney\s+Cruise/i],
  ['Virgin Voyages', /Virgin\s+Voyages/i],
  ['Viking', /\bViking\s+(?:Ocean|River|Cruises|Expeditions)/i],
  ['Oceania Cruises', /Oceania\s+Cruises/i],
  ['Regent Seven Seas Cruises', /Regent\s+Seven\s+Seas/i],
  ['Azamara', /\bAzamara\b/i],
  ['Seabourn', /\bSeabourn\b/i],
  ['Silversea', /\bSilversea\b/i],
  ['Cunard', /\bCunard\b/i],
  ['Costa Cruises', /Costa\s+Cruises/i],
  ['Windstar Cruises', /Windstar/i],
  ['Lindblad Expeditions', /Lindblad/i],
  ['AmaWaterways', /AmaWaterways/i],
  ['Uniworld', /\bUniworld\b/i],
  ['Avalon Waterways', /Avalon\s+Waterways/i],
  ['Celestyal Cruises', /Celestyal/i],
  ['Explora Journeys', /Explora\s+Journeys/i],
];

/**
 * Which cruise line, from the letterhead if it says and from the whole document
 * if it is named more than once. A line named once in passing ("compare with
 * Carnival") is not the line that wrote the proposal.
 */
export function identifyLine(t) {
  const head = t.slice(0, 1500);
  for (const [name, re] of LINES) if (re.test(head)) return name;
  let best = ['', 1];
  for (const [name, re] of LINES) {
    const n = (t.match(new RegExp(re.source, 'gi')) || []).length;
    if (n > best[1]) best = [name, n];
  }
  return best[0];
}

const WEEKDAY = '(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+)?';

// The labels this reader looks for, written once. The same list decides where a
// value stops, which is why it is a list and not a pattern for "anything
// followed by a colon": a group called "Sample Reunion Group" followed by a
// field called Group Number contains a perfectly good-looking label in the
// middle of its own name, and only a list of the real ones can tell.
const LABEL = {
  name: 'Group\\s+Name|Name\\s+of\\s+Group|Group\\s+Title',
  ship: 'Ship(?:\\s+Name)?|Vessel',
  itinerary: 'Itinerary|Cruise\\s+Itinerary|Destination',
  depart: 'Sail(?:ing)?\\s+Date|Departure\\s+Date|Date\\s+of\\s+Departure|Embarkation\\s+Date|Sails|Departs|Departing|Embarks',
  back: 'Return(?:ing)?\\s+Date|Date\\s+of\\s+Return|Disembark(?:ation)?(?:\\s+Date)?|Returns|Returning',
  option: 'Option\\s+Date|Option\\s+(?:Expires|Expiry|Expiration)|Cut-?\\s?off(?:\\s+Date)?|Release\\s+Date|Hold\\s+(?:Date|Until|Expires)|Block\\s+(?:Release|Expires)',
  cabins: 'Number\\s+of\\s+(?:Staterooms|Cabins|Rooms)|Total\\s+(?:Staterooms|Cabins)|(?:Staterooms|Cabins)\\s+(?:Held|Blocked|Requested|Reserved)',
  group: 'Group\\s*(?:(?:Number|No\\.?|ID|Code)\\b|#)',
  proposal: '(?:Proposal|Quote|Agreement|Contract)\\s*(?:(?:ID|Number|No\\.?)\\b|#)',
  port: '(?:Departure|Embarkation|Embark)\\s+Port|Port\\s+of\\s+(?:Embarkation|Departure)|Sailing\\s+From|Departs\\s+From',
  guests: 'Total\\s+(?:Passengers|Guests|Travell?ers|Pax)|Number\\s+of\\s+(?:Passengers|Guests|Travell?ers|Pax)',
  expires: '(?:Proposal|Quote|Offer|Pricing|Rates?)\\s+(?:Expires|Expiration(?:\\s+Date)?|Valid\\s+(?:Through|Until|Thru|To))|Valid\\s+(?:Through|Until|Thru)',
  // Labels that are not looked for but do end a value that runs up to them.
  other: 'Proposal\\s+Date|Contact|Agent|Agency|Phone|Email|Nights|Cabin\\s+Category|Price|Deposit|Notes?',
};
const KNOWN = Object.values(LABEL).join('|');
const NEXT_LABEL = `(?=\\s+(?:${KNOWN})\\s*:|$)`;

/** A date straight after one of these labels. */
function dateAfter(t, labels) {
  const re = new RegExp(`(?:${labels})\\s*[:\\-]?\\s*${WEEKDAY}${DATE_SOURCE}`, 'i');
  const m = t.match(re);
  return m ? parseDate(m[1]) : '';
}

/** The text straight after a labelled colon, up to the next known label. */
function valueAfter(t, labels, max = 70) {
  const m = t.match(new RegExp(`(?:${labels})\\s*:\\s*(.+?)${NEXT_LABEL}`, 'i'));
  if (!m) return '';
  const v = m[1].trim().replace(/\s+/g, ' ');
  return v && v.length <= max ? v : '';
}

/** A reference with a digit in it, from a label that says what it is. */
function referenceAfter(t, labels) {
  const m = t.match(new RegExp(`(?:${labels})\\s*[:#]?\\s*([A-Za-z0-9][A-Za-z0-9-]{2,19})\\b`, 'i'));
  return m && /\d/.test(m[1]) ? m[1] : '';
}

const countAfter = (t, labels) => {
  const m = t.match(new RegExp(`(?:${labels})\\s*[:\\-]?\\s*(\\d{1,4})\\b`, 'i'));
  return m ? Number(m[1]) : 0;
};

/** A ship is a short run of capitalised words, not a sentence. */
function shipAfter(t) {
  const v = valueAfter(t, LABEL.ship, 40);
  return /^[A-Z][A-Za-z'’&.-]*(?:\s+(?:of\s+the\s+|of\s+|the\s+)?[A-Z][A-Za-z'’&.-]*){0,4}$/.test(v) ? v : '';
}

function parse(t) {
  const fields = {
    name: valueAfter(t, LABEL.name, 100),
    vendor: identifyLine(t),
    productName: shipAfter(t),
    destination: valueAfter(t, LABEL.itinerary, 80),
    departDate: dateAfter(t, LABEL.depart),
    returnDate: dateAfter(t, LABEL.back),
    optionDate: dateAfter(t, LABEL.option),
    cabinsHeld: countAfter(t, LABEL.cabins),
    // Only from a label that says group. A proposal number is not this.
    groupCode: referenceAfter(t, LABEL.group),
    proposalId: referenceAfter(t, LABEL.proposal),
    sailingId: '',
    vendorContact: '',
    departurePort: valueAfter(t, LABEL.port, 60),
    passengers: countAfter(t, LABEL.guests),
    proposalExpires: dateAfter(t, LABEL.expires),
  };

  // The line does not count towards deciding whether this is a group quote: it
  // is named on anything the line ever printed.
  const evidence = Object.entries(fields)
    .filter(([k, v]) => k !== 'vendor' && v !== '' && v !== 0).length;
  if (evidence < 3) return null;

  return { fields, rates: [], notes: '', payments: [] };
}

export const generic = {
  id: 'generic',
  name: 'a layout we have not seen before',
  never: [],
  parse,
};
