// Client payments to travel suppliers.
//
// The agency never handles this money. A client pays the cruise line or resort
// directly; the advisor posts and tracks those payments so nothing slips past
// a supplier deadline and cancels a booking. "Deposit" is the amount a client
// pays up front to hold a trip, not a bank deposit.
//
// The agency's own revenue is the commission a supplier pays it, which lives
// on the booking and is deliberately kept out of these totals. Mixing the two
// would make it look like the agency turned over the full trip cost.

import { json, badRequest, notFound, uid, now, clean, cleanDate, toCents, oneOf, readJson } from './util.js';
import { requireUser } from './auth.js';
import { sendPaymentReminder } from './email.js';
import * as db from './db.js';
import * as ghl from './ghl.js';

const KINDS = ['deposit', 'installment', 'final', 'refund'];
const CLASSES = ['hard', 'soft'];
// 'other' leads because it is the fallback: recording a payment as being on a
// card when nobody said so is inventing a detail, not choosing a default.
const METHODS = ['other', 'card', 'ach', 'check', 'cash', 'transfer'];
// How the client settled it. Future cruise credits and deposits are here
// because a client paying with one is the commonest reason a balance drops
// without money moving, and it links the payment to the credit being spent.
export const PAYMENT_TYPES = [
  'other', 'to_vendor', 'to_agency', 'card', 'check', 'cash', 'ach',
  'future_cruise_credit', 'future_cruise_deposit',
];

const isoDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Spending a credit is a ledger move, not a label.
//
// A future cruise credit is money the client has already handed a vendor.
// Spending it on one trip means it cannot be spent on another. Recording only
// the words "paid with a credit" would leave that credit sitting on the
// Credits page as open money, and it would be offered again on the next
// reservation, so the client is told twice that they have money they spent
// once.
//
// A credit is marked used only when the payment is actually posted. A future
// payment that intends to use one is an intention, and marking it spent before
// the money moves is a claim about something that has not happened.
// ---------------------------------------------------------------------------

async function creditForUser(env, userId, creditId) {
  return env.DB.prepare(
    `SELECT id, client_name, vendor, amount_cents, expires_on, used_on, booking_id
       FROM client_credits WHERE id = ? AND user_id = ?`
  ).bind(creditId, userId).first();
}

/** Is some other posted payment already spending this credit? */
async function spentElsewhere(env, userId, creditId, exceptPaymentId) {
  const row = await env.DB.prepare(
    `SELECT id FROM booking_payments
      WHERE credit_id = ? AND user_id = ? AND paid_date IS NOT NULL AND id != ?`
  ).bind(creditId, userId, exceptPaymentId || '').first();
  return Boolean(row);
}

