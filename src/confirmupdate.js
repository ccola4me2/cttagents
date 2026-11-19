// Bringing a reservation up to date from the vendor's newer confirmation.
//
// A Margaritaville at Sea booking changes after it is made: the guest adds prepaid gratuities or a drinks package, and pays
// something. The cruise line sends a new agent copy each time. The advisor used to read it and type the same changes into
// the reservation, and then attach the PDF. This reads the PDF instead and shows what is different; one press applies it
// and files the PDF under Documents.
//
// Two steps on one route. Without `?apply=1` it reads and compares and writes nothing. With it, it does what it showed.
// Applying the same file twice changes nothing the second time, because it compares what is on the reservation with what
// the document says and only adds the difference.
//
// What it never does: remove or lower anything. A charge on the reservation that the document does not have, or more paid
// here than the document shows, is said, and left for a person to decide. It never touches the fare, the taxes or the
// commission lines, which the document states as a whole and which a person has already checked once.

import { json, badRequest, notFound, uid, now } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { pdfRead } from './pdftext.js';
import { parseMasAgentCopy } from './masconfirmation.js';
import { listPricing, PRICE_KINDS, syncBookingTotals } from './pricing.js';
import { handleCreatePayment } from './payments.js';
import { safeName, docsReady, MAX_BYTES } from './documents.js';

