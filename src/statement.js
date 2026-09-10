// A statement the client can read.
//
// Everything the reservation knows, minus everything that is none of the
// client's business. That second half is the whole point of this module. The
// record holds the vendor's commission rate, what the agency earns and which
// lines earn it, passport numbers and expiry dates, the last four digits of a
// card, the advisor's private reminder dates and their own notes. None of that
// belongs in an email to a traveller.
//
// So this builds a deliberately narrow object, field by field, rather than
// passing the record through with the awkward parts deleted. A fact has to be
// named here to reach a client, which means a column added to the reservation
// next month cannot leak into a client's inbox by default.

import { json, badRequest, notFound, readJson, now, sha256Hex } from './util.js';
import { requireUser } from './auth.js';
import { layout, escapeHtml, sendHtml } from './email.js';
import { listPricing } from './pricing.js';
import { listOptions } from './options.js';
import { listTravellers, listAmenities } from './travellers.js';
import * as db from './db.js';

// What a price line is called when a client reads it. "Non-commissionable
// fare" is a fact about the agency's pay, not about the client's holiday, and
// putting it in front of them invites a question with no good answer.
const CLIENT_LABEL = {
  fare: 'Fare', air: 'Air', insurance: 'Travel insurance',
  gratuities: 'Gratuities', transfers: 'Transfers', extra: 'Extras',
  ncf: 'Cruise line fees', taxes: 'Taxes and port fees', discount: 'Discount',
};

const KIND_LABEL = {
  deposit: 'Deposit', installment: 'Payment', final: 'Final balance', refund: 'Refund',
};

const sum = (rows) => rows.reduce((n, r) => n + (r.amountCents || 0), 0);

/**
 * Assembles what the client is told. Pure, so the boundary can be tested
 * without a database or an inbox.
 */
