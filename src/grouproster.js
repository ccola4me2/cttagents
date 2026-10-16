// Who is actually coming, and what is still missing from their record.
//
// The registration list answered "somebody put their name down". That was the
// right answer when a registration was a name and an email. Now it carries a
// cabin grade, a party, passports, allergies and an emergency contact, and the
// question an advisor has three weeks before a departure is a different one:
// who has not sent a passport, who has not been rung, and which grade is full.
//
// Passports are masked by default and nothing on the ordinary screen decrypts
// one. The full numbers come out once, deliberately, when a manifest is built
// for the supplier, and that is logged. See docs/encryption.md.
//
// Everything here is read and written at the advisor's own scope, the same as
// every other screen: the registration carries the group owner's user_id, so
// the fence is the ordinary one and nothing about the public page widens it.

import { json, badRequest, notFound, clean, cleanText, cleanDate, oneOf, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { seal, open, masked, piiReady } from './pii.js';
import { REGISTRATION_STATUSES } from './grouppage.js';
import { LISTS as GROUP_LISTS } from './groupmanifest.js';

/**
 * Everything on one group's roster.
 *
 * One query for the registrations and one for the travellers, joined in the
 * Worker rather than in SQL. A join would repeat the registration's columns
 * once per traveller and then need unpicking, and the shapes the page wants
 * are nested anyway.
 */
export async function handleRoster(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const gScoped = db.scopeWhere(scope, 'g.user_id');
  const group = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.passport_due, g.depart_date
       FROM travel_groups g WHERE g.id = ? AND ${gScoped.sql}`
  ).bind(groupId, ...gScoped.binds).first();
  if (!group) return notFound('Group not found.');

  const rScoped = db.scopeWhere(scope, 'r.user_id');
  const { results: regs } = await env.DB.prepare(
    `SELECT r.id, r.name, r.email, r.phone, r.party_size, r.notes, r.booking_id,
            r.rate_id, r.status, r.supplier_ref, r.terms_at, r.created_at,
            rt.room_type AS rate_name
       FROM group_registrations r
       LEFT JOIN group_rates rt ON rt.id = r.rate_id
      WHERE r.group_id = ? AND ${rScoped.sql}
      ORDER BY r.created_at DESC LIMIT 300`
  ).bind(groupId, ...rScoped.binds).all().catch(() => ({ results: [] }));

  const tScoped = db.scopeWhere(scope, 't.user_id');
  const { results: travellers } = await env.DB.prepare(
    `SELECT t.id, t.registration_id, t.name, t.email, t.passport_country,
            t.dietary, t.accessibility, t.emergency_name, t.emergency_phone,
            t.emergency_relation, t.is_lead,
            t.dob_enc, t.passport_number_enc, t.passport_expiry_enc
       FROM group_travellers t
      WHERE t.group_id = ? AND ${tScoped.sql}
      ORDER BY t.is_lead DESC, t.created_at ASC`
  ).bind(groupId, ...tScoped.binds).all().catch(() => ({ results: [] }));

  // The money, per party.
  //
  // Hard rows only, which is the rule everywhere in this portal: a soft row is
  // the advisor's own reminder to chase the same amount, not a second amount
  // owed. Counting both would double every balance.
  //
  // owed_to splits it in two because they are two different questions. What
  // the supplier is waiting for decides whether a cabin survives; what the
  // agency is waiting for is the agency's own invoice. A single "outstanding"
  // number answers neither.
  const pScoped = db.scopeWhere(scope, 'p.user_id');
  const { results: money } = await env.DB.prepare(
    `SELECT p.registration_id, COALESCE(p.owed_to, 'supplier') AS owed_to,
            SUM(p.amount_cents) AS due_cents,
            SUM(CASE WHEN p.paid_date IS NOT NULL THEN p.amount_cents ELSE 0 END) AS paid_cents,
            MIN(CASE WHEN p.paid_date IS NULL THEN p.due_date END) AS next_due
       FROM booking_payments p
      WHERE p.registration_id IS NOT NULL AND p.payment_class = 'hard' AND ${pScoped.sql}
      GROUP BY p.registration_id, COALESCE(p.owed_to, 'supplier')`
  ).bind(...pScoped.binds).all().catch(() => ({ results: [] }));

  const byMoney = new Map();
  for (const row of money || []) {
    if (!byMoney.has(row.registration_id)) {
      byMoney.set(row.registration_id, {
        supplier: { due: 0, paid: 0, nextDue: null },
        agency: { due: 0, paid: 0, nextDue: null },
      });
    }
    const side = row.owed_to === 'agency' ? 'agency' : 'supplier';
    const bucket = byMoney.get(row.registration_id)[side];
    bucket.due = Number(row.due_cents) || 0;
    bucket.paid = Number(row.paid_cents) || 0;
    bucket.nextDue = row.next_due || null;
  }

  const byReg = new Map();
  for (const t of travellers || []) {
    if (!byReg.has(t.registration_id)) byReg.set(t.registration_id, []);
    byReg.get(t.registration_id).push(await publicTraveller(env, t));
  }

  const rows = (regs || []).map((r) => {
    const party = byReg.get(r.id) || [];
    const owed = byMoney.get(r.id) || {
      supplier: { due: 0, paid: 0, nextDue: null },
      agency: { due: 0, paid: 0, nextDue: null },
    };
    return {
      ...r,
      travellers: party,
      money: {
        ...owed,
        supplierOutstanding: owed.supplier.due - owed.supplier.paid,
        agencyOutstanding: owed.agency.due - owed.agency.paid,
      },
      // What an advisor is chasing. Counted here rather than on the page so
      // the number and the list cannot disagree.
      missingPassport: party.filter((t) => !t.hasPassport).length,
      missingDob: party.filter((t) => !t.hasDob).length,
    };
  });

  return json({
    group,
    registrations: rows,
    statuses: REGISTRATION_STATUSES,
    // What the page offers to download, named here rather than in the markup
    // so a new list appears on the screen by being added to one array.
    lists: GROUP_LISTS,
    // Whether a passport can be recorded at all. The page hides the boxes when
    // it cannot, the same as the public form does, rather than offering
    // somewhere to type that quietly drops what is typed.
    canHoldPassports: piiReady(env),
    counts: {
      parties: rows.length,
      people: rows.reduce((n, r) => n + r.travellers.length, 0),
      missingPassport: rows.reduce((n, r) => n + r.missingPassport, 0),
      booked: rows.filter((r) => r.booking_id).length,
      // The block's money, which is the number an owner asks for. Only the
      // parties that have become reservations carry any, because a payment
      // cannot exist before a booking does.
      supplierDue: rows.reduce((n, r) => n + r.money.supplierOutstanding, 0),
      supplierPaid: rows.reduce((n, r) => n + r.money.supplier.paid, 0),
      agencyDue: rows.reduce((n, r) => n + r.money.agencyOutstanding, 0),
      agencyPaid: rows.reduce((n, r) => n + r.money.agency.paid, 0),
    },
  });
}

/**
 * One traveller, as a screen is allowed to see them.
 *
 * The passport number is masked rather than withheld, because an advisor
 * checking that the right one is on file needs to recognise it and does not
 * need to read it. The expiry is given in full: it is the half that has to be
 * checked against the six month rule, and a date is not an identity document.
 */
async function publicTraveller(env, row) {
  const passport = await open(env, row.passport_number_enc);
  const expiry = await open(env, row.passport_expiry_enc);
  const dob = await open(env, row.dob_enc);
  return {
    id: row.id,
    registration_id: row.registration_id,
    name: row.name,
    email: row.email,
    passport_country: row.passport_country,
    dietary: row.dietary,
    accessibility: row.accessibility,
    emergency_name: row.emergency_name,
    emergency_phone: row.emergency_phone,
    emergency_relation: row.emergency_relation,
    is_lead: row.is_lead,
    passportMasked: masked(passport),
    passportExpiry: expiry,
    dob,
    hasPassport: Boolean(passport),
    hasDob: Boolean(dob),
  };
}

/** Working a registration: where it has got to, and the supplier's reference. */
export async function handleUpdateRegistration(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'group_registrations', id);
  if (!owner) return notFound('Registration not found.');

  const body = await readJson(request);
  const status = oneOf(body.status, REGISTRATION_STATUSES) || 'new';

  const res = await env.DB.prepare(
    `UPDATE group_registrations
        SET status = ?, supplier_ref = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(status, clean(body.supplierRef, 60) || null,
         cleanText(body.notes, 1000) || null, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Registration not found.');

  return json({ ok: true });
}

/**
 * Filling in what somebody did not have to hand.
 *
 * Most parties register without a passport, because the passport is in a
 * drawer and the cabin is going. The advisor types it in later off an email,
 * and this is where that goes.
 *
 * A blank passport field means "no change", not "delete it". Clearing one is
 * not a thing anybody has asked for, and a save that wiped a passport because
 * a box rendered empty is the partial-save bug this portal has had before.
 */
export async function handleUpdateGroupTraveller(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'group_travellers', id);
  if (!owner) return notFound('Traveller not found.');

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('A traveller needs a name.');

  const wantsSealing = Boolean(clean(body.passportNumber, 40))
    || Boolean(cleanDate(body.passportExpiry)) || Boolean(cleanDate(body.dob));
  if (wantsSealing && !piiReady(env)) {
    return badRequest('Passport details and dates of birth cannot be stored yet. '
      + 'Whoever runs the portal needs to set the encryption key first.');
  }

  const current = await env.DB.prepare(
    `SELECT dob_enc, passport_number_enc, passport_expiry_enc, passport_country
       FROM group_travellers WHERE id = ? AND user_id = ?`
  ).bind(id, owner.id).first();

  // The passport is one thing, not three fields.
  //
  // The screen cannot prefill a passport number: what it holds is masked, and
  // putting the mask in the box would save the mask. So the box is always
  // empty when the dialog opens, and an empty box has to mean "I did not touch
  // this" rather than "delete it". The expiry and the country go with it,
  // because a save that kept the number and dropped its expiry would leave a
  // record that is worse than either answer.
  //
  // Type a number and all three are taken. Leave it blank and all three are
  // left exactly as they were. There is no path here that clears a passport,
  // which nobody has asked for and which a stray empty form would otherwise do
  // silently. That is the partial-save bug this portal has had before.
  const typedPassport = Boolean(clean(body.passportNumber, 40));
  const passportNumber = typedPassport
    ? await seal(env, clean(body.passportNumber, 40))
    : (current?.passport_number_enc || null);
  const passportExpiry = typedPassport
    ? await seal(env, cleanDate(body.passportExpiry))
    : (current?.passport_expiry_enc || null);
  const passportCountry = typedPassport
    ? (clean(body.passportCountry, 60) || null)
    : (current?.passport_country || null);

  // The date of birth is its own field, and the dialog does prefill it, so a
  // box somebody emptied really does mean "clear this". A caller that never
  // mentioned it at all is a different thing and leaves it alone: a save that
  // omits a field must not wipe it, which is the rule this portal learned the
  // expensive way on client profiles.
  const saidDob = Object.prototype.hasOwnProperty.call(body, 'dob');
  const dobText = cleanDate(body.dob);
  const dob = saidDob
    ? (dobText ? await seal(env, dobText) : null)
    : (current?.dob_enc || null);

  const res = await env.DB.prepare(
    `UPDATE group_travellers
        SET name = ?, email = ?, passport_country = ?, dietary = ?, accessibility = ?,
            emergency_name = ?, emergency_phone = ?, emergency_relation = ?,
            dob_enc = ?, passport_number_enc = ?, passport_expiry_enc = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(name, clean(body.email, 254) || null, passportCountry,
         cleanText(body.dietary, 300) || null, cleanText(body.accessibility, 300) || null,
         clean(body.emergencyName, 120) || null, clean(body.emergencyPhone, 40) || null,
         clean(body.emergencyRelation, 60) || null,
         dob, passportNumber, passportExpiry,
         now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Traveller not found.');

  await db.logActivity(env, owner.id, 'group.traveller.update',
    `Updated ${name} on a group registration`, { id });
  return json({ ok: true });
}

/**
 * Removing a registration, and the people on it.
 *
 * Named rather than cascaded, because D1 does not enforce foreign keys and a
 * registration deleted on its own would leave its travellers behind with their
 * sealed passports and nothing pointing at them.
 */
export async function handleDeleteRegistration(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'group_registrations', id);
  if (!owner) return notFound('Registration not found.');

  await env.DB.prepare(
    'DELETE FROM group_travellers WHERE registration_id = ? AND user_id = ?'
  ).bind(id, owner.id).run();
  const res = await env.DB.prepare(
    'DELETE FROM group_registrations WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Registration not found.');

  await db.logActivity(env, owner.id, 'group.registration.delete',
    'Removed a group registration and everybody on it', { id });
  return json({ ok: true });
}
