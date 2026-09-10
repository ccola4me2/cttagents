// Advisor accounts: signup, sign-in, sessions, password reset, and the
// helpers the router uses to gate pages.
//
// Access model: an advisor signs up, the account lands in 'pending', and an
// admin approves it before it can reach anything under /app. That is the same
// gate the CruiseShoppers advisor side uses.

import {
  json, badRequest, unauthorized, forbidden,
  cookieHeader, clearCookieHeader, parseCookies,
  hashPassword, verifyPassword, randomToken, sha256Hex,
  isValidEmail, normalizeEmail, clean, readJson,
} from './util.js';
import * as db from './db.js';
import { sendPasswordResetEmail } from './email.js';
import { required as billingRequired, writeState, exemptFromGate } from './billinggate.js';

export const SESSION_COOKIE = 'tv_session';

function sessionTtlSeconds(env) {
  const days = Number(env.SESSION_TTL_DAYS || 30);
  return (Number.isFinite(days) && days > 0 ? days : 30) * 86400;
}

function resetTtlSeconds(env) {
  const minutes = Number(env.RESET_TTL_MINUTES || 60);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60;
}

/** Public shape of a user. Never leaks password_hash. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
    phone: u.phone,
    agencyName: u.agency_name,
    role: u.role,
    status: u.status,
    ghlLocationId: u.ghl_location_id,
    ghlUserId: u.ghl_user_id,
    // Null, not 100. No agreement recorded is a different fact from an
    // agreement that the advisor keeps everything, and the admin screen has to
    // be able to tell them apart to show a blank field rather than a number
    // nobody typed.
    defaultSplitPct: u.default_split_pct === null || u.default_split_pct === undefined
      ? null : Number(u.default_split_pct),
    leadSplitPct: u.lead_split_pct === null || u.lead_split_pct === undefined
      ? null : Number(u.lead_split_pct),
    agencyAddress: u.agency_address,
    sellerOfTravel: u.seller_of_travel,
    // Where leads are announced, which is not always where they sign in.
    notifyEmail: u.notify_email,
    // Whether the portal chases their clients for payment on their behalf.
    autoRemindClients: Boolean(u.auto_remind_clients),
    // Whether Monday brings them the list of people nothing else is chasing.
    weeklyCallList: u.weekly_call_list === undefined ? true : Boolean(u.weekly_call_list),
    // Which agency they are in, and whether they run the portal itself.
    agencyId: u.agency_id || null,
    platformOwner: Boolean(u.platform_owner),
    // Written when an admin approves the account and read by nobody until
    // now, which made it a fact the database kept to itself.
    approvedAt: u.approved_at,
    lastLoginAt: u.last_login_at,
  };
}

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------
export async function getCurrentUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  return db.getSessionUser(env, await sha256Hex(token));
}

export function isAdmin(user) {
  return Boolean(user && user.role === 'admin' && user.status === 'active');
}

export function isActiveAdvisor(user) {
  return Boolean(user && user.status === 'active');
}

/** For API handlers: returns { user } or { response } to return immediately. */
export async function requireUser(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return { response: unauthorized() };
  if (user.status === 'pending') {
    return { response: forbidden('Your account is awaiting approval.') };
  }
  if (user.status !== 'active') {
    return { response: forbidden('This account is not active.') };
  }

  // An advisor whose membership has lapsed keeps reading and stops writing.
  //
  // Here rather than in the router because this is where the user is already
  // loaded, and one gate is easier to trust than a check repeated in ninety
  // handlers -- the one that gets forgotten is the one that matters. Reads
  // pass untouched, and the whole thing short-circuits to nothing while the
  // fee is not being enforced, so it costs no query until somebody turns it
  // on.
  if (request.method !== 'GET' && billingRequired(env)) {
    const path = new URL(request.url).pathname;
    if (!exemptFromGate(path)) {
      const state = writeState(env, user, await db.getBilling(env, user.id));
      if (!state.mayWrite) {
        return {
          response: json({
            error: 'Your portal membership is not current, so this account is read-only.',
            code: 'membership',
            reason: state.reason,
          }, 402),
        };
      }
    }
  }

  return { user };
}

export async function requireAdmin(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return { response };
  // One identity at a time. While acting as an advisor the session IS that
  // advisor, so isAdmin already says no; this says why, and stops the
  // ambiguous case where a suspension or a commission change gets made by a
  // session that reads as somebody else.
  if (user.acting_as) {
    return { response: forbidden('Stop working as an advisor before using the admin screens.') };
  }
  if (!isAdmin(user)) return { response: forbidden('Admin access required.') };
  return { user };
}

/**
 * The admin behind the session, whoever it is currently pretending to be.
 *
 * Used by the two handlers that have to work while acting: stopping, and
 * saying so on the page. Everything else wants the effective user and gets it
 * from requireUser without knowing any of this exists.
 */
