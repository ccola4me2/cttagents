// The Group Desk.
//
// A few people who are not in the same agency share groups: one of them owns a group, all of them book cabins
// into it, and the owner earns the tour conductor credit for however many guests the whole group brings. They
// need one private place to see every group, who has booked what, and how far each is from its next credit.
// That place is cruisegrouppage.com/desk.
//
// Its members are accounts in an agency of their own, flagged is_desk. They are not advisors of the agency that
// runs the portal and nothing of its clients, reservations or money is visible to them, because the data fence
// is the agency. They sign in on the group domain only, which otherwise has no sign in at all, and the one door
// there is for them. Every group page, sign-up form, roster and sheet is the same engine everybody else uses:
// a group a member creates is theirs, the others on the desk may work on it (they are all owners of the desk's
// agency), and its public page carries its owner's own name, logo and contact.
//
// Only the portal's own operator can add a member, and each member sets their own password from a link.

import {
  json, badRequest, notFound, forbidden, clean, readJson, isValidEmail, normalizeEmail, randomToken, sha256Hex,
  hashPassword, now,
} from './util.js';
import { requireUser, requireAdmin, publicUser } from './auth.js';
import { appUrl } from './share.js';
import * as db from './db.js';

const DESK_AGENCY = 'agency-desk';
const INVITE_TTL_DAYS = 7;

/** Is this person on the desk? */
export function isDeskUser(user) {
  return Boolean(user && user.agency_is_desk);
}

/** The desk's own address for a path: on the group domain when there is one, else the portal's own. */
function deskUrl(env, path) {
  const host = String(env.GROUP_HOST || '').trim();
  return host ? `https://${host}${path}` : `${appUrl(env)}${path}`;
}

/** The desk's agency, made the first time somebody is added to it. */
async function ensureDeskAgency(env) {
  const have = await env.DB.prepare('SELECT id FROM agencies WHERE id = ?').bind(DESK_AGENCY).first();
  if (have) return DESK_AGENCY;
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO agencies (id, name, slug, join_open, is_desk, created_at, updated_at)
     VALUES (?, 'Group Desk', 'group-desk', 0, 1, ?, ?)`
  ).bind(DESK_AGENCY, ts, ts).run();
  return DESK_AGENCY;
}

/** The people on the desk, for the operator. */
async function members(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, email, desk_email, first_name, last_name, phone, status, last_login_at FROM users
      WHERE agency_id = ? ORDER BY created_at ASC`
  ).bind(DESK_AGENCY).all().catch(() => ({ results: [] }));
  return (results || []).map((u) => ({
    id: u.id, email: u.desk_email || u.email, name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
    phone: u.phone || '', status: u.status, lastLoginAt: u.last_login_at || null,
  }));
}

/** A one time link that lets somebody choose their own password, good for a week. */
async function issueInvite(env, userId) {
  const token = randomToken(32);
  await db.createResetToken(env, userId, await sha256Hex(token), INVITE_TTL_DAYS * 86400);
  return { url: deskUrl(env, `/desk/reset?token=${encodeURIComponent(token)}`), expiresInDays: INVITE_TTL_DAYS };
}

/** The operator of the portal, and nobody else, may manage the desk. */
async function requireOperator(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return { response };
  if (!user.platform_owner) return { response: forbidden('Only the portal owner can manage the desk.') };
  return { user };
}

/** GET /api/admin/desk */
export async function handleDeskMembers(request, env) {
  const { response } = await requireOperator(request, env);
  if (response) return response;
  return json({ members: await members(env), address: deskUrl(env, '/desk') });
}

/** POST /api/admin/desk { email, firstName, lastName, phone } : adds a member and gives back their link. */
export async function handleAddDeskMember(request, env) {
  const { user: operator, response } = await requireOperator(request, env);
  if (response) return response;

  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  if (!isValidEmail(email)) return badRequest('Enter a valid email address.');
  if (!firstName || !lastName) return badRequest('First and last name are required.');
  // Already on the desk, under that address or as the address they sign in with there.
  const onDesk = await env.DB.prepare(
    'SELECT id FROM users WHERE agency_id = ? AND (email = ? OR desk_email = ?)'
  ).bind(DESK_AGENCY, email, email).first();
  if (onDesk) return badRequest('That address is already on the desk.');
  // An address the same person already has an account under elsewhere in the portal, such as the owner's own.
  // Accounts are one to an address, so the desk account is held under an internal one and the real address is
  // what they type to sign in at the desk. They never see the internal one.
  const taken = await db.emailExists(env, email);

  const agencyId = await ensureDeskAgency(env);
  // Every member is an owner of the desk's agency, so each can see and work on every group on it. They are
  // owners of nothing else: the agency holds nobody but the desk.
  const created = await db.createUser(env, {
    agencyId, email: taken ? `desk-${randomToken(8)}@desk.invalid` : email,
    // Random and thrown away: the account cannot be signed into until the link sets a real password.
    passwordHash: await hashPassword(randomToken(32)),
    firstName, lastName, phone: clean(body.phone, 40), agencyName: 'Group Desk', role: 'admin', status: 'active',
  });
  if (taken) {
    await env.DB.prepare('UPDATE users SET desk_email = ? WHERE id = ? AND agency_id = ?')
      .bind(email, created.id, agencyId).run();
  }
  const user = await db.getUserById(env, created.id);
  await db.logActivity(env, operator.id, 'desk.add', `Added ${email} to the Group Desk`, { userId: user.id });
  return json({ ok: true, member: publicUser(user), invite: await issueInvite(env, user.id) });
}

