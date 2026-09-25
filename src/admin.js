// Admin: approve advisor accounts, bind them to a GoHighLevel sub-account,
// and suspend access.

import {
  json, badRequest, notFound, clean, cleanText, readJson, forbidden, parseCookies,
  isValidEmail, normalizeEmail, randomToken, sha256Hex, hashPassword,
} from './util.js';
import { requireAdmin, requireUser, publicUser, realUserOf, SESSION_COOKIE } from './auth.js';
import { tenantFor } from './tenant.js';
import * as db from './db.js';
import { getAgency } from './brand.js';
import { COMPANY_LEAD } from './split.js';
import { sendAdvisorApprovedEmail, sendAdvisorInviteEmail, checkResend, sendTestEmail } from './email.js';
import { remindTasks } from './taskmail.js';
import { remindDuePayments } from './payremind.js';
import { sendCallLists } from './calllist.js';
import { schemaDrift } from './schema-drift.js';
import { jobHealth } from './cronlog.js';
import { mirrorCatalogStep, mirrorStatus } from './catalogmirror.js';

const STATUSES = ['pending', 'active', 'suspended'];

/**
 * Whether this owner may act on this advisor.
 *
 * The three handlers below took a user id and checked only that the caller was
 * an owner, which with one agency meant "an owner of the only agency there is".
 * With two it meant one agency could suspend another's staff.
 */
async function reachable(env, admin, userId) {
  const target = await db.getUserById(env, userId);
  if (!target) return { error: notFound('Advisor not found.') };
  if (admin.platform_owner) return { target };
  if (!admin.agency_id || target.agency_id !== admin.agency_id) {
    // The same answer as a user who does not exist. Telling one agency that an
    // address belongs to somebody at another is itself the leak.
    return { error: notFound('Advisor not found.') };
  }
  return { target };
}

export async function handleListAdvisors(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  // Their own agency, unless they run the portal. Unfiltered, this handed
  // every owner the name, email and phone of every advisor on the platform.
  const agencyId = admin.platform_owner ? undefined : (admin.agency_id || '__none__');
  const users = await db.listUsers(env, {
    status: STATUSES.includes(status) ? status : undefined,
    agencyId,
  });
  return json({
    users: users.map(publicUser),
    counts: await db.countUsers(env, { agencyId }),
    platformOwner: Boolean(admin.platform_owner),
    // So the work-as picker can leave the reader out of their own list. The
    // server refuses it anyway, with "you are already yourself", but a name in
    // a list of seats to sit in should be a seat somebody can sit in.
    viewerId: admin.id,
    agencies: admin.platform_owner ? await agencyNames(env) : [],
  });
}

/** Agency names for the platform owner's advisor list, so a row says whose. */
async function agencyNames(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, name FROM agencies ORDER BY name ASC LIMIT 200'
  ).all().catch(() => ({ results: [] }));
  return results || [];
}

/** How long a new advisor has to choose a password before the link dies. */
const INVITE_TTL_DAYS = 7;

/**
 * Where an invite link should point.
 *
 * The host the admin is actually using, not APP_URL. The two disagree
 * whenever the custom domain is not attached yet, and a welcome link on a
 * hostname the portal does not answer on is worse than no link at all.
 */
function inviteBase(env, request) {
  try {
    return new URL(request.url).origin;
  } catch {
    return String(env.APP_URL || '').replace(/\/$/, '');
  }
}

/**
 * A one-time link that lets somebody set the password on their own account.
 *
 * Deliberately the same machinery as a password reset: one table, one expiry
 * rule, one consume-once path already used in anger. An invite is not a
 * different idea, it is a reset for an account that has never had a password.
 *
 * The link is returned to the admin whether or not the email went out. Email
 * is best effort and silently does nothing until Resend is configured, so an
 * invite that exists only in an email nobody received would strand the advisor
 * and give the admin nothing to hand them.
 */
async function issueInvite(env, request, user) {
  const token = randomToken(32);
  await db.createResetToken(env, user.id, await sha256Hex(token), INVITE_TTL_DAYS * 86400);
  const url = `${inviteBase(env, request)}/reset-password?token=${encodeURIComponent(token)}`;
  const emailed = await sendAdvisorInviteEmail(env, user, url, INVITE_TTL_DAYS)
    .then((r) => !(r && r.skipped))
    .catch(() => false);
  return { url, expiresInDays: INVITE_TTL_DAYS, emailed };
}

