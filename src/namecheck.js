// Is this line a person's name, or a heading that happens to look like one?
//
// A confirmation often prints the lead guest at the top with no label, so the reader takes the first line made of two or
// three capitalised words as the name. "General Information", "Booking Details" and "Royal Caribbean" are exactly that shape
// and are never a person. Taken as the client, one of them is filed as a real client record and a reservation, and an
// automatic reservation would be made for "General Information". So a candidate that is made of words a heading is made of
// is refused, and the page asks for the real name instead.

const HEADING_WORDS = new Set([
  'general', 'information', 'info', 'booking', 'bookings', 'reservation', 'reservations', 'details', 'detail', 'summary',
  'guest', 'guests', 'passenger', 'passengers', 'traveler', 'travelers', 'traveller', 'travellers', 'cruise', 'cruises',
  'ship', 'confirmation', 'itinerary', 'stateroom', 'cabin', 'payment', 'payments', 'terms', 'conditions', 'important',
  'notes', 'note', 'agent', 'agency', 'copy', 'travel', 'tours', 'invoice', 'receipt', 'contact', 'price', 'pricing', 'fare',
  'fares', 'charges', 'total', 'status', 'sailing', 'departure', 'arrival', 'port', 'ports', 'date', 'dates', 'vendor',
  'supplier', 'group', 'deposit', 'balance', 'insurance', 'protection', 'overview', 'page', 'section', 'customer', 'service',
  'services', 'policy', 'cancellation', 'special', 'requests', 'request', 'dining', 'activities', 'excursions', 'onboard',
  'included', 'includes', 'name', 'names', 'number', 'royal', 'caribbean', 'celebrity', 'norwegian', 'carnival', 'princess',
  'disney', 'holland', 'america', 'viking', 'msc', 'margaritaville', 'costa', 'azamara', 'oceania', 'regent', 'seabourn',
  'silversea', 'cunard', 'line', 'lines', 'seas', 'sea', 'welcome', 'thank', 'thanks', 'your', 'our', 'the', 'and', 'of',
]);

// A word that only ever ends a company's name. One of these anywhere in a candidate makes it a company, whatever the other words are:
// an agency's own name at the top of a confirmation ("Pollack Travel LLC") is not the guest.
const COMPANY_WORDS = new Set(['llc', 'inc', 'ltd', 'corp', 'corporation', 'company', 'plc', 'llp', 'gmbh']);

/** True when every word of a candidate name is the sort of word a heading or a company is made of. */
export function looksLikeHeading(name) {
  const words = String(name || '').toLowerCase().match(/[a-z']+/g) || [];
  if (!words.length) return true;
  if (words.some((w) => COMPANY_WORDS.has(w))) return true;
  // One ordinary word in the mix is enough to be a person: "Summer Cruise" is a stretch, "Cruise Pollack" is a surname.
  return words.every((w) => HEADING_WORDS.has(w));
}
