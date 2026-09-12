// Admin: approve advisor accounts, bind them to a GoHighLevel sub-account,
// and suspend access.

import {
  json, badRequest, notFound, clean, readJson, forbidden, parseCookies,
  isValidEmail, normalizeEmail, randomToken, sha256Hex, hashPassword,
} from './util.js';
import * as ghl from './ghl.js';
import { listSyncState, runSync, resetSync } from './sync.js';
import { requireAdmin, requireUser, publicUser, realUserOf, SESSION_COOKIE } from './auth.js';
import * as db from './db.js';
import { getAgency } from './brand.js';
import { COMPANY_LEAD } from './split.js';
import { sendAdvisorApprovedEmail, sendAdvisorInviteEmail, checkResend, sendTestEmail } from './email.js';
import { remindTasks } from './taskmail.js';
import { remindDuePayments } from './payremind.js';
import { sendCallLists } from './calllist.js';
import { schemaDrift } from './schema-drift.js';
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
    // Their agency's CRM sub-account, so a new advisor lands in the right one
    // without anybody remembering to set it.
    ghlLocationId: agency ? agency.ghl_location_id : null,
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
  // Only downward. Acting as another admin, or as the portal owner, would be
  // a way to borrow authority rather than to do somebody's filing, and an
  // agency owner could use it to reach an account they are not allowed to
  // change directly.
  if (target.role === 'admin' || target.platform_owner) {
    // Named, because the old wording said "You can only work as an advisor",
    // which an owner reads as a claim about their own account rather than
    // about the one they picked.
    const who = [target.first_name, target.last_name].filter(Boolean).join(' ') || target.email;
    return forbidden(`${who} is an owner, so there is nothing to work as. `
      + 'Working as somebody is for doing an advisor\'s filing, not for reaching '
      + 'another owner\'s account.');
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

export async function handleSetAdvisorGhl(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;

  const body = await readJson(request);
  const updated = await db.setUserGhl(env, userId, {
    locationId: clean(body.ghlLocationId, 64),
    ghlUserId: clean(body.ghlUserId, 64),
  });
  if (!updated) return notFound('Advisor not found.');

  await db.logActivity(env, admin.id, 'admin.ghl',
    `Bound ${updated.email} to location ${updated.ghl_location_id || 'default'}`, { userId });
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

export async function handleHealth(request, env) {
  const { response } = await requireAdmin(request, env);
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

  let scopes = null;
  let capabilities = null;
  const resend = wantEmail ? await checkResend(env) : null;
  if (ghl.ghlConfigured(env)) {
    const loc = env.GHL_DEFAULT_LOCATION_ID || '';
    if (wantScopes) scopes = await ghl.probeScopes(env, loc);
    if (wantFull) capabilities = await ghl.probeCapabilities(env, loc);
  }

  return json({
    ghl: {
      tokenPresent: Boolean(env.GHL_API_TOKEN),
      tokenLength: env.GHL_API_TOKEN ? String(env.GHL_API_TOKEN).length : 0,
      defaultLocationId: env.GHL_DEFAULT_LOCATION_ID || null,
      apiBase: env.GHL_API_BASE || null,
      apiVersion: env.GHL_API_VERSION || null,
    },
    email: {
      resendKeyPresent: Boolean(env.RESEND_API_KEY),
      mailFrom: env.MAIL_FROM || null,
      notifyEmail: env.NOTIFY_EMAIL || null,
      resend,
    },
    db: { ok: dbOk, users: userCount },
    // Whether the database has had every migration applied. Migrations here
    // are run by hand, so this is the one fact about the system that the
    // repository cannot tell you.
    schema,
    appUrl: env.APP_URL || null,
    // Which GHL areas this token can actually reach. Skipped unless asked for,
    // since it costs one API call per area.
    scopes,
    capabilities,
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

/** Admin only. Sync status for the default location. */
export async function handleSyncStatus(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const locationId = ghl.locationFor(env, user);
  return json({
    locationId,
    jobs: await listSyncState(env, locationId),
    counts: await db.crmCounts(env, locationId),
  });
}

/** Admin only. Runs a sync pass now. force=true restarts from scratch. */
export async function handleRunSync(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const body = await readJson(request);
  const locationId = ghl.locationFor(env, user);
  const result = await runSync(env, locationId, { force: Boolean(body.force) });
  await db.logActivity(env, user.id, 'admin.sync',
    body.force ? 'Started a full resync' : 'Ran a sync pass', result);
  return json({ ok: true, result, jobs: await listSyncState(env, locationId) });
}