/** POST /api/admin/desk/:id/invite : a fresh link for somebody who lost theirs. */
export async function handleDeskInvite(request, env, userId) {
  const { user: operator, response } = await requireOperator(request, env);
  if (response) return response;
  const target = await env.DB.prepare('SELECT id, email FROM users WHERE id = ? AND agency_id = ?')
    .bind(userId, DESK_AGENCY).first();
  if (!target) return notFound('That person is not on the desk.');
  await db.logActivity(env, operator.id, 'desk.invite', `Re-sent a desk link to ${target.email}`, { userId });
  return json({ ok: true, invite: await issueInvite(env, target.id) });
}

/**
 * GET /api/desk/overview : every group on the desk at a glance, and the credits each owner has earned.
 *
 * Whatever groups the reader may see: on the desk that is all of them, since every member owns the agency.
 */
export async function handleDeskOverview(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'g.user_id');
  const showAll = new URL(request.url).searchParams.get('all') === '1';
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.vendor, g.product_name, g.group_number, g.group_code, g.depart_date,
            g.option_date, g.final_payment_due, g.cabins_held, g.status, g.page_slug, g.registration_open,
            u.first_name, u.last_name,
            (SELECT COUNT(*) FROM group_cabins c
               WHERE c.group_id = g.id AND c.user_id = g.user_id AND c.status <> 'cancelled') AS cabins,
            (SELECT COALESCE(SUM(c.guests), 0) FROM group_cabins c
               WHERE c.group_id = g.id AND c.user_id = g.user_id AND c.status <> 'cancelled') AS guests,
            (SELECT COALESCE(SUM(c.guests), 0) FROM group_cabins c
               WHERE c.group_id = g.id AND c.user_id = g.user_id AND c.status = 'paid') AS paid_guests,
            (SELECT COUNT(*) FROM group_registrations r
               WHERE r.group_id = g.id AND r.user_id = g.user_id AND r.status <> 'cancelled'
                 AND NOT EXISTS (SELECT 1 FROM group_cabins c2
                                  WHERE c2.registration_id = r.id AND c2.user_id = g.user_id)) AS waiting
       FROM travel_groups g JOIN users u ON u.id = g.user_id
      WHERE ${scoped.sql} AND (? = 1 OR g.status = 'open')
      ORDER BY g.depart_date IS NULL, g.depart_date ASC, g.name ASC`
  ).bind(...scoped.binds, showAll ? 1 : 0).all();

  const today = new Date().toISOString().slice(0, 10);
  const groups = (results || []).map((g) => {
    const guests = Number(g.guests) || 0;
    return {
      id: g.id, name: g.name, ship: g.product_name || g.vendor || '', groupNumber: g.group_number || g.group_code || '',
      departDate: g.depart_date || '', optionDate: g.option_date || '', finalPaymentDue: g.final_payment_due || '',
      cabinsHeld: g.cabins_held || 0, status: g.status, pageSlug: g.page_slug || '', pageOpen: g.registration_open === 1,
      owner: `${g.first_name || ''} ${g.last_name || ''}`.trim(), ownerId: g.user_id,
      cabins: Number(g.cabins) || 0, guests, paidGuests: Number(g.paid_guests) || 0, waiting: Number(g.waiting) || 0,
      tcEarned: Math.floor(guests / 12), toNextTc: 12 - (guests % 12),
      minimumMet: (Number(g.cabins) || 0) >= 6,
      // Dates still ahead, so the screen can say how soon.
      optionSoon: Boolean(g.option_date && g.option_date >= today),
    };
  });

  const owners = {};
  for (const g of groups) {
    owners[g.owner] = owners[g.owner] || { groups: 0, guests: 0, tcEarned: 0 };
    owners[g.owner].groups += 1;
    owners[g.owner].guests += g.guests;
    owners[g.owner].tcEarned += g.tcEarned;
  }
  return json({ groups, owners, today });
}
