/**
 * A forwarded confirmation becomes a reservation on its own only when it is plainly safe to.
 *
 * What goes wrong here is not a crash, it is a reservation nobody asked for. A message sent by a stranger to a
 * guessable first-name address. An offer taken for a booking. A sailing that has already happened. A price in lines that
 * does not add up to the total, so the Pricing tab would disagree with the trip. Each is pinned here, along with the
 * one thing that lets a message through: the mail system saying it checked who sent it.
 *
 * The reading is invented. The point is the rule, not the reader.
 */

import { verdict, senderVouched, priceColumns } from '../src/autoimport.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::autoimport: ${label}: ${detail}`);
};
const is = (label, got, want) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

const TODAY = '2026-10-24';
const clean = () => ({
  fields: {
    clientName: 'Pat Sample', confirmationNumber: '9746343', supplier: 'Royal Caribbean', productName: 'Harmony of the Seas',
    departDate: '2027-03-13', returnDate: '2027-03-20', gross: '4871.40', deposit: '1000.00', depositRefundable: 'nonrefundable',
  },
  pricing: null,
});

is('a plain complete reading is clean', verdict(clean(), TODAY).ok, true);

for (const [key, word] of [['clientName', 'the client'], ['confirmationNumber', 'the confirmation number'], ['supplier', 'the cruise line'],
  ['productName', 'the ship'], ['departDate', 'the departure date'], ['returnDate', 'the return date'], ['gross', 'the trip total']]) {
  const r = clean();
  delete r.fields[key];
  const v = verdict(r, TODAY);
  is(`without ${word} it is held`, [v.ok, v.why.includes(word)], [false, true]);
}

{
  const r = clean();
  r.fields.departDate = '2026-10-01';
  r.fields.returnDate = '2026-10-08';
  is('a sailing that has already happened is held', verdict(r, TODAY).ok, false);
}
{
  const r = clean();
  r.fields.status = 'quoted';
  is('an offer is held', verdict(r, TODAY).ok, false);
}
{
  const r = clean();
  delete r.fields.depositRefundable;
  is('a deposit that does not say whether it comes back is held', verdict(r, TODAY).ok, false);
  r.fields.deposit = '0';
  is('but no deposit has nothing to say', verdict(r, TODAY).ok, true);
}
{
  const r = clean();
  r.pricing = { lines: [{ kind: 'fare', amount: '4000.00' }], guests: [], notes: [] };
  is('price lines that do not add up to the total are held', verdict(r, TODAY).ok, false);
  r.pricing = { lines: [{ kind: 'fare', amount: '4000.00' }, { kind: 'taxes', amount: '871.40' }], guests: [], notes: [] };
  is('and ones that do are clean', verdict(r, TODAY).ok, true);
  r.pricing = {
    lines: [{ kind: 'fare', amount: '4871.40' }],
    guests: [{ name: 'Pat Sample', fare: '2435.70', taxes: '', insurance: '', gratuities: '' }, { name: '', fare: '2435.70', taxes: '', insurance: '', gratuities: '' }],
    notes: [],
  };
  is('a guest with no name on a split price is held', verdict(r, TODAY).ok, false);
  r.pricing.guests[1].name = 'Sam Sample';
  is('named, it is clean', verdict(r, TODAY).ok, true);
  is('and the price is one column a guest', priceColumns(r).length, 2);
}

const headers = (o) => new Headers(o);
is('a message the mail system passed is vouched for', senderVouched(headers({ 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass' })), true);
is('spf alone is enough', senderVouched(headers({ 'received-spf': 'pass (example.com: sender is authorized)' })), true);
is('a message with no verdict at all is not', senderVouched(headers({ from: 'a@example.com' })), false);
is('a failed one is not', senderVouched(headers({ 'authentication-results': 'mx.cloudflare.net; dkim=fail; spf=pass' })), false);
is('nor a soft fail', senderVouched(headers({ 'authentication-results': 'mx; spf=softfail' })), false);
is('nor missing headers', senderVouched(null), false);

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) process.exit(1);
