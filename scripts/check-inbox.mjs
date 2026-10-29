/**
 * A confirmation forwarded by email is read the way it was sent.
 *
 * What goes wrong with mail is quiet. A message that carries a plain text version and an HTML one,
 * where the plain one is a single line saying "view this in your browser" and the HTML holds the
 * whole booking. A forward made by attaching the original, so the confirmation is one level down.
 * Text in base64 or quoted-printable that is read as the gibberish it looks like. A table whose
 * cells run together so a label and its figure end up on different lines. A newsletter that happens
 * to say "cruise" being held as though it were a booking. Each is pinned here.
 *
 * Every message below is invented, and shaped like what each kind of mail does. It proves the reader
 * copes with the shape; the first real forward of each is the proof that it copes with the real one.
 */

import { readableParts, htmlToText } from '../src/mime.js';
import { bestReading } from '../src/inbox.js';
import { parseConfirmation } from '../src/confirm.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::inbox: ${label}: ${detail}`);
};
const is = (label, got, want) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

// A booking in the shape Carnival's advisor copy prints it, as rows of a table.
const ROWS = [
  ['BOOKING #: VJ40F6  |  SAILING DATE:'], ['Booking Confirmed'], ['TRAVEL ADVISOR COPY'],
  ['Thanks for booking your client on their 4 Day Western Caribbean itinerary.'],
  ['Ship', 'Room View'], ['Carnival Paradise'], ['Sep/24/2026', 'Ocean View'],
  ['Cabin Number', 'Dining'], ['Room #U65', 'Early Dining'],
  ['ITEMIZED CHARGES'], ['Total', '$896.00 USD'], ['Cruise Charges', '$768.00 USD'],
  ['Cruise Rate', '$500.00 USD'], ['Non-Commission Amount', '$38.00 USD'],
  ['Required Cruise Fees & Expenses', '$114.64 USD'], ['Government Taxes & Fees', '$115.36 USD'],
  ['OTHER CHARGES'], ['Pre-Paid Gratuities', '$128.00 USD'],
  ['Net Balance Due', '$716.00 USD'], ['Total Commission', '$80.00 USD'],
  ['Final Payment Due Date', 'Jul/11/2026'],
  ['GUEST DETAILS', 'VIFP', 'Vacation Protection'], ['Sample, Alex', '', 'GOLD'], ['Example, Bea', '', 'BLUE'],
  ['DAY', 'DATE', 'PORT OF CALL', 'ARRIVE', 'DEPART'],
  ['Thursday', 'Sep/24/2026', 'Tampa, Fl', '', '3:30 PM'],
  ['Monday', 'Sep/28/2026', 'Tampa, Fl', '8:00 AM', ''],
  ['Guest Notes'], ['Applies to guests 1, 2. Deposit is non-refundable and non transferable.'],
];

