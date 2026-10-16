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

import { json, badRequest, notFound, readJson, now, sha256Hex, usDate } from './util.js';
import { requireUser } from './auth.js';
import { layout, escapeHtml, sendHtml, messageAsSent } from './email.js';
import { listPricing, clientLines } from './pricing.js';
import { appUrl, shareCode } from './share.js';
import { listOptions } from './options.js';
import { listTravellers, listAmenities } from './travellers.js';
import * as db from './db.js';
import { paymentFormFor } from './brand.js';

const KIND_LABEL = {
  deposit: 'Deposit', installment: 'Payment', final: 'Final balance', refund: 'Refund',
};

const sum = (rows) => rows.reduce((n, r) => n + (r.amountCents || 0), 0);

/**
 * Assembles what the client is told. Pure, so the boundary can be tested
 * without a database or an inbox.
 */
export function buildStatement({ booking, pricing, travellers, payments, amenities, options, client, user, paymentFormUrl = null }) {
  // The page this document is about, where the client can answer it. Null when
  // the trip has never been shared, and then nothing is offered rather than a
  // link to a page that would say "not available".
  const shareCode = booking.share_code || null;
  // One row per thing, not one row per traveller: see clientLines.
  const lines = clientLines(pricing);

  // A discount is stored as a positive number and subtracted, the same way it
  // is on the advisor's own screen, so the two totals cannot drift apart.
  const brokenDown = lines.reduce((n, l) => n + (l.deduct ? -l.amountCents : l.amountCents), 0);
  const tripCents = lines.length ? brokenDown : (booking.gross_cents || 0);

  // Hard rows only. A soft row is the advisor's private reminder to chase the
  // same money ten days early; showing a client two dates for one payment reads
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
      // Only the row that clears the account is the balance. A split final and
      // a schedule left behind by a price change both put a smaller figure
      // here, and calling either one the balance tells the client they are
      // square when they are not.
      const clears = (nextDue.amount_cents || 0) === owing;
      const what = nextDue.kind === 'deposit' ? 'Deposit' : (clears ? 'Balance' : 'Payment');
      return `${paidCents > 0 ? `${money(paidCents)} received. ` : ''}${what} of ${
        money(nextDue.amount_cents || 0)} due by ${day(nextDue.due_date)}.`;
    }
    // Nothing on a date, but the reservation carries the vendor's own deadline.
    //
    // This is the commonest reservation in the book and it was the one the
    // document said least about: a trip booked inside ninety days is paid in
    // full at once, so the whole fare sits in the deposit field and nobody
    // ever built a schedule. The client was sent an invoice naming a balance
    // and no date at all, which reads as no hurry. The date is the vendor's,
    // it is on the reservation, and it is the one sentence this document
    // exists to carry.
    if (owing > 0 && booking.final_payment_due) {
      const had = paidCents > 0 ? `${money(paidCents)} received. ` : '';
      const when = day(booking.final_payment_due);
      return booking.final_payment_due < new Date().toISOString().slice(0, 10)
        ? `${had}Balance of ${money(owing)}, which was due by ${when}.`
        : `${had}Balance of ${money(owing)} due by ${when}.`;
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
    shareCode,
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
    // Said separately as well, because a client looks for the category they bought and the number of the
    // cabin they will be in, and a joined string makes them find one inside the other.
    cabinCategory: booking.cabin_category || '',
    // A guaranteed cabin has a category and no number until the cruise line assigns one, and a quote that
    // leaves the number blank reads as if somebody forgot it. GTY is what the cruise lines call it.
    cabinNumber: booking.cabin || (booking.cabin_category ? 'GTY' : ''),
    groupNumber: booking.group_number || '',
    // The two dates and the one fact about the deposit a client needs in order to decide, so that none of
    // them has to be asked for.
    finalDue: booking.final_payment_due || '',
    depositRefundable: booking.deposit_refundable || '',
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
          // The advisor's own pick. Carried into the email as well as the
          // page, because the email is what a good many clients read and an
          // advisor who marks a suggestion expects it where they sent it.
          recommended: Boolean(o.recommended),
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
    // What is owed less what is on a date. Rarely zero: insurance the client
    // pays direct, a price change after the vendor set the schedule, or a
    // final that has not been entered yet all leave a gap. The client's copy
    // used to total the schedule with this balance and let the column come out
    // wrong, which reads as an arithmetic mistake on an invoice.
    unscheduledCents: mode === 'quote'
      ? 0 : Math.max(0, tripCents - paidCents) - sum(due),
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
    // Where the agency takes a card authorization, if it has one. Not this portal: it takes none.
    paymentFormUrl: paymentFormUrl || '',
    confirmationNumber: booking.confirmation_number || '',
  };
}