export function buildStatement({ booking, pricing, travellers, payments, amenities, options, client, user }) {
  const lines = (pricing || []).map((l) => ({
    label: l.label || CLIENT_LABEL[l.kind] || l.kind,
    amountCents: l.amount_cents || 0,
    deduct: l.kind === 'discount',
  }));

  // A discount is stored as a positive number and subtracted, the same way it
  // is on the advisor's own screen, so the two totals cannot drift apart.
  const brokenDown = lines.reduce((n, l) => n + (l.deduct ? -l.amountCents : l.amountCents), 0);
  const tripCents = lines.length ? brokenDown : (booking.gross_cents || 0);

  // Hard rows only. A soft row is the advisor's private reminder to chase the
  // same money a week early; showing a client two dates for one payment reads
  // as two payments, and showing them a date the vendor never set is worse.
  const hard = (payments || []).filter((p) => p.payment_class === 'hard');
  const posted = hard.filter((p) => p.paid_date).map((p) => ({
    label: KIND_LABEL[p.kind] || p.kind, date: p.paid_date, amountCents: p.amount_cents || 0,
  }));
  const due = hard.filter((p) => !p.paid_date && p.due_date).map((p) => ({
    label: KIND_LABEL[p.kind] || p.kind, date: p.due_date, amountCents: p.amount_cents || 0,
  }));

  const paidCents = sum(posted);

  /**
   * Where the money stands, in one line.
   *
   * CP Maxx asks the advisor to tick which of eight notices applies: deposit
   * due, deposit received, non-refundable deposit, payment received, final
   * payment due, paid in full, and so on. Every one of those is a fact the
   * software already knows. Asking a person to tick the right one is asking
   * them to be the database's memory, and the day they tick the wrong one the
   * client gets a demand for money they already sent.
   */
  const standing = (() => {
    const total = lines.length ? brokenDown : (booking.gross_cents || 0);
    const owing = Math.max(0, total - paidCents);
    const nextDue = hard.filter((p) => !p.paid_date && p.due_date)
      .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];

    if (total > 0 && owing === 0 && paidCents > 0) return 'Paid in full. Thank you.';
    if (nextDue) {
      const what = nextDue.kind === 'deposit' ? 'Deposit' : 'Balance';
      return `${paidCents > 0 ? `${money(paidCents)} received. ` : ''}${what} of ${
        money(nextDue.amount_cents || 0)} due by ${day(nextDue.due_date)}.`;
    }
    if (paidCents > 0 && owing > 0) return `${money(paidCents)} received. ${money(owing)} still to pay.`;
    if (paidCents > 0) return `${money(paidCents)} received. Thank you.`;
    return null;
  })();

  // A quote and a booked trip are not the same document, and sending one as
  // the other is worse than sending nothing. A client who has not booked has
  // paid nothing and owes nothing; showing them "Received: $0.00" and a
  // balance for a trip they have not agreed to reads as a demand, and the
  // reply is not the one you wanted.
  const mode = booking.status === 'booked' || booking.status === 'travelled'
    ? 'statement' : 'quote';

  return {
    mode,
    standing,
    invoiceNo: mode === 'statement' ? (booking.invoice_no || null) : null,
    invoiceIssuedAt: mode === 'statement' ? (booking.invoice_issued_at || null) : null,
    notes: booking.invoice_notes || '',
    clientName: (client && client.name) || booking.client_name || '',
    to: (client && client.email) || '',
    tripName: booking.product_name || '',
    vendor: booking.supplier || '',
    confirmation: booking.confirmation_number || '',
    departDate: booking.depart_date || '',
    returnDate: booking.return_date || '',
    itinerary: booking.itinerary || '',
    destination: booking.destination || '',
    cabin: [booking.cabin_category, booking.cabin].filter(Boolean).join(' · '),
    // Names only. A passport number in an email is a passport number in an
    // inbox, and neither of us can get it back out.
    travellers: (travellers || []).map((t) => t.name).filter(Boolean),
    lines,
    tripCents,
    // The choices offered. Only on a quote: once a trip is booked there was
    // one price, and showing a client what they turned down is not a kindness.
    options: mode === 'quote'
      ? (options || []).map((o) => ({
          label: o.label, detail: o.detail || '', amountCents: o.amount_cents || 0,
          chosen: Boolean(o.chosen),
        }))
      : [],
    // A quote carries no payment history because there is none. Empty arrays
    // rather than the fields being absent, so the page reading this does not
    // have to know which kind it asked for.
    posted: mode === 'quote' ? [] : posted,
    due: mode === 'quote' ? [] : due,
    paidCents: mode === 'quote' ? 0 : paidCents,
    // What it takes to hold it, which is the only number a quote should end
    // on. Null when the reservation does not say, rather than a guess.
    depositCents: mode === 'quote' ? (booking.deposit_cents || 0) || null : null,
    depositDue: mode === 'quote' ? (booking.deposit_due || '') : '',
    // What the client still owes on the whole trip, which is not the same as
    // what happens to be scheduled: a trip with a deposit paid and nothing
    // else booked in still has a balance, and it is the balance that matters.
    balanceCents: mode === 'quote' ? 0 : Math.max(0, tripCents - paidCents),
    scheduledCents: mode === 'quote' ? 0 : sum(due),
    // What the vendor granted them, without saying who paid for it.
    amenities: (amenities || [])
      .filter((a) => a.status === 'confirmed' || a.status === 'applied')
      .map((a) => ({ description: a.description, amountCents: a.amount_cents || 0 })),
    advisorName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
    advisorEmail: user.email,
    advisorPhone: user.phone || '',
    agencyName: user.agency_name || '',
    agencyAddress: user.agency_address || '',
    // Required on a client document in several states. Empty rather than
    // invented: an omitted registration is a gap, a made up one is a lie.
    sellerOfTravel: user.seller_of_travel || '',
  };
}

