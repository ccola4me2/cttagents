/**
 * A confirmation is turned into itinerary lines, and never into wrong ones.
 *
 * Nobody has written an exact reader for any airline's or hotel site's layout, so
 * this reads what is labelled, which is most of any confirmation and not all of it.
 * The ways that goes wrong are quiet: a check out on the check in date, a flight
 * listed three times because three places in the document mention it, an arrival
 * time taken for the departure, a day and month with no year put in the wrong
 * year. Each of these would show a client a time to be at an airport that is not
 * the time, so each is pinned here.
 *
 * Every fixture below is invented. They are shaped like what each kind of
 * confirmation prints (labels, order, separators) and they prove the reader copes
 * with the shape. They do NOT prove it reads any particular company's document:
 * the first real one of each kind becomes a fixture of the other sort.
 */

import { readConfirmationLines as parseConfirmation, findDates, findTimes, findReference, classify } from '../src/confirmation.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::confirmation: ${label}: ${detail}`);
};
const is = (label, got, want) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

const slim = (r) => r.items.map((i) => [i.date, i.startTime, i.endTime, i.kind, i.title, i.location]);

// ------------------------------------------------------------ fixtures ---
const TICKET = 'ELECTRONIC TICKET RECEIPT Booking reference: QX7P2L Passenger: SAMPLE/PAT MR Ticket number: 0751234567890 '
  + 'Flight IB 6251 Operated by Iberia From: MADRID (MAD) Terminal 4 To: BARCELONA (BCN) Terminal 1 '
  + 'Depart: 10 NOV 2026 08:10 Arrive: 10 NOV 2026 09:30 Seat: 12A Baggage: 1 piece '
  + 'Flight IB 6254 From: BARCELONA (BCN) Terminal 1 To: MADRID (MAD) Terminal 4 '
  + 'Depart: 14 NOV 2026 19:45 Arrive: 14 NOV 2026 21:05 Seat: 14C Baggage: 1 piece Check in opens 24 hours before departure.';

// The same flight named three times, the way an itinerary email does, overnight.
const OVERNIGHT = 'Your trip Thursday, November 5, 2026 Iberia flight IB 340 departs Orlando (MCO) at 6:30 PM and lands in Madrid (MAD) '
  + 'at 9:05 AM on Friday, November 6. Flight Departs Arrives Iberia IB 340 Premium Economy Thu, Nov 5 6:30 PM Orlando (MCO), Terminal C '
  + 'Fri, Nov 6 9:05 AM Madrid-Barajas (MAD), Terminal 4 Satellite Passenger Seat Booking Sample Traveller 14C Iberia confirmation: BJCMYO '
  + 'Timeline 3:30 PM Arrive at Orlando International Airport, Terminal C 6:30 PM Depart Orlando on IB 340';

const HOTEL = 'Expedia itinerary # 7354533998640 Your reservation is booked UMusic Hotel Madrid Calle de la Paz 11, 28012 Madrid '
  + 'Check-in Fri, Nov 6, 2026 3:00 PM Check-out Sat, Nov 7, 2026 12:00 PM Room: Premium Room, Courtyard 1 room, 1 night '
  + 'Guests: 2 adults Breakfast included Confirmation number: EXP-2559732991';

const RESORT = 'Booking confirmation Hotel: SAMPLE SEASIDE RESORT Address: 12 Harbour Road, Nassau, Bahamas '
  + 'Check-in: Friday, November 6, 2026 from 4:00 PM Check-out: Tuesday, November 10, 2026 11:00 AM '
  + 'Room type: Ocean view 2 adults, 4 nights Confirmation number: H88231 Cancellation: free until 48 hours before arrival';

const TOUR = 'Booking reference: GYGBLHBAXM6W Tapas & Wine Tasting Tour Date: Friday, November 6, 2026 Time: 7:00 PM '
  + 'Meeting point: Plaza de Santa Ana, at the statue in front of the theater Participants: 2 adults Voucher: show this on your phone';

