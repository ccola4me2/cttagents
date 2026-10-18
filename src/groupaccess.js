// Who may sell into a group, and what it pays when somebody else does.
//
// A group belongs to one advisor and, until this, nobody else could put a reservation into it. Now
// the advisor chooses: Private (only them), Open (any advisor in the agency) or By request (an
// advisor asks and is approved). An owner sees every group whatever its setting, and may attach to
// any group in the agency.
//
// The money follows one rule. A reservation put into somebody else's group keeps the booking
// advisor's own agreement unless the group names a share for outside bookings, which only an owner
// sets. That share is written onto the reservation when it is booked, the same column an owner's
// hand set share uses, so it is frozen with the reservation: changing the group afterwards does not
// reach back, and taking the reservation out of the group takes the group's share off again.

import { json, badRequest, notFound, forbidden, clean, uid, now, readJson } from './util.js';
import { requireUser, borrowedSeat } from './auth.js';
import * as db from './db.js';

export const SELLING = ['private', 'open', 'request'];

/**
 * Whether this advisor may put a reservation into this group, and if so what the group is.
 * Null when they may not: a group id is not a permission.
 */
export async function groupGrant(env, userId, groupId) {
  if (!groupId) return null;
  const me = await env.DB.prepare('SELECT id, role, agency_id FROM users WHERE id = ?').bind(userId).first();
  if (!me) return null;
  const agency = me.agency_id || '';
  const admin = me.role === 'admin' ? 1 : 0;
  const g = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.selling, g.outside_advisor_pct
       FROM travel_groups g JOIN users u ON u.id = g.user_id
      WHERE g.id = ? AND g.status <> 'cancelled'
        AND (g.user_id = ?
             OR (u.agency_id = ? AND ? = 1)
             OR (u.agency_id = ? AND g.selling = 'open')
             OR (u.agency_id = ? AND g.selling = 'request'
                 AND EXISTS (SELECT 1 FROM group_access a WHERE a.group_id = g.id AND a.user_id = ?
                              AND a.agency_id = ? AND a.status = 'approved')))`
  ).bind(groupId, userId, agency, admin, agency, agency, userId, agency).first();
  if (!g || (!agency && g.user_id !== userId)) return null;
  return { group: g, outside: g.user_id !== userId };
}

/**
 * After a reservation has been put in a group, or moved out of one: the group's share for outside
 * bookings goes on, or comes off. Never overwrites a share somebody set by hand.
 */
export async function applyGroupTerms(env, ownerId, bookingId, newGroupId, oldGroupId) {
  if (oldGroupId && oldGroupId !== newGroupId) {
    const old = await env.DB.prepare(
      'SELECT user_id, outside_advisor_pct FROM travel_groups WHERE id = ?'
    ).bind(oldGroupId).first();
    if (old && old.user_id !== ownerId && old.outside_advisor_pct !== null && old.outside_advisor_pct !== undefined) {
      await env.DB.prepare(
        'UPDATE bookings SET advisor_split_pct = NULL WHERE id = ? AND user_id = ? AND advisor_split_pct = ?'
      ).bind(bookingId, ownerId, old.outside_advisor_pct).run();
    }
  }
  if (newGroupId && newGroupId !== oldGroupId) {
    const grant = await groupGrant(env, ownerId, newGroupId);
    const pct = grant && grant.outside ? grant.group.outside_advisor_pct : null;
    if (pct !== null && pct !== undefined) {
      await env.DB.prepare(
        'UPDATE bookings SET advisor_split_pct = ? WHERE id = ? AND user_id = ? AND advisor_split_pct IS NULL'
      ).bind(pct, bookingId, ownerId).run();
    }
  }
}

const ADVISOR_NAME = `COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)`;

/**
 * GET /api/groups/bookable : the groups this advisor can put a reservation into (their own and the
 * open ones), and the ones that take requests, with where their request stands.
 */
export async function handleBookableGroups(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const agency = user.agency_id || '';
  const admin = user.role === 'admin' ? 1 : 0;

  const { results } = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.vendor, g.group_code, g.depart_date, g.status, g.selling,
            g.advisor_notes, g.outside_advisor_pct, g.cabins_held,
            (SELECT COUNT(*) FROM bookings b WHERE b.group_id = g.id
               AND b.status IN ('quoted','booked','travelled')) AS cabins_sold,
            ${ADVISOR_NAME} AS advisor_name,
            (SELECT a.status FROM group_access a WHERE a.group_id = g.id AND a.user_id = ?
               AND a.agency_id = ?) AS access
       FROM travel_groups g JOIN users u ON u.id = g.user_id
      WHERE g.status = 'open'
        AND (g.user_id = ? OR (u.agency_id = ? AND (g.selling <> 'private' OR ? = 1)))
      ORDER BY g.depart_date ASC, g.name ASC LIMIT 300`
  ).bind(user.id, agency, user.id, agency, admin).all().catch(() => ({ results: [] }));

  const groups = (results || []).map((g) => {
    const mine = g.user_id === user.id;
    const may = mine || admin === 1 || g.selling === 'open' || (g.selling === 'request' && g.access === 'approved');
    return {
      id: g.id, name: g.name, vendor: g.vendor || '', code: g.group_code || '', departs: g.depart_date || '',
      advisor: g.advisor_name, mine, selling: g.selling, may,
      access: mine ? 'own' : (g.selling === 'open' ? 'open' : (g.access || 'none')),
      // What the advisor needs to sell it. Never prices or anybody else's clients.
      notes: mine || may || g.selling === 'request' ? (g.advisor_notes || '') : '',
      outsidePct: mine ? null : (g.outside_advisor_pct === null || g.outside_advisor_pct === undefined
        ? null : Number(g.outside_advisor_pct)),
      left: Math.max(0, (g.cabins_held || 0) - (g.cabins_sold || 0)),
    };
  });
  return json({ groups });
}

