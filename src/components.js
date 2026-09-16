// One trip, several vendors.
//
// A cruise with air on it is two bookings with two vendors, two confirmation
// numbers and two commission cheques, and it is one holiday. The reservation
// held exactly one vendor, so air went in as a second reservation that
// duplicated the client and the dates, or it went in nowhere and the
// commission on it was never chased.
//
// A component carries no money. It is who you booked with and what they gave
// you: a vendor, a confirmation number, its own dates. What it costs lives
// where all the other money lives, as pricing lines tagged with the component
// they belong to. One money model, so the trip total, the commission, the
// invoice and every report keep working without knowing components exist.

import { json, badRequest, notFound, clean, cleanDate, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import { resolveVendor } from './vendors.js';
import * as db from './db.js';

// 'other' leads because oneOf falls back to the first entry, and filing an
// unlabelled component as travel insurance is worse than filing it as nothing.
export const COMPONENT_KINDS = ['other', 'air', 'insurance', 'lodging', 'excursion', 'transfer', 'car'];

const COLUMNS = `
  id, booking_id, user_id, kind, vendor_id, supplier, product_name,
  confirmation_number, start_date, end_date, notes, sort_order,
  created_at, updated_at
`;

export async function listComponents(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM components
      WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY sort_order ASC, created_at ASC`
  ).bind(bookingId, ...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

function parse(body) {
  const supplier = clean(body.supplier, 120);
  if (!supplier) return { error: 'Who is this booked with?' };

  const startDate = cleanDate(body.startDate);
  const endDate = cleanDate(body.endDate);
  if (startDate && endDate && endDate < startDate) {
    return { error: 'That ends before it starts.' };
  }

  return {
    fields: {
      kind: oneOf(body.kind, COMPONENT_KINDS),
      supplier,
      productName: clean(body.productName, 160),
      confirmationNumber: clean(body.confirmationNumber, 80),
      startDate,
      endDate,
      notes: clean(body.notes, 1000),
      sortOrder: Math.max(0, Math.min(Number(body.sortOrder) || 0, 999)),
    },
  };
}

export async function handleAddComponent(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');

  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  // Through the same vendor list as everything else, so air booked with a
  // consolidator lands under one spelling in the reports rather than three.
  const vendorId = await resolveVendor(env, owner.id, fields.supplier);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO components
       (id, booking_id, user_id, kind, vendor_id, supplier, product_name,
        confirmation_number, start_date, end_date, notes, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, owner.id, fields.kind, vendorId, fields.supplier,
         fields.productName, fields.confirmationNumber, fields.startDate,
         fields.endDate, fields.notes, fields.sortOrder, ts, ts).run();

  await db.logActivity(env, owner.id, 'component.add',
    db.byHand(
      `Added ${fields.kind} with ${fields.supplier} to ${booking.client_name}'s trip`,
      user, owner),
    { bookingId });
  return json({ ok: true, id }, 201);
}

export async function handleUpdateComponent(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'components', id);
  if (!owner) return notFound('Component not found.');

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const vendorId = await resolveVendor(env, owner.id, fields.supplier);
  const res = await env.DB.prepare(
    `UPDATE components SET kind = ?, vendor_id = ?, supplier = ?, product_name = ?,
            confirmation_number = ?, start_date = ?, end_date = ?, notes = ?,
            sort_order = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(fields.kind, vendorId, fields.supplier, fields.productName,
         fields.confirmationNumber, fields.startDate, fields.endDate, fields.notes,
         fields.sortOrder, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Component not found.');
  return json({ ok: true });
}

/**
 * Removes a component and detaches its charges rather than deleting them.
 *
 * The money was real. Somebody paid for that air whether or not the line
 * saying who booked it survives, and silently removing a thousand dollars from
 * a trip total because a vendor row was tidied up is the kind of thing nobody
 * notices until the commission does not arrive.
 */
export async function handleDeleteComponent(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'components', id);
  if (!owner) return notFound('Component not found.');

  const row = await env.DB.prepare(
    'SELECT id, booking_id FROM components WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!row) return notFound('Component not found.');

  await env.DB.prepare(
    'UPDATE booking_pricing SET component_id = NULL, updated_at = ? WHERE component_id = ? AND user_id = ?'
  ).bind(now(), id, owner.id).run();
  await env.DB.prepare('DELETE FROM components WHERE id = ? AND user_id = ?')
    .bind(id, owner.id).run();

  await db.logActivity(env, owner.id, 'component.delete',
    db.byHand('Removed a component, keeping what it cost',
      user, owner), { bookingId: row.booking_id });
  return json({ ok: true });
}
