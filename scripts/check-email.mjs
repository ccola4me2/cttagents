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
// The third used to be the opposite. A payment reminder was asserted NOT to offer
// an unsubscribe, on the reasoning that stopping somebody's own payment dates is
// no kindness. That was changed on 2026-10-01 at Brent's direction: every email
// to a client carries a way out, a payment reminder and a quote included. What
// the link stops is the AUTOMATIC email, so a client who takes it up still hears
// from their advisor and the advisor can see on the record that they asked. What
// is asserted here now is that every sender a client's mail comes from has the
// link, in the HTML, in the plain text, and in the List-Unsubscribe header.
//
//   node scripts/check-email.mjs

import {
  layout, plainText, linkify, escapeHtml, withUnsubscribe, unsubscribeParts,
  sendPaymentReminder, sendReviewRequest, sendFormInviteEmail, sendTripReplyEmail, sendHtml,
  sendAutomationEmail, sendTaskDigestEmail, sendCallListEmail,
} from '../src/email.js';
import { readToken } from '../src/unsubtoken.js';
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

// A link somebody pastes into the body, and the ways that can go wrong.
const pasted = 'Book here: https://example.test/s/ALASKA26. Reply if you want it.';
const linked = linkify(escapeHtml(pasted));
const injection = linkify(escapeHtml('https://x.test/a"onmouseover="alert(1)'));

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
  // A URL in the body is grey text unless something makes it a link, and the
  // client whose mail reader does not linkify one by itself is always the one
  // you most wanted to reach.
  ['a pasted link becomes clickable',
    linked.includes('<a href="https://example.test/s/ALASKA26"')],
  ['and the sentence it sits in keeps its full stop outside the link',
    linked.includes('</a>. Reply')],
  ['and the text alternative does not print the address twice',
    plainText(`<p>${linked}</p>`).includes('ALASKA26. Reply')
      && !plainText(`<p>${linked}</p>`).includes('(https://example.test')],
  // Escaping runs before linkifying, so a quote in a pasted URL cannot close
  // the attribute it lands in. This is the assertion that matters most here:
  // the body is text a person typed, and it ends up inside an href.
  ['a quote in a pasted URL cannot break out of the attribute',
    !/href="[^"]*"[^>]*on\w+=/i.test(injection) && injection.includes('&quot;')],

];

// ---------------------------------------------------------------------------
// Every sender a client's mail comes from
// ---------------------------------------------------------------------------
//
// Called for real, with the network replaced by something that keeps what was
// posted. Each message is judged as the client receives it: the HTML, the plain
// text and the header a mail app's unsubscribe button reads.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push(JSON.parse(init.body));
  return { ok: true, status: 200, text: async () => '' };
};
const live = { ...env, RESEND_API_KEY: 'test', UNSUBSCRIBE_SECRET: 'check-email', MAIL_FROM: 'Test <t@example.test>' };
const to = 'client@example.com';

try {
  await sendPaymentReminder(live, { to, clientName: 'Ed', advisorName: 'Pat', agencyName: 'Test Travel', agencyId: 'ag1',
    amountCents: 190000, dueDate: '2026-09-26', hard: true, kind: 'final', tripName: 'Alaska' });
  await sendReviewRequest(live, { to, clientName: 'Ed', advisorName: 'Pat', agencyName: 'Test Travel', agencyId: 'ag1',
    tripName: 'Alaska', href: 'https://example.test/t/x' });
  await sendFormInviteEmail(live, { to, clientName: 'Ed', advisorName: 'Pat', agencyName: 'Test Travel', agencyId: 'ag1',
    formName: 'Trip questions', href: 'https://example.test/f/x' });
  await sendTripReplyEmail(live, { to, clientName: 'Ed', advisorName: 'Pat', tripName: 'Alaska', body: 'Hello',
    href: 'https://example.test/t/x', agencyId: 'ag1', agencyName: 'Test Travel' });
  await sendHtml(live, { to, subject: 'Your quote', html: '<html><body><p>A quote.</p></body></html>',
    unsubscribe: { agencyId: 'ag1', agencyName: 'Test Travel' } });
  await sendHtml(live, { to, subject: 'Your link', html: '<p>A fragment with no body tag.</p>',
    unsubscribe: { agencyId: null } });
  const url = `${env.APP_URL}/u/${(await unsubscribeParts(live, { to, agencyId: 'ag1' })).url.split('/u/')[1]}`;
  await sendAutomationEmail(live, to, 'Hello', 'Body', {
    // Both ways a portal may be asked: a footer and header built by the caller (a list
    // send), or the way out asked for by agency (an automation).
    footer: marketingFooter({ agencyName: 'Test Travel', unsubscribeUrl: url }), unsubscribeUrl: url,
    unsubscribe: { agencyId: 'ag1', agencyName: 'Test Travel' },
  });
} finally {
  globalThis.fetch = realFetch;
}