async function spendCredit(env, userId, creditId, bookingId, paidDate) {
  await env.DB.prepare(
    `UPDATE client_credits SET used_on = ?, booking_id = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(paidDate, bookingId, now(), creditId, userId).run();
}

/**
 * Puts a credit back when the payment that spent it is deleted, unposted, or
 * repointed at a different credit. A credit left marked used after its payment
 * has gone is money the client owns and nobody can see. The booking link is
 * left alone: the credit is still earmarked for that trip, it just has not
 * been spent yet.
 */
export async function releaseCredit(env, userId, creditId, exceptPaymentId) {
  if (!creditId) return;
  if (await spentElsewhere(env, userId, creditId, exceptPaymentId)) return;
  await env.DB.prepare(
    'UPDATE client_credits SET used_on = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(now(), creditId, userId).run();
}

/**
 * Checked before the payment is written, so a refused credit does not leave a
 * payment behind claiming to have spent it.
 */
async function creditProblem(env, userId, creditId, exceptPaymentId) {
  if (!creditId) return null;
  const credit = await creditForUser(env, userId, creditId);
  if (!credit) return 'That credit is not yours.';
  if (await spentElsewhere(env, userId, creditId, exceptPaymentId)) {
    return 'That credit has already been applied to another payment.';
  }
  return null;
}

/**
 * Who handed the money over has to be someone actually on the trip.
 *
 * A traveller id from another reservation would show that reservation's
 * passenger as having paid for a trip they are not on.
 */
async function payerProblem(env, userId, bookingId, paidBy) {
  if (!paidBy) return null;
  const row = await env.DB.prepare(
    'SELECT id FROM travellers WHERE id = ? AND booking_id = ? AND user_id = ?'
  ).bind(paidBy, bookingId, userId).first();
  return row ? null : 'That payer is not a traveller on this reservation.';
}

/**
 * Brings the credit ledger into line with a payment that has just been written.
 *
 * One place rather than three, because create, update and mark-posted can all
 * change which credit a payment spends and whether it has been posted yet.
 */
async function settleCredit(env, userId, payment, previousCreditId) {
  const creditId = payment.credit_id || null;
  if (previousCreditId && previousCreditId !== creditId) {
    await releaseCredit(env, userId, previousCreditId, payment.id);
  }
  if (!creditId) return;
  if (payment.paid_date) {
    await spendCredit(env, userId, creditId, payment.booking_id, payment.paid_date);
  } else {
    await releaseCredit(env, userId, creditId, payment.id);
  }
}

export async function handlePayments(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const state = oneOf(url.searchParams.get('state') || 'all', ['all', 'outstanding', 'paid']);
  const cls = url.searchParams.get('class');
  const scope = db.scopeFor(env, user, request);

  const [payments, stats, balances] = await Promise.all([
    db.listPayments(env, scope, {
      state: state === 'all' ? undefined : state,
      paymentClass: CLASSES.includes(cls) ? cls : undefined,
      query: clean(url.searchParams.get('q'), 80) || undefined,
      limit: url.searchParams.get('limit'),
    }),
    db.paymentStats(env, scope, { today: isoDay(0), soonThrough: isoDay(30) }),
    db.bookingBalances(env, scope),
  ]);

  const { rows: shown, truncated } = db.capped(payments, url.searchParams.get('limit'));
  return json({
    payments: shown,
    truncated,
    cap: db.LIST_CAP,
    stats,
    balances: balances.map((b) => ({
      ...b,
      // What is neither paid nor even scheduled yet. A booking worth $8,000
      // with a $500 deposit and nothing else on the schedule is the common
      // case that quietly goes uncollected.
      unscheduled_cents: Math.max(0, (b.gross_cents || 0) - (b.paid_cents || 0) - (b.scheduled_cents || 0)),
    })),
    today: isoDay(0),
    paymentTypes: PAYMENT_TYPES,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

function parsePayment(body) {
  const bookingId = clean(body.bookingId, 64);
  if (!bookingId) return { error: 'Pick a booking.' };

  const amountCents = toCents(body.amount);
  if (amountCents <= 0) return { error: 'Enter an amount.' };

  const dueDate = cleanDate(body.dueDate);
  const paidDate = cleanDate(body.paidDate);
  if (!dueDate && !paidDate) {
    return { error: 'A payment needs a due date, a paid date, or both.' };
  }

  return {
    fields: {
      bookingId,
      kind: oneOf(body.kind, KINDS),
      // Hard is the vendor's deadline, soft the advisor's own earlier
      // reminder. Defaulting to hard is the safe way round: treating a real
      // deadline as a reminder is how a reservation gets cancelled.
      paymentClass: oneOf(body.paymentClass, CLASSES),
      amountCents,
      dueDate,
      paidDate,
      method: paidDate ? oneOf(body.method, METHODS) : null,
      // Left null when nobody said. oneOf would otherwise turn silence into
      // the first item in the list, which is a claim about how a client paid.
      paymentType: body.paymentType ? oneOf(body.paymentType, PAYMENT_TYPES) : null,
      paidBy: clean(body.paidBy, 64) || null,
      creditId: clean(body.creditId, 64) || null,
      // The last four digits and nothing more. Storing a card number would
      // put this Worker and its database inside PCI scope, which is a serious
      // undertaking for a small tool and answers no question an advisor asks.
      // Digits first, then the last four. Truncating to four characters before
      // stripping would turn a pasted "4111 1111 1111 4242" into "4111": the
      // first four digits of a card, which is exactly the wrong end of it.
      cardLast4: (clean(body.cardLast4, 40) || '').replace(/\D/g, '').slice(-4) || null,
      reference: clean(body.reference, 80),
      notes: clean(body.notes, 500),
    },
  };
}

/**
 * Chase a client about a payment, and remember that you did.
 *
 * Preview first, send second, as two separate requests. An email to a client
 * is not undoable, and a button that sends one on its first click is a button
 * people learn to be afraid of. The preview returns exactly what would be
 * sent, from the same call that sends it.
 */
export async function handlePaymentReminder(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const payment = await db.getPayment(env, id, user.id);
  if (!payment) return notFound('Payment not found.');
  if (payment.paid_date) return badRequest('That payment has already been posted.');

  const booking = await db.getBooking(env, payment.booking_id, user.id);
  if (!booking) return notFound('Reservation not found.');

  const client = booking.client_id
    ? await db.getClient(env, db.selfScope(user), { id: booking.client_id })
    : await db.getClient(env, db.selfScope(user), { name: booking.client_name });

  const body = await readJson(request);
  const to = client && client.email;

  const details = {
    to,
    replyTo: user.email,
    clientName: (client && client.name) || booking.client_name,
    advisorName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
    agencyName: user.agency_name || '',
    amountCents: payment.amount_cents,
    dueDate: payment.due_date,
    hard: payment.payment_class === 'hard',
    tripName: booking.product_name || '',
    vendor: booking.supplier || '',
    confirmation: booking.confirmation_number || '',
  };

  if (body.preview) {
    return json({
      preview: true,
      to: to || null,
      // Named rather than left as a failed send: the fix is on the client
      // record, and saying so is more use than an error.
      problem: to ? null : 'That client has no email address on file.',
      clientId: client ? client.id : null,
      details,
      alreadySent: payment.reminded_at || null,
      sentCount: payment.reminder_count || 0,
    });
  }

  if (!to) return badRequest('That client has no email address on file.');

  try {
    await sendPaymentReminder(env, details);
  } catch (e) {
    return badRequest(String((e && e.message) || e).slice(0, 300));
  }

  await env.DB.prepare(
    `UPDATE booking_payments SET reminded_at = ?, reminder_count = reminder_count + 1, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(now(), now(), id, user.id).run();

  await db.logActivity(env, user.id, 'payment.remind',
    `Reminded ${details.clientName} about ${details.hard ? 'a vendor deadline' : 'a balance'}`,
    { paymentId: id, bookingId: booking.id });

  return json({ ok: true, sentTo: to });
}

export async function handleCreatePayment(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parsePayment(await readJson(request));
  if (error) return badRequest(error);

  // The booking has to be this advisor's, or one advisor could attach a
  // payment to another's booking.
  const booking = await db.getBooking(env, fields.bookingId, user.id);
  if (!booking) return notFound('Booking not found.');

  const problem = (await creditProblem(env, user.id, fields.creditId, null))
    || (await payerProblem(env, user.id, fields.bookingId, fields.paidBy));
  if (problem) return badRequest(problem);

  const payment = await db.createPayment(env, user.id, fields);
  await settleCredit(env, user.id, payment, null);
  await db.logActivity(env, user.id, 'payment.create',
    `${fields.paidDate ? 'Recorded' : 'Scheduled'} ${fields.kind} for ${booking.client_name}`,
    { bookingId: fields.bookingId });
  return json({ ok: true, payment }, 201);
}

export async function handleUpdatePayment(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const { fields, error } = parsePayment(body);
  if (error) return badRequest(error);

  // The payment itself is scoped by user, but the booking it points at comes
  // from the request. Without this an advisor could move their own payment
  // onto someone else's booking and corrupt that booking's balance. Create
  // already checked this; update did not.
  const booking = await db.getBooking(env, fields.bookingId, user.id);
  if (!booking) return notFound('Booking not found.');

  // Read before writing, because the credit this payment used to spend has to
  // be put back if it is no longer the one being spent.
  const existing = await db.getPayment(env, id, user.id);
  if (!existing) return notFound('Payment not found.');

  // An update writes every column, so a form that does not carry these fields
  // would silently erase them. The Payments page edits dates and amounts and
  // knows nothing about who paid or which credit was spent; without this,
  // correcting a typo there would strip a payment of its payer, its card and
  // its credit, and hand the credit back to the client as unspent.
  for (const [key, column] of [['paymentType', 'payment_type'], ['paidBy', 'paid_by'],
                               ['creditId', 'credit_id'], ['cardLast4', 'card_last4']]) {
    if (body[key] === undefined) fields[key] = existing[column] || null;
  }
  // The method follows the same rule, except that unposting a payment clears
  // it: a payment nobody has received was not received by any means.
  if (body.method === undefined && fields.paidDate) fields.method = existing.method || null;

  const problem = (await creditProblem(env, user.id, fields.creditId, id))
    || (await payerProblem(env, user.id, fields.bookingId, fields.paidBy));
  if (problem) return badRequest(problem);

  const payment = await db.updatePayment(env, id, user.id, fields);
  if (!payment) return notFound('Payment not found.');
  await settleCredit(env, user.id, payment, existing.credit_id || null);
  await db.logActivity(env, user.id, 'payment.update', 'Updated a payment', { id });
  return json({ ok: true, payment });
}

/** The one-click action: this money arrived today. */
/**
 * Keep the reminder honest about what is still owed.
 *
 * A final balance is two rows: the vendor's deadline, and a soft line a week
 * earlier that exists only to make somebody chase it in time. They are one
 * obligation shown twice, which is why every money total counts the hard rows
 * and ignores the soft ones.
 *
 * So once money has moved, the reminder has to be told. Left alone it goes on
 * asking for the original figure after half of it has been paid, which is how
 * a client gets chased for money they already sent.
 */
async function syncSoftReminder(env, user, bookingId, kind) {
  const rows = await db.listPayments(env, db.selfScope(user), { bookingId });
  const mine = rows.filter((r) => r.kind === kind);
  const owed = mine
    .filter((r) => r.payment_class === 'hard' && !r.paid_date)
    .reduce((n, r) => n + (r.amount_cents || 0), 0);
  const reminders = mine
    .filter((r) => r.payment_class === 'soft' && !r.paid_date)
    .sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));

  if (owed <= 0) {
    // Nothing left to chase, so there is nothing to be reminded about.
    for (const r of reminders) await db.deletePayment(env, r.id, user.id);
    return;
  }
  // One reminder, for what is actually left. Any others are leftovers from a
  // schedule built more than once.
  const [keep, ...extra] = reminders;
  for (const r of extra) await db.deletePayment(env, r.id, user.id);
  if (keep && (keep.amount_cents || 0) !== owed) {
    await db.updatePayment(env, keep.id, user.id, {
      kind: keep.kind,
      paymentClass: keep.payment_class,
      amountCents: owed,
      dueDate: keep.due_date,
      paidDate: null,
      method: keep.method || null,
      paymentType: keep.payment_type || null,
      paidBy: keep.paid_by || null,
      creditId: keep.credit_id || null,
      cardLast4: keep.card_last4 || null,
      reference: keep.reference,
      notes: keep.notes,
    });
  }
}