const html = `<html><head><style>td { color: red; }</style></head><body><table>${ROWS.map((r) =>
  `<tr>${r.map((c) => `<td>${c.replace(/&/g, '&amp;')}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
const plain = ROWS.map((r) => r.join('\t')).join('\n');

const message = (headers, body) => `${headers.join('\r\n')}\r\n\r\n${body}`;
const alt = (parts) => message([
  'From: Brent <brent@example.test>', 'To: conf-abc@example.test', 'Subject: Fwd: Booking Confirmation',
  'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"',
], `${parts.map((p) => `--b1\r\n${p}`).join('\r\n')}\r\n--b1--\r\n`);
const part = (type, body, encoding = '7bit') => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${body}\r\n`;

const b64 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/(.{76})/g, '$1\r\n');
const qp = (s) => unescape(encodeURIComponent(s)).replace(/=/g, '=3D').replace(/[\u0080-ÿ]/g, (c) => `=${c.charCodeAt(0).toString(16).toUpperCase()}`);

// ------------------------------------------------------------ the table ---
{
  const text = htmlToText(html);
  is('a table row is one line with a tab between its cells', text.split('\n').find((l) => l.startsWith('Total\t')), 'Total\t$896.00 USD');
  is('an ampersand in a cell comes back as an ampersand',
    text.split('\n').some((l) => l.startsWith('Required Cruise Fees & Expenses\t')), true);
  is('a style block is not text', /color: red/.test(text), false);
}

// ----------------------------------------- html beats a one line text ---
{
  const raw = alt([part('text/plain', 'Your confirmation is best viewed in a browser.'), part('text/html', html)]);
  const { best } = await bestReading(raw);
  const f = best.read.fields;
  is('the HTML is read when the plain text version is only a pointer to it', best.source, 'html');
  is('the number, the ship and the money come off it', [f.confirmationNumber, f.productName, f.gross, f.commission],
    ['VJ40F6', 'Carnival Paradise', '896.00', '80.00']);
  is('and the guests, turned the right way round', best.read.guests, ['Alex Sample', 'Bea Example']);
  is('and the price adds up to the total it states', best.read.pricing && best.read.pricing.balanced, true);
}

// ----------------------------------- the same email as run together text ---
{
  // What a plain text version made from the same HTML looks like: the cells of a row on one line with
  // spaces between them, and a guest's loyalty tier stuck on the end of the name.
  const flat = ROWS.map((r) => r.filter(Boolean).join(' ')).join('\n');
  const raw = message(['From: a@example.test', 'Subject: Fwd', 'Content-Type: text/plain; charset=utf-8'], flat);
  const { best } = await bestReading(raw);
  is('a plain text version with the cells run together still gives the number, ship and money',
    [best.read.fields.confirmationNumber, best.read.fields.productName, best.read.fields.gross],
    ['VJ40F6', 'Carnival Paradise', '896.00']);
  is('and the guests, without the loyalty tier after their names', best.read.guests, ['Alex Sample', 'Bea Example']);
  is('and the cabin and its view', [best.read.fields.cabin, best.read.fields.cabinCategory], ['U65', 'Ocean View']);
}

// -------------------------------------------------------- encodings ---
{
  const raw = alt([part('text/html', b64(html), 'base64')]);
  const { best } = await bestReading(raw);
  is('a base64 body is decoded before it is read', best.read.fields.confirmationNumber, 'VJ40F6');
}
{
  const raw = alt([part('text/html', qp(html), 'quoted-printable')]);
  const { best } = await bestReading(raw);
  is('a quoted-printable body is decoded before it is read', best.read.fields.confirmationNumber, 'VJ40F6');
}

// ------------------------------------------------- forwarded ways ---
{
  const inner = alt([part('text/html', html)]);
  const wrapper = message([
    'From: Brent <brent@example.test>', 'To: conf-abc@example.test', 'Subject: Fwd', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
  ], `--outer\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n--outer\r\nContent-Type: message/rfc822\r\n\r\n${inner}\r\n--outer--\r\n`);
  const { best } = await bestReading(wrapper);
  is('a forward made by attaching the original is read from inside the attachment', best.read.fields.confirmationNumber, 'VJ40F6');
}
{
  const quoted = plain.split('\n').map((l) => `> ${l}`).join('\n');
  const raw = message(['From: a@example.test', 'Subject: Fwd', 'Content-Type: text/plain; charset=utf-8'],
    `Please add this one.\n\n---------- Forwarded message ---------\n${quoted}`);
  const { best } = await bestReading(raw);
  is('a forward quoted with > marks is read as it was written', best.read.fields.confirmationNumber, 'VJ40F6');
}

// ------------------------------------------------------ pdf parts ---
{
  const raw = message([
    'From: a@example.test', 'Subject: Confirmation', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="m"',
  ], `--m\r\nContent-Type: text/plain\r\n\r\nAttached.\r\n--m\r\nContent-Type: application/pdf; name="conf.pdf"\r\nContent-Disposition: attachment; filename="conf.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa('%PDF-1.4 not a real file')}\r\n--m--\r\n`);
  const parts = readableParts(raw);
  is('a PDF attachment is found, by its type or its name', parts.pdfs.map((p) => p.filename), ['conf.pdf']);
}

// ----------------------------------------- a header laid out across a line ---
{
  // An agent confirmation whose first page runs several labelled facts along one line, two without a colon, and a note in brackets
  // after the number. Invented, and shaped like the real one.
  const header = [
    'TEST TRAVEL LLC Reservation ID: 7654321 (Group ID Not Applicable) Booking Date: 23 OCT 2026',
    'Attn: PAT AGENT Ship: OASIS OF THE SEAS Booking Status Booked',
    '5551234567 Departure Date: 25 JAN 2027',
    '1 SAMPLE STREET Itinerary: 4 NIGHT BAHAMAS & PERFECT DAY CRUISE',
    'CITY,FL-33000 Stateroom: 1J-11191 Central Park View Balcony',
    'UNITED STATES Stateroom Obstructed View Percentage 0%',
    'Sailing Date: 25 JAN 2027', 'Promo Restrictions :',
  ];
  const r = parseConfirmation(header.join('\n'));
  is('a ship is not run together with the label after it', r.fields.productName, 'OASIS OF THE SEAS');
  is('and nothing on the page is taken for the guest, since no guest is named', r.fields.clientName, undefined);
  is('a number is not run together with the note in brackets', r.fields.confirmationNumber, '7654321');
  is('a return date worked out from "4 NIGHT" is flagged as worked out', [r.fields.returnDate, r.derived], ['2027-01-29', ['returnDate']]);
  const h2 = parseConfirmation(['General Information', ...header].join('\n'));
  is('a heading above it is not taken as the guest', h2.fields.clientName, undefined);
  const printed = parseConfirmation([...header, 'Return Date: 29 JAN 2027'].join('\n'));
  is('a return date that is printed is used and not flagged', [printed.fields.returnDate, printed.derived], ['2027-01-29', []]);

  // An offer with no number yet: "Booking ID" there introduces a paragraph of terms, and a sentence is not a number.
  const offer = [
    'Attn: PAT AGENT Ship: EXPLORER OF THE SEAS Booking Status Offer', 'Sailing Date: 16 DEC 2026',
    'Booking ID: When you make your booking with us, please ensure that you provide your first name and last name as it appears on your passport.',
  ];
  is('a sentence after Booking ID is not taken as the confirmation number', parseConfirmation(offer.join('\n')).fields.confirmationNumber, undefined);
  is('and a real number further down is still found', parseConfirmation([...offer, 'Booking ID: 8765432'].join('\n')).fields.confirmationNumber, '8765432');
}

// ------------------------------------------------- picture attachments ---
{
  // A screenshot of a confirmation, sent as a picture. It has to be found so it can be read, and a small logo in a signature must not be.
  const big = btoa(String.fromCharCode(...Array.from({ length: 12000 }, (_x, i) => (i * 7) % 256)));
  const logo = btoa(String.fromCharCode(...Array.from({ length: 900 }, (_x, i) => (i * 5) % 256)));
  const raw = message([
    'From: a@example.test', 'Subject: Fwd: Confirmation', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="m"',
  ], `--m\r\nContent-Type: text/plain\r\n\r\nSee the screenshot.\r\n--m\r\nContent-Type: image/png; name="shot.png"\r\nContent-Disposition: attachment; filename="shot.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${big}\r\n--m\r\nContent-Type: image/png; name="logo.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${logo}\r\n--m--\r\n`);
  const parts = readableParts(raw);
  is('a screenshot attached to the message is found, and a small logo is not', parts.images.map((p) => p.filename), ['shot.png']);
  const { best } = await bestReading(raw);
  is('and with no AI bound a message with only a picture reads as nothing, without failing', best ? Object.keys(best.read.fields || {}).length : 0, 0);
}

// ----------------------------------------------------- not a booking ---
{
  const news = alt([part('text/plain', 'Our summer cruise sale is on. Book now and save on a cruise to the Caribbean.')]);
  const { best } = await bestReading(news);
  const f = best ? best.read.fields : {};
  is('a newsletter is not mistaken for a booking: nothing that identifies a trip is found',
    ['confirmationNumber', 'departDate', 'gross', 'productName'].filter((k) => f[k]), []);
}

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) process.exit(1);