const money = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`;

const day = (iso) => usDate(iso);

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
 * `to` is left out on purpose: it is who it went to, not what it said.
 */
export async function statementFingerprint(statement) {
  const { to, ...content } = statement;
  return (await sha256Hex(JSON.stringify(content))).slice(0, 32);
}

/**
 * The card authorization, as a block a client cannot miss: what to do, what to type, and a button.
 *
 * The agency's own form takes the card and this portal never sees it. The block says exactly what the
 * form asks for, so nobody is left to work out the amount or the date, and that a card is not charged
 * before the date they give. `scope` says what one form covers when it covers more than one trip.
 */
function cardBlock(url, { heading, button, amountCents, dueIso, confirmation, scope = '' }) {
  return `<div style="margin:18px 0 0;padding:16px 18px;border:1px solid #cfe0ee;border-radius:10px;background:#f7fafd;">
      <p style="margin:0 0 8px;font-weight:600;color:#12315e;">${escapeHtml(heading)}</p>
      <p style="margin:0 0 12px;color:#2f4459;">${scope ? `${escapeHtml(scope)} ` : ''}Fill in the agency's secure card
        authorization form. It asks for the amount, <strong>${money(amountCents)}</strong>${dueIso
          ? `; the date to charge it on or after, <strong>${escapeHtml(day(dueIso))}</strong>` : ''}${confirmation
          ? `; and your trip confirmation number, <strong>${escapeHtml(confirmation)}</strong>` : ''}.
        Your card is not charged before that date.</p>
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#12315e;color:#ffffff;text-decoration:none;
        font-weight:600;padding:11px 22px;border-radius:8px;">${escapeHtml(button)}</a>
    </div>`;
}

/** What the advisor may change before it goes: the subject, the opening message and a closing note. */
export function cleanCustom(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const text = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
  // The note is told apart from the others: absent means the standard closing, and an empty one means the
  // advisor took it out and wants none.
  return { subject: text(c.subject, 200).replace(/\s+/g, ' '), intro: text(c.intro, 4000),
    note: c.note === undefined || c.note === null ? undefined : text(c.note, 4000) };
}

/** Typed text as paragraphs: a blank line starts a new one and a single line break is kept. */
const paragraphs = (text) => String(text || '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)
  .map((x) => `<p style="margin:0 0 14px;">${escapeHtml(x).replace(/\n/g, '<br>')}</p>`).join('');

/** The opening paragraph as it is written when nobody has changed it, so the editor can start from it. */
export function defaultIntro(quote) {
  return quote
    ? 'Thank you for the opportunity to plan this trip for you. I have put together everything below: your dates, your cabin, the full price and what it takes to hold it. Take a look, and if you would like anything changed, reply to this and I will rework it.'
    : 'Thank you for booking with us. Here is where your trip stands, with what has been received and what is still due. If anything looks wrong, reply to this and I will sort it out.';
}

const HAPPY_TO_HELP = 'If you have any questions at all, call or email me and I will be happy to help.';

/**
 * The closing note as it is written when nobody has changed it. It reads as the last thing before the
 * signature, so where the agency has a card form it points back at the form above it, and where it has
 * not it does not mention one.
 */
export function defaultNote(s) {
  if (s.mode !== 'quote') return `Thank you again for choosing us. If you have any questions about your payments or your trip, call or email me any time.`;
  if (s.depositCents && s.paymentFormUrl) {
    return `To hold your space, please complete the secure card authorization form above by the deposit date. Your card is not charged before the date you give. ${HAPPY_TO_HELP}`;
  }
  if (s.depositCents) {
    return `To hold your space, reply to let me know you would like to go ahead and I will take care of the next steps. ${HAPPY_TO_HELP}`;
  }
  return `Say the word and I will hold it for you. ${HAPPY_TO_HELP}`;
}

export function renderStatement(env, s, custom = {}) {
  const heading = [s.tripName, s.vendor].filter(Boolean).join(' with ')
    || (s.mode === 'quote' ? 'Your quote' : 'Your trip');

  const facts = [
    ['Confirmation', s.confirmation],
    ['Departing', day(s.departDate)],
    ['Returning', day(s.returnDate)],
    ['Itinerary', s.itinerary],
    ['Cabin category', s.cabinCategory],
    ['Cabin', s.cabinNumber],
    ['Group number', s.groupNumber],
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

  // First name only, the same as on the trip page: "Brent suggests this" is a
  // person and "Brent Beasley suggests this" is a letterhead.
  const firstName = String(s.advisorName || '').trim().split(/\s+/)[0] || '';
  const suggests = firstName ? `${firstName} suggests this` : 'suggested';

  // What a quote ends on: the one thing the client has to do next, and by
  // when. A quote that stops at a total leaves them to work out what happens
  // now, and the commonest answer to that is nothing.
  // How to answer, and it has to be somewhere they can act rather than a
  // sentence inviting a reply. A quote that ends at a total leaves the client
  // to work out what happens next, and the commonest answer to that is
  // nothing. The button below goes to the trip page, where the same three
  // answers live: pick an option, say yes, say no, or ask a question.
  const answerHere = s.shareCode
    ? ' You can answer on the page below, or reply to this and I will pick it up.'
    : '';
  // The agency's own form for authorizing a card, and exactly what to put in it, so a client is not left
  // to work out the amount and the date. Only where the agency has set one and there is something to pay.
  const cardForm = (amountCents, dueIso) => (s.paymentFormUrl && amountCents > 0
    ? cardBlock(s.paymentFormUrl, {
      heading: quote ? 'To secure it, authorize your deposit' : 'To pay by card',
      button: quote ? 'Authorize your deposit' : 'Authorize your payment',
      amountCents, dueIso, confirmation: s.confirmationNumber,
    }) : '');

  const depositNote = s.depositRefundable === 'refundable' ? ' The deposit is refundable.'
    : s.depositRefundable === 'nonrefundable' ? ' The deposit is non refundable.' : '';
  const finalNote = s.finalDue ? ` The final balance is due by ${escapeHtml(day(s.finalDue))}.` : '';
  const hold = quote
    ? `<p style="margin:22px 0 0;">${s.options.length && !s.options.some((o) => o.chosen)
        ? 'Tell me which one and I will hold it. ' : ''}${s.depositCents
        ? `A deposit of <strong>${money(s.depositCents)}</strong> holds this${
            s.depositDue ? ` and is due by ${escapeHtml(day(s.depositDue))}` : ''}.${depositNote}${finalNote}`
        : `Say the word and I will hold it.${finalNote}`
      } Prices and space are not held until it is booked.${answerHere}</p>${cardForm(s.depositCents, s.depositDue)}`
    : '';

  const body = [
    `<p style="margin:0 0 14px;">Hello ${escapeHtml(s.clientName || 'there')},</p>`,
    paragraphs(custom.intro || defaultIntro(quote)),
    block(quote ? 'The trip' : 'Your trip', facts.map(([k, v]) => `<tr>
      <td style="padding:6px 0;color:#5c7286;width:38%;">${escapeHtml(k)}</td>
      <td style="padding:6px 0;color:#2f4459;">${escapeHtml(v)}</td></tr>`).join('')),
    // With choices on the table, the breakdown of one of them is noise: the
    // client is picking between prices, not auditing one.
    quote && s.options.length
      ? block('Your choices', s.options.map((o) => `<tr>
          <td style="padding:8px 0;color:#2f4459;">
            <strong>${escapeHtml(o.label)}</strong>${o.chosen
              ? ' <span style="color:#12315e;font-size:12px;">&middot; the one you chose</span>'
              : (o.recommended
                ? ` <span style="color:#12315e;font-size:12px;">&middot; ${escapeHtml(suggests)}</span>`
                : '')}
            ${o.detail ? `<div style="color:#5c7286;font-size:13px;">${escapeHtml(o.detail)}</div>` : ''}</td>
          <td style="padding:8px 0;text-align:right;white-space:nowrap;color:#2f4459;">${
            money(o.amountCents)}</td></tr>`).join(''))
      : block('What it costs', s.lines.length
        ? rows(s.lines, { strike: true }) + totalRow('Trip total', s.tripCents, true)
        : totalRow('Trip total', s.tripCents, true)),
    quote ? '' : block('Received, thank you', rows(s.posted)),
    // Nothing is still to come on a trip that is paid for. A block under that
    // heading holding a single zero is the one thing a client who has just
    // settled up does not need to read.
    quote || (!s.due.length && !s.balanceCents)
      ? ''
      : block('Still to come', s.due.length
        ? rows(s.due) + totalRow('Balance', s.balanceCents, true)
        : totalRow('Balance', s.balanceCents, true)),
    // Said in words rather than added as a row, because the difference is not
    // a charge and inventing a line item for it would be a third number to
    // argue with. The balance is the one that is owed either way.
    !quote && s.due.length && s.unscheduledCents
      ? `<p style="margin:8px 0 0;font-size:13px;color:#5c7286;">${escapeHtml(s.unscheduledCents > 0
          ? `Not all of that balance is on a payment date yet. ${money(s.unscheduledCents)} of it `
            + 'is still to be scheduled, and I will let you know when it is.'
          : `Your balance is lower than the payment${s.due.length > 1 ? 's' : ''} scheduled above. `
            + 'The balance is what is owed, and I am having the schedule corrected.')}</p>`
      : '',
    quote ? hold : '',
    // Where the money stands, worked out rather than ticked.
    !quote && s.standing
      ? `<p style="margin:20px 0 0;padding:12px 16px;background:#f2f7fb;border-radius:8px;
           font-weight:600;color:#12315e;">${escapeHtml(s.standing)}</p>`
      : '',
    !quote && s.due.length ? cardForm(s.due[0].amountCents, s.due[0].date) : '',
    (custom.note === undefined ? defaultNote(s) : custom.note) ? `<div style="margin:18px 0 0;">${paragraphs(custom.note === undefined ? defaultNote(s) : custom.note)}</div>` : '',
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
    subject: custom.subject || (s.mode === 'quote'
      ? `Your quote: ${heading}`
      : `Invoice${s.confirmation ? ` for confirmation ${s.confirmation}` : ''}: ${heading}`),
    // A quote gets a button to the page it is about, where the client can
    // pick an option, say yes, say no or ask a question. Without it the email
    // ends at a total and the only way to answer is to compose a reply, which
    // is the step most people never take.
    //
    // A statement gets one only when the trip page exists, pointing at the
    // documents and payment dates there. Nothing to answer, so no "answer" label.
    html: layout(env, {
      heading,
      body,
      footer,
      // An invoice links to the trip page only where one already exists, and
      // never makes one: whether a client has a page is the advisor's choice.
      cta: s.shareCode
        ? { label: s.mode === 'quote' ? 'See it and answer' : 'See your trip and documents',
            href: `${appUrl(env)}/t/${s.shareCode}?s=${s.mode === 'quote' ? 'quote' : 'invoice'}` }
        : null,
    }),
  };
}