/**
 * Create an advisor. Nobody signs themselves up here: the agency decides who
 * is an advisor, so this is the only way an account comes into being.
 *
 * The account is active from the start rather than pending. Pending exists to
 * hold a stranger who asked for access at the door, and there are no strangers
 * in this flow: an admin typed the address. What stands in for approval is the
 * password, which only the person reading the invite can set.
 */
export async function handleCreateAdvisor(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  const phone = clean(body.phone, 40);
  const role = body.role === 'admin' ? 'admin' : 'advisor';

  if (!isValidEmail(email)) return badRequest('Enter a valid email address.');
  if (!firstName || !lastName) return badRequest('First and last name are required.');
  // Only the operator of the portal hands out the role that sees every book in
  // an agency. An owner who could promote their own staff could widen who sees
  // their advisors' clients and money with nobody outside the agency knowing.
  if (role === 'admin' && !admin.platform_owner) {
    return badRequest('Only the portal owner can create an administrator.');
  }
  if (await db.emailExists(env, email)) {
    // Said plainly. This is an admin who just typed the address, not a
    // stranger probing which of their colleagues are registered.
    return badRequest('There is already an account with that email address.');
  }

  const agencyId = admin.agency_id || null;
  const agency = agencyId ? await getAgency(env, agencyId) : null;

  const user = await db.createUser(env, {
    agencyId,
    email,
    // Random and thrown away. The account cannot be signed into until the
    // invite sets a real one, which is the point: no default password exists
    // to be guessed, shared, or left in place for a year.
    passwordHash: await hashPassword(randomToken(32)),
    firstName,
    lastName,
    phone,
    agencyName: agency ? agency.name : null,
    role,
    status: 'active',
  });

  const invite = await issueInvite(env, request, user);
  await db.logActivity(env, admin.id, 'admin.advisor.create',
    `Created ${email} as ${role}`, { userId: user.id, role });
  return json({ ok: true, user: publicUser(user), invite });
}

/** A fresh link, for the advisor who lost theirs or let it expire. */
export async function handleReissueInvite(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;

  const invite = await issueInvite(env, request, reach.target);
  await db.logActivity(env, admin.id, 'admin.advisor.invite',
    `Re-sent invite to ${reach.target.email}`, { userId });
  return json({ ok: true, invite });
}

/** The session this request arrived on, so acting can be turned on for it alone. */
async function sessionHash(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  return token ? sha256Hex(token) : null;
}

/**
 * Work inside an advisor's account: their clients, their reservations, their
 * CRM. For the owner who has to enter a booking somebody phoned in, or fix a
 * record an advisor cannot.
 *
 * The whole portal behaves as that advisor for the duration, because the
 * session says so and every handler reads the session. Nothing else changes,
 * which is why this is a dozen lines rather than a second set of screens.
 */
export async function handleStartActing(request, env, userId) {
  // requireAdmin also refuses if this session is already acting, so switching
  // straight from one advisor to another is not possible without stopping.
  // That keeps "who am I" answerable at every moment.
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;
  const target = reach.target;

  if (target.id === admin.id) return badRequest('You are already yourself.');

  // Anybody in your own agency, owner or associate. reachable() above is the
  // agency fence; this is about what working as somebody can be used for.
  //
  // It used to refuse any owner, for two reasons. One has stopped being true:
  // an owner could not change another owner's records directly, so acting as
  // them was a way round that. Owners now work on the whole agency, so acting
  // as a fellow owner borrows nothing they did not already have.
  //
  // The other reason is what keeps this safe, and it is not this check: while
  // a session is acting, requireAdmin refuses outright, so the admin screens
  // and the commission split are shut whoever is being worked as. Acting as a
  // fellow owner is a lateral move into their advisor seat, not a way up.
  //
  // The portal owner stays out of reach. That account reaches every agency
  // here, so acting as it is the one case that would really be borrowing
  // authority, and reachable() lets it past the agency fence by design.
  if (target.platform_owner) {
    const who = [target.first_name, target.last_name].filter(Boolean).join(' ') || target.email;
    return forbidden(`${who} runs the portal itself, so that account is not one `
      + 'to work as. Working as somebody is for doing their filing inside your '
      + 'agency, not for reaching the platform.');
  }
  if (target.status !== 'active') return badRequest('That account is not active.');

  const hash = await sessionHash(request);
  if (!hash) return forbidden('No session to switch.');
  await db.setSessionActingAs(env, hash, target.id);

  // Logged against the admin, so an advisor's history can always be read back
  // as "this stretch was the office, not them".
  await db.logActivity(env, admin.id, 'admin.act.start',
    `Started working as ${target.email}`, { userId: target.id });
  return json({ ok: true, actingAs: publicUser(target) });
}

