/**
 * Pay dates, and what an advisor may see before one.
 *
 * Commission is paid on the 1st and the 15th. The ways this goes wrong are quiet
 * and all of them pay somebody the wrong money on the wrong day: someone back on
 * October 31 paid on the 31st, someone leaving on November 15 paid on the 15th
 * before they have been anywhere, a month that rolls over into the wrong year, a
 * date that is not a date reaching a SQL string. Each is pinned here, along with
 * the remittance reader, because what it reads decides which advisor is paid.
 *
 * The remittance below is invented and laid out the way the real one reads once
 * its words have been pulled out of the PDF: the cells of a line arrive in the
 * order they were drawn, a long name wraps, and the date and amount that end a
 * line come last.
 */

import {
  PAY_DAYS, nextPayDate, payDatesFrom, suggestPayDate, dayAfter, hideAfterFor,
  receiptShown, statusShown,
} from '../src/paydates.js';
import { readRemittance, centsFrom, nameFit, nameWords } from '../src/remittance.js';
import { owedByDate } from '../src/commissionschedule.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::paydates: ${label}: ${detail}`);
};
const is = (label, got, want) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

// ------------------------------------------------------------ the calendar ---
is('the agency pays on the 1st and the 15th', PAY_DAYS, [1, 15]);
is('early in the month, the next one is the 15th', nextPayDate('2026-10-05'), '2026-10-15');
is('on the 1st, the pay date is that day', nextPayDate('2026-10-01'), '2026-10-01');
is('on the 15th, the pay date is that day', nextPayDate('2026-10-15'), '2026-10-15');
is('the day after the 15th rolls to the 1st', nextPayDate('2026-10-16'), '2026-11-01');
is('the last day of a month rolls to the 1st', nextPayDate('2026-10-31'), '2026-11-01');
is('the end of the year rolls into the new one', nextPayDate('2026-12-20'), '2027-01-01');
is('and so does the last day of it', nextPayDate('2026-12-31'), '2027-01-01');
is('February has a 15th', nextPayDate('2027-02-10'), '2027-02-15');
is('four dates ahead', payDatesFrom('2026-10-05', 4), ['2026-10-15', '2026-11-01', '2026-11-15', '2026-12-01']);
is('a list that starts on a pay date includes it', payDatesFrom('2026-11-01', 2), ['2026-11-01', '2026-11-15']);
is('the day after a month end', dayAfter('2026-10-31'), '2026-11-01');
is('not a date, not a day after', dayAfter('soon'), null);

// ------------------------------------------------------- the suggested day ---
const sug = (a) => suggestPayDate(a, '2026-10-05');
is('back on the 31st, paid on the 1st',
  sug({ receivedOn: '2026-10-05', returnDate: '2026-10-31' }), '2026-11-01');
is('leaving on the 15th, not paid on the 15th',
  sug({ receivedOn: '2026-10-13', departDate: '2026-11-15' }), '2026-12-01');
is('back on the 14th, paid on the 15th',
  sug({ receivedOn: '2026-10-13', returnDate: '2026-11-14' }), '2026-11-15');
is('the return date beats the departure',
  sug({ receivedOn: '2026-10-05', departDate: '2026-10-01', returnDate: '2026-10-31' }), '2026-11-01');
is('a reservation with no dates is paid on the next pay date',
  sug({ receivedOn: '2026-10-13' }), '2026-10-15');
is('money that arrives after the trip waits for the next pay date, not one in the past',
  sug({ receivedOn: '2026-11-20', returnDate: '2026-10-31' }), '2026-12-01');
is('a trip ending on the last day of the year is paid on New Year\'s Day',
  sug({ receivedOn: '2026-10-05', returnDate: '2026-12-31' }), '2027-01-01');
is('no received date means today', suggestPayDate({ returnDate: '2026-10-01' }, '2026-10-20'), '2026-11-01');