/**
 * Several quotes in one email, with one deposit.
 *
 * For a family or a group travelling on separate reservations that one person pays for: one message to
 * one address, each trip listed with its own price and its own link, and a single deposit that holds
 * all of them. When every reservation needs its own deposit they are sent one at a time instead.
 *
 * Built from the statements the single quote is built from, so a trip reads here as it would alone.
 */
/** The opening paragraph of a combined quote as written when nobody has changed it. */
export const combinedIntro = (withDeposit) => 'Thank you for the opportunity to plan these trips for you. Below is each trip with its dates, cabin and price'
  + `${withDeposit ? ', and one deposit that holds them all' : ''}. Each link opens a page with everything else about that trip. If you would like anything changed, reply to this and I will rework it.`;

/** The closing note of a combined quote as written when nobody has changed it. */
export const combinedNote = ({ withDeposit, withForm }) => (withDeposit && withForm
  ? `To hold all of these trips, please complete the one secure card authorization form above by the deposit date. Your card is not charged before the date you give. ${HAPPY_TO_HELP}`
  : withDeposit
    ? `To hold all of these trips, reply to let me know you would like to go ahead and I will take care of the next steps. ${HAPPY_TO_HELP}`
    : `Say the word and I will hold them for you. ${HAPPY_TO_HELP}`);