/** Back to your own seat. Must work while acting, so it cannot use requireAdmin. */
export async function handleStopActing(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const hash = await sessionHash(request);
  if (!hash) return forbidden('No session to switch.');
  await db.setSessionActingAs(env, hash, null);

  if (user.acting_as) {
    const admin = realUserOf(user);
    await db.logActivity(env, admin.id, 'admin.act.stop',
      `Stopped working as ${user.email}`, { userId: user.id });
  }
  return json({ ok: true });
}

export async function handleSetAdvisorStatus(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;

  const body = await readJson(request);
  const status = String(body.status || '');
  if (!STATUSES.includes(status)) return badRequest('Unknown status.');
  if (userId === admin.id && status !== 'active') {
    return badRequest('You cannot suspend your own account.');
  }

  const before = await db.getUserById(env, userId);
  if (!before) return notFound('Advisor not found.');

  const updated = await db.setUserStatus(env, userId, status, admin.id);

  // Suspending must take effect immediately, not at session expiry.
  if (status !== 'active') await db.deleteUserSessions(env, userId);

  // Only email on the pending to active transition, so re-saving an already
  // active advisor does not spam them.
  if (status === 'active' && before.status === 'pending') {
    await sendAdvisorApprovedEmail(env, updated).catch(() => {});
  }

  await db.logActivity(env, admin.id, 'admin.status',
    `Set ${updated.email} to ${status}`, { userId, status });
  return json({ ok: true, user: publicUser(updated) });
}

/**
 * Set an advisor's standing share of the commission they bill.
 *
 * Owner only, and deliberately so: an associate who could set their own split
 * could pay themselves. Blank clears the agreement, which is not the same as
 * setting it to zero, so the two are kept apart all the way down.
 */
/**
 * How one reservation's commission divides: a figure of its own, and which of
 * the two standing agreements it falls under.
 *
 * Its own endpoint rather than a guard on the advisor's, because the advisor's
 * is scoped to whoever is signed in. An admin cannot reach somebody else's
 * booking through it at all, and an admin working inside an advisor's account
 * is an advisor there and refused. Guarding it left these settable by nobody.
 *
 * Reached by user rather than by booking: the fence is which agency the
 * advisor who owns it belongs to, which is the same question reachable()
 * already answers everywhere else in this file.
 */
/**
 * The advisor's own details, edited by somebody who is not them.
 *
 * Every field here ends up in front of a client: the name on a quote, the
 * phone at the bottom of an email, the registration number a state requires on
 * the document. A typo in one is a typo a client reads, and the only way to
 * fix one used to be to sign in as the advisor and do it from their side.
 *
 * Deliberately not the notification switches. Those are the advisor's own
 * choices about how the portal talks to them, and an admin silently turning
 * off somebody's morning email is not a profile edit.
 */
export async function handleUpdateAdvisor(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;
  const before = reach.target;

  const body = await readJson(request);
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  if (!firstName || !lastName) return badRequest('First and last name are required.');

  // The address they sign in with. Optional to send: a caller that does not
  // mention it leaves it alone, which is the rule everywhere else in this
  // portal and the reason a save from one screen cannot undo another.
  let email = before.email;
  if (body.email !== undefined) {
    email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return badRequest('Enter a valid email address.');
    if (email !== before.email && await db.emailExists(env, email)) {
      return badRequest('There is already an account with that email address.');
    }
  }

  const updated = await db.updateUserProfile(env, userId, {
    firstName,
    lastName,
    phone: clean(body.phone, 40),
    notifyEmail: clean(body.notifyEmail, 254),
    agencyName: clean(body.agencyName, 160),
    agencyAddress: cleanText(body.agencyAddress, 400),
    sellerOfTravel: clean(body.sellerOfTravel, 120),
  });
  if (!updated) return notFound('Advisor not found.');

  if (email !== before.email) {
    await db.setUserEmail(env, userId, email);
  }

  // What changed, by name. "Updated the advisor" is a line nobody can audit;
  // this one says which field and from what, which is the only version worth
  // keeping.
  const changed = [];
  const say = (label, was, now) => {
    if ((was || '') !== (now || '')) changed.push(`${label} ${was || 'blank'} to ${now || 'blank'}`);
  };
  say('name', [before.first_name, before.last_name].filter(Boolean).join(' '),
      [firstName, lastName].filter(Boolean).join(' '));
  say('email', before.email, email);
  say('phone', before.phone, clean(body.phone, 40));
  say('agency name', before.agency_name, clean(body.agencyName, 160));
  say('seller of travel', before.seller_of_travel, clean(body.sellerOfTravel, 120));

  if (changed.length) {
    await db.logActivity(env, admin.id, 'admin.advisor.edit',
      `Changed ${before.email}: ${changed.join('; ')}`, { userId, fields: changed.length });
  }

  const after = await db.getUserById(env, userId);
  return json({ ok: true, user: publicUser(after), changed });
}

