// Other vendors on one trip, which is no longer how a trip with two vendors
// is filed.
//
// A cruise with air on it used to go in as one reservation with a component
// hanging off it for the air: its own vendor, its own confirmation number,
// its own dates, and its charges tagged onto the same pricing grid. It worked
// and it cost more than it saved. The grid had to be switched from one vendor
// to another, an option had to say which part of the trip it belonged to, and
// the commission on the air was chased on the cruise's row. Two vendors is
// two reservations, which is how most of them were going in anyway.
//
// What is left here reads and removes. Nothing writes a new one, and nothing
// deletes what exists: a reservation still carrying components shows them
// read only until somebody clears them, because a confirmation number on
// somebody's air is worth more than a tidy screen.

import { json, notFound, now } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

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
