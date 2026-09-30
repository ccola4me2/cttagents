/**
 * The trip page puts several reservations in date order, and says nothing it should not.
 *
 * Samantha's Spain holiday is nine reservations. What a client needs from them is
 * one timeline, and the ways that goes wrong are quiet: a check out listed after the
 * next hotel's check in, a day missing so the list reads as if Tuesday never
 * happened, a reservation with no date taking the whole page with it, a name with a
 * tag in it arriving as markup. None of those fail anything until a client opens the
 * link, so this builds a trip of the shape that matters and reads the days back.
 *
 * The fixtures are invented and shaped like the real thing: hotels that hand over on
 * the same day, a flight each way, a tour with a timed itinerary line.
 */

import { planDays, planBody } from '../src/tripplan.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::trips: ${label}: ${detail}`);
};
const is = (label, got, want) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

const b = (o) => ({ share_code: null, status: 'booked', supplier: '', destination: '', confirmation_number: '',
  gross_cents: 0, itinerary_shared: 0, ...o });

const FLIGHTS = b({ id: 'a', product_type: 'air', product_name: 'Flights to Madrid', supplier: 'Iberia',
  depart_date: '2026-11-02', return_date: '2026-11-12', confirmation_number: 'IB1234', gross_cents: 120000 });
const HOTEL1 = b({ id: 'h1', product_type: 'hotel', product_name: 'Hotel Madrid', depart_date: '2026-11-03',
  return_date: '2026-11-06', confirmation_number: 'M-1' });
const HOTEL2 = b({ id: 'h2', product_type: 'hotel', product_name: 'Hotel Sevilla', depart_date: '2026-11-06',
  return_date: '2026-11-10', share_code: 'CODE2' });
const TOUR = b({ id: 't', product_type: 'tour', product_name: 'Alhambra tour', supplier: 'GetYourGuide',
  depart_date: '2026-11-08', return_date: '2026-11-08', itinerary_shared: 1 });
const NODATE = b({ id: 'n', product_type: 'other', product_name: 'Travel insurance' });
const ITEMS = [
  { booking_id: 't', day_number: 1, start_time: '09:30', end_time: '12:00', kind: 'activity',
    title: 'Meet the guide', location: 'Plaza Nueva', detail: 'Wear good shoes', confirmation: 'GYG9' },
  { booking_id: 't', day_number: 1, start_time: '08:00', end_time: null, kind: 'meal', title: 'Breakfast',
    location: '', detail: '', confirmation: '' },
];

const days = planDays([TOUR, HOTEL2, NODATE, FLIGHTS, HOTEL1], ITEMS);
const on = (date) => days.find((d) => d.date === date);

is('every day from the first reservation to the last is there, empty ones too', [days.length, days[0].date, days[days.length - 1].date],
  [11, '2026-11-02', '2026-11-12']);
is('days are numbered from the first', [days[0].n, days[10].n], [1, 11]);
is('a reservation with no date is left off the days rather than breaking them',
  days.some((d) => d.events.some((e) => e.title === 'Travel insurance')), false);
is('a check out comes before the next hotel\'s check in on the day they hand over',
  on('2026-11-06').events.map((e) => `${e.word}: ${e.title}`), ['Check out: Hotel Madrid', 'Check in: Hotel Sevilla']);
is('a flight shows on each way', [on('2026-11-02').events[0].word, on('2026-11-12').events[0].word],
  ['Outbound flight', 'Return flight']);
is('the middle of a stay says where the client is sleeping', on('2026-11-04').staying, ['Hotel Madrid']);
is('an itinerary line lands on its own date and is in time order, before the tour itself',
  on('2026-11-08').events.map((e) => e.title), ['Breakfast', 'Meet the guide', 'Alhambra tour']);
is('a day with nothing on it is still a day', [on('2026-11-05').events.length, on('2026-11-05').staying],
  [0, ['Hotel Madrid']]);
is('a long absurd range is cut rather than printed',
  planDays([b({ id: 'x', product_type: 'hotel', product_name: 'X', depart_date: '2026-01-01', return_date: '2029-01-01' })], []).length, 150);
is('no dated reservation, no days', planDays([NODATE], []), []);

// The page itself.
const env = { APP_URL: 'https://example.test' };
const trip = { id: 'T', name: 'Spain <b>2026</b>', intro: 'Welcome & enjoy', tips: 'Bring "cash"', share_code: 'ABC123',
  user_id: 'u', first_name: 'Pat', last_name: 'Advisor', advisor_email: 'pat@example.test', notify_email: '',
  advisor_phone: '555', agency_name: 'Sample Agency', seller_of_travel: 'ST123' };
const paid = new Map([['a', { paid_cents: 50000, due_cents: 70000, next_due: '2026-09-01' }]]);
const html = planBody(env, { trip, bookings: [FLIGHTS, HOTEL1, HOTEL2, TOUR, NODATE],
  items: ITEMS, travellers: [{ name: 'Sam Client', is_lead: 1 }, { name: 'Sam Client', is_lead: 0 }], paid });

is('a name with markup in it arrives as text', [html.includes('Spain <b>2026</b>'), html.includes('Spain &lt;b&gt;2026&lt;/b&gt;')], [false, true]);
is('the welcome and tips are there, escaped', [html.includes('Welcome &amp; enjoy'), html.includes('Bring &quot;cash&quot;')], [true, true]);
is('a traveller on two reservations is named once', html.split('Sam Client').length - 1, 1);
is('a reservation with its own page links to it, one without does not',
  [html.includes('href="/t/CODE2"'), (html.match(/href="\/t\//g) || []).length], [true, 1]);
is('the costs add up across reservations and say what is still owed',
  [html.includes('$1,200.00'), html.includes('$500.00'), html.includes('$700.00')], [true, true, true]);
is('the costs can be left off a printed copy', html.includes('hp-cost') && html.includes('display:none'), true);
is('the link a printed copy points back to is this trip\'s', html.includes('data-url="https://example.test/i/ABC123"'), true);
is('a trip with nothing booked says so instead of an empty list',
  planBody(env, { trip, bookings: [], items: [], travellers: [], paid: new Map() }).includes('Nothing is booked on this trip yet'), true);

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) process.exit(1);
