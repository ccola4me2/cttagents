// Reading a cruise line's group proposal, so nobody types it twice.
//
// A group starts as a PDF from the cruise line, and somebody then copies a dozen
// details out of it by hand. That is ten minutes and a transcription error
// waiting to happen on the dates that decide whether the cabins are still held.
//
// Every cruise line lays its proposal out differently, so this is a registry and
// not a parser. Each recognised layout has a module of its own that knows where
// everything is, and is tried first. A layout nobody has written a reader for
// falls through to a conservative one that takes only what a label says.
//
// Adding a cruise line is one module and one line in FORMATS, written from a
// real proposal and checked against it, which is why the exact readers can fill
// in the rate grid and the payment terms and the fallback cannot.
//
// Nothing here writes. It returns fields for a form the advisor checks and
// corrects, because a number that decides a deposit deadline should be read by a
// person once before it is saved.

import { tidy } from './groupquote-util.js';
import { mvas } from './groupquote-mvas.js';
import { ncl } from './groupquote-ncl.js';
import { celebrity } from './groupquote-celebrity.js';
import { generic } from './groupquote-generic.js';

export { tidy };

// Tried in order. A layout is recognised by its letterhead and its form title,
// never by a single word.
export const FORMATS = [mvas, ncl, celebrity];

// What a group can hold, in the order they are asked for, and the words the
// screen uses when one was not in the document.
export const FIELD_WORDS = {
  name: 'group name',
  vendor: 'cruise line',
  productName: 'ship',
  destination: 'itinerary',
  departDate: 'sailing date',
  returnDate: 'return date',
  optionDate: 'option date',
  cabinsHeld: 'number of cabins',
  groupCode: 'group number',
  proposalId: 'proposal number',
  vendorContact: 'vendor contact',
  departurePort: 'departure port',
  passengers: 'passengers',
  proposalExpires: 'proposal expiry',
};

const nothing = () => ({
  read: false, format: null, fields: {}, rates: [], notes: '', found: [], missing: [],
});

/**
 * A proposal, as the fields of a group.
 *
 * `found` and `missing` are the honest half of the answer. A form that fills
 * eight fields and says nothing about the six it left alone looks complete, and
 * the advisor saves it believing the dates came out of the document.
 */
export function parseGroupQuote(text) {
  const t = tidy(text);
  if (t.length < 40) return nothing();

  const exact = FORMATS.find((f) => f.matches(t));
  const format = exact || generic;
  const out = format.parse(t);
  if (!out) return nothing();

  const fields = out.fields;
  const filled = (k) => fields[k] !== '' && fields[k] !== 0 && fields[k] !== undefined;
  return {
    read: true,
    format: { id: format.id, name: format.name, exact: Boolean(exact) },
    fields,
    rates: out.rates || [],
    notes: out.notes || '',
    payments: out.payments || [],
    // Things worth a second look that are not missing fields: a total that does not
    // agree with the rows under it, say.
    warnings: out.warnings || [],
    found: Object.keys(FIELD_WORDS).filter(filled),
    // What this layout has no place for has not been left out, and listing it
    // would teach people to skip the list.
    missing: Object.keys(FIELD_WORDS)
      .filter((k) => !filled(k) && !(format.never || []).includes(k)),
    // A layout that never carries a group number says so, so the screen can
    // explain that one instead of leaving the box empty without a word.
    noGroupNumber: (format.never || []).includes('groupCode'),
  };
}