const TRAIN = 'Renfe ticket Booking reference (localizador): NR22U2 Train AVE 02136 From Madrid Puerta de Atocha to Antequera AV '
  + 'Departure: Sat, Nov 7, 2026 13:35 Arrival: Sat, Nov 7, 2026 16:00 Coach 3 Seat 6B Passenger: Sample Traveller Platform shown 20 minutes before';

const TRANSFER = 'DayTrip Transfer confirmation Booking reference: DT48291 Pickup: Terminal 4 arrivals hall, Madrid-Barajas Airport '
  + 'Pickup date: Friday, November 6, 2026 Pickup time: 10:15 AM Drop-off: UMusic Hotel Madrid Passengers: 2 Driver will hold a sign';

const NOT = 'Quarterly newsletter: what is new this season at our office, a few recipes and a competition to win a prize. '
  + 'Thanks for reading, and see you at the next one.';

// ---------------------------------------------------------- primitives ---
is('a date written with a year', findDates('Check-in Fri, Nov 6, 2026 3:00 PM', '').map((d) => d.iso), ['2026-11-06']);
is('an airline date with a two digit year', findDates('Depart 10NOV26', '').map((d) => d.iso), ['2026-11-10']);
is('a day and month with no year takes the year nearest the trip',
  [findDates('Thu, Jan 7', '2026-12-28').map((d) => d.iso), findDates('Thu, Nov 5', '2026-11-04').map((d) => d.iso)],
  [['2027-01-07'], ['2026-11-05']]);
is('the same date is not found twice', findDates('Friday, November 6, 2026', '').length, 1);
is('times read as a person writes them', findTimes('6:30 PM, 9:05 am, 13:35, 7 PM').map((x) => x.hhmm),
  ['18:30', '09:05', '13:35', '19:00']);
is('noon and midnight', findTimes('12:00 PM and 12:30 AM').map((x) => x.hhmm), ['12:00', '00:30']);
is('a duration is not a time', findTimes('Flight time: 8 hours 35 minutes').length, 0);
is('a reference is the code beside its label, however the label is worded',
  [findReference('Booking reference: QX7P2L'), findReference('Iberia confirmation: BJCMYO'),
    findReference('Booking reference (localizador): NR22U2'), findReference('Confirmation number: EXP-2559732991')],
  ['QX7P2L', 'BJCMYO', 'NR22U2', 'EXP-2559732991']);
is('a sentence after the word is not a reference', findReference('Reservation confirmed, see below for details'), '');

// ------------------------------------------------------------- kinds ---
is('each kind of confirmation is recognised',
  [TICKET, HOTEL, RESORT, TOUR, TRAIN, TRANSFER].map((x) => classify(x).kind),
  ['flight', 'hotel', 'hotel', 'tour', 'train', 'transfer']);
is('a document that is none of them is not read', parseConfirmation(NOT, {}).read, false);

// ---------------------------------------------------------------- flights ---
{
  const r = parseConfirmation(TICKET, { depart: '2026-11-10' });
  is('an e-ticket gives one line for each flight', r.items.length, 2);
  is('with the right day, hour and airports, and the terminal it leaves from',
    slim(r), [['2026-11-10', '08:10', '09:30', 'flight', 'Iberia IB 6251, MAD to BCN', 'MAD Terminal 4'],
      ['2026-11-14', '19:45', '21:05', 'flight', 'Iberia IB 6254, BCN to MAD', 'BCN Terminal 1']]);
  is('the reference and the seat come with them', [r.items[0].confirmation, r.items[0].detail, r.items[1].detail],
    ['QX7P2L', 'Seat 12A', 'Seat 14C']);
  is('the reservation facts are offered', r.fields,
    { confirmationNumber: 'QX7P2L', supplier: 'Iberia', departDate: '2026-11-10', returnDate: '2026-11-14',
      productName: 'Flights MAD to BCN and back', productType: 'air' });
}
{
  const r = parseConfirmation(OVERNIGHT, { depart: '2026-11-05' });
  is('a flight named three times is one line', r.items.length, 1);
  is('leaving at half past six, arriving the next morning and not before it',
    [r.items[0].date, r.items[0].startTime, r.items[0].endTime, r.items[0].detail],
    ['2026-11-05', '18:30', '', 'Arrives 9:05 am on Nov 6']);
  is('with no year printed it is the trip\'s year', r.items[0].date.slice(0, 4), '2026');
  is('from the terminal it leaves', r.items[0].location, 'MCO Terminal C');
}
is('a time with no am or pm is read as 24 hour and said to be',
  parseConfirmation(TICKET, { depart: '2026-11-10' }).warnings.length, 2);