export function renderCombinedQuote(env, statements, { paymentFormUrl = '', custom = {} } = {}) {
  const first = statements[0];
  const tripTotal = statements.reduce((n, s) => n + (s.tripCents || 0), 0);
  const deposits = statements.filter((s) => s.depositCents);
  const depositTotal = deposits.reduce((n, s) => n + s.depositCents, 0);
  const dueDates = deposits.map((s) => s.depositDue).filter(Boolean).sort();
  const due = dueDates[0] || '';

  const cell = 'padding:4px 0;';
  const trip = (s) => {
    const name = [s.tripName, s.vendor].filter(Boolean).join(' with ') || 'Your trip';
    const facts = [
      ['Departing', day(s.departDate)],
      ['Returning', day(s.returnDate)],
      ['Itinerary', s.itinerary],
      ['Cabin category', s.cabinCategory],
      ['Cabin', s.cabinNumber],
      ['Group number', s.groupNumber],
      ['Travelling', s.travellers.join(', ')],
    ].filter(([, v]) => v);
    const deposit = s.depositCents ? `<tr><td style="${cell}color:#5c7286;">Deposit share</td>
        <td style="${cell}text-align:right;color:#2f4459;">${money(s.depositCents)}</td></tr>` : '';
    const final = s.finalDue ? `<tr><td style="${cell}color:#5c7286;">Final balance due</td>
        <td style="${cell}text-align:right;color:#2f4459;">${escapeHtml(day(s.finalDue))}</td></tr>` : '';
    const refund = s.depositRefundable ? `<tr><td style="${cell}color:#5c7286;">The deposit is</td>
        <td style="${cell}text-align:right;color:#2f4459;">${s.depositRefundable === 'refundable' ? 'refundable' : 'non refundable'}</td></tr>` : '';
    return `<p style="margin:26px 0 4px;font-size:16px;font-weight:600;color:#12315e;">
        ${escapeHtml(s.clientName ? `${s.clientName}: ${name}` : name)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;border-collapse:collapse;">
        ${facts.map(([k, v]) => `<tr><td style="${cell}color:#5c7286;width:34%;vertical-align:top;">${escapeHtml(k)}</td>
          <td style="${cell}color:#2f4459;">${escapeHtml(v)}</td></tr>`).join('')}
      </table>
      ${s.lines.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="font-size:15px;border-collapse:collapse;margin-top:8px;border-top:1px solid #e2ebf4;">
        ${rows(s.lines, { strike: true })}</table>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#12315e;font-weight:600;border-top:1px solid #e2ebf4;">Trip total</td>
          <td style="padding:6px 0;text-align:right;color:#12315e;font-weight:600;border-top:1px solid #e2ebf4;">${money(s.tripCents)}</td></tr>
        ${deposit}${refund}${final}
      </table>
      ${s.amenities.length ? `<p style="margin:8px 0 0;font-size:14px;color:#5c7286;">Included: ${
        escapeHtml(s.amenities.map((a) => a.description).join(', '))}</p>` : ''}
      <p style="margin:10px 0 0;"><a href="${s.shareCode ? escapeHtml(`${appUrl(env)}/t/${s.shareCode}?s=quote`) : '#'}"
        style="color:#12315e;font-weight:600;">See everything for this trip, and answer</a></p>`;
  };

  const closing = custom.note === undefined
    ? combinedNote({ withDeposit: depositTotal > 0, withForm: Boolean(paymentFormUrl) }) : custom.note;
  const hold = depositTotal
    ? `A single deposit of <strong>${money(depositTotal)}</strong> holds all ${statements.length} of these${
        due ? ` and is due by ${escapeHtml(day(due))}` : ''}.`
    : 'Say the word and I will hold them.';
  const card = paymentFormUrl && depositTotal > 0
    ? cardBlock(paymentFormUrl, {
      heading: 'To secure all of them, authorize one deposit',
      button: 'Authorize your deposit',
      amountCents: depositTotal, dueIso: due,
      scope: `One form covers all ${statements.length} trips.`,
    }) : '';

  const body = [
    '<p style="margin:0 0 14px;">Hello,</p>',
    paragraphs(custom.intro || combinedIntro(depositTotal > 0)),
    statements.map(trip).join(''),
    `<p style="margin:22px 0 0;padding:12px 16px;background:#f2f7fb;border-radius:8px;color:#12315e;">
       All together: <strong>${money(tripTotal)}</strong>. ${hold}</p>`,
    `<p style="margin:14px 0 0;">Prices and space are not held until they are booked.</p>`,
    card,
    closing ? `<div style="margin:18px 0 0;">${paragraphs(closing)}</div>` : '',
    `<p style="margin:24px 0 0;">${escapeHtml(first.advisorName)}${
      first.agencyName ? `<br><span style="color:#5c7286;">${escapeHtml(first.agencyName)}</span>` : ''}</p>`,
  ].filter(Boolean).join('');

  const footer = [
    escapeHtml(first.advisorName),
    first.agencyName ? escapeHtml(first.agencyName) : '',
    first.agencyAddress ? escapeHtml(first.agencyAddress) : '',
    first.advisorPhone ? escapeHtml(first.advisorPhone) : '',
    `<a href="mailto:${escapeHtml(first.advisorEmail)}" style="color:#12315e;">${escapeHtml(first.advisorEmail)}</a>`,
    first.sellerOfTravel ? escapeHtml(first.sellerOfTravel) : '',
  ].filter(Boolean).join(' &middot; ');

  return {
    subject: custom.subject || `Your quotes: ${statements.length} reservations`,
    html: layout(env, { heading: `Your ${statements.length} quotes`, body, footer, cta: null }),
    tripCents: tripTotal, depositCents: depositTotal, depositDue: due,
  };
}