export async function handleMarkPaid(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  let existing = await db.getPayment(env, id, user.id);
  if (!existing) return notFound('Payment not found.');

  // You cannot pay a reminder.
  //
  // The soft line is the same money as the vendor deadline it sits a week in
  // front of, and only the hard rows are counted as paid. Posting against the
  // reminder therefore recorded the payment somewhere no total looks at: the
  // reservation still showed the whole balance outstanding, and the vendor
  // deadline still asked for all of it. So the posting is moved to the row it
  // was really about.
  if (existing.payment_class === 'soft') {
    const siblings = await db.listPayments(env, db.selfScope(user),
      { bookingId: existing.booking_id });
    const realOne = siblings.find((r) => r.kind === existing.kind
      && r.payment_class === 'hard' && !r.paid_date);
    if (realOne) {
      id = realOne.id;
      existing = realOne;
    }
  }

  // Everything not being posted right now is carried across. An update writes
  // every column, so leaving these out silently erased who paid and how from a
  // payment that already recorded it.
  const creditId = body.creditId === undefined
    ? (existing.credit_id || null) : (clean(body.creditId, 64) || null);
  const paidBy = body.paidBy === undefined
    ? (existing.paid_by || null) : (clean(body.paidBy, 64) || null);

  const problem = (await creditProblem(env, user.id, creditId, id))
    || (await payerProblem(env, user.id, existing.booking_id, paidBy));
  if (problem) return badRequest(problem);

  // How much actually arrived. Blank or absent means all of it, which is the
  // ordinary case and the one the button posts.
  //
  // A part payment is recorded as two facts rather than one half-finished
  // one: this row becomes what was received, and the remainder becomes its
  // own scheduled line on the same date. Nothing else in the portal has to
  // learn a new idea -- a paid row is paid and a scheduled row is due, which
  // is what every report, reminder and client statement already reads. A
  // "partly paid" column would have meant changing what outstanding means in
  // forty-odd places, and the ledger would read less honestly for it.
  const due = existing.amount_cents || 0;
  // Dollars, like every other amount this module takes. Taking cents as well
  // would mean guessing which one "1000" meant.
  const received = body.amount === undefined || body.amount === null || body.amount === ''
    ? due
    : Math.max(0, Math.min(toCents(body.amount) || 0, due));
  if (received <= 0) return badRequest('Enter how much was received.');
  const remainder = due - received;

  const payment = await db.updatePayment(env, id, user.id, {
    kind: existing.kind,
    paymentClass: existing.payment_class,
    amountCents: received,
    dueDate: existing.due_date,
    paidDate: cleanDate(body.paidDate) || isoDay(0),
    method: body.method === undefined ? (existing.method || null) : oneOf(body.method, METHODS),
    paymentType: body.paymentType === undefined
      ? (existing.payment_type || null)
      : (body.paymentType ? oneOf(body.paymentType, PAYMENT_TYPES) : null),
    paidBy,
    creditId,
    cardLast4: body.cardLast4 === undefined
      ? (existing.card_last4 || null)
      : ((clean(body.cardLast4, 40) || '').replace(/\D/g, '').slice(-4) || null),
    reference: clean(body.reference, 80) || existing.reference,
    notes: existing.notes,
  });
  await settleCredit(env, user.id, payment, existing.credit_id || null);

  // What is still owed, carried on its own line so the deadline it was due by
  // is not quietly lost with the part that was paid.
  let rest = null;
  if (remainder > 0) {
    rest = await db.createPayment(env, user.id, {
      bookingId: existing.booking_id,
      kind: existing.kind,
      paymentClass: existing.payment_class,
      amountCents: remainder,
      dueDate: existing.due_date,
      paidDate: null,
      method: null,
      reference: existing.reference,
      notes: existing.notes,
      paymentType: null,
      paidBy: existing.paid_by || null,
      creditId: null,
      cardLast4: null,
    });
  }

  await syncSoftReminder(env, user, existing.booking_id, existing.kind);

  await db.logActivity(env, user.id, 'payment.paid',
    remainder > 0
      ? `Recorded a part payment, ${remainder} cents still due`
      : 'Marked a payment received',
    { id, received, remainder });
  return json({ ok: true, payment, remainder: rest });
}