// ------------------------------------------------------------------ hotels ---
{
  const r = parseConfirmation(HOTEL, { depart: '2026-11-06' });
  is('a hotel is a check in and a check out, in that order',
    slim(r), [['2026-11-06', '15:00', '', 'hotel', 'Check in: UMusic Hotel Madrid', ''],
      ['2026-11-07', '12:00', '', 'hotel', 'Check out: UMusic Hotel Madrid', '']]);
  is('its facts are offered', r.fields,
    { confirmationNumber: 'EXP-2559732991', productName: 'UMusic Hotel Madrid', departDate: '2026-11-06',
      returnDate: '2026-11-07', productType: 'hotel' });
}
{
  const r = parseConfirmation(RESORT, { depart: '2026-11-06' });
  is('a labelled hotel gives its name in normal case and its address',
    slim(r), [['2026-11-06', '16:00', '', 'hotel', 'Check in: Sample Seaside Resort', '12 Harbour Road, Nassau, Bahamas'],
      ['2026-11-10', '11:00', '', 'hotel', 'Check out: Sample Seaside Resort', '12 Harbour Road, Nassau, Bahamas']]);
  is('the night count is the gap between the two dates', [r.fields.departDate, r.fields.returnDate], ['2026-11-06', '2026-11-10']);
}

// -------------------------------------------------- tours, trains, transfers ---
{
  const r = parseConfirmation(TOUR, { depart: '2026-11-06' });
  is('a tour is one activity with its start and its meeting point',
    slim(r), [['2026-11-06', '19:00', '', 'activity', 'Tapas & Wine Tasting Tour',
      'Plaza de Santa Ana, at the statue in front of the theater']]);
}
{
  const r = parseConfirmation(TRAIN, { depart: '2026-11-07' });
  is('a train leaves when the ticket says it does, from where it says',
    slim(r), [['2026-11-07', '13:35', '16:00', 'transfer', 'Train AVE 02136: Madrid Puerta de Atocha to Antequera AV', 'Madrid Puerta de Atocha']]);
  is('with the coach and the seat', r.items[0].detail, 'Coach 3, seat 6B');
}
{
  const r = parseConfirmation(TRANSFER, { depart: '2026-11-06' });
  is('a transfer is a pickup at a time and a place',
    slim(r), [['2026-11-06', '10:15', '', 'transfer', 'DayTrip Transfer', 'Terminal 4 arrivals hall, Madrid-Barajas Airport']]);
}

// ---------------------------------------------------------------- refusals ---
is('nothing is invented from almost nothing', parseConfirmation('Hello', {}).read, false);
is('a reference alone is still offered, and nothing else', parseConfirmation(
  'Your booking reference: ZZ99QX. Thank you for choosing us, we look forward to welcoming you very soon indeed.', {}).fields,
  { confirmationNumber: 'ZZ99QX' });
is('a hotel with no dates makes no lines',
  parseConfirmation('Hotel: Sample Inn Check-in: to be confirmed Check-out: to be confirmed Confirmation number: A1B2C3 Room: double', {}).items.length, 0);

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) process.exit(1);