export async function handleSetBookingSplit(request, env, bookingId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const booking = await db.getBookingUnscoped(env, bookingId);
  if (!booking) return notFound('Reservation not found.');
  const reach = await reachable(env, admin, booking.user_id);
  if (reach.error) return notFound('Reservation not found.');

  const body = await readJson(request);

  // Blank is not nought. Clearing puts the trip back on the standing
  // agreement; a deliberate 0 means the agency keeps everything, which is a
  // real arrangement for a house account.
  let pct = null;
  if (Object.prototype.hasOwnProperty.call(body, 'advisorSplitPct')) {
    const raw = body.advisorSplitPct;
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return badRequest('A share is a number between 0 and 100, or blank to follow the agreement.');
      }
      pct = Math.round(n * 10) / 10;
    }
  } else {
    pct = booking.advisor_split_pct === null || booking.advisor_split_pct === undefined
      ? null : Number(booking.advisor_split_pct);
  }

  const leadSource = Object.prototype.hasOwnProperty.call(body, 'leadSource')
    ? (body.leadSource === COMPANY_LEAD ? COMPANY_LEAD : 'personal')
    : (booking.lead_source === COMPANY_LEAD ? COMPANY_LEAD : 'personal');

  const updated = await db.setBookingSplit(env, bookingId, {
    advisorSplitPct: pct, leadSource,
  });
  await db.logActivity(env, admin.id, 'admin.booking.split',
    `${booking.client_name}: ${pct === null ? 'follows the agreement' : `${pct}%`}`
    + `, ${leadSource === COMPANY_LEAD ? 'company lead' : 'own booking'}`,
    { bookingId, pct, leadSource });
  return json({ ok: true, booking: updated });
}

/**
 * Hand a reservation to the advisor it should have been taken under.
 *
 * A trip typed in by the owner without first working as the advisor lands on
 * the owner's book: their production, their commission, their statement. The
 * only fix was to type the whole thing in again and delete the first one,
 * which loses the payments, the travellers and the date it was sold.
 *
 * Both ends are checked, not just one. The reservation has to be reachable by
 * this owner and so does the advisor receiving it, or an owner of one agency
 * could push work into another's book.
 */
export async function handleSetBookingAdvisor(request, env, bookingId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const booking = await db.getBookingUnscoped(env, bookingId);
  if (!booking) return notFound('Reservation not found.');
  const from = await reachable(env, admin, booking.user_id);
  if (from.error) return notFound('Reservation not found.');

  const body = await readJson(request);
  const toId = clean(body.userId, 64);
  if (!toId) return badRequest('Pick the advisor it belongs to.');
  if (toId === booking.user_id) return badRequest('It is already theirs.');

  const to = await reachable(env, admin, toId);
  if (to.error) return to.error;
  if (to.target.status !== 'active') {
    return badRequest('That account is not active, so nothing can be filed under it.');
  }

  const { moved, client } = await db.reassignBooking(
    env, bookingId, booking.user_id, toId
  );

  const named = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
  await db.logActivity(env, admin.id, 'admin.booking.advisor',
    `${booking.client_name}: moved from ${named(from.target)} to ${named(to.target)}`,
    { bookingId, from: booking.user_id, to: toId, rows: moved, client });

  // Said on both books, because both change. The advisor losing it is the one
  // who will notice a figure move and have nothing to explain it.
  await db.logActivity(env, booking.user_id, 'booking.moved.out',
    `${booking.client_name} moved to ${named(to.target)}, by ${named(admin)}`, { bookingId });
  await db.logActivity(env, toId, 'booking.moved.in',
    `${booking.client_name} moved to you from ${named(from.target)}, by ${named(admin)}`,
    { bookingId });

  return json({
    ok: true,
    advisor: named(to.target),
    // What actually moved, so the page can say what became of the client
    // rather than leaving somebody to find out by clicking their name.
    // 'moved' came with it, 'shared' means the advisor already kept that
    // person and the trip now points at their copy, 'kept' means the outgoing
    // advisor still has another trip for them.
    rows: moved,
    client,
    was: named(from.target),
  });
}

