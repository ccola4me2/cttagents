// Group space: cabins a vendor holds before anybody has booked them.
//
// The number that matters is not how many cabins are in the block, it is how
// many are still unsold and how long is left before the vendor takes them
// back. That is the option date, and it behaves exactly like a final payment
// deadline: nothing happens when it passes except that your space quietly
// disappears.
//
// Cabins sold is counted from the reservations pointing at the group rather
// than stored on it. Two numbers that can disagree eventually will.

import { json, badRequest, notFound, clean, cleanText, cleanDate, oneOf, toCents, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { pdfRead } from './pdftext.js';
import { parseGroupQuote, FIELD_WORDS } from './groupquote.js';
// The schedule generator, shared with the reservation screen so a group
// booking and a typed one cannot produce different schedules. payments.js
// does not import this file, so there is no cycle.
import { buildSchedule } from './payments.js';
import { assignSlug, linkInfo, releaseAllFor, cleanSlug, slugProblem, slugState } from './groupslug.js';

const STATUSES = ['open', 'closed', 'cancelled'];

// A cruise group, a package and a block of rooms are held and sold
// differently, and a list that cannot tell them apart leaves the advisor
// remembering which is which.
export const GROUP_TYPES = ['cruise', 'package', 'lodging', 'tour', 'other'];

const COLUMNS = `
  g.id, g.user_id, g.name, g.vendor, g.product_name, g.destination, g.group_code,
  g.depart_date, g.return_date, g.option_date, g.cabins_held, g.status, g.notes,
  g.group_type, g.registration_open, g.registration_blurb,
  g.proposal_id, g.sailing_id, g.vendor_contact, g.departure_port,
  g.passengers, g.proposal_expires,
  g.deposit_due, g.final_payment_due, g.passport_due, g.group_number,
  g.deposit_per_guest_cents, g.reminded_on,
  g.faq_json, g.terms, g.agency_fee_cents, g.fee_terms, g.trip_terms,
  g.page_slug, g.headline, g.hero_image_url, g.perks_json, g.itinerary_json,
  g.created_at, g.updated_at
`;

const SOLD = `(SELECT COUNT(*) FROM bookings b
                WHERE b.group_id = g.id AND b.status IN ('quoted','booked','travelled')) AS cabins_sold`;

const ADVISOR = `COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                   AS advisor_name`;

function parse(body) {
  const name = clean(body.name, 160);
  if (!name) return { error: 'Give the group a name.' };

  const departDate = cleanDate(body.departDate);
  const returnDate = cleanDate(body.returnDate);
  if (departDate && returnDate && returnDate < departDate) {
    return { error: 'The return date cannot be before the departure date.' };
  }

  const optionDate = cleanDate(body.optionDate);
  if (optionDate && departDate && optionDate > departDate) {
    return { error: 'The option date falls after departure, which cannot be right.' };
  }

  const heroImageUrl = imageUrlOf(body.heroImageUrl);
  if (clean(body.heroImageUrl, 500) && !heroImageUrl) {
    return { error: 'The picture needs to be a link starting with https:// that goes straight to an image.' };
  }

  return {
    fields: {
      name,
      vendor: clean(body.vendor, 120),
      productName: clean(body.productName, 160),
      destination: clean(body.destination, 160),
      groupCode: clean(body.groupCode, 80),
      departDate,
      returnDate,
      optionDate,
      cabinsHeld: Math.max(0, Math.min(Number(body.cabinsHeld) || 0, 9999)),
      status: oneOf(body.status, STATUSES),
      groupType: oneOf(body.groupType, GROUP_TYPES),
      registrationOpen: body.registrationOpen ? 1 : 0,
      // Prose, and paragraphs are how somebody writes a page. clean() would
      // fold the whole thing onto one line.
      registrationBlurb: cleanText(body.registrationBlurb, 1500),
      notes: cleanText(body.notes, 4000),
      // What the vendor's proposal said. Text for the two references because
      // they are printed on paperwork rather than added up, so a vendor who
      // writes 04589 keeps the leading nought.
      proposalId: clean(body.proposalId, 40),
      sailingId: clean(body.sailingId, 40),
      vendorContact: clean(body.vendorContact, 120),
      departurePort: clean(body.departurePort, 120),
      passengers: Math.max(0, Math.min(Number(body.passengers) || 0, 99999)),
      proposalExpires: cleanDate(body.proposalExpires),
      // The supplier's dates for the block, which are not any one
      // reservation's. Deliberately not validated against each other beyond
      // the obvious: a supplier who wants the balance before the deposit date
      // has made a mistake, but it is their mistake and the advisor has to be
      // able to record what they were actually told.
      depositDue: cleanDate(body.depositDue),
      // Per guest, because that is how a group proposal is written. Without an
      // amount the schedule generator writes no deposit row at all and the
      // whole cost lands on the final date.
      depositPerGuestCents: Math.max(0, Math.min(toCents(body.depositPerGuest) || 0, 10000000)),
      finalPaymentDue: cleanDate(body.finalPaymentDue),
      passportDue: cleanDate(body.passportDue),
      groupNumber: clean(body.groupNumber, 60),
      faqJson: faqOf(body.faq),
      terms: cleanText(body.terms, 4000),
      // Per person, and the agency's own. Dollars on the wire and cents in the
      // record, the same as every other money field here: the page sends what
      // was typed and toCents is the one place that decides what "1,250" means.
      // Capped at a number that is clearly a typo rather than a fee.
      agencyFeeCents: Math.max(0, Math.min(toCents(body.agencyFee) || 0, 10000000)),
      feeTerms: cleanText(body.feeTerms, 1000),
      tripTerms: cleanText(body.tripTerms, 1000),
      // What the shared page adds to the record. Each is only written when the caller sent it,
      // see pageFields below.
      headline: clean(body.headline, 140),
      heroImageUrl,
      perksJson: perksOf(body.perks),
      itineraryJson: itineraryOf(body.itinerary),
    },
  };
}

/** A link to a picture, or nothing. https only, and nothing that could close a CSS url(). */
function imageUrlOf(value) {
  const text = clean(value, 500);
  return /^https:\/\/[^\s'"()<>\\]+$/i.test(text) ? text : null;
}

/** What the group gets, as short lines. Blank ones are dropped rather than shown empty. */
function perksOf(value) {
  if (!Array.isArray(value)) return null;
  const lines = value.slice(0, 12).map((v) => clean(v, 120)).filter(Boolean);
  return lines.length ? JSON.stringify(lines) : null;
}

/** Day by day. A row with neither a port nor a note says nothing and is dropped. */
function itineraryOf(value) {
  if (!Array.isArray(value)) return null;
  const rows = [];
  for (const item of value.slice(0, 30)) {
    const row = {
      day: clean(item && item.day, 20),
      port: clean(item && item.port, 80),
      note: clean(item && item.note, 200),
    };
    if (row.port || row.note) rows.push(row);
  }
  return rows.length ? JSON.stringify(rows) : null;
}

/**
 * The page fields a save actually mentioned, as SET clauses.
 *
 * A save that does not carry them leaves them alone: the group page on the portal sends the
 * whole group, but anything older that saves a group without them must not wipe a headline,
 * a picture or an itinerary that somebody wrote.
 */
function pageFields(raw, fields) {
  const sets = [];
  const binds = [];
  const pairs = [
    ['headline', 'headline', fields.headline],
    ['heroImageUrl', 'hero_image_url', fields.heroImageUrl],
    ['perks', 'perks_json', fields.perksJson],
    ['itinerary', 'itinerary_json', fields.itineraryJson],
  ];
  for (const [key, column, value] of pairs) {
    if (raw[key] === undefined) continue;
    sets.push(`${column} = ?`);
    binds.push(value || null);
  }
  return { sets, binds };
}

/**
 * The FAQ, as a page would write it.
 *
 * Stored as JSON on the group rather than as rows, because it is written and
 * reordered as a whole and nothing ever asks a question of it. Empty pairs are
 * dropped rather than saved blank: a form with three empty slots in it is how
 * an FAQ ends up with three empty questions on the public page.
 */
function faqOf(value) {
  if (!Array.isArray(value)) return null;
  const pairs = [];
  for (const item of value.slice(0, 30)) {
    const q = clean(item && item.q, 200);
    const a = cleanText(item && item.a, 2000);
    if (q && a) pairs.push({ q, a });
  }
  return pairs.length ? JSON.stringify(pairs) : null;
}


/**
 * The rate grid, replaced wholesale.
 *
 * Rows rather than a merge, because a proposal is reissued as a whole and a
 * grade that has gone from the new one has gone. Merging would leave last
 * month's suite on the group with nothing saying it is stale.
 *
 * Every statement names user_id as well as group_id. The group id already
 * implies the owner; saying so again is what makes the fence readable from the
 * statement, which is what scripts/check-scope.mjs asks for.
 */
async function saveRates(env, groupId, userId, rates) {
  if (!Array.isArray(rates)) return;
  await env.DB.prepare('DELETE FROM group_rates WHERE group_id = ? AND user_id = ?')
    .bind(groupId, userId).run();
  const ts = now();
  let i = 0;
  for (const r of rates.slice(0, 40)) {
    const roomType = clean(r.roomType, 160);
    if (!roomType) continue;
    await env.DB.prepare(
      `INSERT INTO group_rates (id, group_id, user_id, room_type, occupancy, cabins, guests,
         per_guest_cents, extra_adult_cents, extra_child_cents, taxes_cents, total_cents,
         sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uid(), groupId, userId, roomType, clean(r.occupancy, 40),
           Math.max(0, Number(r.cabins) || 0), Math.max(0, Number(r.guests) || 0),
           Math.max(0, Number(r.perGuestCents) || 0),
           Math.max(0, Number(r.extraAdultCents) || 0), Math.max(0, Number(r.extraChildCents) || 0),
           Math.max(0, Number(r.taxesCents) || 0),
           Math.max(0, Number(r.totalCents) || 0), i, ts, ts).run();
    i += 1;
  }
}

/** The grid as the page draws it, in the order the proposal listed it. */
async function ratesFor(env, groupId, userId) {
  const { results } = await env.DB.prepare(
    `SELECT id, room_type, occupancy, cabins, guests, per_guest_cents, extra_adult_cents,
            extra_child_cents, taxes_cents, total_cents, sort_order
       FROM group_rates WHERE group_id = ? AND user_id = ? ORDER BY sort_order ASC`
  ).bind(groupId, userId).all().catch(() => ({ results: [] }));
  return results || [];
}

export async function listGroups(env, scope, { status, limit = 200 } = {}) {
  const scoped = db.scopeWhere(scope, 'g.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (status) { where.push('g.status = ?'); binds.push(status); }

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS}, ${SOLD}, ${ADVISOR}
       FROM travel_groups g LEFT JOIN users u ON u.id = g.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(g.depart_date, '9999-12-31') ASC LIMIT ?`
  ).bind(...binds, Math.min(Number(limit) || 200, 500)).all();
  return results || [];
}

export async function handleListGroups(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const scope = db.scopeFor(env, user, request);
  const groups = await listGroups(env, scope, {
    status: STATUSES.includes(statusParam) ? statusParam : undefined,
  });

  const today = new Date().toISOString().slice(0, 10);
  const open = groups.filter((g) => g.status === 'open');
  return json({
    groups,
    clashingCodes: await clashingCodes(env, groups),
    today,
    stats: {
      open: open.length,
      held: open.reduce((n, g) => n + (g.cabins_held || 0), 0),
      sold: open.reduce((n, g) => n + (g.cabins_sold || 0), 0),
      // Space about to go back to the vendor is the whole reason this screen
      // exists, so it is a headline figure rather than something to notice.
      releasing: open.filter((g) => g.option_date && g.option_date >= today
        && g.option_date <= isoAhead(30))
        .reduce((n, g) => n + Math.max(0, (g.cabins_held || 0) - (g.cabins_sold || 0)), 0),
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * Which of these codes another group also answers to.
 *
 * The code is a public address now, so two groups holding the same one means
 * one of the two pages is unreachable. Uniqueness is enforced from here on,
 * but codes handed out before that are still sitting in the table, and the
 * advisor cannot see the clash because the other group may be somebody
 * else's. Only the codes they already hold are checked, so this says "yours
 * is not the only group on this code" and nothing about whose the other is.
 */
async function clashingCodes(env, groups) {
  const codes = [...new Set(groups.map((g) => g.group_code).filter(Boolean))];
  if (!codes.length) return [];
  const marks = codes.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT group_code FROM travel_groups WHERE group_code IN (${marks})
      GROUP BY group_code HAVING COUNT(*) > 1`
  ).bind(...codes).all();
  return (results || []).map((r) => r.group_code);
}

function isoAhead(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function getGroup(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${COLUMNS}, ${SOLD} FROM travel_groups g WHERE g.id = ? AND g.user_id = ?`
  ).bind(id, userId).first();
}

export async function handleGetGroup(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'g.user_id');
  const group = await env.DB.prepare(
    `SELECT ${COLUMNS}, ${SOLD}, ${ADVISOR}
       FROM travel_groups g LEFT JOIN users u ON u.id = g.user_id
      WHERE g.id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).first();
  if (!group) return notFound('Group not found.');

  // The reservations in the block, read at the same scope as the group.
  const bScoped = db.scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.confirmation_number, b.travellers, b.status,
            b.gross_cents, b.commission_cents, b.depart_date
       FROM bookings b WHERE b.group_id = ? AND ${bScoped.sql}
      ORDER BY b.created_at ASC`
  ).bind(id, ...bScoped.binds).all();

  // Who has put their name down and not yet been turned into a reservation.
  // The whole point of a public page is that this list exists somewhere other
  // than the advisor's inbox.
  const rScoped = db.scopeWhere(scope, 'r.user_id');
  const { results: registrations } = await env.DB.prepare(
    `SELECT r.id, r.name, r.email, r.phone, r.party_size, r.notes, r.booking_id, r.created_at
       FROM group_registrations r WHERE r.group_id = ? AND ${rScoped.sql}
      ORDER BY r.created_at DESC LIMIT 300`
  ).bind(id, ...rScoped.binds).all();

  return json({
    group,
    bookings: results || [],
    registrations: registrations || [],
    groupTypes: GROUP_TYPES,
    // Whether the link is safe to hand out, which is only true if this group
    // is the only one on the code.
    codeShared: (await clashingCodes(env, [group])).length > 0,
    // The short name the page is shared under, and the ones it used to have.
    link: await linkInfo(env, group),
    rates: await ratesFor(env, id, group.user_id) });
}

/**
 * Turn somebody who put their name down into a reservation.
 *
 * The same step the lead report does, and for the same reason: the details are
 * already here, and retyping them is how a name sits on a list for a fortnight.
 * Quoted, because putting your name down is not agreeing to anything.
 */
export async function handleBookRegistration(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'group_registrations', id);
  if (!owner) return notFound('No such registration.');

  const reg = await env.DB.prepare(
    `SELECT r.*, g.name AS group_name, g.vendor, g.product_name, g.destination,
            g.depart_date, g.return_date, g.group_type,
            g.deposit_due, g.final_payment_due, g.deposit_per_guest_cents,
            g.agency_fee_cents, g.fee_terms,
            rt.room_type, rt.guests AS rate_guests, rt.per_guest_cents, rt.taxes_cents
       FROM group_registrations r
       JOIN travel_groups g ON g.id = r.group_id
       LEFT JOIN group_rates rt ON rt.id = r.rate_id
      WHERE r.id = ? AND r.user_id = ?`
  ).bind(id, owner.id).first();
  if (!reg) return notFound('No such registration.');
  if (reg.booking_id) return badRequest('That one is already on a reservation.');

  const clientId = await db.resolveClient(env, owner.id, reg.name, {});
  if (clientId && (reg.email || reg.phone)) {
    await env.DB.prepare(
      `UPDATE clients SET email = COALESCE(NULLIF(email, ''), ?),
         phone = COALESCE(NULLIF(phone, ''), ?), updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(reg.email || null, reg.phone || null, now(), clientId, owner.id).run();
  }

  // How many people the money is for. The travellers they named, falling back
  // to what they typed in the short enquiry form, falling back to one: a party
  // of nobody is not a thing, and a cabin priced for nought guests is worse
  // than one priced for the person who filled the form in.
  const named = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM group_travellers WHERE registration_id = ? AND user_id = ?'
  ).bind(id, owner.id).first().catch(() => null);
  const heads = Math.max(1, Math.min(
    Number(named?.n) || Number(reg.party_size) || 1, 99));

  // What the cabin costs, from the band they picked.
  //
  // Per guest times heads rather than the band's total_cents, because the
  // total on a rate band is for its own stated occupancy and the party may not
  // match it: two people in a cabin quoted for four pay two fares, not the
  // quoted total. A registration with no band chosen comes through at nought,
  // which is the honest answer and leaves the advisor to price it.
  const fareCents = (Number(reg.per_guest_cents) || 0) * heads;
  const taxCents = (Number(reg.taxes_cents) || 0) * heads;
  const depositCents = (Number(reg.deposit_per_guest_cents) || 0) * heads;
  const feeCents = (Number(reg.agency_fee_cents) || 0) * heads;

  const booking = await db.createBooking(env, owner.id, {
    clientName: reg.name,
    clientId: clientId || null,
    supplier: reg.vendor || null,
    productType: ['cruise', 'package', 'lodging', 'tour'].includes(reg.group_type)
      ? (reg.group_type === 'lodging' ? 'hotel' : reg.group_type) : 'cruise',
    productName: reg.product_name || null,
    destination: reg.destination || null,
    departDate: reg.depart_date || null,
    returnDate: reg.return_date || null,
    // The group's dates, not nothing. These are the supplier's deadlines for
    // the block and they are the only dates anybody has at this point.
    depositDue: reg.deposit_due || null,
    finalPaymentDue: reg.final_payment_due || null,
    depositCents,
    cabin: reg.room_type || null,
    cabinCategory: reg.room_type || null,
    travellers: heads,
    grossCents: fareCents + taxCents,
    commissionCents: 0,
    commissionStatus: 'pending',
    status: 'quoted',
    groupId: reg.group_id,
    notes: [`From the ${reg.group_name} sign-up page.`,
            reg.room_type ? `They asked for ${reg.room_type}.` : '',
            reg.notes ? `They said: ${reg.notes}` : ''].filter(Boolean).join('\n'),
    insuranceStatus: 'unknown',
  });

  await env.DB.prepare(
    'UPDATE group_registrations SET booking_id = ? WHERE id = ? AND user_id = ?'
  ).bind(booking.id, id, owner.id).run();

  // The people, carried across by name only.
  //
  // Their passports and dates of birth stay sealed on the group registration
  // and are deliberately not copied here, because `travellers` is not an
  // encrypted table: copying them in would quietly undo the encryption for
  // every one of them. The manifest is taken from the group, which is where
  // that data belongs and where it stays. See docs/encryption.md.
  const party = await env.DB.prepare(
    `SELECT name, email, is_lead FROM group_travellers
      WHERE registration_id = ? AND user_id = ? ORDER BY is_lead DESC, created_at ASC`
  ).bind(id, owner.id).all().catch(() => ({ results: [] }));

  const people = (party.results || []).length
    ? party.results
    : [{ name: reg.name, email: reg.email, is_lead: 1 }];

  for (const person of people) {
    await env.DB.prepare(
      `INSERT INTO travellers (id, booking_id, user_id, name, email, phone, is_lead,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uid(), booking.id, owner.id, person.name,
           person.email || (person.is_lead ? reg.email : null) || null,
           person.is_lead ? (reg.phone || null) : null,
           person.is_lead ? 1 : 0, now(), now()).run();
  }

  // What the price is made of, so the commission comes out right without
  // anybody typing it again. The fare earns and the taxes do not, which is the
  // one idea the whole pricing model turns on.
  const ts = now();
  if (fareCents > 0) {
    await env.DB.prepare(
      `INSERT INTO booking_pricing (id, booking_id, user_id, kind, label, amount_cents,
         commissionable, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 'fare', ?, ?, 1, 0, ?, ?)`
    ).bind(uid(), booking.id, owner.id,
           reg.room_type ? `${reg.room_type} fare` : 'Fare', fareCents, ts, ts).run();
  }
  if (taxCents > 0) {
    await env.DB.prepare(
      `INSERT INTO booking_pricing (id, booking_id, user_id, kind, label, amount_cents,
         commissionable, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 'taxes', 'Taxes and port fees', ?, 0, 1, ?, ?)`
    ).bind(uid(), booking.id, owner.id, taxCents, ts, ts).run();
  }

  // The supplier's schedule, from the generator the reservation screen uses.
  // It writes the deposit on the group's date, the balance on the group's
  // final date, and a reminder ten days in front of that one.
  const made = await db.getBooking(env, booking.id, owner.id);
  const schedule = made ? await buildSchedule(env, owner, made) : { created: [] };
  if (schedule.created.length) {
    await env.DB.prepare(
      `UPDATE booking_payments SET registration_id = ?, owed_to = 'supplier'
        WHERE booking_id = ? AND user_id = ?`
    ).bind(id, booking.id, owner.id).run();
  }

  // And the agency's own fee, which is not the supplier's money and never was.
  // Its own line with owed_to set, so a total of what the supplier is waiting
  // for and a total of what the agency is waiting for are different questions
  // with different answers.
  if (feeCents > 0) {
    await db.createPayment(env, owner.id, {
      bookingId: booking.id, kind: 'installment', paymentClass: 'hard',
      amountCents: feeCents, dueDate: reg.deposit_due || null, paidDate: null,
      registrationId: id, owedTo: 'agency',
      notes: [`Our fee, ${heads} at ${(Number(reg.agency_fee_cents) || 0) / 100}`,
              reg.fee_terms || ''].filter(Boolean).join('. '),
    });
  }

  await db.logActivity(env, owner.id, 'group.book',
    db.byHand(`Booked ${reg.name} onto ${reg.group_name}`,
      user, owner), { groupId: reg.group_id, bookingId: booking.id });

  return json({ ok: true, bookingId: booking.id });
}

/**
 * Is this code already somebody's public address?
 *
 * The group code became a URL the moment a group could take names at
 * /g/<code>, and a URL that resolves to two groups resolves to whichever the
 * database returns first. Checked across every advisor, not just this one:
 * the address is global even though the group is not.
 */
async function codeTaken(env, code, exceptId = null) {
  if (!code) return false;
  const row = await env.DB.prepare(
    'SELECT id FROM travel_groups WHERE group_code = ? AND id != ?'
  ).bind(code, exceptId || '').first();
  return Boolean(row);
}

export async function handleCreateGroup(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const raw = await readJson(request);
  const { fields, error } = parse(raw);
  if (error) return badRequest(error);
  if (await codeTaken(env, fields.groupCode)) {
    return badRequest(`The code ${fields.groupCode} is already in use. Pick another.`);
  }
  // A short name asked for has to be usable. One not asked for is chosen after the group exists.
  const askedSlug = cleanSlug(raw.pageSlug);
  if (askedSlug) {
    const problem = slugProblem(askedSlug);
    if (problem) return badRequest(problem);
    if ((await slugState(env, askedSlug, user.id, null)).state !== 'free') {
      return badRequest('That name is taken. Try another.');
    }
  }

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO travel_groups (id, user_id, name, vendor, product_name, destination,
       group_code, depart_date, return_date, option_date, cabins_held, status, notes,
       group_type, registration_open, registration_blurb,
       proposal_id, sailing_id, vendor_contact, departure_port, passengers, proposal_expires,
       deposit_due, final_payment_due, passport_due, group_number,
       faq_json, terms, agency_fee_cents, fee_terms, trip_terms,
       deposit_per_guest_cents, headline, hero_image_url, perks_json, itinerary_json,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.name, fields.vendor, fields.productName, fields.destination,
         fields.groupCode, fields.departDate, fields.returnDate, fields.optionDate,
         fields.cabinsHeld, fields.status, fields.notes,
         fields.groupType, fields.registrationOpen, fields.registrationBlurb,
         fields.proposalId, fields.sailingId, fields.vendorContact, fields.departurePort,
         fields.passengers, fields.proposalExpires,
         fields.depositDue, fields.finalPaymentDue, fields.passportDue, fields.groupNumber,
         fields.faqJson, fields.terms, fields.agencyFeeCents, fields.feeTerms, fields.tripTerms,
         fields.depositPerGuestCents, fields.headline || null, fields.heroImageUrl,
         fields.perksJson, fields.itineraryJson, ts, ts).run();
  await saveRates(env, id, user.id, raw.rates);
  // Best effort: a group that cannot be given a name yet is still a group, and the share box
  // on its page offers one.
  try {
    await assignSlug(env, {
      userId: user.id, groupId: id, name: fields.name, departDate: fields.departDate,
      preferred: askedSlug,
    });
  } catch (e) {
    console.error('group slug', e);
  }

  await db.logActivity(env, user.id, 'group.create', `Opened group ${fields.name}`, { id });
  return json({ ok: true, group: await getGroup(env, id, user.id) }, 201);
}

export async function handleUpdateGroup(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', id);
  if (!owner) return notFound('Group not found.');

  const raw = await readJson(request);
  const { fields, error } = parse(raw);
  if (error) return badRequest(error);
  if (await codeTaken(env, fields.groupCode, id)) {
    return badRequest(`The code ${fields.groupCode} is already in use. Pick another.`);
  }

  const res = await env.DB.prepare(
    `UPDATE travel_groups SET name = ?, vendor = ?, product_name = ?, destination = ?,
       group_code = ?, depart_date = ?, return_date = ?, option_date = ?,
       cabins_held = ?, status = ?, notes = ?, group_type = ?, registration_open = ?,
       registration_blurb = ?, proposal_id = ?, sailing_id = ?, vendor_contact = ?,
       departure_port = ?, passengers = ?, proposal_expires = ?,
       deposit_due = ?, final_payment_due = ?, passport_due = ?, group_number = ?,
       faq_json = ?, terms = ?, agency_fee_cents = ?, fee_terms = ?, trip_terms = ?,
       deposit_per_guest_cents = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.name, fields.vendor, fields.productName, fields.destination, fields.groupCode,
         fields.departDate, fields.returnDate, fields.optionDate, fields.cabinsHeld,
         fields.status, fields.notes, fields.groupType, fields.registrationOpen,
         fields.registrationBlurb, fields.proposalId, fields.sailingId, fields.vendorContact,
         fields.departurePort, fields.passengers, fields.proposalExpires,
         fields.depositDue, fields.finalPaymentDue, fields.passportDue, fields.groupNumber,
         fields.faqJson, fields.terms, fields.agencyFeeCents, fields.feeTerms, fields.tripTerms,
         fields.depositPerGuestCents, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Group not found.');
  const page = pageFields(raw, fields);
  if (page.sets.length) {
    await env.DB.prepare(`UPDATE travel_groups SET ${page.sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...page.binds, id, owner.id).run();
  }
  // Only when the caller mentioned them. A save from the details form does not
  // carry rates, and treating that silence as "no grades" would wipe the grid
  // every time somebody corrected a date.
  if (Array.isArray(raw.rates)) await saveRates(env, id, owner.id, raw.rates);

  return json({ ok: true, group: await getGroup(env, id, owner.id),
    rates: await ratesFor(env, id, owner.id) });
}

export async function handleDeleteGroup(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', id);
  if (!owner) return notFound('Group not found.');

  // Reservations survive their group. Deleting a block should not delete the
  // bookings made out of it, which are real trips people have paid for.
  await env.DB.prepare('UPDATE bookings SET group_id = NULL WHERE group_id = ? AND user_id = ?')
    .bind(id, owner.id).run();
  // Its short names stop meaning anything with it.
  await releaseAllFor(env, id, owner.id);
  const res = await env.DB.prepare('DELETE FROM travel_groups WHERE id = ? AND user_id = ?')
    .bind(id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Group not found.');
  return json({ ok: true });
}

/**
 * POST /api/groups/quote
 *
 * A vendor's proposal in, the fields of a group out. Reads nothing into the
 * database and creates nothing: the answer fills a form the advisor checks,
 * because a date that decides when cabins stop being held should be read by a
 * person once before it is saved.
 *
 * A file it cannot read is not an error. `read: false` with empty fields means
 * the advisor fills the form in the way they always have, which is the same
 * work as today rather than a new way to fail.
 */
export async function handleParseQuote(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!user) return badRequest('Sign in first.');

  const buf = await request.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength) return badRequest('No file arrived.');
  // A group proposal is a few hundred kilobytes. Anything past this is not one,
  // and a Worker that inflates it finds out the expensive way.
  if (buf.byteLength > 8 * 1024 * 1024) {
    return badRequest('That file is larger than 8MB, which is bigger than any proposal.');
  }

  const file = await pdfRead(buf);
  const out = parseGroupQuote(file.text);

  // Why it could not be read, in terms the screen can act on. An empty result
  // has three different causes and they want three different sentences: a file
  // that is only pictures (a scan, or a brochure exported from a design tool),
  // a file whose letters may be wrong, and a file with words in it that are not
  // a group proposal. Saying "this does not look like a proposal" to somebody
  // holding a scan of one is unkind and unhelpful.
  const locked = file.encryption === 'password' || file.encryption === 'unsupported';
  const why = out.read ? null
    : locked ? (file.encryption === 'password' ? 'password' : 'protected')
      : file.text.trim().length < 40 ? (file.images > 0 ? 'picture' : 'empty')
        : 'unrecognised';

  return json({
    read: out.read,
    why,
    // What the file held, so a file that does not read can be diagnosed from the
    // answer rather than from another deploy.
    chars: file.text.length,
    images: file.images,
    // Non-zero means two fonts disagree about a character, so a letter or a
    // digit may be wrong. Reported, because a date with one wrong digit looks
    // exactly like a right one.
    conflicts: file.conflicts,
    // Whether the file was locked: none, rc4 (it was, and has been opened),
    // password (needs one), or unsupported (locked in a way this cannot open).
    encryption: file.encryption,
    format: out.format,
    fields: out.fields,
    // The grid, which the page draws and then sends back with the group.
    rates: out.rates || [],
    notes: out.notes,
    found: out.found,
    // What this layout did not say, so the screen can list it rather than leave
    // the advisor to notice which boxes are empty.
    missing: (out.missing || []).map((k) => FIELD_WORDS[k] || k),
    // Things worth a second look that are not missing fields.
    warnings: out.warnings || [],
    // Some layouts never carry a group number; the screen explains that one.
    noGroupNumber: Boolean(out.noGroupNumber),
  });
}