// -------------------------------------------------------- who sees what ---
is('an owner sees everything', hideAfterFor({ role: 'admin' }, '2026-10-05'), null);
is('an advisor sees up to the next pay date', hideAfterFor({ role: 'associate' }, '2026-10-05'), '2026-10-15');
is('an advisor on a pay date sees that pay date', hideAfterFor({ role: 'associate' }, '2026-11-01'), '2026-11-01');
is('nobody means the strictest reading', hideAfterFor(null, '2026-10-05'), null);
is('an owner\'s statement is not narrowed', receiptShown('r', null), '1 = 1');
is('an advisor\'s sees receipts on or before the date, and the ones with no date',
  receiptShown('r', '2026-11-01'), "(r.payout_on IS NULL OR r.payout_on <= '2026-11-01')");
{
  const s = receiptShown('r', "2026-11-01'; DROP TABLE bookings; --");
  is('a date that is not a date never reaches the SQL', s.includes('DROP'), false);
  is('and shows nothing instead', s.includes("'0000-00-00'"), true);
}
is('an owner reads the status as it is', statusShown('b', null), 'b.commission_status');
{
  const s = statusShown('b', '2026-11-01');
  is('an advisor reads received as pending while some of it is still waiting',
    /received[\s\S]*payout_on > '2026-11-01'[\s\S]*THEN 'pending'/.test(s), true);
}

// --------------------------------------------------------------- the check ---
is('money with a comma', centsFrom('1,234.50'), 123450);
is('money that is negative', centsFrom('-12.50'), -1250);
is('money in brackets is negative', centsFrom('(12.50)'), -1250);

const REMIT = `
Payment Remittance
Example Network
PO BOX 100
Anytown MN 55000
United States
Sample Travel Agency
1 Main St
Anytown FL 33000
United States
Check #    00012345/678
Vendor No.: EXNET1234567  October 2, 2026
Doc Number  Description  Doc Date  Net
Amount
SNAP-SEP26 Jordan
Lee_ABCD12_SAMPL_599 ARC Airline Ticket-12345_-_11/05/2026_VEX1234567 Jordan   Lee_EXG18XYZ | Jordan Lee_ABCD12_SAMPLE/PAT
MR
09/30/2026  48.60
SNAP-SEP26 Jordan Lee_QRST34_SAMPL_600 Hotel booking_-_12/10/2026_VEX1234567 Jordan Lee_QRST34_DOE/JANE
ANN MRS
09/30/2026  125.00
SNAP-AUG26 Jordan Lee_ZZZ999_REFUND_1 Refund of ticket_-_09/01/2026_VEX1234567 Jordan Lee_ZZZ999_ROE/RICK
08/31/2026  (10.00)
Total  163.60
`;