export async function handleSetAdvisorSplit(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;

  const body = await readJson(request);

  // Two agreements, both optional and both meaning the same thing when blank:
  // nothing has been agreed, so the advisor keeps all of it. Blank is not
  // zero here any more than it is anywhere else in this module.
  const readPct = (raw) => {
    if (raw === null || raw === undefined || String(raw).trim() === '') return { pct: null };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { error: 'A share is a number between 0 and 100, or blank for no agreement.' };
    }
    return { pct: Math.round(n * 10) / 10 };
  };

  const own = readPct(body.defaultSplitPct);
  if (own.error) return badRequest(own.error);
  const lead = readPct(body.leadSplitPct);
  if (lead.error) return badRequest(lead.error);

  const updated = await db.setUserSplit(env, userId, own.pct, lead.pct);
  if (!updated) return notFound('Advisor not found.');

  const say = (p) => (p === null ? 'all of it' : `${p}%`);
  await db.logActivity(env, admin.id, 'admin.split',
    `Set ${updated.email} to keep ${say(own.pct)} of their own bookings and `
    + `${say(lead.pct === null ? own.pct : lead.pct)} of company leads`,
    { userId, pct: own.pct, leadPct: lead.pct });
  return json({ ok: true, user: publicUser(updated) });
}

/**
 * Bring reservation statuses up to date now rather than on the next cron.
 *
 * The sweep runs every few minutes on its own. This exists so it can be run
 * on demand, which is what you want after an import brings in a book of past
 * trips and the reports still say nobody has travelled.
 */
export async function handleRunLifecycle(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const today = new Date().toISOString().slice(0, 10);
  const moved = await db.markReturnedTripsTravelled(env, { today });
  return json({ ok: true, travelled: moved });
}

/**
 * Configuration health, admin only.
 *
 * Reports whether each secret and binding is actually reachable at runtime.
 * Deliberately reports presence only, never a value, so it is safe to call
 * from the browser and safe to paste into a support thread.
 */
/** Pull the sailing catalog from the copy CruiseShoppers already holds. */
export async function handleMirrorCatalog(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  const body = await readJson(request);
  const result = await mirrorCatalogStep(env, {
    maxShips: Math.min(Math.max(Number(body.ships) || 25, 1), 60),
    force: body.force === true,
  });
  await db.logActivity(env, user.id, 'catalog.mirror', 'Imported sailings', result);
  return json({ ...result, status: await mirrorStatus(env) });
}

export async function handleMirrorStatus(request, env) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;
  return json(await mirrorStatus(env));
}

/**
 * Rows left behind by a reservation that is gone.
 *
 * Here because an orphan is invisible everywhere else. Every screen reads
 * these tables through the booking they hang off, so a pricing line whose
 * reservation was deleted is read by nothing, reaches no total and appears on
 * no page. That is exactly why deleteBooking could leave them for a year
 * without anybody noticing, and why a smoke test written against the API
 * could not have caught it either: there is no request whose answer changes.
 *
 * So the health page asks the database instead. Zero is the answer, and
 * anything else is a delete that did not finish.
 *
 * client_credits is not on this list. A credit whose booking_id points at a
 * deleted trip is not litter, it is a client's money waiting to be spent on
 * something else, and handleDeleteBooking nulls the pointer on purpose.
 */
