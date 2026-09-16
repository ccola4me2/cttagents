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

import { json, badRequest, notFound, clean, cleanText, cleanDate, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const STATUSES = ['open', 'closed', 'cancelled'];

// A cruise group, a package and a block of rooms are held and sold
// differently, and a list that cannot tell them apart leaves the advisor
// remembering which is which.
export const GROUP_TYPES = ['cruise', 'package', 'lodging', 'tour', 'other'];

const COLUMNS = `
  g.id, g.user_id, g.name, g.vendor, g.product_name, g.destination, g.group_code,
  g.depart_date, g.return_date, g.option_date, g.cabins_held, g.status, g.notes,
  g.group_type, g.registration_open, g.registration_blurb,
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
    },
  };
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
  });
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
            g.depart_date, g.return_date, g.group_type
       FROM group_registrations r JOIN travel_groups g ON g.id = r.group_id
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
    depositDue: null,
    finalPaymentDue: null,
    travellers: Math.max(1, Math.min(Number(reg.party_size) || 1, 99)),
    grossCents: 0,
    commissionCents: 0,
    commissionStatus: 'pending',
    status: 'quoted',
    groupId: reg.group_id,
    notes: [`From the ${reg.group_name} sign-up page.`,
            reg.notes ? `They said: ${reg.notes}` : ''].filter(Boolean).join('\n'),
    insuranceStatus: 'unknown',
  });

  await env.DB.prepare(
    'UPDATE group_registrations SET booking_id = ? WHERE id = ? AND user_id = ?'
  ).bind(booking.id, id, owner.id).run();

  await env.DB.prepare(
    `INSERT INTO travellers (id, booking_id, user_id, name, email, phone, is_lead,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(uid(), booking.id, owner.id, reg.name, reg.email || null, reg.phone || null,
         now(), now()).run();

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

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);
  if (await codeTaken(env, fields.groupCode)) {
    return badRequest(`The code ${fields.groupCode} is already in use. Pick another.`);
  }

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO travel_groups (id, user_id, name, vendor, product_name, destination,
       group_code, depart_date, return_date, option_date, cabins_held, status, notes,
       group_type, registration_open, registration_blurb, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.name, fields.vendor, fields.productName, fields.destination,
         fields.groupCode, fields.departDate, fields.returnDate, fields.optionDate,
         fields.cabinsHeld, fields.status, fields.notes,
         fields.groupType, fields.registrationOpen, fields.registrationBlurb, ts, ts).run();

  await db.logActivity(env, user.id, 'group.create', `Opened group ${fields.name}`, { id });
  return json({ ok: true, group: await getGroup(env, id, user.id) }, 201);
}

export async function handleUpdateGroup(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', id);
  if (!owner) return notFound('Group not found.');

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);
  if (await codeTaken(env, fields.groupCode, id)) {
    return badRequest(`The code ${fields.groupCode} is already in use. Pick another.`);
  }

  const res = await env.DB.prepare(
    `UPDATE travel_groups SET name = ?, vendor = ?, product_name = ?, destination = ?,
       group_code = ?, depart_date = ?, return_date = ?, option_date = ?,
       cabins_held = ?, status = ?, notes = ?, group_type = ?, registration_open = ?,
       registration_blurb = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.name, fields.vendor, fields.productName, fields.destination, fields.groupCode,
         fields.departDate, fields.returnDate, fields.optionDate, fields.cabinsHeld,
         fields.status, fields.notes, fields.groupType, fields.registrationOpen,
         fields.registrationBlurb, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Group not found.');

  return json({ ok: true, group: await getGroup(env, id, owner.id) });
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
  const res = await env.DB.prepare('DELETE FROM travel_groups WHERE id = ? AND user_id = ?')
    .bind(id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Group not found.');
  return json({ ok: true });
}