const money = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`;

const day = (iso) => (iso
  ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US',
      { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  : '');

function rows(items, { strike = false } = {}) {
  return items.map((i) => `<tr>
    <td style="padding:6px 0;color:#2f4459;">${escapeHtml(i.label)}${
      i.date ? `<span style="color:#5c7286;"> &middot; ${escapeHtml(day(i.date))}</span>` : ''}</td>
    <td style="padding:6px 0;text-align:right;color:#2f4459;white-space:nowrap;">${
      strike && i.deduct ? '&minus;' : ''}${money(i.amountCents)}</td>
  </tr>`).join('');
}

/**
 * A fingerprint of what the client was actually told.
 *
 * Taken over the built statement rather than the reservation, so it moves when
 * the client's copy would move and stays still otherwise: an internal note, a
 * commission figure or a passport number can change all day without making the
 * document in their inbox wrong.
 *
 * Three fields are left out on purpose. `to` is who it went to, not what it
 * said. `invoiceNo` and `invoiceIssuedAt` are assigned by the act of sending,
 * so including them would make every invoice differ from itself the moment it
 * was sent.
 */
export async function statementFingerprint(statement) {
  const { to, invoiceNo, invoiceIssuedAt, ...content } = statement;
  return (await sha256Hex(JSON.stringify(content))).slice(0, 32);
}

export function renderStatement(env, s) {
  const heading = [s.tripName, s.vendor].filter(Boolean).join(' with ')
    || (s.mode === 'quote' ? 'Your quote' : 'Your trip');

  const facts = [
    ['Confirmation', s.confirmation],
    ['Departing', day(s.departDate)],
    ['Returning', day(s.returnDate)],
    ['Itinerary', s.itinerary],
    ['Cabin', s.cabin],
    ['Travelling', s.travellers.join(', ')],
  ].filter(([, v]) => v);

  const block = (title, inner) => (inner
    ? `<p style="margin:22px 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5c7286;">
         ${escapeHtml(title)}</p>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
              style="font-size:15px;border-collapse:collapse;">${inner}</table>`
    : '');

  const totalRow = (label, cents, strong) => `<tr>
    <td style="padding:8px 0;border-top:1px solid #e2ebf4;${strong ? 'font-weight:600;' : ''}color:#12315e;">
      ${escapeHtml(label)}</td>
    <td style="padding:8px 0;border-top:1px solid #e2ebf4;text-align:right;white-space:nowrap;${
      strong ? 'font-weight:600;' : ''}color:#12315e;">${money(cents)}</td></tr>`;

  const quote = s.mode === 'quote';

  // What a quote ends on: the one thing the client has to do next, and by
  // when. A quote that stops at a total leaves them to work out what happens
  // now, and the commonest answer to that is nothing.
  const hold = quote
    ? `<p style="margin:22px 0 0;">${s.options.length && !s.options.some((o) => o.chosen)
        ? 'Tell me which one and I will hold it. ' : ''}${s.depositCents
        ? `A deposit of <strong>${money(s.depositCents)}</strong> holds this${
            s.depositDue ? ` and is due by ${escapeHtml(day(s.depositDue))}` : ''}.`
        : 'Say the word and I will hold it.'
      } Prices and space are not held until it is booked.</p>`
    : '';

  const body = [
    // The number and date first, because the thing that makes this a document
    // a client can file rather than an email they skim is that it is
    // identifiable eleven months later.
    !quote && s.invoiceNo
      ? `<p style="margin:0 0 14px;font-size:13px;color:#5c7286;">
          Invoice ${escapeHtml(s.invoiceNo)}${s.invoiceIssuedAt
            ? ` &middot; ${escapeHtml(new Date(s.invoiceIssuedAt * 1000)
                .toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }))}` : ''}</p>`
      : '',
    `<p style="margin:0 0 14px;">Hello ${escapeHtml(s.clientName || 'there')},</p>`,
    quote
      ? '<p style="margin:0 0 14px;">Here is what I have put together. Anything you would '
        + 'change, reply to this and I will rework it.</p>'
      : '<p style="margin:0 0 14px;">Here is where your trip stands. Anything that looks wrong, '
        + 'reply to this and I will sort it out.</p>',
    block(quote ? 'The trip' : 'Your trip', facts.map(([k, v]) => `<tr>
      <td style="padding:6px 0;color:#5c7286;width:38%;">${escapeHtml(k)}</td>
      <td style="padding:6px 0;color:#2f4459;">${escapeHtml(v)}</td></tr>`).join('')),
    // With choices on the table, the breakdown of one of them is noise: the
    // client is picking between prices, not auditing one.
    quote && s.options.length
      ? block('Your choices', s.options.map((o) => `<tr>
          <td style="padding:8px 0;color:#2f4459;">
            <strong>${escapeHtml(o.label)}</strong>${o.chosen
              ? ' <span style="color:#12315e;font-size:12px;">&mdash; the one you chose</span>' : ''}
            ${o.detail ? `<div style="color:#5c7286;font-size:13px;">${escapeHtml(o.detail)}</div>` : ''}</td>
          <td style="padding:8px 0;text-align:right;white-space:nowrap;color:#2f4459;">${
            money(o.amountCents)}</td></tr>`).join(''))
      : block('What it costs', s.lines.length
        ? rows(s.lines, { strike: true }) + totalRow('Trip total', s.tripCents, true)
        : totalRow('Trip total', s.tripCents, true)),
    quote ? '' : block('Received, thank you', rows(s.posted)),
    quote ? '' : block('Still to come', s.due.length
      ? rows(s.due) + totalRow('Balance', s.balanceCents, true)
      : totalRow('Balance', s.balanceCents, true)),
    quote ? hold : '',
    // Where the money stands, worked out rather than ticked.
    !quote && s.standing
      ? `<p style="margin:20px 0 0;padding:12px 16px;background:#f2f7fb;border-radius:8px;
           font-weight:600;color:#12315e;">${escapeHtml(s.standing)}</p>`
      : '',
    s.notes
      ? `<p style="margin:18px 0 0;white-space:pre-wrap;">${escapeHtml(s.notes)}</p>` : '',
    s.amenities.length
      // Confirmed by the vendor only, in both documents. Listing something
      // that was merely asked for is a promise on somebody else's behalf, and
      // on a quote it is the promise that wins the sale and loses the client.
      ? block(quote ? 'Included in this price' : 'Included with your booking',
          s.amenities.map((a) => `<tr>
          <td style="padding:6px 0;color:#2f4459;">${escapeHtml(a.description)}</td>
          <td style="padding:6px 0;text-align:right;color:#5c7286;white-space:nowrap;">${
            a.amountCents ? money(a.amountCents) : ''}</td></tr>`).join(''))
      : '',
    `<p style="margin:24px 0 0;">${escapeHtml(s.advisorName)}${
      s.agencyName ? `<br><span style="color:#5c7286;">${escapeHtml(s.agencyName)}</span>` : ''}</p>`,
  ].filter(Boolean).join('');

  // The client's footer is their advisor, not the software. They have no
  // account in the portal and no reason to be shown its front door.
  const footer = [
    escapeHtml(s.advisorName),
    s.agencyName ? escapeHtml(s.agencyName) : '',
    s.agencyAddress ? escapeHtml(s.agencyAddress) : '',
    s.advisorPhone ? escapeHtml(s.advisorPhone) : '',
    `<a href="mailto:${escapeHtml(s.advisorEmail)}" style="color:#12315e;">${
      escapeHtml(s.advisorEmail)}</a>`,
    s.sellerOfTravel ? escapeHtml(s.sellerOfTravel) : '',
  ].filter(Boolean).join(' &middot; ');

  return {
    subject: s.mode === 'quote'
      ? `Your quote: ${heading}`
      : `Invoice${s.invoiceNo ? ` ${s.invoiceNo}` : ''}: ${heading}`,
    html: layout(env, { heading, body, footer }),
  };
}