async function orphanRows(env, user) {
  // This agency's, like everything else an admin reads.
  //
  // The first version counted every row in the table, which check-scope refused
  // and was right to. An orphan belongs to whoever owned the trip it came off,
  // so an unfenced count told an agency owner how much litter the agency next
  // door was carrying. A small fact, still not theirs, and a number nobody can
  // act on is not worth a hole in the fence.
  //
  // The predicate is written out rather than interpolated from scopeWhere, and
  // that is not style. A statement that builds its table name is read by no
  // rule in check-scope except the one that insists it still names user_id in
  // its own text, and `${scope.sql}` satisfies a human reading it while leaving
  // the checker with nothing. The one statement in this file that can reach any
  // of fourteen tables is the last one to hide its fence behind an
  // interpolation.
  //
  // An admin with no agency counts nothing, because agency_id = NULL is true of
  // no row. The fence failing shut is a health page reporting less than there
  // is; failing open is one agency reading another's.
  const counts = {};
  let total = 0;
  for (const table of db.BOOKING_OWNED) {
    // One statement per table rather than one compound SELECT: D1 refuses a
    // compound of this many terms, and a count that fails for a table this
    // deployment does not have should not take the other thirteen with it.
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table} x
        WHERE x.user_id IN (SELECT id FROM users WHERE agency_id = ?)
          AND x.booking_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = x.booking_id)`
    ).bind(user.agency_id || null).first().catch(() => null);
    if (!row) continue;
    if (row.n) { counts[table] = row.n; total += row.n; }
  }
  return { total, tables: counts };
}

export async function handleHealth(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const probe = url.searchParams.get('probe');
  const wantScopes = probe === '1';
  const wantFull = probe === 'full';
  const wantEmail = probe === 'email' || wantFull;

  let dbOk = false;
  let userCount = 0;
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    userCount = row?.n ?? 0;
    dbOk = true;
  } catch (e) {
    console.error('health db', e);
  }

  const schema = dbOk ? await schemaDrift(env) : null;

  // Rows whose reservation has gone. Nothing else in the portal can see one.
  const orphans = dbOk ? await orphanRows(env, user) : null;

  // What the cron has been doing. Cheap, one query, and the only place the
  // answer to "are the reminders still going out" exists at all.
  const jobs = dbOk ? await jobHealth(env) : { jobs: [], ok: false, error: 'no database' };

  const resend = wantEmail ? await checkResend(env) : null;

  return json({
    email: {
      resendKeyPresent: Boolean(env.RESEND_API_KEY),
      mailFrom: env.MAIL_FROM || null,
      notifyEmail: env.NOTIFY_EMAIL || null,
      resend,
    },
    db: { ok: dbOk, users: userCount },
    // When each scheduled job last ran, and when it last ran without throwing.
    // Those two being far apart is a job that has been failing quietly.
    jobs,
    // Whether the database has had every migration applied. Migrations here
    // are run by hand, so this is the one fact about the system that the
    // repository cannot tell you.
    schema,
    // Should always be zero. Anything else is a reservation that was deleted
    // and left part of itself behind.
    orphans,
    appUrl: env.APP_URL || null,
    // Names of every binding and var the Worker can actually see. Values are
    // never included; this is here to catch a secret saved under the wrong
    // name or in the build environment instead of the runtime one.
    visibleKeys: Object.keys(env).sort(),
  });
}

/** Admin only. Sends a real email and returns Resend's actual response. */
/**
 * Run the daily "what is due" pass now, ignoring the hour.
 *
 * The pass is meant to fire once a morning, which makes it the hardest thing
 * here to check: waiting until tomorrow to find out whether it works is not
 * testing it. Admin only, and it sends for real, so the stamps it writes are
 * the real stamps: a task told about here is not told about again.
 */
export async function handleRunTaskReminders(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const result = await remindTasks(env, { force: true });
  await db.logActivity(env, user.id, 'admin.taskReminders', 'Ran the task reminder pass', result);
  return json(result);
}

/**
 * Run the client payment reminder pass now.
 *
 * It sends for real, to real clients, so this is the one admin button that can
 * be embarrassing. It obeys the same rules as the cron: advisors who turned it
 * on, hard deadlines only, and one notice per lead time.
 */
export async function handleRunPaymentReminders(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const result = await remindDuePayments(env);
  await db.logActivity(env, user.id, 'admin.paymentReminders',
    'Ran the client payment reminder pass', result);
  return json(result);
}

/**
 * Send the weekly call list now, whatever day it is.
 *
 * It goes to advisors rather than to clients, so this is the safe one of the
 * three. It still writes the real stamp: an advisor sent one here does not get
 * another on Monday, which is the point of pressing it on a Friday to see what
 * it looks like.
 */
export async function handleRunCallLists(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const body = await readJson(request).catch(() => ({}));
  const result = await sendCallLists(env, {
    force: true,
    // Just to whoever pressed it, unless they ask for everybody. Trying the
    // wording out should not put an email in nine other inboxes.
    only: body && body.everyone ? null : user.id,
  });
  await db.logActivity(env, user.id, 'admin.callLists', 'Sent the weekly call list', result);
  return json(result);
}

export async function handleTestEmail(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  const body = await readJson(request);
  const to = clean(body.to, 254) || user.email;
  if (!to) return badRequest('No address to send to.');

  const result = await sendTestEmail(env, to);
  await db.logActivity(env, user.id, 'admin.testEmail', `Test email to ${to}`, { ok: result.ok });
  return json(result, result.ok ? 200 : 502);
}

