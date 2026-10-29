// The Margaritaville at Sea agent confirmation reader, against both layouts the same document comes out in.
//
// The browser's PDF reader prints "$ 1,140.44" with a space after the dollar sign and the summary fields in a different order from the
// reader this was first tried against: Itinerary before Stateroom Category, Ship before Stateroom(s), and the advisor's commission rate
// before their ID. It read nothing of the money and glued the cabin number onto the ship's name. Both layouts are kept here, so a change
// that fixes one cannot quietly break the other.
//
//   node scripts/check-masconfirmation.mjs

import { parseMasAgentCopy } from '../src/masconfirmation.js';

let checks = 0;
let failures = 0;
function is(name, got, want) {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
}

// The browser's reading: the summary in two columns, a space after every dollar sign, the advisor's rate before their ID.
const BROWSER = [
  'Pat Sample BOOKING ID: 54407601', 'pat@example.test Booking Date: Jul 29, 2026', '5550100 Status: Pending', 'AGENCY COPY Cruise Planners - Jane Advisor',
  'RESERVATION SUMMARY', 'Departure Date: Mar 15, 2027 Return Date: Mar 20, 2027',
  'Itinerary: 5-Night Bahamas & Eastern Caribbean Stateroom Category: Cozy Interior',
  'Ship: Margaritaville at Sea Beachcomber Stateroom(s): 7257', 'Departure Port: PortMiami Total Guests: 2',
  'Total Booking Amount: $ 1,140.44 Remaining Due: $ 942.44', 'Payments Made: $ 198.00',
  'RESERVATION DETAIL', 'COZY INTERIOR - STATEROOM: 7257', 'Guest 1 Guest 2', 'First Name PAT LEE', 'Last Name Sample Sample',
  'Date of Birth, Age Oct 06, 1956, 70 Aug 10, 1952, 74', 'Cabin Fare $266.22 $266.22', 'Passenger Total $411.22 $411.22', 'Stateroom Subtotal: $822.44',
  'TOTAL STATEROOM AMOUNT: $1,140.44', 'RESERVATION SUMMARY', 'Gross Amount of Reservation: $ 1,200.44',
  'Total Booking Amount: $ 1,140.44', 'Payments Made: $ 198.00', 'Remaining Balance Due: $ 942.44',
  'Travel Advisor Name: Cruise Planners - Jane Advisor Fare Commission Rate: 16%', 'Advisor ID: 100200300',
].join('\n');

// The other reading: one line of facts in the order the page prints them, no space after the dollar sign.
const OTHER = [
  'Pat Sample', 'pat@example.test', '5550100', 'BOOKING ID: 54407601', 'Booking Date: Jul 29, 2026', 'Status: Pending', 'AGENCY COPY', 'Cruise Planners - Jane Advisor',
  'Departure Date: Mar 15, 2027 Itinerary: 5-Night Bahamas & Eastern Caribbean Ship: Margaritaville at Sea Beachcomber Departure Port: PortMiami RESERVATION SUMMAR',
  'Return Date: Mar 20, 2027', 'Stateroom Category: Cozy Interior', 'Stateroom(s): 7257', 'Total Guests: 2',
  'Total Booking Amount: $1,140.44 Payments Made: $198.00', 'Remaining Due: $942.44',
  'RESERVATION DETAIL', 'COZY INTERIOR - STATEROOM: 7257', 'Guest 1 Guest 2', 'First Name PAT LEE', 'Last Name Sample Sample',
  'Date of Birth, Age Oct 06, 1956, 70 Aug 10, 1952, 74', 'Cabin Fare $266.22 $266.22', 'Passenger Total $411.22 $411.22', 'Stateroom Subtotal: $822.44',
  'TOTAL STATEROOM AMOUNT: $1,140.44', 'Total Booking Amount: $1,140.44', 'Payments Made: $198.00', 'Remaining Balance Due: $942.44',
  'Travel Advisor Name: Cruise Planners - Jane Advisor Advisor ID: 100200300 Fare Commission Rate: 16%',
].join('\n');

for (const [label, text] of [['the browser reading', BROWSER], ['the other reading', OTHER]]) {
  const r = parseMasAgentCopy(text);
  is(`${label}: the booking, the ship and the itinerary, each alone`,
    [r.ok, r.bookingId, r.ship, r.itinerary], [true, '54407601', 'Margaritaville at Sea Beachcomber', '5-Night Bahamas & Eastern Caribbean']);
  is(`${label}: the sailing`, [r.departDate, r.returnDate], ['2027-03-15', '2027-03-20']);
  is(`${label}: the money, to the cent`, [r.totalCents, r.paidCents, r.dueCents], [114044, 19800, 94244]);
  is(`${label}: the cabin, its category and its two guests`,
    r.rooms.map((x) => [x.cabin, x.category, x.guests, x.subtotalCents]), [['7257', 'Cozy Interior', ['Pat Sample', 'Lee Sample'], 82244]]);
  is(`${label}: booked by the person, with no commission rate on the end`, r.bookedBy, 'Jane Advisor');
  is(`${label}: nothing to warn about`, r.warnings, []);
}

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) process.exit(1);