/**
 * Preview first, send second, as two separate requests.
 *
 * The same rule the payment chaser follows, for the same reason: an email to a
 * client cannot be recalled, and the preview returns exactly what would be
 * sent, from the same code that sends it.
 */
/**
 * Quotes for several reservations at once, previewed and then sent.
 *
 * Each goes through handleStatement, the one route a quote goes out by, so a client gets exactly
 * what one-at-a-time would have sent: the same email, the same page, the same record that it was
 * sent. This only asks the same question of each reservation and collects the answers.
 *
 * Previewed before it is sent, as a separate request, because an email cannot be recalled. Only a
 * quoted reservation is sent a quote: a booked one would be sent an invoice, which is a different
 * thing to say to a client, so it is refused here whatever was asked for.
 */
const BULK_QUOTE_MAX = 25;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleBulkQuote(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map((x) => String(x || '').slice(0, 64)).filter(Boolean) : [])];
  if (!ids.length) return badRequest('Pick the reservations to send quotes for.');
  if (ids.length > BULK_QUOTE_MAX) return badRequest(`Send at most ${BULK_QUOTE_MAX} at a time.`);
  const send = body.send === true;

  // Where each one goes when it is not the address on the client's record: a family on one parent's
  // email, a group's organiser. Checked here so a mistyped address is refused before anything is sent.
  const sendTo = {};
  for (const [key, value] of Object.entries(body.to && typeof body.to === 'object' ? body.to : {})) {
    const address = String(value || '').trim();
    if (!address) continue;
    if (!EMAIL.test(address)) return badRequest(`"${address.slice(0, 60)}" does not look like an email address.`);
    sendTo[key] = address;
  }
  const combineTo = body.combine && typeof body.combine === 'object' ? String(body.combine.to || '').trim() : '';
  if (body.combine && !EMAIL.test(combineTo)) return badRequest('Say which address the combined quote goes to.');
  if (body.combine && ids.length < 2) return badRequest('Combining needs at least two reservations.');

  // Words the advisor added, for each email when they go one at a time. The subject is left to each: a
  // single subject over eight different trips would be wrong for most of them.
  const typed = cleanCustom(body.custom);
  const eachCustom = { intro: typed.intro, note: typed.note, subject: '' };
  const ask = (id, preview, to) => handleStatement(new Request(request.url, {
    method: 'POST', headers: request.headers,
    body: JSON.stringify({ preview, ...(to ? { to } : {}), custom: eachCustom }),
  }), env, id);

  const results = [];
  const statements = [];
  for (const id of ids) {
    const looked = await ask(id, true, sendTo[id] || (combineTo || ''));
    const data = await looked.json().catch(() => ({}));
    if (!looked.ok) { results.push({ id, ok: false, error: data.error || `Not found (${looked.status}).` }); continue; }
    const s = data.statement || {};
    const row = {
      id, client: s.clientName || '', to: data.to || null, problem: data.problem || null,
      alreadySent: data.alreadySent || null, sentCount: data.sentCount || 0,
      depositCents: s.depositCents || 0, depositDue: s.depositDue || '', tripCents: s.tripCents || 0,
      mode: s.mode, sample: s,
    };
    if (s.mode !== 'quote') {
      results.push({ ...row, ok: false, error: 'Only a quoted reservation is sent a quote.' });
      continue;
    }
    if (data.problem && !body.combine) { results.push({ ...row, ok: false, error: data.problem }); continue; }
    if (body.combine) { results.push({ ...row, ok: true }); statements.push({ id, s }); continue; }
    if (!send) { results.push({ ...row, ok: true }); continue; }

    const sent = await ask(id, false, sendTo[id] || '');
    const out = await sent.json().catch(() => ({}));
    results.push({ ...row, ok: sent.ok, error: sent.ok ? null : (out.error || `Not sent (${sent.status}).`) });
  }

  if (body.combine) {
    return combinedQuote(request, env, user, { results: results.map(({ sample: _s, ...row }) => row), statements, ids, combineTo, send, test: body.test === true, custom: cleanCustom(body.custom) });
  }

  if (send) {
    const n = results.filter((r) => r.ok).length;
    await db.logActivity(env, user.id, 'quote.bulk', `Sent ${n} quote${n === 1 ? '' : 's'} at once`, { count: n });
  }
  // The starting words for the editor, for one at a time and for one email, so it can offer them before
  // anything has been previewed.
  const firstRead = results.find((r) => r.ok);
  const anyDeposit = results.some((r) => r.ok && r.depositCents);
  const sample = firstRead && firstRead.sample;
  return json({ ok: true, sent: send, results: results.map(({ sample: _s, ...row }) => row), defaults: sample ? {
    each: { intro: defaultIntro(true), note: defaultNote(sample) },
    combined: { intro: combinedIntro(anyDeposit), note: combinedNote({ withDeposit: anyDeposit, withForm: Boolean(sample.paymentFormUrl) }) },
  } : null });
}