{
  const r = readRemittance(REMIT);
  is('it is read as a remittance', r.read, true);
  is('who paid', r.payer, 'Example Network');
  is('the check number', r.checkNumber, '00012345/678');
  is('the vendor number', r.vendorNo, 'EXNET1234567');
  is('the date on the page', r.remittedOn, '2026-10-02');
  is('the total', r.totalCents, 16360);
  is('three lines', r.lines.length, 3);
  is('and they add up, so there is no warning', r.warnings, []);

  const [a, b, c] = r.lines;
  is('a line\'s amount', [a.amountCents, b.amountCents, c.amountCents], [4860, 12500, -1000]);
  is('a refund is a negative line', c.amountCents < 0, true);
  is('the document date that ends the line', a.docDate, '2026-09-30');
  is('the travel date, which is not the document date', a.travelDate, '2026-11-05');
  is('the record locator', [a.locator, b.locator, c.locator], ['ABCD12', 'QRST34', 'ZZZ999']);
  is('the ticket number', a.ticket, '12345');
  is('the traveller, SURNAME/FIRST', a.traveller, { last: 'SAMPLE', first: 'PAT' });
  is('a traveller with a middle name and a title', b.traveller, { last: 'DOE', first: 'JANE ANN' });
  is('a traveller with no title', c.traveller, { last: 'ROE', first: 'RICK' });
  is('who the vendor says it was for', a.agent, 'Jordan Lee');
  is('what was sold, where the page says', [a.product, b.product], ['air', 'hotel']);
}
{
  const bumped = readRemittance(REMIT.replace('Total  163.60', 'Total  200.00'));
  is('a total that does not match its lines is flagged, not trusted', bumped.warnings.length, 1);
  is('an empty page is not a remittance', readRemittance('').read, false);
  is('a different kind of page is not one either', readRemittance('Your itinerary: Madrid to Barcelona').read, false);
  is('a remittance with no check number is not read', readRemittance(REMIT.replace(/Check #\s+\S+/, '')).read, false);
  is('one with no lines still gives its total', readRemittance(REMIT.split('Doc Number')[0] + 'Total  50.00').totalCents, 5000);
}


// ------------------------------------------------------ what is owed when ---
{
  const NOW = '2026-10-05';
  const line = (amount, on, kind = 'base') => ({ amount_cents: amount, payout_on: on, kind });
  is('one line, one date: the advisor\'s share of it',
    owedByDate([line(19800, '2026-11-01')], 80, 0, NOW), [{ date: '2026-11-01', cents: 15840 }]);
  is('a line with no date is payable at the next run',
    owedByDate([line(10000, null)], 50, 0, NOW), [{ date: NOW, cents: 5000 }]);
  is('a date already past is payable at the next run too',
    owedByDate([line(10000, '2026-09-15')], 50, 0, NOW), [{ date: NOW, cents: 5000 }]);
  is('two lines on two dates are two amounts',
    owedByDate([line(10000, '2026-10-15'), line(20000, '2026-11-01')], 50, 0, NOW),
    [{ date: '2026-10-15', cents: 5000 }, { date: '2026-11-01', cents: 10000 }]);
  is('lines are ordered by date whatever order they arrived in',
    owedByDate([line(20000, '2026-11-01'), line(10000, '2026-10-15')], 50, 0, NOW),
    [{ date: '2026-10-15', cents: 5000 }, { date: '2026-11-01', cents: 10000 }]);
  is('two lines on one date are one amount',
    owedByDate([line(10000, '2026-11-01'), line(5000, '2026-11-01')], 50, 0, NOW),
    [{ date: '2026-11-01', cents: 7500 }]);
  is('what has been paid comes off the earliest date first',
    owedByDate([line(10000, '2026-10-15'), line(20000, '2026-11-01')], 50, 5000, NOW),
    [{ date: '2026-11-01', cents: 10000 }]);
  is('and part of a date if it was only part paid',
    owedByDate([line(10000, '2026-10-15')], 50, 2000, NOW), [{ date: '2026-10-15', cents: 3000 }]);
  {
    // Three odd amounts at a split that rounds: the dates add up to the share of the whole.
    const rows = owedByDate([line(333, '2026-10-15'), line(333, '2026-11-01'), line(333, '2026-11-15')], 33, 0, NOW);
    is('the cents add up to the share of the whole, not of each line',
      rows.reduce((n, r) => n + r.cents, 0), Math.round(999 * 33 / 100));
  }
  is('a bonus is the advisor\'s in full whatever the split',
    owedByDate([line(10000, '2026-11-01', 'bonus')], 50, 0, NOW), [{ date: '2026-11-01', cents: 10000 }]);
  is('a refund takes money off a later date, not a smaller number than nothing',
    owedByDate([line(10000, '2026-10-15'), line(-4000, '2026-11-01')], 50, 0, NOW),
    [{ date: '2026-10-15', cents: 5000 }, { date: '2026-11-01', cents: -2000 }]);
  is('nothing received is nothing owed', owedByDate([], 50, 0, NOW), []);
}
// -------------------------------------------------------------- the names ---
is('words of a name', nameWords('Pat & Sam Sample-Jones'), ['PAT', 'SAM', 'SAMPLE', 'JONES']);
is('a surname and a first name is a good fit', nameFit({ last: 'SAMPLE', first: 'PAT' }, ['Pat Sample']), 2);
is('a surname alone is a candidate, not an answer', nameFit({ last: 'SAMPLE', first: 'PAT' }, ['Sam Sample']), 1);
is('a different surname is no fit', nameFit({ last: 'SAMPLE', first: 'PAT' }, ['Pat Other']), 0);
is('a booking under both names fits', nameFit({ last: 'SAMPLE', first: 'PAT' }, ['Sam & Pat Sample']), 2);
is('no traveller is no fit', nameFit(null, ['Pat Sample']), 0);

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) process.exit(1);
