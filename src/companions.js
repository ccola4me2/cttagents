// People a client travels with who do not live with them.
//
// A household is the people at one address and a companion is everybody else
// who turns up as the second name on a booking: the sister two states away,
// the friend they cruise with every year. Linking them lets a new reservation
// offer them as travellers, with the passport already on file, which is the
// same thing a household already does for the people in the house.
//
// A link is stored once each way, so asking who a client travels with is one
// lookup. Both people belong to the one advisor, and nothing here reaches from
// one advisor's book into another's.

import { json, badRequest, notFound, clean, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

export const RELATIONS = ['companion', 'friend', 'family', 'colleague', 'other'];

/** Who this client travels with, as the page and the reservation form want them. */
export async function companionsOf(env, clientId, scope) {
  if (!clientId) return [];
  const scoped = db.scopeWhere(scope, 'k.user_id');
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.phone, c.birthday, c.household_id,
            c.legal_first, c.legal_middle, c.legal_last, c.gender, c.citizenship,
            c.passport_number, c.passport_country, c.passport_expiry,
            k.relation AS relation,
            (SELECT COUNT(*) FROM bookings b WHERE b.client_id = c.id
              AND b.status IN ('booked','travelled')) AS trips
       FROM client_companions k
       JOIN clients c ON c.id = k.companion_id AND c.user_id = k.user_id
      WHERE k.client_id = ? AND ${scoped.sql}
      ORDER BY c.name ASC LIMIT 40`
  ).bind(clientId, ...scoped.binds).all();
  return results || [];
}

/**
 * Link two clients, both ways round.
 *
 * INSERT OR IGNORE so linking the same pair twice is a no-op and not an error,
 * and the unique index is what makes that safe. The relation of an existing
 * link is updated instead, so choosing "Friend" for somebody already linked as
 * a companion changes the label and leaves one link.
 */
async function link(env, ownerId, a, b, relation) {
  const ts = now();
  for (const [x, y] of [[a, b], [b, a]]) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO client_companions
         (id, user_id, client_id, companion_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(uid(), ownerId, x, y, relation, ts).run();
    await env.DB.prepare(
      'UPDATE client_companions SET relation = ? WHERE client_id = ? AND companion_id = ? AND user_id = ?'
    ).bind(relation, x, y, ownerId).run();
  }
}

/** Link this client to another one of the same advisor's clients. */
export async function handleAddCompanion(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('Client not found.');

  const body = await readJson(request);
  const otherId = clean(body.companionId, 64);
  if (!otherId) return badRequest('Choose who they travel with.');
  if (otherId === id) return badRequest('Somebody cannot be their own travelling companion.');

  const both = await env.DB.prepare(
    'SELECT id FROM clients WHERE user_id = ? AND id IN (?, ?)'
  ).bind(owner.id, id, otherId).all();
  if ((both.results || []).length < 2) return notFound('Client not found.');

  const relation = oneOf(body.relation, RELATIONS);
  await link(env, owner.id, id, otherId, relation);
  return json({ ok: true });
}

/** Take the link away, both ways round. The people and their trips are untouched. */
export async function handleRemoveCompanion(request, env, id, otherId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('Client not found.');

  const res = await env.DB.prepare(
    'DELETE FROM client_companions WHERE client_id = ? AND companion_id = ? AND user_id = ?'
  ).bind(id, otherId, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('They are not linked.');
  await env.DB.prepare(
    'DELETE FROM client_companions WHERE client_id = ? AND companion_id = ? AND user_id = ?'
  ).bind(otherId, id, owner.id).run();
  return json({ ok: true });
}

/**
 * Move one client's links onto another when the two records are merged.
 *
 * The record being dropped is going to be deleted, and its links with it. Each
 * is handed to the keeper first unless it would link the keeper to themselves
 * or repeat a link the keeper already has.
 */
export async function moveCompanions(env, ownerId, keepId, dropId) {
  const ts = now();
  const { results } = await env.DB.prepare(
    `SELECT companion_id, relation FROM client_companions
      WHERE client_id = ? AND user_id = ?`
  ).bind(dropId, ownerId).all();
  for (const row of results || []) {
    if (row.companion_id === keepId) continue;
    for (const [x, y] of [[keepId, row.companion_id], [row.companion_id, keepId]]) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO client_companions
           (id, user_id, client_id, companion_id, relation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(uid(), ownerId, x, y, row.relation, ts).run();
    }
  }
  await dropCompanions(env, ownerId, dropId);
}

/** Every link to or from one client, gone. For a deleted or merged record. */
export async function dropCompanions(env, ownerId, clientId) {
  await env.DB.prepare(
    'DELETE FROM client_companions WHERE client_id = ? AND user_id = ?'
  ).bind(clientId, ownerId).run();
  await env.DB.prepare(
    'DELETE FROM client_companions WHERE companion_id = ? AND user_id = ?'
  ).bind(clientId, ownerId).run();
}
