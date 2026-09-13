// Does an email still say what it has to say once it is rendered?
//
// Everything else in this repository checks the code. This checks the one
// artifact that leaves it: the message a client opens. It renders a real
// marketing email and a real transactional one and asserts the things that
// are invisible from the source and expensive to get wrong.
//
// The first is the one that matters most. A marketing email carries a way out,
// and the plain-text alternative every client is sent alongside the HTML has
// to carry it too: a mail reader set to plain text, and a good number of spam
// filters, only ever see that half. The text version is built by stripping
// tags out of the HTML, so a change to the footer's markup can quietly drop
// the link from it while the HTML still looks right in a preview.
//
// There is deliberately no postal address in the footer. Brent asked for it
// left off on 2026-09-13, having been told what US commercial email is
// supposed to carry. So this asserts the address is absent rather than
// present: whichever way that decision goes, it should be on purpose and not
// drift back by accident.
//
// The third is the opposite, and it is the one that would be embarrassing: a
// payment reminder must NOT offer to unsubscribe. Offering to stop sending
// somebody their own payment dates is not a kindness, and a client who takes
// it up then misses a deadline nobody told them about.
//
//   node scripts/check-email.mjs

import { layout, plainText } from '../src/email.js';
import { marketingFooter } from '../src/suppression.js';
import { annotate } from './lib/annotate.mjs';

const env = { APP_URL: 'https://example.test' };
const UNSUB = 'https://example.test/u/dGVzdDpjbGllbnRAZXhhbXBsZS5jb20.0123456789ab';

const marketing = layout(env, {
  heading: 'One cabin left',
  body: '<p style="margin:0;">Hello Ed,<br>One thing before you go.</p>',
  footer: marketingFooter({
    agencyName: 'Test Travel',
    unsubscribeUrl: UNSUB,
  }),
});

const transactional = layout(env, {
  heading: 'Payment due',
  body: '<p style="margin:0;">The balance for your trip is due on 26 September.</p>',
});

// The same footer, given an address it should ignore.
const withAddress = marketingFooter({
  agencyName: 'Test Travel',
  agencyAddress: '100 Harbour Way, Tampa, FL 33602',
  unsubscribeUrl: UNSUB,
});

const marketingText = plainText(marketing);
const transactionalText = plainText(transactional);

const checks = [
  ['the marketing HTML carries the unsubscribe link', marketing.includes(UNSUB)],
  ['and the plain text alternative carries it too', marketingText.includes(UNSUB)],
  ['the agency name survives into the plain text', /Test Travel/.test(marketingText)],
  // Asked for, not an oversight. See the note at the top of this file.
  //
  // Proved by handing the footer an address and finding it absent, rather than
  // by hunting the output for something that looks like one. The first version
  // of this looked for five digits in a row and matched the unsubscribe token,
  // which is exactly the kind of assertion that fails for the wrong reason and
  // then gets deleted.
  ['an address handed to the footer is not printed', !withAddress.includes('Harbour Way')],
  ['the plain text has no markup left in it', !/<[a-z/]/i.test(marketingText)],
  ['and is not empty', marketingText.trim().length > 60],
  // The merge fields are filled in before this point, so a brace reaching the
  // renderer means somebody will read "Hello {{first_name}}".
  ['no unrendered merge field', !/\{\{/.test(marketing)],
  // The other half of the rule, and the one worth being strict about.
  ['a transactional email offers no way to unsubscribe',
    !/unsubscribe/i.test(transactionalText)],
  ['and carries no opt-out link', !/\/u\//.test(transactional)],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${label}`);
  if (!ok) {
    failed += 1;
    annotate('Email render', label);
  }
}

console.log('');
if (failed) {
  console.log(`${failed} of ${checks.length} things a rendered email must do are not done.`);
  process.exit(1);
}
console.log(`check-email: all ${checks.length} render checks pass`);