export async function handleDeletePayment(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const existing = await db.getPayment(env, id, user.id);
  const removed = await db.deletePayment(env, id, user.id);
  if (!removed) return notFound('Payment not found.');
  // The credit that payment spent goes back to the client.
  if (existing && existing.credit_id) {
    await releaseCredit(env, user.id, existing.credit_id, id);
  }
  await db.logActivity(env, user.id, 'payment.delete', 'Removed a payment', { id });
  return json({ ok: true });
}

/**
 * Builds a schedule from what the booking already knows.
 *
 * Most bookings follow the same shape: a deposit to hold it, then the balance
 * by a supplier deadline. Generating that rather than making someone type it
 * twice is the difference between the schedule being kept up and being
 * ignored. Skips anything already scheduled so it is safe to run twice.
 */
export async function handleGenerateSchedule(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Booking not found.');

  // Self scope: this reads in order to write, so it must not widen for an owner.
  const existing = await db.listPayments(env, db.selfScope(user), { bookingId });
  const have = new Set(existing.map((p) => p.kind));
  const created = [];

  if (booking.deposit_cents > 0 && booking.deposit_due && !have.has('deposit')) {
    created.push(await db.createPayment(env, user.id, {
      bookingId, kind: 'deposit', paymentClass: 'hard',
      amountCents: booking.deposit_cents,
      dueDate: booking.deposit_due, paidDate: null,
      notes: 'Vendor deadline, generated from the reservation',
    }));
  }

  const balance = (booking.gross_cents || 0) - (booking.deposit_cents || 0);
  if (balance > 0 && booking.final_payment_due && !have.has('final')) {
    // The vendor's date, and a soft reminder a week ahead of it. The reminder
    // is the whole point: chasing on the deadline itself is already too late.
    created.push(await db.createPayment(env, user.id, {
      bookingId, kind: 'final', paymentClass: 'hard', amountCents: balance,
      dueDate: booking.final_payment_due, paidDate: null,
      notes: 'Vendor deadline, generated from the reservation',
    }));

    const softDate = new Date(Date.parse(`${booking.final_payment_due}T00:00:00`) - 7 * 86400000)
      .toISOString().slice(0, 10);
    if (softDate > isoDay(0)) {
      created.push(await db.createPayment(env, user.id, {
        bookingId, kind: 'final', paymentClass: 'soft', amountCents: balance,
        dueDate: softDate, paidDate: null,
        notes: 'Internal reminder, one week before the vendor deadline',
      }));
    }
  }

  if (!created.length) {
    return json({
      ok: true, created: [],
      message: have.size
        ? 'This booking already has a schedule.'
        : 'Add a deposit amount and payment dates to the booking first.',
    });
  }

  await db.logActivity(env, user.id, 'payment.schedule',
    `Built a payment schedule for ${booking.client_name}`, { bookingId });
  return json({ ok: true, created }, 201);
}