/**
 * One email, one deposit, for several reservations.
 *
 * Every reservation has to be a quote with the same advisor, and none may have failed to read: sending
 * a combined message that quietly leaves one out is worse than not sending it. On send each trip is
 * given its page first, so the link beside it goes somewhere, and each is then recorded as sent exactly
 * as it would have been on its own.
 */
async function combinedQuote(request, env, user, { results, statements, ids, combineTo, send, test, custom }) {
  const bad = results.find((r) => !r.ok);
  if (bad) return badRequest(`${bad.client || 'One of them'}: ${bad.error}`);
  if (new Set(statements.map(({ s }) => s.advisorEmail)).size > 1) {
    return badRequest('A combined quote can only hold one advisor\'s reservations.');
  }

  // A test goes to the signed in person and nowhere else, and records nothing against the clients: the
  // point is to read the email as they will, so it must not make a quote look sent that was not.
  if (test && combineTo.toLowerCase() !== String(user.email || '').toLowerCase()) {
    return badRequest(`A test can only be sent to your own address, ${user.email || 'the one you signed in with'}.`);
  }

  const owner = await db.writerForBooking(env, user, ids[0]);
  if (!owner) return notFound('Reservation not found.');

  let built = statements.map(({ s }) => s);
  const rendered = (list) => renderCombinedQuote(env, list, { paymentFormUrl: list[0].paymentFormUrl || '', custom });
  let out = rendered(built);
  const plain = renderCombinedQuote(env, built, { paymentFormUrl: built[0].paymentFormUrl || '' });
  const summary = {
    // What it says when nothing is changed, so the editor can start from the real words.
    defaults: { subject: plain.subject, intro: combinedIntro(plain.depositCents > 0), note: combinedNote({ withDeposit: plain.depositCents > 0, withForm: Boolean(built[0].paymentFormUrl) }) },
    to: combineTo, count: built.length, subject: out.subject,
    tripCents: out.tripCents, depositCents: out.depositCents, depositDue: out.depositDue,
  };
  // The message itself on a preview, so the advisor can read exactly what would go before it does.
  if (!send) return json({ ok: true, sent: false, results, combined: { ...summary, html: out.html } });

  // Each trip gets its page when it is sent, as a single quote's does.
  for (const { id, s } of statements) {
    if (s.shareCode) continue;
    const code = shareCode();
    const ts = now();
    await env.DB.prepare(
      `UPDATE bookings SET share_code = ?, shared_at = COALESCE(shared_at, ?), updated_at = ?
        WHERE id = ? AND user_id = ? AND share_code IS NULL`
    ).bind(code, ts, ts, id, owner.id).run();
  }
  built = [];
  for (const { id } of statements) {
    const again = await handleStatement(new Request(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify({ preview: true, to: combineTo }),
    }), env, id);
    built.push((await again.json().catch(() => ({}))).statement);
  }
  if (built.some((s) => !s)) return badRequest('One of the reservations could not be read again. Nothing was sent.');
  out = rendered(built);

  try {
    await sendHtml(env, {
      to: combineTo, replyTo: owner.email, subject: test ? `TEST: ${out.subject}` : out.subject, html: out.html,
      unsubscribe: { agencyId: owner.agency_id, agencyName: owner.agency_name },
    });
  } catch (e) {
    return badRequest(String((e && e.message) || e).slice(0, 300));
  }

  if (test) {
    await db.logActivity(env, user.id, 'quote.test', `Sent a test of ${built.length} quotes to myself`, { count: built.length });
    return json({ ok: true, sent: true, test: true, results, combined: { ...summary, subject: `TEST: ${out.subject}` } });
  }

  // Recorded only after the send returns, one by one, the way a single quote is.
  for (let i = 0; i < statements.length; i += 1) {
    const fingerprint = await statementFingerprint(built[i]);
    await env.DB.prepare(
      `UPDATE bookings SET quote_sent_at = ?, quote_sent_count = quote_sent_count + 1,
              statement_hash = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(now(), fingerprint, now(), statements[i].id, owner.id).run();
  }
  await db.logActivity(env, owner.id, 'quote.combined',
    db.byHand(`Sent ${built.length} quotes as one email`, user, owner), { count: built.length });
  return json({ ok: true, sent: true, results, combined: { ...summary, subject: out.subject } });
}

export async function handleStatement(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerForBooking(env, user, id);
  if (!owner) return notFound('Reservation not found.');

  // Sent over the advisor's name and reply-to, whoever pressed the button. An
  // owner may send a statement on an advisor's reservation the same way they
  // may correct one, and the activity line on it says who actually did.
  const booking = await db.getBooking(env, id, owner.id);
  if (!booking) return notFound('Reservation not found.');

  // Nothing goes out about a trip that is off. Whatever the advisor meant to
  // send, this is not it.
  if (booking.status === 'cancelled') {
    return badRequest('That reservation is cancelled. Nothing should go to the client about it.');
  }

  const scope = db.selfScope(owner);
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
  // Sent somewhere other than the address on the client's record: a family on one email, a group's
  // organiser. Used for this send only, and the record is left as it was.
  const custom = cleanCustom(body.custom);
  const toOverride = String(body.to || '').trim();
  if (toOverride && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toOverride)) {
    return badRequest(`"${toOverride.slice(0, 60)}" does not look like an email address.`);
  }

  // `user:` written out rather than shorthand. buildStatement destructures a
  // property of that name, so the shorthand was a key as much as a value, and
  // renaming the variable silently renamed the key: every statement became a
  // 500 that read as a variable rename.
  const paymentFormUrl = await paymentFormFor(env, owner.agency_id);
  const build = () => buildStatement({
    booking, pricing, travellers, amenities, payments, options,
    client: toOverride ? { ...(client || {}), email: toOverride } : client,
    user: owner, paymentFormUrl,
  });

  let statement = build();
  let rendered = renderStatement(env, statement, custom);

  if (body.preview) {
    // The message as it will leave, footer and all, from the same function the send uses.
    const asSent = statement.to ? await messageAsSent(env, {
      to: statement.to, replyTo: owner.email, subject: rendered.subject, html: rendered.html,
      unsubscribe: { agencyId: owner.agency_id, agencyName: owner.agency_name },
    }) : null;
    return json({
      preview: true,
      to: statement.to || null,
      // Who it is from and to, what is attached, and where its links lead. Attachments are a list
      // of names and sizes only: the files themselves stay on the server.
      envelope: asSent ? {
        from: asSent.from, to: asSent.to, replyTo: asSent.replyTo, subject: asSent.subject,
        attachments: asSent.attachments.map((a) => ({
          filename: a.filename, bytes: Math.floor(String(a.content || '').length * 3 / 4),
        })),
        links: asSent.links,
      } : null,
      // The plain text version that goes with it, which some mail programs show instead.
      text: asSent ? asSent.text : null,
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
      subject: rendered.subject,
      // What it says when nothing is changed, so the editor can start from the real words.
      defaults: { subject: renderStatement(env, statement).subject, intro: defaultIntro(statement.mode === 'quote'), note: defaultNote(statement) },
      statement,
      html: asSent ? asSent.html : rendered.html,
    });
  }

  if (!statement.to) return badRequest('That client has no email address on file.');

  // A quote gets its page when it is sent, if it has not got one already.
  //
  // The button in the email needs somewhere to go, and until now a quote could
  // be sent to a client with no page behind it at all: the email ended at a
  // total and the only way to answer was to compose a reply. Sending is the
  // act that says the client may see this, which is the same rule the client's
  // own page already follows, so it is also the moment the page should exist.
  //
  // Only a quote, and only on send. Previewing publishes nothing, and a booked
  // trip already has whatever link it was given.
  if (statement.mode === 'quote' && !booking.share_code) {
    const code = shareCode();
    const ts = now();
    await env.DB.prepare(
      `UPDATE bookings SET share_code = ?, shared_at = COALESCE(shared_at, ?), updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(code, ts, ts, id, owner.id).run();
    booking.share_code = code;
    booking.shared_at = booking.shared_at || ts;
    statement = build();
    rendered = renderStatement(env, statement, custom);
  }

  try {
    await sendHtml(env, {
      to: statement.to, replyTo: owner.email, subject: rendered.subject, html: rendered.html,
      // Every message to a client carries its way out, a quote and an invoice included.
      unsubscribe: { agencyId: owner.agency_id, agencyName: owner.agency_name },
    });
  } catch (e) {
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
    ).bind(now(), fingerprint, now(), id, owner.id).run();
  } else {
    await env.DB.prepare(
      `UPDATE bookings SET statement_sent_at = ?, statement_hash = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(now(), fingerprint, now(), id, owner.id).run();
  }

  await db.logActivity(env, owner.id, `booking.${statement.mode}`,
    db.byHand(`Sent ${statement.clientName} a ${statement.mode}`, user, owner), { bookingId: id });
  return json({ ok: true, sentTo: statement.to, subject: rendered.subject, mode: statement.mode });
}