/**
 * The next invoice number for this advisor, this year.
 *
 * Assigned when an invoice is first issued rather than when the reservation is
 * created, because numbering trips nobody has invoiced leaves gaps in a
 * sequence that somebody may one day have to explain to an accountant.
 *
 * Per advisor, so two advisors in one agency do not interleave into a sequence
 * neither of them can reconcile.
 */
async function nextInvoiceNo(env, userId, year) {
  const prefix = `INV-${year}-`;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bookings
      WHERE user_id = ? AND invoice_no LIKE ?`
  ).bind(userId, `${prefix}%`).first().catch(() => ({ n: 0 }));

  // Checked rather than trusted: a deleted reservation makes the count lower
  // than the highest number issued, and reusing a number is worse than
  // skipping one.
  for (let i = (row?.n || 0) + 1; i < (row?.n || 0) + 50; i += 1) {
    const candidate = `${prefix}${String(i).padStart(4, '0')}`;
    const clash = await env.DB.prepare(
      'SELECT id FROM bookings WHERE user_id = ? AND invoice_no = ?'
    ).bind(userId, candidate).first();
    if (!clash) return candidate;
  }
  return `${prefix}${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Preview first, send second, as two separate requests.
 *
 * The same rule the payment chaser follows, for the same reason: an email to a
 * client cannot be recalled, and the preview returns exactly what would be
 * sent, from the same code that sends it.
 */
export async function handleStatement(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Self scope. An owner may read an associate's reservation, but sending a
  // client an email over that advisor's name is not reading.
  const booking = await db.getBooking(env, id, user.id);
  if (!booking) return notFound('Reservation not found.');

  // Nothing goes out about a trip that is off. Whatever the advisor meant to
  // send, this is not it.
  if (booking.status === 'cancelled') {
    return badRequest('That reservation is cancelled. Nothing should go to the client about it.');
  }

  const scope = db.selfScope(user);
  const [pricing, travellers, amenities, payments, options] = await Promise.all([
    listPricing(env, id, scope),
    listTravellers(env, id, scope),
    listAmenities(env, id, scope),
    db.listPayments(env, scope, { bookingId: id }),
    listOptions(env, id, scope),
  ]);

  const client = booking.client_id
    ? await db.getClient(env, scope, { id: booking.client_id })
    : await db.getClient(env, scope, { name: booking.client_name });

  // Numbered on send, not on preview. Previewing an invoice three times before
  // deciding not to send it would otherwise burn three numbers out of a
  // sequence whose whole value is that it has no gaps. The preview says a
  // number will be assigned rather than showing a blank where one will be.
  const body = await readJson(request);
  const issuing = booking.status === 'booked' || booking.status === 'travelled';

  const build = () => buildStatement({
    booking, pricing, travellers, amenities, payments, options, client, user,
  });

  let statement = build();
  let rendered = renderStatement(env, statement);

  if (body.preview) {
    return json({
      preview: true,
      to: statement.to || null,
      // Named rather than left to fail on send: the fix is on the client
      // record, and saying so is more use than an error.
      problem: statement.to ? null : 'That client has no email address on file.',
      // So the page can offer the fix rather than only the complaint.
      clientId: client ? client.id : null,
      // So the advisor can see they have already sent this before sending it
      // again. The payment chaser has shown this from the start; the client
      // documents showed nothing, which is how a quote gets sent three times
      // and followed up never.
      alreadySent: (statement.mode === 'quote' ? booking.quote_sent_at : booking.statement_sent_at)
        || null,
      // Whether what they are holding still matches the booking. Only means
      // anything once something has been sent.
      changedSince: Boolean(booking.statement_hash)
        && booking.statement_hash !== (await statementFingerprint(statement)),
      // The fingerprint of what this preview would send. Not secret, and the
      // only way to answer "why does it think this changed" without guessing.
      fingerprint: await statementFingerprint(statement),
      sentFingerprint: booking.statement_hash || null,
      sentCount: statement.mode === 'quote' ? (booking.quote_sent_count || 0) : 0,
      // So the page can say so rather than showing a gap where a number goes.
      willNumber: issuing && !booking.invoice_no,
      subject: rendered.subject,
      statement,
      html: rendered.html,
    });
  }

  if (!statement.to) return badRequest('That client has no email address on file.');

  // Numbered here and nowhere earlier: after the preview has returned, after
  // the address has been checked, immediately before the send. Every step
  // skipped over above is a way of not sending an invoice, and each of them
  // would otherwise have spent a number out of a sequence whose only value is
  // having no gaps in it.
  const assignedHere = issuing && !booking.invoice_no;
  if (assignedHere) {
    const no = await nextInvoiceNo(env, user.id, new Date().getFullYear());
    await env.DB.prepare(
      'UPDATE bookings SET invoice_no = ?, invoice_issued_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(no, now(), now(), id, user.id).run();
    booking.invoice_no = no;
    booking.invoice_issued_at = now();
    statement = build();
    rendered = renderStatement(env, statement);
  }

  try {
    await sendHtml(env, {
      to: statement.to, replyTo: user.email, subject: rendered.subject, html: rendered.html,
    });
  } catch (e) {
    // The number goes back. A send that failed is an invoice nobody has.
    if (assignedHere) {
      await env.DB.prepare(
        'UPDATE bookings SET invoice_no = NULL, invoice_issued_at = NULL WHERE id = ? AND user_id = ?'
      ).bind(id, user.id).run().catch(() => null);
    }
    return badRequest(String((e && e.message) || e).slice(0, 300));
  }

  // Recorded only after the send returns. A failed send that still marked the
  // quote as sent would be worse than no record at all: the follow-up list is
  // the one place that would have caught it.
  // Taken from the statement that actually went, after the number was assigned
  // and the object rebuilt. Fingerprinting the earlier one would have marked
  // every invoice as changed the instant it was sent.
  const fingerprint = await statementFingerprint(statement);

  if (statement.mode === 'quote') {
    await env.DB.prepare(
      `UPDATE bookings SET quote_sent_at = ?, quote_sent_count = quote_sent_count + 1,
              statement_hash = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(now(), fingerprint, now(), id, user.id).run();
  } else {
    await env.DB.prepare(
      `UPDATE bookings SET statement_sent_at = ?, statement_hash = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(now(), fingerprint, now(), id, user.id).run();
  }

  await db.logActivity(env, user.id, `booking.${statement.mode}`,
    `Sent ${statement.clientName} a ${statement.mode}`, { bookingId: id });
  return json({ ok: true, sentTo: statement.to, subject: rendered.subject, mode: statement.mode });
}