/** POST /api/groups/:id/access-request : ask to sell into a group that takes requests. */
export async function handleRequestAccess(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return forbidden('Stop working as an advisor to ask for yourself.');
  const agency = user.agency_id || '';

  const g = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.selling
       FROM travel_groups g JOIN users u ON u.id = g.user_id
      WHERE g.id = ? AND g.status <> 'cancelled' AND u.agency_id = ? AND g.user_id <> ?`
  ).bind(groupId, agency, user.id).first();
  if (!g || !agency || g.selling !== 'request') return notFound('That group does not take requests.');

  await env.DB.prepare(
    `INSERT INTO group_access (id, agency_id, group_id, user_id, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET status = CASE WHEN group_access.status = 'approved'
       THEN 'approved' ELSE 'pending' END, decided_at = NULL, decided_by = NULL`
  ).bind(uid(), agency, groupId, user.id, now()).run();
  await db.logActivity(env, user.id, 'group.access_request', `Asked to sell into ${g.name}`, { groupId });
  return json({ ok: true, access: 'pending' });
}

/** GET /api/groups/:id/access : who has asked, for the group's advisor and for an owner. */
export async function handleGroupAccess(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerFor(env, user, 'travel_groups', groupId);
  if (!owner) return notFound('Group not found.');
  const agency = user.agency_id || '';
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.status, a.created_at, a.decided_at, ${ADVISOR_NAME} AS advisor
       FROM group_access a JOIN users u ON u.id = a.user_id
      WHERE a.group_id = ? AND a.agency_id = ?
      ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 200`
  ).bind(groupId, agency).all().catch(() => ({ results: [] }));
  return json({ requests: results || [] });
}

/** PUT /api/groups/:id/access/:requestId { decision: approve | decline | revoke } */
export async function handleDecideAccess(request, env, groupId, requestId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerFor(env, user, 'travel_groups', groupId);
  if (!owner) return notFound('Group not found.');
  const agency = user.agency_id || '';
  const decision = clean((await readJson(request)).decision, 20);
  const status = { approve: 'approved', decline: 'declined', revoke: 'declined' }[decision];
  if (!status) return badRequest('Say whether to approve or decline.');
  const res = await env.DB.prepare(
    `UPDATE group_access SET status = ?, decided_at = ?, decided_by = ?
      WHERE id = ? AND group_id = ? AND agency_id = ?`
  ).bind(status, now(), user.id, requestId, groupId, agency).run();
  if (!res.meta || !res.meta.changes) return notFound('Request not found.');
  await db.logActivity(env, user.id, 'group.access_decision', `${status} a request to sell into a group`,
    { groupId, requestId, status });
  return json({ ok: true, status });
}