const usd = (cents) => `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Which line of the pricing grid an enhancement belongs on, from what the cruise line calls it. */
export function kindOfEnhancement(name) {
  const n = String(name || '').toUpperCase();
  if (/GRATUIT/.test(n)) return 'gratuities';
  if (/BEVERAGE|DRINK|BAR\b|CHILL|TOAST/.test(n)) return 'beverage';
  if (/DINING|RESTAURANT|SPECIALTY|STEAK|BRUNCH/.test(n)) return 'dining';
  if (/\bSPA\b|MASSAGE/.test(n)) return 'spa';
  if (/WI-?FI|INTERNET/.test(n)) return 'internet';
  if (/EXCURSION|TOUR\b/.test(n)) return 'excursion';
  return 'extra';
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * What would change, and nothing else. A pure function of the document and the reservation, so the preview and the
 * apply cannot disagree about it.
 *
 * `travellers` are in cabin order with the lead first; `lines` are the reservation's current pricing rows.
 */
export function planUpdate(read, booking, travellers, lines, paidCents) {
  const warnings = [...(read.warnings || [])];
  const notes = [];

  // Which traveller each guest in the document is: by name where the names agree, otherwise by place in the list.
  const guestNames = read.rooms.flatMap((r) => r.guests).filter((g) => !/^Guest \d+$/.test(g));
  const guestIds = (guestNames.length ? guestNames : travellers.map((t) => t.name)).map((g, i) => {
    const byName = travellers.find((t) => sameName(t.name, g));
    return (byName || travellers[i] || travellers[0] || {}).id || null;
  });
  const lead = travellers[0] || null;
  const nameOf = (id) => (travellers.find((t) => t.id === id) || {}).name || 'the reservation';

  // What the document says each person owes for each kind of enhancement, one unit at a time.
  const wanted = new Map(); // `${kind}|${travellerId}` -> cents
  const turn = {};
  for (const e of read.enhancements || []) {
    const kind = kindOfEnhancement(e.name);
    for (let i = 0; i < e.qty; i += 1) {
      const slot = turn[kind] || 0;
      turn[kind] = slot + 1;
      const id = guestIds.length ? guestIds[slot % guestIds.length] : (lead && lead.id);
      const key = `${kind}|${id || ''}`;
      wanted.set(key, (wanted.get(key) || 0) + e.priceCents);
    }
  }

  const have = new Map();
  const haveByKind = {};
  for (const l of lines) {
    const key = `${l.kind}|${l.traveller_id || ''}`;
    have.set(key, (have.get(key) || 0) + (l.amount_cents || 0));
    haveByKind[l.kind] = (haveByKind[l.kind] || 0) + (l.amount_cents || 0);
  }

  const wantedByKind = {};
  for (const [key, cents] of wanted) {
    const kind = key.split('|')[0];
    wantedByKind[kind] = (wantedByKind[kind] || 0) + cents;
  }

  const additions = [];
  for (const kind of Object.keys(wantedByKind)) {
    const label = (PRICE_KINDS.find((k) => k.kind === kind) || {}).label || kind;
    const missing = wantedByKind[kind] - (haveByKind[kind] || 0);
    if (missing <= 0) {
      if (missing < 0) warnings.push(`This reservation has ${usd(-missing)} more in ${label} than the confirmation. It was left as it is.`);
      continue;
    }
    // Per person where that adds up to what is missing, otherwise one line for the lead, with a word about it.
    const perPerson = [];
    for (const [key, cents] of wanted) {
      const [k, id] = key.split('|');
      if (k !== kind) continue;
      const short = cents - (have.get(key) || 0);
      if (short > 0) perPerson.push({ travellerId: id || null, amountCents: short });
    }
    const sum = perPerson.reduce((n, p) => n + p.amountCents, 0);
    if (sum === missing) {
      for (const p of perPerson) additions.push({ kind, label, travellerId: p.travellerId, travellerName: nameOf(p.travellerId), amountCents: p.amountCents });
    } else {
      warnings.push(`${label} could not be matched person by person, so ${usd(missing)} went on ${lead ? lead.name : 'the reservation'}. Move it if it belongs to someone else.`);
      additions.push({ kind, label, travellerId: lead ? lead.id : null, travellerName: lead ? lead.name : 'the reservation', amountCents: missing });
    }
  }

  const addedCents = additions.reduce((n, a) => n + a.amountCents, 0);
  const totalAfter = (booking.gross_cents || 0) + addedCents;
  if (read.totalCents !== null && totalAfter !== read.totalCents) {
    warnings.push(`After this the reservation totals ${usd(totalAfter)} and the confirmation says ${usd(read.totalCents)}. `
      + 'Check the fare, taxes and insurance lines, which this leaves alone.');
  }

  // Paid: only ever the difference, and only upwards.
  let payment = null;
  if (read.paidCents !== null) {
    const delta = read.paidCents - paidCents;
    if (delta > 0) payment = { amountCents: delta, paidBy: lead ? lead.id : null, paidByName: lead ? lead.name : null };
    else if (delta < 0) warnings.push(`This reservation shows ${usd(-delta)} more paid than the confirmation does. It was left as it is.`);
  }

  if (read.departDate && booking.depart_date && read.departDate !== booking.depart_date) {
    warnings.push(`The confirmation sails ${read.departDate} and this reservation says ${booking.depart_date}.`);
  }
  if (read.commissionCents !== null && booking.commission_cents !== undefined && read.commissionCents !== (booking.commission_cents || 0)
      && !additions.length) {
    notes.push(`The confirmation shows ${usd(read.commissionCents)} fare commission and this reservation has ${usd(booking.commission_cents || 0)}.`);
  }
  if (read.cancelled) warnings.push('The confirmation says this booking is cancelled. Nothing was changed on that account.');

  return {
    additions, payment, warnings, notes,
    totals: {
      confirmationTotalCents: read.totalCents, totalAfterCents: totalAfter,
      confirmationPaidCents: read.paidCents, portalPaidCents: paidCents,
      dueCents: read.dueCents,
    },
    nothingToDo: !additions.length && !payment,
  };
}

/**
 * POST /api/bookings/:id/confirmation-update, the PDF itself as the body, `X-Filename` naming it.
 * `?apply=1` makes the changes and files the PDF; without it, only reads and compares.
 */
export async function handleConfirmationUpdate(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor. Deliberately not the lock on a booked reservation: this is the vendor's own
  // document being applied, which is the one change to a booked trip that is expected, and it only ever adds.
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');
  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');

  const buf = await request.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength) return badRequest('No file arrived.');
  if (buf.byteLength > MAX_BYTES) return badRequest('That file is larger than 10MB, which is bigger than any confirmation.');

  const file = await pdfRead(buf);
  if (file.encryption === 'password' || file.encryption === 'unsupported') {
    return badRequest('That PDF is locked, so it cannot be read. Download it again from the booking system.');
  }
  if ((file.text || '').trim().length < 40) {
    return badRequest(file.images > 0
      ? 'That PDF is only a picture of a page, such as a scan, so there is no text to read. Download the confirmation itself.'
      : 'Nothing could be read from that file.');
  }
  const read = parseMasAgentCopy(file.text);
  if (!read.ok) return badRequest(read.reason);

  if (booking.confirmation_number && String(booking.confirmation_number).trim() !== read.bookingId) {
    return badRequest(`That confirmation is for booking ${read.bookingId}, and this reservation is booking ${booking.confirmation_number}. `
      + 'Open the reservation it belongs to and upload it there.');
  }

  const { results: people } = await env.DB.prepare(
    `SELECT id, name, is_lead FROM travellers WHERE booking_id = ? AND user_id = ?
      ORDER BY is_lead DESC, created_at ASC, rowid ASC`
  ).bind(bookingId, owner.id).all().catch(() => ({ results: [] }));
  const lines = await listPricing(env, bookingId, { all: false, userId: owner.id });
  const { results: paidRows } = await env.DB.prepare(
    `SELECT amount_cents FROM booking_payments
      WHERE booking_id = ? AND user_id = ? AND payment_class = 'hard' AND paid_date IS NOT NULL`
  ).bind(bookingId, owner.id).all().catch(() => ({ results: [] }));
  const paidCents = (paidRows || []).reduce((n, p) => n + (p.amount_cents || 0), 0);

  const plan = planUpdate(read, booking, people || [], lines, paidCents);
  const summary = {
    bookingId: read.bookingId, itinerary: read.itinerary, ship: read.ship, departDate: read.departDate,
    cabins: read.rooms.map((r) => r.cabin).join(', '),
  };

  const url = new URL(request.url);
  if (url.searchParams.get('apply') !== '1') return json({ ok: true, applied: false, read: summary, plan });

  // Applying. Pricing first and the payment after, so the final balance is resized once for each, in the order a person
  // would have done them by hand.
  const ts = now();
  const order = new Map(PRICE_KINDS.map((k, i) => [k.kind, i]));
  for (const a of plan.additions) {
    await env.DB.prepare(
      `INSERT INTO booking_pricing (id, booking_id, user_id, traveller_id, component_id, kind, label, amount_cents,
         commissionable, commission_cents, commission_pct, commission_kind, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 0, 0, NULL, 'base', ?, ?, ?)`
    ).bind(uid(), bookingId, owner.id, a.travellerId, a.kind, a.amountCents, order.get(a.kind) || 0, ts, ts).run();
  }
  if (plan.additions.length) await syncBookingTotals(env, bookingId, owner.id);

  if (!booking.confirmation_number) {
    await env.DB.prepare('UPDATE bookings SET confirmation_number = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(read.bookingId, now(), bookingId, owner.id).run();
  }

  let paymentSaved = false;
  if (plan.payment) {
    const today = new Date().toISOString().slice(0, 10);
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    const res = await handleCreatePayment(new Request(request.url, {
      method: 'POST', headers,
      body: JSON.stringify({
        bookingId, kind: 'installment', paymentClass: 'hard', amount: (plan.payment.amountCents / 100).toFixed(2),
        dueDate: today, paidDate: today, method: 'other', paymentType: 'to_vendor', paidBy: plan.payment.paidBy || '',
        notes: `From the confirmation for booking ${read.bookingId}. The date is the day it was entered.`,
      }),
    }), env);
    paymentSaved = res.ok;
    if (!res.ok) plan.warnings.push('The payment could not be recorded. Add it by hand.');
  }

  // The PDF itself, under Documents as a confirmation, unless this very file is already there. Not shared with the
  // client: the agent copy has the commission printed on it.
  let filed = null;
  if (docsReady(env)) {
    const filename = safeName(request.headers.get('x-filename') || `AGENT_${read.bookingId}.pdf`);
    const dup = await env.DB.prepare(
      'SELECT id FROM documents WHERE booking_id = ? AND user_id = ? AND filename = ? AND size_bytes = ?'
    ).bind(bookingId, owner.id, filename, buf.byteLength).first();
    if (!dup) {
      const id = uid();
      const key = `${owner.id}/${bookingId}/${id}-${filename}`;
      await env.DOCS.put(key, buf, { httpMetadata: { contentType: 'application/pdf' } });
      await env.DB.prepare(
        `INSERT INTO documents (id, user_id, booking_id, object_key, filename, content_type, size_bytes, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, 'confirmation', ?, ?)`
      ).bind(id, owner.id, bookingId, key, filename, buf.byteLength, ts, ts).run();
      filed = filename;
    }
  }

  await db.logActivity(env, owner.id, 'booking.confirmation',
    db.byHand(`Updated ${booking.client_name}'s trip from the vendor confirmation`, user, owner),
    { bookingId, added: plan.additions.length, payment: paymentSaved });

  return json({ ok: true, applied: true, read: summary, plan, filed, paymentSaved });
}