/**
 * Set a booking's status.
 *
 * Exists because of what happens when a final payment date passes unpaid: the
 * supplier cancels the booking. The portal cannot know that happened, so the
 * payments page offers the advisor a way to record it once they have checked,
 * rather than leaving a dead booking counted as live revenue forever.
 */
export async function handleSetBookingStatus(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const status = oneOf(body.status, ['booked', 'quoted', 'travelled', 'cancelled']);

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Booking not found.');

  const updated = await db.updateBooking(env, bookingId, user.id, {
    ghlContactId: booking.ghl_contact_id,
    ghlOpportunityId: booking.ghl_opportunity_id,
    clientName: booking.client_name,
    supplier: booking.supplier,
    productType: booking.product_type,
    productName: booking.product_name,
    destination: booking.destination,
    confirmationNumber: booking.confirmation_number,
    departDate: booking.depart_date,
    returnDate: booking.return_date,
    depositDue: booking.deposit_due,
    finalPaymentDue: booking.final_payment_due,
    travellers: booking.travellers,
    grossCents: booking.gross_cents,
    depositCents: booking.deposit_cents,
    commissionCents: booking.commission_cents,
    commissionStatus: booking.commission_status,
    status,
    notes: booking.notes,
  });

  await db.logActivity(env, user.id, 'booking.status',
    `Marked ${booking.client_name} ${status}`, { bookingId, status });
  return json({ ok: true, booking: updated });
}
