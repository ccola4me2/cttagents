// Bookings and trips.
//
// This is the one CRM area GoHighLevel cannot model without a pile of custom
// fields: supplier, confirmation number, sail dates, payment deadlines and
// commission. It lives in D1, optionally linked back to the GHL contact and
// opportunity it came from.

import { json, badRequest, notFound, clean, cleanDate, toCents, oneOf, readJson, now } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import * as ghl from './ghl.js';
import { fireTrigger } from './automations.js';
import { applyTemplates } from './tasktemplates.js';
import { PRODUCT_TYPES } from './producttypes.js';
import { buildStatement, statementFingerprint } from './statement.js';
import { resolveVendor } from './vendors.js';
import { listTravellers, listAmenities, passportProblem } from './travellers.js';
import { PAYMENT_TYPES, releaseCredit } from './payments.js';
import { splitPct, shareOf, UNSPLIT_COMMISSION_KINDS } from './split.js';
import { listOptions } from './options.js';
import { listTiers, penaltyToday } from './penalties.js';
import { listDocuments, docsReady, CATEGORIES as DOC_CATEGORIES } from './documents.js';
import { listComponents, COMPONENT_KINDS } from './components.js';
import { listPricing, summarise, PRICE_KINDS } from './pricing.js';

// The taxonomy a travel agency actually reports on. Five buckets could not
// tell a transfer from a tour from travel insurance, which meant "travel by
// type" said almost nothing. Cruise leads because oneOf falls back to the
// first entry and this is a cruise-first agency, so it is the likeliest
// answer rather than an arbitrary one.
// oneOf falls back to the first entry, so this order decides what a
// reservation created without a status becomes. Quoted, not booked: a
// reservation that nobody said was booked should not quietly land in
// production totals and commission owed.
const STATUSES = ['quoted', 'booked', 'travelled', 'cancelled'];
const COMMISSION_STATUSES = ['pending', 'invoiced', 'paid'];
const BOOKING_METHODS = ['direct', 'portal', 'phone', 'group', 'other'];
// 'unknown' leads because oneOf falls back to the first entry, and not having
// asked is the honest default. Recording a decline is a deliberate act.
const INSURANCE_STATUS = ['unknown', 'purchased', 'declined', 'covered_elsewhere', 'purchased_outside'];

// Handed to every page that offers these as a choice. One list, so a form and
// the validator behind it cannot disagree about what a status may be.
const FIELD_OPTIONS = {
  productTypes: PRODUCT_TYPES,
  statuses: STATUSES,
  commissionStatuses: COMMISSION_STATUSES,
  bookingMethods: BOOKING_METHODS,
  insuranceStatuses: INSURANCE_STATUS,
};

/** Shared parse and validate for create and update. */
function parseBooking(body) {
  const clientName = clean(body.clientName, 120);
  if (!clientName) return { error: 'Client name is required.' };

  const travellers = Math.max(1, Math.min(Number(body.travellers) || 1, 999));
  const departDate = cleanDate(body.departDate);
  const returnDate = cleanDate(body.returnDate);
  if (departDate && returnDate && returnDate < departDate) {
    return { error: 'The return date cannot be before the departure date.' };
  }

  const depositDue = cleanDate(body.depositDue);
  const finalPaymentDue = cleanDate(body.finalPaymentDue);
  if (depositDue && finalPaymentDue && finalPaymentDue < depositDue) {
    return { error: 'Final payment cannot be due before the deposit.' };
  }

  const grossCents = toCents(body.gross);
  const commissionCents = toCents(body.commission);
  if (commissionCents > grossCents && grossCents > 0) {
    return { error: 'Commission cannot exceed the gross booking value.' };
  }

  return {
    fields: {
      ghlContactId: clean(body.ghlContactId, 64) || null,
      ghlOpportunityId: clean(body.ghlOpportunityId, 64) || null,
      groupId: clean(body.groupId, 64) || null,
      clientName,
      supplier: clean(body.supplier, 120),
      productType: oneOf(body.productType, PRODUCT_TYPES),
      productName: clean(body.productName, 160),
      destination: clean(body.destination, 160),
      confirmationNumber: clean(body.confirmationNumber, 80),
      cabin: clean(body.cabin, 40),
      cabinCategory: clean(body.cabinCategory, 120),
      itinerary: clean(body.itinerary, 200),
      bookingMethod: oneOf(body.bookingMethod, BOOKING_METHODS),
      // Not a boolean. "Declined" is a different fact from "not asked", and an
      // advisor who recorded the refusal is in a very different position
      // afterwards from one who left it blank.
      insuranceStatus: oneOf(body.insuranceStatus, INSURANCE_STATUS),
      // An advisor's own holiday. Kept out of production and targets, kept in
      // commission, because the money is real even when the sale is not client
      // business.
      personal: body.personal ? 1 : 0,
      advisorSplitPct: body.advisorSplitPct === '' || body.advisorSplitPct == null
        ? null
        : Math.max(0, Math.min(Number(body.advisorSplitPct) || 0, 100)),
      departDate,
      returnDate,
      depositDue,
      finalPaymentDue,
      travellers,
      grossCents,
      depositCents: toCents(body.deposit),
      commissionCents,
      commissionStatus: oneOf(body.commissionStatus, COMMISSION_STATUSES),
      status: oneOf(body.status, STATUSES),
      notes: clean(body.notes, 4000),
    },
  };
}