const names = ['a payment reminder', 'a review request', 'a form invite', 'a trip reply', 'a quote or invoice',
  'a sign in link', 'an automatic or marketing email'];
sent.forEach((m, i) => {
  const html = m.html || '';
  const link = (html.match(/https:\/\/example\.test\/u\/[A-Za-z0-9._-]+/) || [])[0] || '';
  checks.push([`${names[i]} carries an unsubscribe link`, Boolean(link) && /unsubscribe/i.test(html)]);
  checks.push([`and its plain text carries it too`, /\/u\//.test(m.text || '') && /unsubscribe/i.test(m.text || '')]);
  checks.push([`and the List-Unsubscribe header names the same address`,
    (m.headers || {})['List-Unsubscribe'] === `<${link}>`
      && (m.headers || {})['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click']);
});
checks.push(['every one of the seven was sent', sent.length === names.length]);
checks.push(['a message that already carries a link does not get a second', (() => {
  const once = withUnsubscribe('<body>x <a href="https://example.test/u/abc.def">Unsubscribe</a></body>',
    { block: '<p>MORE</p>' });
  return !once.includes('MORE');
})()]);
// The link is the person's own, for the agency it was sent under.
const who = await readToken(live, (sent[0]?.html.match(/\/u\/([A-Za-z0-9._-]+)/) || [])[1]);
checks.push(['the link is signed for that client and that agency', who && who.email === to && who.agencyId === 'ag1']);

// The automatic payment reminder is not sent to somebody who has unsubscribed, and
// the pass says it skipped them rather than that nothing was due.
{
  const { remindDuePayments } = await import('../src/payremind.js');
  const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const row = { id: 'p1', booking_id: 'b1', user_id: 'u1', amount_cents: 190000, due_date: soon, payment_class: 'hard',
    kind: 'final', auto_lead_sent: null, reminded_at: null, client_name: 'Ed', product_name: 'Alaska',
    supplier: 'Line', confirmation_number: 'X1', client_id: 'c1', client_email: to, client_record_name: 'Ed',
    first_name: 'Pat', last_name: 'Advisor', advisor_email: 'pat@example.test', notify_email: null,
    agency_name: 'Test Travel', agency_id: 'ag1', advisor_phone: '555' };
  const posted = [];
  globalThis.fetch = async (u, init) => { posted.push(init.body); return { ok: true, status: 200, text: async () => '' }; };
  const fake = (optedOut) => ({ ...live, DB: { prepare: (sql) => ({ bind: () => ({
    all: async () => ({ results: [row] }),
    first: async () => (/email_suppression/.test(sql) && optedOut ? { yes: 1 } : null),
    run: async () => ({ meta: { changes: 1 } }),
  }) }) } });
  try {
    const skipped = await remindDuePayments(fake(true), {});
    checks.push(['an automatic reminder skips somebody who has unsubscribed', skipped.optedOut === 1 && skipped.sent === 0 && posted.length === 0]);
    const normal = await remindDuePayments(fake(false), {});
    checks.push(['and still goes to everybody else, with the link', normal.sent === 1 && /\/u\//.test(posted[0] || '')]);
  } finally { globalThis.fetch = realFetch; }
}

// The colleagues' recurring mail points at the switch that turns it off.
const digestHtml = await (async () => {
  globalThis.fetch = async (u, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '' }; };
  try {
    await sendTaskDigestEmail(live, { to: 'pat@example.test', firstName: 'Pat', due: [{ title: 'Ring Ed' }], late: [] });
    await sendCallListEmail(live, { to: 'pat@example.test', firstName: 'Pat', lists: [{ key: 'home', label: 'Home from a trip', rows: [{ name: 'Ed', days: 3 }], shown: [{ name: 'Ed', days: 3 }], truncated: false }] });
  } finally { globalThis.fetch = realFetch; }
  return sent.slice(-2).map((m) => m.html || '');
})();
checks.push(['the daily task email says how to turn it off', /\/app\/settings/.test(digestHtml[0] || '') && /unsubscribe/i.test(digestHtml[0] || '')]);
checks.push(['and so does the weekly call list', /\/app\/settings/.test(digestHtml[1] || '') && /unsubscribe/i.test(digestHtml[1] || '')]);

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