export function realUserOf(user) {
  if (!user) return null;
  return {
    id: user.real_user_id,
    email: user.real_email,
    name: `${user.real_first_name || ''} ${user.real_last_name || ''}`.trim(),
    role: user.real_role,
    platformOwner: Boolean(user.real_platform_owner),
    agencyId: user.real_agency_id,
  };
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------
export async function handleLogin(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!email || !password) return badRequest('Email and password are required.');

  const row = await db.getUserForLogin(env, email);
  const ok = row ? await verifyPassword(password, row.password_hash) : false;
  if (!row || !ok) return json({ error: 'Email or password is incorrect.' }, 401);

  if (row.status === 'pending') {
    return json({ error: 'Your account is still awaiting approval.', status: 'pending' }, 403);
  }
  if (row.status !== 'active') {
    return json({ error: 'This account has been suspended.', status: row.status }, 403);
  }

  const token = randomToken(32);
  await db.createSession(env, row.id, await sha256Hex(token), sessionTtlSeconds(env));
  await db.setLastLogin(env, row.id);
  await db.logActivity(env, row.id, 'account.login', 'Signed in');

  return json(
    { ok: true, user: publicUser(row), redirect: row.role === 'admin' ? '/admin/' : '/app/' },
    200,
    { 'Set-Cookie': cookieHeader(SESSION_COOKIE, token, { maxAge: sessionTtlSeconds(env) }) }
  );
}

export async function handleLogout(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) await db.deleteSession(env, await sha256Hex(token));
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader(SESSION_COOKIE) });
}

export async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return json({ user: null }, 200);
  // `actingAs` is what the shell reads to put a banner across every page. It
  // has to be impossible to forget which account you are working in, because
  // the whole feature is that the portal behaves as though you are them.
  return json({
    user: publicUser(user),
    actingAs: user.acting_as
      ? { user: publicUser(user), admin: realUserOf(user) }
      : null,
  });
}

export async function handleUpdateProfile(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);
  const updated = await db.updateUserProfile(env, user.id, {
    firstName: clean(body.firstName, 80),
    lastName: clean(body.lastName, 80),
    phone: clean(body.phone, 40),
    agencyName: clean(body.agencyName, 120),
    // Both go on a client invoice. Several states require the registration
    // number on one, which is a reason to have somewhere to put it and not a
    // reason to invent one when it is blank.
    agencyAddress: clean(body.agencyAddress, 200),
    sellerOfTravel: clean(body.sellerOfTravel, 80),
    notifyEmail: clean(body.notifyEmail, 254),
    autoRemindClients: body.autoRemindClients === true || body.autoRemindClients === 'on',
    // Undefined rather than false when it is absent, so a save that never
    // heard of this switch leaves it where the advisor put it.
    weeklyCallList: body.weeklyCallList === undefined ? undefined
      : (body.weeklyCallList === true || body.weeklyCallList === 'on'),
  });
  return json({ ok: true, user: publicUser(updated) });
}

export async function handleChangePassword(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (next.length < 10) return badRequest('New password must be at least 10 characters.');

  const row = await db.getUserForLogin(env, user.email);
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    return badRequest('Current password is incorrect.');
  }

  await db.setUserPassword(env, user.id, await hashPassword(next));

  // Drop every existing session, then immediately issue a fresh one for the
  // device that made the change. Anyone signed in elsewhere is logged out,
  // which is the point, but the person who just changed their own password
  // does not get thrown out of the app they are standing in. Signing them out
  // too adds no security and turns a mistyped password into a lockout.
  await db.deleteUserSessions(env, user.id);
  const token = randomToken(32);
  await db.createSession(env, user.id, await sha256Hex(token), sessionTtlSeconds(env));

  await db.logActivity(env, user.id, 'account.password', 'Changed password');
  return json(
    { ok: true },
    200,
    { 'Set-Cookie': cookieHeader(SESSION_COOKIE, token, { maxAge: sessionTtlSeconds(env) }) }
  );
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------
export async function handleForgot(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  // Always the same answer, so this cannot be used to enumerate addresses.
  const answer = json({ ok: true });
  if (!isValidEmail(email)) return answer;

  const row = await db.getUserForLogin(env, email);
  if (!row || row.status === 'suspended') return answer;

  const token = randomToken(32);
  await db.createResetToken(env, row.id, await sha256Hex(token), resetTtlSeconds(env));
  await sendPasswordResetEmail(env, row, token);
  return answer;
}

export async function handleReset(request, env) {
  const body = await readJson(request);
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token) return badRequest('This reset link is invalid.');
  if (password.length < 10) return badRequest('Password must be at least 10 characters.');

  const userId = await db.consumeResetToken(env, await sha256Hex(token));
  if (!userId) return badRequest('This reset link has expired or already been used.');

  await db.setUserPassword(env, userId, await hashPassword(password));
  await db.deleteUserSessions(env, userId);
  await db.logActivity(env, userId, 'account.password', 'Reset password');
  return json({ ok: true });
}

export { publicUser };