export async function handleListBookings(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const scope = db.scopeFor(env, user, request);
  const found = await db.listBookings(env, scope, {
    status: STATUSES.includes(statusParam) ? statusParam : undefined,
    search: clean(url.searchParams.get('q'), 80) || undefined,
    limit: url.searchParams.get('limit'),
  });
  // One row past the cap came back if there is more behind it, so the page can
  // say the list was cut rather than filtering an answer that is already
  // missing what somebody is looking for.
  const { rows: bookings, truncated } = db.capped(found, url.searchParams.get('limit'));
  return json({
    bookings,
    truncated,
    cap: db.LIST_CAP,
    stats: await db.bookingStats(env, scope),
    // The same lists the record page gets, so the new reservation form and the
    // validator cannot disagree about what a status may be.
    fieldOptions: FIELD_OPTIONS,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

export async function handleGetBooking(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  // Read scope, not write scope: an owner opening an advisor's reservation
  // from search should see it. Editing it still goes through getBooking.
  const booking = await db.getBookingInScope(env, id, db.scopeFor(env, user, request));
  return booking ? json({ booking }) : notFound('Booking not found.');
}

/**
 * Everything about one reservation on a single screen.
 *
 * Until now a trip was scattered: its payments lived on the Payments page
 * behind a filter, its tasks on the To do page, a credit against it on the
 * Credits page, and the block it was sold from on Groups. Answering "where are
 * we with the Barnabys" meant four screens and holding the answer in your
 * head. This is the screen a CRM exists to have.
 *
 * Each part is fetched independently and allowed to be empty. A reservation
 * with no schedule yet is the normal case, not an error.
 */
export async function handleBookingRecord(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const booking = await db.getBookingInScope(env, id, scope);
  if (!booking) return notFound('Reservation not found.');

  // Scoped the same way the reservation was, so an owner reading an
  // associate's trip sees its payments too rather than an empty schedule.
  const payScope = db.scopeWhere(scope, 'p.user_id');
  const taskScope = db.scopeWhere(scope, 't.user_id');
  const creditScope = db.scopeWhere(scope, 'c.user_id');

  const [payments, tasks, credits, spendable, group, people, extras, priceLines,
         options, tiers, docs, components] = await Promise.all([
    // Joined rather than looked up in the page, so a payment made with a
    // credit can show the credit's own amount beside it. A $250 credit against
    // a $1,000 payment is a difference worth seeing, not one worth hiding.
    env.DB.prepare(
      `SELECT ${db.PAYMENT_COLUMNS},
              t.name AS paid_by_name,
              cr.amount_cents AS credit_amount_cents, cr.vendor AS credit_vendor
         FROM booking_payments p
         LEFT JOIN travellers t ON t.id = p.paid_by
         LEFT JOIN client_credits cr ON cr.id = p.credit_id
        WHERE p.booking_id = ? AND ${payScope.sql}
        ORDER BY COALESCE(p.due_date, '9999-12-31') ASC`
    ).bind(id, ...payScope.binds).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.priority, t.done_at, t.pinned_at
         FROM tasks t WHERE t.booking_id = ? AND ${taskScope.sql}
        ORDER BY t.done_at IS NOT NULL ASC, COALESCE(t.due_date, '9999-12-31') ASC`
    ).bind(id, ...taskScope.binds).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT c.id, c.client_name, c.vendor, c.kind, c.amount_cents, c.expires_on, c.used_on
         FROM client_credits c WHERE c.booking_id = ? AND ${creditScope.sql}`
    ).bind(id, ...creditScope.binds).all().catch(() => ({ results: [] })),

    // What this client could pay with: their open credits, plus whatever is
    // already spent on this trip so an existing choice still has a name.
    // Offering a credit that has been spent is how the same money gets counted
    // against two reservations.
    env.DB.prepare(
      `SELECT c.id, c.client_name, c.vendor, c.kind, c.reference, c.amount_cents,
              c.expires_on, c.used_on
         FROM client_credits c
        WHERE ${creditScope.sql}
          AND ((c.used_on IS NULL AND ((c.client_id IS NOT NULL AND c.client_id = ?)
                                       OR c.client_name = ?))
               OR c.id IN (SELECT credit_id FROM booking_payments WHERE booking_id = ?))
        ORDER BY COALESCE(c.expires_on, '9999-12-31') ASC`
    ).bind(...creditScope.binds, booking.client_id || null, booking.client_name, id)
      .all().catch(() => ({ results: [] })),

    booking.group_id
      ? env.DB.prepare(
          'SELECT id, name, group_code, vendor, option_date, cabins_held FROM travel_groups WHERE id = ?'
        ).bind(booking.group_id).first()
      : Promise.resolve(null),
    listTravellers(env, id, scope),
    listAmenities(env, id, scope),
    listPricing(env, id, scope),
    listOptions(env, id, scope),
    listTiers(env, scope, { bookingId: id }),
    listDocuments(env, id, scope),
    listComponents(env, id, scope),
  ]);

  // Looked up the way the statement looks it up. The client's name reaches the
  // document, so a fingerprint taken without them would never match one taken
  // with them, and the invoice would read as stale from the moment it was sent.
  const statementClient = booking.client_id
    ? await db.getClient(env, scope, { id: booking.client_id })
    : await db.getClient(env, scope, { name: booking.client_name });

  // The vendor's own rate, so an expected commission can be worked out and
  // compared with what actually arrived.
  const vendor = booking.vendor_id
    ? await env.DB.prepare('SELECT name, commission_pct FROM vendors WHERE id = ?')
        .bind(booking.vendor_id).first()
    : null;

  // Hard rows only. A soft row is a reminder to chase the same balance a week
  // before its vendor deadline, not a second amount owed, so totalling both
  // reports a $5,000 trip as owing $9,500.
  const owed = (payments.results || []).filter((p) => p.payment_class === 'hard');
  const paid = owed.filter((p) => p.paid_date).reduce((n, p) => n + (p.amount_cents || 0), 0);
  const scheduled = owed.filter((p) => !p.paid_date).reduce((n, p) => n + (p.amount_cents || 0), 0);

  // A passport is checked against the trip's own return date, not today: the
  // six month rule is applied on arrival, so a passport valid now can still be
  // refused at a desk in four months' time.
  const travellers = (people || []).map((t) => ({
    ...t, passportWarning: passportProblem(t, booking.return_date || booking.depart_date),
  }));

  return json({
    booking,
    // The choices offered, and which one was taken. Empty for most
    // reservations, which is the normal case rather than a missing feature.
    options,
    // What it costs the client to cancel today, and the schedule it came
    // from. Null when nobody has recorded terms, which is a different answer
    // from nothing to pay.
    penaltyTiers: tiers,
    // The paperwork, and whether there is anywhere to put any. Said plainly
    // rather than showing an upload button that fails.
    documents: docs,
    documentCategories: DOC_CATEGORIES,
    // What the client has said on their own page. Read here rather than on a
    // request of its own: a note nobody sees is the read-only page quietly
    // breaking the promise that telling you is enough.
    messages: await tripMessages(env, booking.id, booking.user_id),
    // Whether the invoice or quote the client is holding still matches this
    // reservation. Answered here so the page can say "changed since you sent
    // it" without the advisor having to open the preview and compare by eye.
    statementStale: await statementStale(env, booking, {
      // The same inputs the statement itself is built from, under the names
      // this handler happens to use for them. `people` rather than the
      // enriched travellers above: the statement reads only names, and
      // fingerprinting a passport warning would make the client's copy look
      // stale because a passport moved closer to expiring.
      pricing: priceLines, travellers: people || [], amenities: extras || [],
      payments: payments.results || [], options, client: statementClient, user,
    }),
    // The lists the edit form needs, so the page and the validator can never
    // disagree about what a status or a product type may be. The reservations
    // list hardcoded its own copies and drifted from these twice.
    fieldOptions: FIELD_OPTIONS,
    documentsReady: docsReady(env),
    // The other vendors on this trip. Air, insurance, a hotel either side of a
    // cruise: one holiday, several confirmation numbers.
    components,
    componentKinds: COMPONENT_KINDS,
    penalty: penaltyToday(booking, tiers, new Date().toISOString().slice(0, 10)),
    pricing: priceLines,
    priceKinds: PRICE_KINDS,
    // Null when there is no breakdown: an empty summary reads as zero, and
    // zero is a claim rather than an absence.
    priceSummary: priceLines.length
      ? summarise(priceLines, vendor && vendor.commission_pct) : null,
    vendorRate: vendor ? vendor.commission_pct : null,
    travellers,
    amenities: extras || [],
    payments: payments.results || [],
    tasks: tasks.results || [],
    credits: credits.results || [],
    spendableCredits: spendable.results || [],
    paymentTypes: PAYMENT_TYPES,
    group,
    // What is neither posted nor even on the schedule. The quiet number: a
    // trip worth $8,000 with a $500 deposit and nothing else planned.
    money: {
      paidCents: paid,
      scheduledCents: scheduled,
      unscheduledCents: Math.max(0, (booking.gross_cents || 0) - paid - scheduled),
    },
    // What the advisor who booked it keeps, and what the agency keeps. Shown
    // on the reservation because that is where the override is set, and a
    // percentage with no money beside it is easy to get backwards.
    split: (() => {
      const pct = splitPct(booking.advisor_split_pct, booking.default_split_pct);
      // A TC credit or a bonus is the advisor's in full, so it comes out of
      // the sum before the percentage is applied and goes back on afterwards.
      const unsplit = priceLines
        .filter((l) => UNSPLIT_COMMISSION_KINDS.includes(l.commission_kind))
        .reduce((n, l) => n + (l.commission_cents || 0), 0);
      return {
        pct,
        // Whether this trip carries its own figure or is following the
        // advisor's standing agreement. The page says which, because "70%"
        // means something different in each case.
        overridden: booking.advisor_split_pct !== null && booking.advisor_split_pct !== undefined,
        defaultPct: booking.default_split_pct === null || booking.default_split_pct === undefined
          ? null : Number(booking.default_split_pct),
        ...shareOf(booking.commission_cents, pct, unsplit),
      };
    })(),
    // Whether this reader may change any of it, so the page does not offer
    // buttons that would fail.
    editable: booking.user_id === user.id,
    today: new Date().toISOString().slice(0, 10),
  });
}

/**
 * Has the reservation moved since the client's copy was sent?
 *
 * False when nothing has been sent: there is no copy to be out of date. Wrapped
 * because a fingerprint that throws must not cost the whole page.
 */
async function statementStale(env, booking, parts) {
  if (!booking.statement_hash) return false;
  try {
    const built = buildStatement({ booking, ...parts });
    return booking.statement_hash !== (await statementFingerprint(built));
  } catch (e) {
    console.error('statement stale', e);
    return false;
  }
}

/** Notes the client left on their trip page, newest first. */
async function tripMessages(env, bookingId, userId) {
  const { results } = await env.DB.prepare(
    `SELECT id, body, read_at, created_at FROM trip_messages
      WHERE booking_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(bookingId, userId).all().catch(() => ({ results: [] }));
  return results || [];
}

export async function handleCreateBooking(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parseBooking(await readJson(request));
  if (error) return badRequest(error);

  // The client record is created as a side effect of booking, so nobody has
  // to maintain a separate list of people before they can take a reservation.
  fields.clientId = await db.resolveClient(env, user.id, fields.clientName,
    { ghlContactId: fields.ghlContactId });
  fields.vendorId = await resolveVendor(env, user.id, fields.supplier);
  const booking = await db.createBooking(env, user.id, fields);
  await db.logActivity(env, user.id, 'booking.create',
    `Added booking for ${booking.client_name}`, { id: booking.id });
  await fireTrigger(env, ghl.locationFor(env, user), 'booking.created', {
    bookingId: booking.id,
    contactId: booking.ghl_contact_id || null,
    name: booking.client_name,
    supplier: booking.supplier || '',
    product: booking.product_name || '',
    depart_date: booking.depart_date || '',
    final_payment_due: booking.final_payment_due || '',
  });
  // The standard tasks that follow this kind of trip. Best effort: a template
  // that cannot work out its date is skipped, and a failure here does not cost
  // the reservation, which would be entirely the wrong way round.
  const tasks = await applyTemplates(env, user.id, booking);

  return json({ ok: true, booking, tasksMade: tasks.made }, 201);
}

/**
 * Fill in one or two fields without sending the whole reservation back.
 *
 * An import brings in the skeleton a list can carry: client, vendor, ship,
 * departure, confirmation. Everything that matters afterwards, the trip cost,
 * the commission and the vendor's deadline, has to be typed in. Doing that
 * through the full edit dialog is eighty dialogs, which is the sort of task
 * that never gets finished.
 *
 * Only the fields present in the request are touched. A partial update that
 * quietly blanks what it was not told about is worse than no partial update.
 */
const QUICK_FIELDS = {
  gross: ['gross_cents', (v) => toCents(v)],
  commission: ['commission_cents', (v) => toCents(v)],
  deposit: ['deposit_cents', (v) => toCents(v)],
  departDate: ['depart_date', (v) => cleanDate(v)],
  returnDate: ['return_date', (v) => cleanDate(v)],
  depositDue: ['deposit_due', (v) => cleanDate(v)],
  finalPaymentDue: ['final_payment_due', (v) => cleanDate(v)],
  confirmationNumber: ['confirmation_number', (v) => clean(v, 80)],
  cabin: ['cabin', (v) => clean(v, 40)],
  cabinCategory: ['cabin_category', (v) => clean(v, 120)],
  itinerary: ['itinerary', (v) => clean(v, 200)],
  bookingMethod: ['booking_method', (v) => oneOf(v, BOOKING_METHODS)],
  insuranceStatus: ['insurance_status', (v) => oneOf(v, INSURANCE_STATUS)],
  supplier: ['supplier', (v) => clean(v, 120)],
  productName: ['product_name', (v) => clean(v, 160)],
  status: ['status', (v) => oneOf(v, STATUSES)],
  productType: ['product_type', (v) => oneOf(v, PRODUCT_TYPES)],
  commissionStatus: ['commission_status', (v) => oneOf(v, COMMISSION_STATUSES)],
  invoiceNotes: ['invoice_notes', (v) => clean(v, 1000)],
  personal: ['personal', (v) => (v ? 1 : 0)],
  // Blank clears the override and puts the trip back on the advisor's standing
  // agreement, which is why this cannot go through toCents or oneOf: both turn
  // "nothing set" into a value.
  advisorSplitPct: ['advisor_split_pct', (v) => (v === '' || v === null || v === undefined
    || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(Number(v), 100)))],
};

export async function handleQuickUpdate(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const sets = [];
  const binds = [];

  for (const [key, [column, coerce]] of Object.entries(QUICK_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    sets.push(`${column} = ?`);
    binds.push(coerce(body[key]));
  }
  if (!sets.length) return badRequest('Nothing to change.');

  const before = await db.getBooking(env, id, user.id);
  if (!before) return notFound('Reservation not found.');

  // Checked against what will actually be stored rather than what was sent,
  // so a commission typed into a row whose value is already recorded is
  // refused the same way the dialog refuses it.
  const gross = Object.prototype.hasOwnProperty.call(body, 'gross')
    ? toCents(body.gross) : (before.gross_cents || 0);
  const commission = Object.prototype.hasOwnProperty.call(body, 'commission')
    ? toCents(body.commission) : (before.commission_cents || 0);
  if (gross > 0 && commission > gross) {
    return badRequest('Commission cannot exceed the trip cost.');
  }

  const depart = Object.prototype.hasOwnProperty.call(body, 'departDate')
    ? cleanDate(body.departDate) : before.depart_date;
  const back = Object.prototype.hasOwnProperty.call(body, 'returnDate')
    ? cleanDate(body.returnDate) : before.return_date;
  if (depart && back && back < depart) {
    return badRequest('The return date cannot be before the departure date.');
  }

  await env.DB.prepare(
    `UPDATE bookings SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(...binds, Math.floor(Date.now() / 1000), id, user.id).run();

  return json({ ok: true, booking: await db.getBooking(env, id, user.id) });
}

export async function handleUpdateBooking(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parseBooking(await readJson(request));
  if (error) return badRequest(error);

  fields.clientId = await db.resolveClient(env, user.id, fields.clientName,
    { ghlContactId: fields.ghlContactId });
  fields.vendorId = await resolveVendor(env, user.id, fields.supplier);
  const booking = await db.updateBooking(env, id, user.id, fields);
  if (!booking) return notFound('Booking not found.');
  await db.logActivity(env, user.id, 'booking.update',
    `Updated booking for ${booking.client_name}`, { id });
  return json({ ok: true, booking });
}

/**
 * Records that somebody rang them after the trip.
 *
 * A date, not a tick, because "have they been rung" and "when" are different
 * questions and only the second one tells you whether it is worth ringing
 * again. Sent as false to undo, which is what happens when the wrong row was
 * clicked, and that is more common than a client un-travelling.
 */
export async function handleWelcomed(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, id, user.id);
  if (!booking) return notFound('Reservation not found.');

  const body = await readJson(request);
  // Seconds, like every other timestamp in this database. A Date.now() here
  // would read as fifty thousand years from now to anything that compared it,
  // and the page would say the client was rung some time in the year 57000.
  const done = body.welcomed === false ? null : now();

  await env.DB.prepare(
    'UPDATE bookings SET welcomed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(done, now(), id, user.id).run();

  await db.logActivity(env, user.id, 'booking.welcomed',
    done ? `Rang ${booking.client_name} after their trip`
         : `Cleared the welcome home note for ${booking.client_name}`,
    { bookingId: id });
  return json({ ok: true, welcomedAt: done });
}

export async function handleDeleteBooking(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Read before deleting: the payments go with the reservation, and with them
  // any record of which credits they spent.
  const spent = await env.DB.prepare(
    `SELECT DISTINCT credit_id FROM booking_payments
      WHERE booking_id = ? AND user_id = ? AND credit_id IS NOT NULL`
  ).bind(id, user.id).all().catch(() => ({ results: [] }));

  const removed = await db.deleteBooking(env, id, user.id);
  if (!removed) return notFound('Booking not found.');

  // A credit spent on a trip that no longer exists was spent on nothing, so it
  // goes back to the client. Released after the delete, so the check for
  // another payment still spending it sees only the payments that survived.
  for (const row of spent.results || []) {
    await releaseCredit(env, user.id, row.credit_id, null);
  }
  // And nothing keeps pointing at a reservation that has gone.
  await env.DB.prepare(
    'UPDATE client_credits SET booking_id = NULL, updated_at = ? WHERE booking_id = ? AND user_id = ?'
    // Seconds, like every other timestamp. This wrote milliseconds, which
    // sorts and compares as a date ~55,000 years from now.
  ).bind(now(), id, user.id).run();

  await db.logActivity(env, user.id, 'booking.delete', 'Deleted a booking', { id });
  return json({ ok: true });
}
