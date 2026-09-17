// D1 access layer. Everything that touches the database lives here so the
// route handlers stay readable and the SQL is in one place.
//
// Remember what D1 owns: portal accounts, sessions, and bookings. Contacts,
// opportunities and conversations are read live from GoHighLevel (see ghl.js)
// and are deliberately not mirrored here.

import { uid, now } from './util.js';
import { SPLIT_PCT_SQL, ADVISOR_SHARE_SQL, UNSPLIT_SQL, EARNED_SQL } from './split.js';

const USER_COLUMNS = `
  id, email, first_name, last_name, phone, agency_name, role, status,
  created_at, updated_at, last_login_at,
  approved_at, approved_by, default_split_pct, lead_split_pct,
  agency_address, seller_of_travel,
  notify_email, auto_remind_clients, weekly_call_list, call_list_sent_at,
  task_digest, alerts_feed, push_alerts, alerts_seen_at,
  -- The zone an advisor's day is in, and the address invites are
  -- forwarded to. Absent from here, zoneOf would have read undefined and
  -- quietly used the portal default for everybody, for ever.
  timezone, invite_token,
  agency_id, platform_owner
`;

// The same columns qualified, for the session lookup that joins sessions to
// users. A second hand written list of this table's columns is how a field
// added to the profile form saved correctly and then read back as null on
// every request: the write went to users, and the session query never learned
// the column existed. One list per table, and the column checker watches it.
const USER_COLUMNS_U = USER_COLUMNS.split(',')
  .map((c) => `u.${c.trim()}`).join(', ');

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export async function getUserById(env, id) {
  if (!id) return null;
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
}

/** Includes password_hash. Only for the sign-in path. */
export async function getUserForLogin(env, email) {
  if (!email) return null;
  return env.DB.prepare(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`
  ).bind(email).first();
}

export async function emailExists(env, email) {
  const row = await env.DB.prepare('SELECT 1 AS hit FROM users WHERE email = ?').bind(email).first();
  return Boolean(row);
}

export async function createUser(env, fields) {
  const ts = now();
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO users
       (id, email, password_hash, first_name, last_name, phone, agency_name,
        role, status, created_at, updated_at, agency_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    fields.email,
    fields.passwordHash,
    fields.firstName || null,
    fields.lastName || null,
    fields.phone || null,
    fields.agencyName || null,
    fields.role || 'advisor',
    fields.status || 'pending',
    ts,
    ts,
    fields.agencyId || null
  ).run();
  return getUserById(env, id);
}

/**
 * The address somebody signs in with.
 *
 * Its own function rather than a field on updateUserProfile, because it is the
 * only one that changes how an account is reached rather than how it reads.
 * Nothing else moves: not the password, not any session already open. This is
 * for the account created with a typo in the address, which until now could
 * not be signed into and could not be fixed.
 */
export async function setUserEmail(env, id, email) {
  await env.DB.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?')
    .bind(email, now(), id).run();
  return getUserById(env, id);
}

export async function updateUserProfile(env, id, fields) {
  await env.DB.prepare(
    `UPDATE users
        SET first_name = ?, last_name = ?, phone = ?, agency_name = ?,
            agency_address = ?, seller_of_travel = ?, notify_email = ?,
            -- Left alone when the caller did not mention it, the same as the
            -- three below. This one was not, and a save that never mentioned
            -- it turned off the reminders that chase clients for money.
            auto_remind_clients = COALESCE(?, auto_remind_clients),
            -- Left alone when the caller did not mention it. This one is on by
            -- default, so treating a missing field as false would let any save
            -- that predates the switch quietly turn it off.
            weekly_call_list = COALESCE(?, weekly_call_list),
            -- The same rule for all three: a save that does not mention a
            -- switch must not be a save that turns it off.
            task_digest = COALESCE(?, task_digest),
            alerts_feed = COALESCE(?, alerts_feed),
            push_alerts = COALESCE(?, push_alerts),
            updated_at = ?
      WHERE id = ?`
  ).bind(
    fields.firstName || null,
    fields.lastName || null,
    fields.phone || null,
    fields.agencyName || null,
    fields.agencyAddress || null,
    fields.sellerOfTravel || null,
    fields.notifyEmail || null,
    fields.autoRemindClients === undefined ? null : (fields.autoRemindClients ? 1 : 0),
    fields.weeklyCallList === undefined ? null : (fields.weeklyCallList ? 1 : 0),
    fields.taskDigest === undefined ? null : (fields.taskDigest ? 1 : 0),
    fields.alertsFeed === undefined ? null : (fields.alertsFeed ? 1 : 0),
    fields.pushAlerts === undefined ? null : (fields.pushAlerts ? 1 : 0),
    now(),
    id
  ).run();
  return getUserById(env, id);
}

export async function setUserPassword(env, id, passwordHash) {
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(passwordHash, now(), id).run();
}

export async function setLastLogin(env, id) {
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), id).run();
}

export async function listUsers(env, { status, role, agencyId } = {}) {
  const where = [];
  const binds = [];
  if (status) { where.push('status = ?'); binds.push(status); }
  if (role) { where.push('role = ?'); binds.push(role); }
  // Left out only by the platform operator, deliberately and in one place.
  if (agencyId) { where.push('agency_id = ?'); binds.push(agencyId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { results } = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users ${clause} ORDER BY created_at DESC LIMIT 500`
  ).bind(...binds).all();
  return results || [];
}

export async function setUserStatus(env, id, status, approvedBy = null) {
  const ts = now();
  if (status === 'active') {
    await env.DB.prepare(
      'UPDATE users SET status = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?'
    ).bind(status, ts, approvedBy, ts, id).run();
  } else {
    await env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .bind(status, ts, id).run();
  }
  return getUserById(env, id);
}

/** Bind an advisor to their own tenant partition. Admin only. */
/**
 * An advisor's standing share of the commission they bill.
 *
 * Null clears it, which puts them back on keeping all of it. Stored on the
 * advisor rather than copied onto their reservations, so changing the
 * agreement changes every trip that has not been given its own figure.
 */
export async function setUserSplit(env, id, pct, leadPct) {
  await env.DB.prepare(
    'UPDATE users SET default_split_pct = ?, lead_split_pct = ?, updated_at = ? WHERE id = ?'
  ).bind(pct, leadPct, now(), id).run();
  return getUserById(env, id);
}

// ---------------------------------------------------------------------------
// What an advisor pays for access
// ---------------------------------------------------------------------------
export async function getBilling(env, userId) {
  return env.DB.prepare(
    `SELECT user_id, stripe_customer_id, subscription_id, status,
            current_period_end, grace_until, updated_at,
            annual_subscription_id, annual_status, annual_period_end
       FROM advisor_billing WHERE user_id = ?`
  ).bind(userId).first();
}

/** By customer, for the webhook, which knows Stripe's ids and not ours. */
export async function getBillingByCustomer(env, customerId) {
  return env.DB.prepare(
    `SELECT user_id, stripe_customer_id, subscription_id, status,
            current_period_end, grace_until, updated_at,
            annual_subscription_id, annual_status, annual_period_end
       FROM advisor_billing WHERE stripe_customer_id = ?`
  ).bind(customerId).first();
}

export async function saveBilling(env, userId, f) {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO advisor_billing
       (user_id, stripe_customer_id, subscription_id, status, current_period_end,
        grace_until, updated_at, annual_subscription_id, annual_status, annual_period_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       stripe_customer_id = COALESCE(excluded.stripe_customer_id, advisor_billing.stripe_customer_id),
       subscription_id    = COALESCE(excluded.subscription_id, advisor_billing.subscription_id),
       status             = excluded.status,
       current_period_end = excluded.current_period_end,
       grace_until        = excluded.grace_until,
       updated_at         = excluded.updated_at,
       annual_subscription_id = COALESCE(excluded.annual_subscription_id,
                                         advisor_billing.annual_subscription_id),
       annual_status      = COALESCE(excluded.annual_status, advisor_billing.annual_status),
       annual_period_end  = COALESCE(excluded.annual_period_end,
                                     advisor_billing.annual_period_end)`
  ).bind(userId, f.stripeCustomerId || null, f.subscriptionId || null,
    f.status || 'none', f.currentPeriodEnd || null, f.graceUntil || null, ts,
    f.annualSubscriptionId || null, f.annualStatus || null,
    f.annualPeriodEnd || null).run();
  return getBilling(env, userId);
}

export async function countUsers(env, { agencyId } = {}) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
     FROM users WHERE role = 'advisor'${agencyId ? ' AND agency_id = ?' : ''}`
  ).bind(...(agencyId ? [agencyId] : [])).first();
  return { total: row?.total || 0, pending: row?.pending || 0, active: row?.active || 0 };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export async function createSession(env, userId, tokenHash, ttlSeconds) {
  const ts = now();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(tokenHash, userId, ts, ts + ttlSeconds).run();
}

/**
 * Who this request is, and who is really behind it.
 *
 * `u` is the effective user: the advisor when an admin is acting as one, and
 * otherwise the person who signed in. Every handler downstream reads that and
 * needs no idea any of this is happening, which is the point -- ownership,
 * the agency fence and the CRM lookups all keep working unchanged.
 *
 * The columns prefixed `real_` are the account that actually signed in. They
 * exist so two things can still be decided correctly: whether the admin
 * screens are allowed (they are not, while acting), and who to name in the
 * log. When nobody is acting, the two are the same row.
 */
export async function getSessionUser(env, tokenHash) {
  if (!tokenHash) return null;
  return env.DB.prepare(
    `SELECT ${USER_COLUMNS_U},
            s.acting_as AS acting_as,
            ru.id AS real_user_id,
            ru.email AS real_email,
            ru.first_name AS real_first_name,
            ru.last_name AS real_last_name,
            ru.role AS real_role,
            ru.platform_owner AS real_platform_owner,
            ru.agency_id AS real_agency_id
       FROM sessions s
       JOIN users u ON u.id = COALESCE(s.acting_as, s.user_id)
       JOIN users ru ON ru.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`
  ).bind(tokenHash, now()).first();
}

/** Start or stop acting as somebody. Null puts the admin back in their own seat. */
export async function setSessionActingAs(env, tokenHash, userId) {
  await env.DB.prepare('UPDATE sessions SET acting_as = ? WHERE id = ?')
    .bind(userId || null, tokenHash).run();
}

export async function deleteSession(env, tokenHash) {
  if (!tokenHash) return;
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run();
}

export async function deleteUserSessions(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export async function purgeExpiredSessions(env) {
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()).run();
}

// ---------------------------------------------------------------------------
// Password resets
// ---------------------------------------------------------------------------
export async function createResetToken(env, userId, tokenHash, ttlSeconds) {
  const ts = now();
  await env.DB.prepare(
    'INSERT INTO password_reset_tokens (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(tokenHash, userId, ts, ts + ttlSeconds).run();
}

/** Returns the user id if the token is valid and unused, and marks it used. */
export async function consumeResetToken(env, tokenHash) {
  const row = await env.DB.prepare(
    'SELECT user_id FROM password_reset_tokens WHERE id = ? AND used = 0 AND expires_at > ?'
  ).bind(tokenHash, now()).first();
  if (!row) return null;
  await env.DB.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').bind(tokenHash).run();
  return row.user_id;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------
//
// Two kinds of account use this portal.
//
//   An agency owner is an admin. They see every advisor's reservations,
//   payments and production, and can break any report down by advisor. An
//   independent advisor working alone is also an admin, where "everyone"
//   happens to be just them, so the same code covers both without a setting.
//
//   An advisor associate sees their own records and nothing else.
//
// The scope is always derived from the signed in user. An advisor id in the
// query string is honoured only when the caller is an admin, so asking for
// someone else's data is not a matter of editing a URL.

/**
 * Resolves what the signed in user may see.
 *
 * The widening used to be by GoHighLevel sub-account, falling back to a
 * default when an advisor had none. That worked while there was one agency and
 * broke the moment there were two: an agency with no sub-account of its own
 * landed on the same default as every other one, and their books merged. The
 * fence is the agency now, which is a row rather than a fallback.
 *
 * An owner with no agency sees only themselves. It should not happen after the
 * migration, and if it ever does the answer is too little rather than too much.
 */
export function visibilityScope(env, user, advisorId = null) {
  const agencyId = user.agency_id || null;
  if (user.role !== 'admin' || !agencyId) {
    return { all: false, userId: user.id, agencyId, self: true };
  }
  if (advisorId && advisorId !== 'all') {
    return { all: false, userId: advisorId, agencyId, self: advisorId === user.id };
  }
  return { all: true, agencyId, userId: user.id, self: false };
}

/** The scope for a request, honouring ?advisor= only for admins. */
export function scopeFor(env, user, request) {
  const advisorId = new URL(request.url).searchParams.get('advisor');
  return visibilityScope(env, user, advisorId);
}

/**
 * This user and no one else, whatever their role.
 *
 * Every write goes through one of these. An owner may see an advisor's
 * reservation; that is not the same as writing to it, and using the viewing
 * scope on a write is how the two would quietly become one permission.
 */
export function selfScope(user) {
  return { all: false, userId: user.id, self: true };
}

/**
 * The whole agency, whatever the reader's role.
 *
 * The one thing that is not somebody's private record. A supplier directory is
 * an agency asset: the commission rate somebody negotiated, the desk contact,
 * how to book them. Held per advisor it left a new joiner staring at an empty
 * screen and rebuilding it from scratch, slightly differently, which is where
 * three spellings of Carnival came from.
 *
 * Falls back to the reader alone when they are in no agency, the same way
 * visibilityScope does, so the failure mode is a short list rather than
 * somebody else's book.
 */
export function agencyScope(user) {
  if (!user.agency_id) return { all: false, userId: user.id, agencyId: null, self: true };
  return { all: true, agencyId: user.agency_id, userId: user.id, self: false };
}

/**
 * How the UI should describe the current scope.
 *
 * Every screen that can show more than your own records says whose they are.
 * A total that silently covers the whole agency looks exactly like a total
 * that covers you, and the difference is the whole point of the number.
 */
export function scopeLabel(scope, user) {
  // viewerId so the picker can tell "an advisor's records" from "my own", and
  // offer to work as them only in the first case.
  // Not while acting as somebody. requireAdmin refuses for the whole of that
  // stretch, so an owner sitting in a colleague's seat who was still offered
  // the picker would get a Work as button that answers "stop working as an
  // advisor first". One seat at a time, and the screen says so by having one.
  const base = { canPick: user.role === 'admin' && !user.acting_as, viewerId: user.id };
  if (scope.all) return { ...base, all: true, advisorId: null, label: 'All advisors' };
  if (scope.self) return { ...base, all: false, advisorId: user.id, label: 'Just me' };
  return { ...base, all: false, advisorId: scope.userId, label: 'One advisor' };
}

/**
 * The advisors an owner may narrow a screen to. Empty for an associate, whose
 * only scope is themselves, so the picker never appears for them.
 */
export async function advisorOptions(env, user) {
  if (user.role !== 'admin') return [];
  // Their own agency, never the platform. This list is the scope picker on a
  // dozen screens, and unfiltered it named every advisor on the portal to
  // every owner on it.
  const users = await listUsers(env, { agencyId: user.agency_id });
  return users
    .filter((u) => u.status === 'active')
    .map((u) => ({
      id: u.id,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
      role: u.role,
      // So the picker can offer Work as for everybody it would actually work
      // for, and withhold it on the one account it would not.
      platformOwner: Boolean(u.platform_owner),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The scope as a WHERE fragment plus its binds. */
/**
 * Whether an advisor's own trips count towards the figures.
 *
 * Brent's answer to "does personal travel count towards production" was that
 * it can, but not always: booking your own holiday through the agency does
 * earn real commission, and it is also not the client production a target is
 * usually about. So neither answer is hard-coded. The caller decides, the
 * default leaves personal travel out, and the reports say which they are
 * showing rather than leaving the reader to guess.
 */
export function personalFilter(includePersonal, alias = '') {
  if (includePersonal) return '';
  return ` AND ${alias ? `${alias}.` : ''}personal = 0`;
}

export function scopeWhere(scope, column = 'user_id') {
  if (!scope.all) return { sql: `${column} = ?`, binds: [scope.userId] };
  // Every advisor in this agency. Written as a subquery rather than a list of
  // ids so it stays one statement however many advisors there are, and so an
  // advisor added mid-request cannot fall outside it.
  //
  // A widened scope with no agency behind it would match every user whose
  // agency is also null, which is the whole platform. It narrows to the reader
  // instead: the fence failing shut is a screen with too little on it, and
  // failing open is one agency reading another's book.
  if (!scope.agencyId) return { sql: `${column} = ?`, binds: [scope.userId] };
  return {
    sql: `${column} IN (SELECT id FROM users WHERE agency_id = ?)`,
    binds: [scope.agencyId],
  };
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
// Falls back to the email so a row is never attributed to nobody.
const ADVISOR_NAME =
  "COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS advisor_name";

/**
 * What the vendor is still waiting for on a reservation, for a list that has to
 * decide whether it is at risk without loading its schedule.
 *
 * Hard rows only. A soft row is this portal's own reminder to chase, and a
 * reminder nobody needs any more is not the vendor waiting. The count comes
 * back as well as the total, because no schedule at all and a schedule with
 * nothing left on it are different facts and nought would tell them apart.
 *
 * What is posted comes back too, so a list can work out the quiet number the
 * reservation page already shows: the trip cost that is on no payment row at
 * all, neither taken nor planned. Nothing chases that, because there is
 * nothing there to chase.
 */
const OWING_SQL = `
  COALESCE((SELECT SUM(p.amount_cents) FROM booking_payments p
             WHERE p.booking_id = b.id AND p.payment_class = 'hard'
               AND p.paid_date IS NULL), 0) AS owing_cents,
  COALESCE((SELECT SUM(p.amount_cents) FROM booking_payments p
             WHERE p.booking_id = b.id AND p.payment_class = 'hard'
               AND p.paid_date IS NOT NULL), 0) AS paid_cents,
  (SELECT COUNT(*) FROM booking_payments p
     WHERE p.booking_id = b.id AND p.payment_class = 'hard') AS hard_rows`;

const BOOKING_COLUMNS = `
  id, user_id, ghl_contact_id, ghl_opportunity_id, client_name, supplier,
  product_type, product_name, destination, confirmation_number, depart_date,
  return_date, deposit_due, final_payment_due, travellers, gross_cents, deposit_cents,
  commission_cents, commission_status, status, notes, group_id, client_id, vendor_id,
  cabin, cabin_category, itinerary, booking_method, insurance_status, advisor_split_pct,
  agreed_split_pct, agreed_lead_split_pct,
  quote_sent_at, quote_sent_count, statement_sent_at, welcomed_at,
  invoice_no, invoice_issued_at, invoice_notes, personal,
  created_at, updated_at, share_code, shared_at, statement_hash, lead_source,
  itinerary_shared, options_open,
  viewed_first_at, viewed_last_at, view_count
`;

// The same columns qualified, for the queries that join users to name the
// advisor. Derived rather than written out a second time. The old copy was
// spelled out on the grounds that id and status exist on both tables and an
// unqualified one would be an error waiting to happen, which is true and is
// exactly what prefixing every column prevents. What a second hand written
// list actually bought was the chance to fall behind the first, which is how
// the session lookup spent an afternoon reading two profile fields as null.
const BOOKING_COLUMNS_B = BOOKING_COLUMNS.split(',').map((c) => `b.${c.trim()}`).join(', ');

/**
 * How many rows a list hands back, and why there is one more.
 *
 * These lists are read whole by the page and filtered there, which works
 * until a book outgrows the cap. Past it the page filters an answer that is
 * already missing the row somebody is looking for, and nothing says so: a
 * search for a client who exists comes back empty and reads as lost data.
 *
 * Every list asks for one row more than it will return. If that row arrives,
 * the list was cut, and the page can say so instead of quietly lying.
 */
export const LIST_CAP = 500;
export const CLIENT_CAP = 500;

/**
 * How many rows to ask for: what was requested, never more than the cap, plus
 * one to see past it.
 *
 * The plus one is the whole mechanism, and the first version of this got it
 * wrong in a way that looked right. The lists defaulted to fewer rows than the
 * cap, so the probe row was never inside the limit, and every list reported
 * itself complete while returning two hundred of a possible thousand.
 */
export function pageSize(limit, cap = LIST_CAP) {
  return Math.min(Number(limit) || cap, cap);
}

export function takeWithProbe(limit, cap = LIST_CAP) {
  return pageSize(limit, cap) + 1;
}

/**
 * Take what was asked for, and say whether there was more behind it.
 *
 * Sliced to the size that was actually requested rather than to the cap. An
 * earlier version always sliced to the cap, so asking for two rows returned
 * three and reported the answer complete: the probe row came back and nothing
 * looked at it.
 */
export function capped(rows, limit, cap = LIST_CAP) {
  const all = rows || [];
  const size = pageSize(limit, cap);
  return { rows: all.slice(0, size), truncated: all.length > size };
}

export async function listBookings(env, scope, { status, search, limit } = {}) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (status) { where.push('b.status = ?'); binds.push(status); }
  if (search) {
    where.push('(b.client_name LIKE ? OR b.supplier LIKE ? OR b.product_name LIKE ? OR b.confirmation_number LIKE ?)');
    const like = `%${search}%`;
    binds.push(like, like, like, like);
  }
  binds.push(takeWithProbe(limit));
  const { results } = await env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS_B}, ${ADVISOR_NAME}, ${OWING_SQL}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC, b.created_at DESC
      LIMIT ?`
  ).bind(...binds).all();
  return results || [];
}

export async function getBooking(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = ? AND user_id = ?`
  ).bind(id, userId).first();
}

/**
 * A reservation without asking whose it is.
 *
 * Only for the admin path that has to reach an advisor's booking. The caller
 * is responsible for the agency fence, which is why this is named for what it
 * skips rather than sitting behind the ordinary getBooking.
 */
export async function getBookingUnscoped(env, id) {
  // The LIMIT is not for the database, which is looking up a primary key. It
  // makes this statement distinguishable from the scoped getBooking above,
  // whose SQL this would otherwise be a prefix of, so the line excusing it in
  // check-scope.mjs cannot silently excuse some future unscoped lookup too.
  return env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = ? LIMIT 1`
  ).bind(id).first();
}

/**
 * Which tables a write may be resolved through.
 *
 * Written out rather than derived, because the table name is interpolated into
 * the statement below and a name that came from anywhere near a request would
 * be a hole.
 */
const WRITABLE = new Set([
  // A reservation and everything hanging off one.
  'bookings', 'booking_payments', 'booking_pricing', 'quote_options',
  'penalty_tiers', 'documents', 'components', 'travellers', 'amenities',
  'itinerary_items', 'trip_messages',
  // The book behind it: the people, the households they sit in, the groups
  // they travel with, and the money owed either way.
  'clients', 'households', 'travel_groups', 'group_registrations',
  'client_credits', 'commission_statements', 'commission_receipts',
  // The work: a checklist item under a task, the deals an advisor publishes,
  // the enquiries those pull, a saved list and a mailing.
  'task_items', 'specials', 'special_leads', 'segments', 'broadcasts',
  // Deliberately not here, each for its own reason rather than by oversight:
  //
  //   vendors and itinerary_library are already the agency's, so there is
  //   nothing left to widen.
  //
  //   user_prefs is which columns somebody hid on a screen, and
  //   hotlist_actions is which row they put away until Thursday. Both are one
  //   person working rather than a record of anything, and reaching into them
  //   would change an advisor's screen while they were looking at it.
  //
  //   task_templates already has a narrower rule of its own for the shared
  //   ones, and it stays.
]);

/**
 * Who a write belongs to, which is not always who is making it.
 *
 * An advisor writes to their own records and nobody else's. An agency owner
 * may also write to anything belonging to anybody in their own agency: they
 * are the person who fixes a wrong date on a Saturday while the advisor is on
 * a ship with no signal, and a portal where the owner can read that record and
 * not correct it is a portal the correction gets made outside of.
 *
 * Anybody, including another owner. The question this asks is which agency a
 * record is in, never what rank its holder is, so two owners of one agency
 * reach each other's work the same way either reaches an associate's. An
 * agency with two people running it should not need one of them to be the
 * only person who can fix their own typo.
 *
 * What it returns is the holder, not the caller. The row stays whose it was:
 * the reservation, the commission and the production all belong to the person
 * who sold it, and somebody else touching it is a correction, not a transfer.
 * Every caller writes as the returned user, and logs the real one alongside,
 * so the activity line says who actually did it.
 *
 * Null means "not yours", which every caller turns into the same not found it
 * would have given before. A reader who may not have it is not told it exists.
 *
 * The agency fence is in the statement rather than in JavaScript after it. A
 * fence held by an if is a fence somebody edits around; this one cannot return
 * a row from another agency to forget to check.
 */
export async function writerFor(env, user, table, id) {
  if (!id) return null;
  if (!WRITABLE.has(table)) throw new Error(`writerFor: ${table} is not a reservation table`);
  // An owner with no agency is an independent advisor working alone, whose
  // agency is themselves. Widening on a null agency_id would match every user
  // whose agency is also null, which is the failing-open case scopeWhere warns
  // about, so the flag is off unless there is an agency to be inside.
  const mayWiden = user.role === 'admin' && user.agency_id ? 1 : 0;
  const row = await env.DB.prepare(
    `SELECT t.user_id AS user_id FROM ${table} t
       JOIN users u ON u.id = t.user_id
      WHERE t.id = ? AND (t.user_id = ? OR (? = 1 AND u.agency_id = ?))`
  ).bind(id, user.id, mayWiden, user.agency_id || '').first();
  if (!row) return null;
  return row.user_id === user.id ? user : getUserById(env, row.user_id);
}

/**
 * The same question asked about a reservation, which is the common case.
 *
 * Separate so the callers that have a booking id read as what they are, and so
 * the table name is written once rather than at forty call sites.
 */
export async function writerForBooking(env, user, bookingId) {
  return writerFor(env, user, 'bookings', bookingId);
}

/**
 * The same question asked about a task, which is narrower on purpose.
 *
 * Somebody's own to-do list is their own. An owner can already read the whole
 * agency's tasks board, and being able to read it is not a licence to tick
 * things off it: "ring the dentist" is not agency business.
 *
 * A task hanging off a reservation is different. It is part of the work on
 * that trip, and an owner who may correct the trip may tick off the thing the
 * trip was waiting for. So the widening is borrowed from the reservation
 * rather than granted to tasks, and a task on no reservation stays private.
 */
export async function writerForTask(env, user, taskId) {
  if (!taskId) return null;
  const own = await env.DB.prepare(
    'SELECT user_id FROM tasks WHERE id = ? AND user_id = ?'
  ).bind(taskId, user.id).first();
  if (own) return user;
  const linked = await env.DB.prepare(
    'SELECT booking_id FROM tasks WHERE id = ? AND user_id <> ? AND booking_id IS NOT NULL'
  ).bind(taskId, user.id).first();
  if (!linked) return null;
  return writerForBooking(env, user, linked.booking_id);
}

/**
 * Names the person who actually made a change, when it was not their record.
 *
 * The line goes in the advisor's own activity, because it is their reservation
 * and they are the one who needs to know it moved. Without the name it reads
 * as something they did and forgot, which is worse than no line at all.
 */
export function byHand(message, actor, owner) {
  if (!actor || !owner || actor.id === owner.id) return message;
  const who = [actor.first_name, actor.last_name].filter(Boolean).join(' ') || actor.email;
  return `${message}, by ${who}`;
}

/**
 * May this reader change this record?
 *
 * For the page, which needs the answer before it draws a button rather than
 * after somebody presses one. Takes a row already loaded through the read
 * scope, which is agency-fenced, so a reader who can see it is a reader who is
 * inside its agency and no second query is needed to prove it. That is the
 * whole reason this can be a plain function while writerFor has to be a query.
 */
export function mayWrite(user, row) {
  if (!row) return false;
  if (row.user_id === user.id) return true;
  return user.role === 'admin' && Boolean(user.agency_id);
}

/** The two fields that decide how a commission divides. Admin path only. */
export async function setBookingSplit(env, id, { advisorSplitPct, leadSource }) {
  await env.DB.prepare(
    'UPDATE bookings SET advisor_split_pct = ?, lead_source = ?, updated_at = ? WHERE id = ?'
  ).bind(advisorSplitPct, leadSource, now(), id).run();
  return getBookingUnscoped(env, id);
}

/**
 * The agreement is stamped here, in the insert, rather than worked out by the
 * caller and passed in.
 *
 * Four places create a reservation and a fifth creates one from a deal, and a
 * rule that every one of them has to remember is a rule one of them will not.
 * Read straight off the advisor's row in the same statement, it cannot be
 * forgotten and cannot disagree with itself.
 *
 * Copied as it stands, nulls included. No agreement recorded is not an
 * agreement that the advisor keeps everything: freezing it as 100 would mean an
 * advisor who sells before their agreement is written down keeps the lot on
 * those trips for ever, silently, and that is the usual order of an onboarding.
 * A null here falls through to the advisor's record, which is where an
 * agreement that has not been reached yet belongs. See 0074_agreed_split.sql.
 */
const AGREED_SPLIT_SQL = `
  (SELECT u.default_split_pct FROM users u WHERE u.id = ?),
  (SELECT u.lead_split_pct FROM users u WHERE u.id = ?)`;

export async function createBooking(env, userId, f) {
  const ts = now();
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO bookings
       (id, user_id, ghl_contact_id, ghl_opportunity_id, client_name, supplier,
        product_type, product_name, destination, confirmation_number,
        depart_date, return_date, deposit_due, final_payment_due, travellers,
        gross_cents, deposit_cents, commission_cents, commission_status, status, notes,
        group_id, client_id, vendor_id, cabin, cabin_category, itinerary,
        booking_method, insurance_status, advisor_split_pct, personal, created_at, updated_at,
        agreed_split_pct, agreed_lead_split_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ${AGREED_SPLIT_SQL})`
  ).bind(
    id, userId, f.ghlContactId || null, f.ghlOpportunityId || null,
    f.clientName, f.supplier || null, f.productType, f.productName || null,
    f.destination || null, f.confirmationNumber || null,
    f.departDate, f.returnDate, f.depositDue, f.finalPaymentDue,
    f.travellers, f.grossCents, f.depositCents || 0, f.commissionCents, f.commissionStatus,
    f.status, f.notes || null, f.groupId || null, f.clientId || null, f.vendorId || null,
    f.cabin || null, f.cabinCategory || null, f.itinerary || null, f.bookingMethod || null,
    f.insuranceStatus || 'unknown', f.advisorSplitPct == null ? null : f.advisorSplitPct,
    f.personal ? 1 : 0, ts, ts,
    userId, userId
  ).run();
  return getBooking(env, id, userId);
}

export async function updateBooking(env, id, userId, f) {
  const res = await env.DB.prepare(
    `UPDATE bookings SET
       ghl_contact_id = ?, ghl_opportunity_id = ?, client_name = ?, supplier = ?,
       product_type = ?, product_name = ?, destination = ?, confirmation_number = ?,
       depart_date = ?, return_date = ?, deposit_due = ?, final_payment_due = ?,
       travellers = ?, gross_cents = ?, deposit_cents = ?, commission_cents = ?, commission_status = ?,
       status = ?, notes = ?, group_id = ?, client_id = ?, vendor_id = ?,
       cabin = ?, cabin_category = ?, itinerary = ?, booking_method = ?,
       insurance_status = ?, advisor_split_pct = ?, personal = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(
    f.ghlContactId || null, f.ghlOpportunityId || null, f.clientName, f.supplier || null,
    f.productType, f.productName || null, f.destination || null, f.confirmationNumber || null,
    f.departDate, f.returnDate, f.depositDue, f.finalPaymentDue,
    f.travellers, f.grossCents, f.depositCents || 0, f.commissionCents, f.commissionStatus,
    f.status, f.notes || null, f.groupId || null, f.clientId || null, f.vendorId || null,
    f.cabin || null, f.cabinCategory || null, f.itinerary || null, f.bookingMethod || null,
    f.insuranceStatus || 'unknown', f.advisorSplitPct == null ? null : f.advisorSplitPct,
    f.personal ? 1 : 0, now(), id, userId
  ).run();
  if (!res.meta || res.meta.changes === 0) return null;
  return getBooking(env, id, userId);
}

export async function deleteBooking(env, id, userId) {
  const res = await env.DB.prepare('DELETE FROM bookings WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  return Boolean(res.meta && res.meta.changes > 0);
}

/** Headline numbers for the dashboard and the reports page. */
export async function bookingStats(env, scope) {
  const scoped = scopeWhere(scope, 'b.user_id');
  // Joined to users so the advisor's standing split can be applied. The
  // commission figure is what the vendor pays the agency; the share is what
  // the person reading the screen actually keeps, and for an associate on a
  // split those are not the same number.
  // Read through EARNED_SQL, so a reservation marked "no commission" adds
  // nothing to anybody's column, the agency's included.
  const earned = EARNED_SQL('b.commission_cents', 'b.commission_status');
  const share = ADVISOR_SHARE_SQL(earned,
    SPLIT_PCT_SQL(),
    UNSPLIT_SQL('b.id'));
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN b.status = 'booked' THEN 1 ELSE 0 END) AS booked,
       SUM(CASE WHEN b.status = 'quoted' THEN 1 ELSE 0 END) AS quoted,
       SUM(CASE WHEN b.status = 'travelled' THEN 1 ELSE 0 END) AS travelled,
       SUM(CASE WHEN b.status IN ('booked','travelled') THEN b.gross_cents ELSE 0 END) AS gross_cents,
       SUM(CASE WHEN b.status IN ('booked','travelled') THEN ${earned} ELSE 0 END) AS commission_cents,
       SUM(CASE WHEN b.status IN ('booked','travelled') THEN ${share} ELSE 0 END) AS commission_share_cents,
       SUM(CASE WHEN b.commission_status = 'paid' THEN ${earned} ELSE 0 END) AS commission_paid_cents,
       SUM(CASE WHEN b.commission_status = 'paid' THEN ${share} ELSE 0 END) AS commission_paid_share_cents
     FROM bookings b LEFT JOIN users u ON u.id = b.user_id WHERE ${scoped.sql}`
  ).bind(...scoped.binds).first();
  return {
    total: row?.total || 0,
    booked: row?.booked || 0,
    quoted: row?.quoted || 0,
    travelled: row?.travelled || 0,
    grossCents: row?.gross_cents || 0,
    commissionCents: row?.commission_cents || 0,
    commissionShareCents: row?.commission_share_cents || 0,
    commissionPaidCents: row?.commission_paid_cents || 0,
    commissionPaidShareCents: row?.commission_paid_share_cents || 0,
  };
}

/**
 * Payments falling due on or before `through`, newest deadline first.
 *
 * Reads the payment schedule rather than the booking's own date columns. Those
 * columns say when a deadline is, not whether it has been met, so a dashboard
 * built on them keeps showing money as due after it has been paid.
 */
export async function upcomingPayments(env, scope, through) {
  const scoped = scopeWhere(scope, 'p.user_id');
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.kind, p.payment_class, p.amount_cents, p.due_date,
            b.id AS booking_id, b.client_name, b.supplier, b.product_name,
            b.depart_date, b.status
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE ${scoped.sql}
        AND p.paid_date IS NULL
        AND p.due_date IS NOT NULL
        AND p.due_date <= ?
        AND b.status IN ('quoted','booked')
      ORDER BY p.due_date ASC
      LIMIT 50`
  ).bind(...scoped.binds, through).all();
  return results || [];
}

/** Gross and commission grouped by departure month, for the reports chart. */
export async function productionByMonth(env, scope, sinceDate, { includePersonal = false } = {}) {
  const scoped = scopeWhere(scope);
  const { results } = await env.DB.prepare(
    `SELECT substr(depart_date, 1, 7) AS month,
            COUNT(*) AS bookings,
            SUM(gross_cents) AS gross_cents,
            SUM(${EARNED_SQL('commission_cents', 'commission_status')}) AS commission_cents
       FROM bookings
      WHERE ${scoped.sql} AND depart_date IS NOT NULL AND depart_date >= ?
        AND status IN ('booked','travelled')${personalFilter(includePersonal)}
      GROUP BY month ORDER BY month ASC LIMIT 36`
  ).bind(...scoped.binds, sinceDate).all();
  return results || [];
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
/**
 * Production broken down by advisor, for an owner looking at the agency.
 *
 * Active advisors with nothing booked still appear, at zero. An owner asking
 * who is producing needs to see the quiet ones, and a report that silently
 * omits them answers a different question from the one being asked.
 *
 * A suspended advisor appears only if they produced something in the window.
 * Their past production is real and belongs in the total, but a row of zeros
 * for someone who no longer works here is noise, not information.
 */
export async function productionByAdvisor(env, scope, sinceDate, { includePersonal = false } = {}) {
  const scoped = scopeWhere(scope, 'u.id');
  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, ${ADVISOR_NAME}, u.role, u.status,
            COUNT(b.id) AS bookings,
            COALESCE(SUM(b.gross_cents), 0) AS gross_cents,
            COALESCE(SUM(${EARNED_SQL('b.commission_cents', 'b.commission_status')}), 0) AS commission_cents,
            COALESCE(SUM(CASE WHEN b.commission_status = 'paid'
              THEN ${EARNED_SQL('b.commission_cents', 'b.commission_status')} END), 0)
              AS commission_paid_cents,
            -- What this advisor keeps, and what the agency keeps out of what
            -- they billed. An owner reading a combined report needs both: the
            -- agency is owed the whole commission and pays out only part of it.
            COALESCE(SUM(${ADVISOR_SHARE_SQL(EARNED_SQL('b.commission_cents', 'b.commission_status'),
              SPLIT_PCT_SQL(), UNSPLIT_SQL('b.id'))}), 0)
              AS advisor_share_cents,
            u.default_split_pct, u.lead_split_pct
       FROM users u
       LEFT JOIN bookings b
         ON b.user_id = u.id
        AND b.status IN ('booked','travelled')${personalFilter(includePersonal, 'b')}
        AND b.depart_date IS NOT NULL AND b.depart_date >= ?
      WHERE ${scoped.sql} AND u.status != 'pending'
      GROUP BY u.id
      HAVING u.status = 'active' OR COUNT(b.id) > 0
      ORDER BY gross_cents DESC, advisor_name ASC`
  ).bind(sinceDate, ...scoped.binds).all();
  // The agency's share is the remainder, never its own rounded figure, so an
  // advisor's share and the agency's always add back to the commission.
  return (results || []).map((r) => ({
    ...r, agency_share_cents: (r.commission_cents || 0) - (r.advisor_share_cents || 0),
  }));
}

/**
 * One reservation, readable by anyone whose scope covers it.
 *
 * Deliberately separate from getBooking, which stays scoped to the owner
 * because every write goes through it. Seeing an advisor's reservation and
 * editing it are different permissions, and merging the two lookups is how
 * they would quietly become the same one.
 */
export async function getBookingInScope(env, id, scope) {
  const scoped = scopeWhere(scope, 'b.user_id');
  return env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS_B}, ${ADVISOR_NAME}, u.default_split_pct, u.lead_split_pct
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).first();
}

/**
 * Booked value split by what was sold, and by whom it was sold through.
 *
 * Two questions an owner actually asks: what mix are we selling, and which
 * vendors are we sending business to. Both are one grouped query, so they are
 * one function with the grouping column chosen rather than two near copies.
 */
export async function productionBreakdown(env, scope, sinceDate, by = 'type') {
  const column = by === 'vendor' ? "COALESCE(NULLIF(supplier, ''), 'Unrecorded')" : 'product_type';
  const scoped = scopeWhere(scope);
  const { results } = await env.DB.prepare(
    `SELECT ${column} AS label,
            COUNT(*) AS bookings,
            SUM(gross_cents) AS gross_cents,
            SUM(${EARNED_SQL('commission_cents', 'commission_status')}) AS commission_cents
       FROM bookings
      WHERE ${scoped.sql} AND depart_date IS NOT NULL AND depart_date >= ?
        AND status IN ('booked','travelled')
      GROUP BY label ORDER BY gross_cents DESC LIMIT 20`
  ).bind(...scoped.binds, sinceDate).all();
  return results || [];
}

/**
 * Trips where insurance was never discussed.
 *
 * insurance_status has had four values since the day travellers stopped being
 * a headcount, and one of them, "unknown", means nobody has asked. It has been
 * stored on every reservation and shown on none but its own, which makes it a
 * field an advisor fills in for nobody.
 *
 * The reason to surface it is not sales. Declined is already a different fact
 * from not asked, kept apart deliberately, because if something goes wrong on
 * a trip the difference between "they turned it down" and "nobody raised it"
 * is the advisor's whole position. This lists the second one while there is
 * still time to make it the first.
 *
 * Ordered by departure, soonest first, because that is the order the chance to
 * do anything about it runs out.
 */
export async function insuranceExposure(env, scope, { today, limit = 20 } = {}) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.final_payment_due, b.gross_cents, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql}
        AND b.status IN ('quoted','booked')
        AND (b.insurance_status IS NULL OR b.insurance_status = 'unknown')
        AND b.depart_date IS NOT NULL AND b.depart_date >= ?
      ORDER BY b.depart_date ASC
      LIMIT ?`
  ).bind(...scoped.binds, today, Math.min(Number(limit) || 20, 100)).all();

  return (results || []).map((b) => ({
    ...b,
    days_to_departure: Math.round(
      (Date.parse(`${b.depart_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000),
    // Whether the vendor's own deadline has already gone. Reported as a fact
    // about this reservation rather than a claim about what any insurer will
    // accept, which varies by policy and is not this software's to assert.
    past_final_payment: Boolean(b.final_payment_due && b.final_payment_due < today),
  }));
}

/**
 * Clients who are back and have not been rung.
 *
 * The call after a trip is where reviews, referrals and the next booking come
 * from. It is also the easiest one to skip, because nothing goes wrong when
 * you do: no vendor cancels anything, no deadline passes, the client simply
 * drifts and books with somebody else next year.
 *
 * A window rather than everybody who has ever travelled. Ringing about a
 * holiday somebody had eight months ago is a different conversation, and it
 * belongs on the rebooking list rather than this one.
 */
/**
 * The dates on the books, as calendar entries.
 *
 * Departures, returns and money due are already recorded on reservations, and
 * were nowhere near the calendar: an advisor looking at their week saw
 * GoHighLevel appointments and none of the travel those appointments were
 * about. These are derived on read rather than written into GoHighLevel as
 * appointments, because a departure date that moves would leave a stale
 * appointment behind and nothing to reconcile it against. The reservation is
 * the fact; the calendar entry is a view of it.
 */
export async function travelDates(env, scope, { from, to }) {
  const scoped = scopeWhere(scope, 'b.user_id');

  const { results: trips } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.product_name, b.supplier, b.personal,
            b.depart_date, b.return_date, b.confirmation_number
       FROM bookings b
      WHERE ${scoped.sql}
        AND b.status IN ('quoted','booked','travelled')
        AND ((b.depart_date IS NOT NULL AND b.depart_date BETWEEN ? AND ?)
          OR (b.return_date IS NOT NULL AND b.return_date BETWEEN ? AND ?))
      LIMIT 400`
  ).bind(...scoped.binds, from, to, from, to).all();

  const paymentScope = scopeWhere(scope, 'p.user_id');
  const { results: due } = await env.DB.prepare(
    `SELECT p.id, p.booking_id, p.kind, p.amount_cents, p.due_date,
            b.client_name, b.product_name, b.supplier
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id AND b.user_id = p.user_id
      WHERE ${paymentScope.sql}
        AND p.paid_date IS NULL
        AND p.payment_class = 'hard'
        AND p.due_date BETWEEN ? AND ?
        AND b.status IN ('quoted','booked')
      LIMIT 400`
  ).bind(...paymentScope.binds, from, to).all();

  const events = [];
  for (const t of trips || []) {
    const label = t.product_name || t.supplier || 'Trip';
    if (t.depart_date >= from && t.depart_date <= to) {
      events.push({
        source: 'reservation', kind: 'departure', date: t.depart_date,
        bookingId: t.id, title: `${t.client_name} departs`, detail: label,
        personal: Boolean(t.personal), reference: t.confirmation_number || null,
      });
    }
    if (t.return_date && t.return_date >= from && t.return_date <= to) {
      events.push({
        source: 'reservation', kind: 'return', date: t.return_date,
        bookingId: t.id, title: `${t.client_name} home`, detail: label,
        personal: Boolean(t.personal), reference: t.confirmation_number || null,
      });
    }
  }
  for (const d of due || []) {
    events.push({
      source: 'reservation', kind: 'payment', date: d.due_date,
      bookingId: d.booking_id, paymentId: d.id,
      title: `${d.client_name}: ${d.kind === 'deposit' ? 'deposit' : 'payment'} due`,
      detail: d.product_name || d.supplier || '', amountCents: d.amount_cents,
    });
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

export async function welcomeHomeCandidates(env, scope, { today, days = 30, limit = 20 } = {}) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000)
    .toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.return_date, b.depart_date,
            b.gross_cents, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql}
        AND b.status = 'travelled'
        AND b.personal = 0
        AND b.welcomed_at IS NULL
        AND COALESCE(b.return_date, b.depart_date) IS NOT NULL
        AND COALESCE(b.return_date, b.depart_date) <= ?
        AND COALESCE(b.return_date, b.depart_date) >= ?
      ORDER BY COALESCE(b.return_date, b.depart_date) DESC
      LIMIT ?`
  ).bind(...scoped.binds, today, from, Math.min(Number(limit) || 20, 100)).all();

  const nowMs = Date.parse(`${today}T00:00:00Z`);
  return (results || []).map((b) => ({
    ...b,
    back_days: Math.round((nowMs - Date.parse(`${b.return_date || b.depart_date}T00:00:00Z`)) / 86400000),
  }));
}

/**
 * Every proposal that is still a question.
 *
 * A proposal is not a record type here: it is a reservation in the quoted
 * state with options on it, and until now there was no way to see them
 * together. The reservation list showed them among everything else, and the
 * dashboard showed the ones nobody had answered in a week. Neither answers
 * the question an advisor actually has on a Monday, which is "what have I got
 * out, and which of them is waiting on me rather than on them".
 *
 * Every field this needs was already being written down. Nothing here is new
 * data: it is the first time anybody looked at it in one place.
 */
export async function proposals(env, scope, { limit = 200 } = {}) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS_B}, ${ADVISOR_NAME},
            (SELECT COUNT(*) FROM quote_options o
              WHERE o.booking_id = b.id) AS option_count,
            (SELECT COUNT(*) FROM quote_options o
              WHERE o.booking_id = b.id AND o.chosen = 1) AS chosen_count,
            (SELECT o.label FROM quote_options o
              WHERE o.booking_id = b.id AND o.chosen = 1 LIMIT 1) AS chosen_label,
            (SELECT o.chosen_at FROM quote_options o
              WHERE o.booking_id = b.id AND o.chosen = 1 LIMIT 1) AS chosen_at,
            (SELECT o.chosen_by FROM quote_options o
              WHERE o.booking_id = b.id AND o.chosen = 1 LIMIT 1) AS chosen_by
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql} AND b.status = 'quoted'
      ORDER BY COALESCE(b.quote_sent_at, b.shared_at, b.created_at) ASC
      LIMIT ?`
  ).bind(...scoped.binds, takeWithProbe(limit)).all();
  return results || [];
}

/**
 * Quotes sitting with no answer.
 *
 * The largest quiet leak in travel sales, and the one nothing in this portal
 * could see until the documents started recording that they had been sent. A
 * quote is not a task, so it never appeared on the to do list; it is not a
 * booking, so it never appeared in production; and the reservation looked the
 * same the day it went out and a month later.
 *
 * Two states, because they call for different things. One has been sent and
 * ignored, which is a follow-up. The other was never sent at all, which is a
 * quote somebody wrote and forgot, and no amount of chasing the client fixes
 * it.
 */
export async function quoteFollowUps(env, scope, { quietDays = 7, limit = 20 } = {}) {
  const scoped = scopeWhere(scope, 'b.user_id');
  // Seconds. Every timestamp column in this database is written by now(),
  // which is seconds, and mixing in a Date.now() milliseconds figure here
  // would put the cut-off fifty thousand years in the future and return every
  // quote ever written as overdue.
  const nowSec = now();
  const quietBefore = nowSec - quietDays * 86400;

  const { results } = await env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS_B}, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql} AND b.status = 'quoted'
        AND (b.quote_sent_at IS NULL OR b.quote_sent_at < ?)
      ORDER BY COALESCE(b.quote_sent_at, b.created_at) ASC
      LIMIT ?`
  ).bind(...scoped.binds, quietBefore, Math.min(Number(limit) || 20, 100)).all();

  return (results || []).map((b) => ({
    ...b,
    state: b.quote_sent_at ? 'waiting' : 'unsent',
    quiet_days: b.quote_sent_at ? Math.floor((nowSec - b.quote_sent_at) / 86400) : null,
  }));
}

/**
 * A trip whose return date has passed has been travelled.
 *
 * "Travelled" was a status nothing ever set. It could only be reached by an
 * advisor opening each reservation after each holiday and changing it by
 * hand, which nobody does, so the count on the reports screen sat at zero
 * next to Booked and Quoted and quietly said that none of these people had
 * ever gone anywhere.
 *
 * Only booked trips move. A cancelled one stays cancelled, and a quote that
 * was never taken is not a holiday somebody had.
 *
 * Written one advisor at a time rather than as a single sweeping UPDATE, so
 * every write in this codebase still names the user whose rows it changes.
 * The batch is bounded because this runs on a cron every few minutes: a
 * backlog clears over a few passes rather than in one long transaction.
 */
export async function markReturnedTripsTravelled(env, { today, limit = 200 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id FROM bookings
      WHERE status = 'booked'
        AND COALESCE(return_date, depart_date) IS NOT NULL
        AND COALESCE(return_date, depart_date) < ?
      ORDER BY COALESCE(return_date, depart_date) ASC
      LIMIT ?`
  ).bind(today, Math.min(Number(limit) || 200, 500)).all();

  const byUser = new Map();
  for (const row of results || []) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.id);
  }

  let moved = 0;
  for (const [userId, ids] of byUser) {
    const marks = ids.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `UPDATE bookings SET status = 'travelled', updated_at = ?
        WHERE user_id = ? AND status = 'booked' AND id IN (${marks})`
    ).bind(now(), userId, ...ids).run();
    const changed = res.meta ? res.meta.changes || 0 : 0;
    moved += changed;
    if (changed) {
      await logActivity(env, userId, 'booking.travelled',
        `${changed} trip${changed === 1 ? '' : 's'} marked travelled, the return date having passed`,
        { count: changed });
    }
  }

  return moved;
}

/**
 * Clients worth ringing: they have travelled with you and have nothing booked.
 *
 * The most reliable rebooking signal an agency has, and the one nobody acts on
 * because it is invisible. A client who came back from a cruise eleven months
 * ago and has nothing on the books is not a lapsed client yet; they are a
 * client about to book with somebody else.
 *
 * Matched on client name rather than a contact id, because reservations are
 * often entered before the CRM record exists and the name is the only thing
 * both records reliably share.
 */
export async function rebookCandidates(env, scope, { today, before, limit = 25 } = {}) {
  const scoped = scopeWhere(scope, 'b.user_id');
  // How long ago they got back before it counts as a lead. The dashboard wants
  // everyone with nothing on the books; the call list wants the ones who have
  // been quiet a while, which is the same question with the line moved.
  const cutoff = before || today;
  const { results } = await env.DB.prepare(
    `SELECT b.user_id, b.client_name, ${ADVISOR_NAME},
            MAX(c.id) AS client_id, MAX(c.email) AS email, MAX(c.phone) AS phone,
            MAX(COALESCE(b.return_date, b.depart_date)) AS last_travelled,
            COUNT(*) AS trips,
            SUM(b.gross_cents) AS lifetime_cents,
            MAX(b.supplier) AS last_vendor
       FROM bookings b
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN clients c ON c.user_id = b.user_id AND c.name = b.client_name
      WHERE ${scoped.sql}
        AND b.status IN ('booked','travelled')
        -- Not your own holiday. This list is people to ring about booking
        -- again, and ringing yourself is not a lead.
        AND b.personal = 0
        AND COALESCE(b.return_date, b.depart_date) IS NOT NULL
        AND COALESCE(b.return_date, b.depart_date) < ?
      -- By advisor as well as by name. Grouping on the name alone folded two
      -- advisors' clients who happen to share one into a single row, which is
      -- only visible when an owner looks across the agency and is wrong every
      -- time it happens.
      GROUP BY b.user_id, b.client_name
      HAVING NOT EXISTS (
        SELECT 1 FROM bookings f
         WHERE f.client_name = b.client_name
           AND f.user_id = b.user_id
           AND f.status IN ('quoted','booked')
           AND COALESCE(f.return_date, f.depart_date) >= ?)
      ORDER BY last_travelled DESC LIMIT ?`
  ).bind(...scoped.binds, cutoff, today, Math.min(Number(limit) || 25, 500)).all();
  return results || [];
}

/**
 * Everything with a date on it, for one month.
 *
 * Departures, returns, vendor deadlines, own reminders, task due dates and the
 * day a group's unsold space goes back. Six queries rather than one union so
 * each keeps its own columns and its own scope column, and because a union of
 * six differently shaped tables is unreadable a month after writing it.
 *
 * Read only and cheap: each is an indexed range scan over one month.
 */
/**
 * Open tasks falling in a window, for the calendar's run of days.
 *
 * calendarMonth answers the same question for a whole month across five kinds
 * of thing at once. This is the narrow version, because the calendar screen
 * already has its departures and its money from elsewhere and only needs the
 * tasks.
 */
export async function openTasksBetween(env, scope, { from, to }) {
  const t = scopeWhere(scope, 't.user_id');
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.notes, t.due_date, t.due_time, t.priority, t.kind
       FROM tasks t
      WHERE ${t.sql} AND t.done_at IS NULL AND t.due_date BETWEEN ? AND ?
      ORDER BY t.due_date ASC, COALESCE(t.due_time, '99:99') ASC`
  ).bind(...t.binds, from, to).all();
  return results || [];
}

/**
 * Where every live reservation stands, as pipeline stages.
 *
 * The Sales opportunities board reads the CRM, and a reservation taken in
 * this portal is not in the CRM, so the board sat empty while the book of
 * business filled up. The stages it showed, inquiry, quote sent, deposit
 * paid, final payment due, were already facts on the reservation: the status,
 * whether a quote was sent, whether the deposit is posted, whether the
 * balance is due or paid.
 *
 * So this derives rather than syncs. A copy pushed into the CRM at creation
 * would be right on the day it was made and drift from then on, and would
 * need somebody to remember to drag a card every time money arrived. A
 * derived stage cannot disagree with the reservation it came from, because it
 * is read from it.
 */
/**
 * What became of the reservations raised in a window.
 *
 * Created in the window, by what they are now. There is no column recording
 * when a reservation closed, so "closed this year" cannot be answered and is
 * not claimed: this is the intake of the window and what came of it.
 *
 * Quotes still open are counted apart. Silence is not a loss, and a rate that
 * treats it as one reads as decisive when it is only unknown.
 */
export async function closedSince(env, scope, sinceIso) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN b.status IN ('booked','travelled') THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN b.status IN ('booked','travelled') THEN COALESCE(b.gross_cents,0) ELSE 0 END)
         AS won_cents,
       SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END) AS lost,
       SUM(CASE WHEN b.status = 'quoted' THEN 1 ELSE 0 END) AS still_open
     FROM bookings b
     WHERE ${scoped.sql} AND b.created_at >= ?`
  ).bind(...scoped.binds, Math.floor(Date.parse(`${sinceIso}T00:00:00Z`) / 1000))
    .first().catch(() => null);

  const won = Number(row?.won || 0);
  const lost = Number(row?.lost || 0);
  const decided = won + lost;
  return {
    won,
    wonValue: Math.round(Number(row?.won_cents || 0) / 100),
    lost,
    abandoned: Number(row?.still_open || 0),
    // Null rather than nought when nothing has been decided either way: a
    // closing rate of 0% and no data at all are different things.
    closingRate: decided ? Math.round((won / decided) * 100) : null,
  };
}

export const RESERVATION_STAGES = [
  { id: 'inquiry', name: 'Inquiry' },
  { id: 'quote_sent', name: 'Quote sent' },
  { id: 'deposit_due', name: 'Booked, deposit due' },
  { id: 'deposit_paid', name: 'Deposit paid' },
  { id: 'final_due', name: 'Final payment due' },
  { id: 'final_paid', name: 'Paid in full' },
  { id: 'travelling', name: 'Away now' },
  { id: 'travelled', name: 'Home' },
];

export async function reservationPipeline(env, scope, today) {
  const b = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.status, b.gross_cents,
            b.depart_date, b.return_date, b.final_payment_due, b.quote_sent_at,
            b.ghl_contact_id,
            -- Hard rows only, like every other money total. A soft row is the
            -- same balance ten days early, so counting a paid one would carry a
            -- reservation to "paid in full" on half the money.
            COALESCE((SELECT SUM(p.amount_cents) FROM booking_payments p
                       WHERE p.booking_id = b.id AND p.kind = 'deposit'
                         AND p.payment_class = 'hard'
                         AND p.paid_date IS NOT NULL), 0) AS deposit_paid_cents,
            COALESCE((SELECT SUM(p.amount_cents) FROM booking_payments p
                       WHERE p.booking_id = b.id AND p.payment_class = 'hard'
                         AND p.paid_date IS NOT NULL), 0) AS paid_cents
       FROM bookings b
      WHERE ${b.sql} AND b.status IN ('quoted', 'booked', 'travelled')
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC
      LIMIT 500`
  ).bind(...b.binds).all();

  return (results || []).map((r) => ({
    id: r.id,
    // The same shape the CRM cards use, so the board renders both without
    // knowing which it is looking at.
    name: [r.client_name, r.product_name || r.supplier].filter(Boolean).join(' · '),
    status: 'open',
    stageId: stageOf(r, today),
    pipelineId: 'reservations',
    monetaryValue: Math.round((r.gross_cents || 0) / 100),
    contactId: r.ghl_contact_id || null,
    contactName: r.client_name || '',
    href: `/app/reservation?id=${r.id}`,
    departDate: r.depart_date || null,
  }));
}

function stageOf(r, today) {
  if (r.status === 'travelled') return 'travelled';
  if (r.status === 'quoted') return r.quote_sent_at ? 'quote_sent' : 'inquiry';

  // Booked. Away now beats every money stage: where the client physically is
  // outranks what the ledger says about them.
  if (r.depart_date && r.depart_date <= today
      && (!r.return_date || r.return_date >= today)) return 'travelling';

  if (!r.deposit_paid_cents) return 'deposit_due';
  if (r.gross_cents && r.paid_cents >= r.gross_cents) return 'final_paid';
  if (r.final_payment_due && r.final_payment_due <= today) return 'final_due';
  return 'deposit_paid';
}

export async function calendarMonth(env, scope, { from, to }) {
  const b = scopeWhere(scope, 'b.user_id');
  const p = scopeWhere(scope, 'p.user_id');
  const t = scopeWhere(scope, 't.user_id');
  const g = scopeWhere(scope, 'g.user_id');
  const a = scopeWhere(scope, 'a.user_id');
  const c = scopeWhere(scope, 'c.user_id');

  const [departs, returns, payments, tasks, options, appts, leadSteps] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id, b.depart_date AS on_date, b.client_name, b.supplier
         FROM bookings b WHERE ${b.sql} AND b.status IN ('quoted','booked','travelled')
          AND b.depart_date BETWEEN ? AND ?`
    ).bind(...b.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT b.id, b.return_date AS on_date, b.client_name, b.supplier
         FROM bookings b WHERE ${b.sql} AND b.status IN ('quoted','booked','travelled')
          AND b.return_date BETWEEN ? AND ?`
    ).bind(...b.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT p.id, p.due_date AS on_date, p.payment_class, p.kind, p.amount_cents,
              b.client_name, b.supplier
         FROM booking_payments p JOIN bookings b ON b.id = p.booking_id
        WHERE ${p.sql} AND p.paid_date IS NULL AND p.due_date BETWEEN ? AND ?`
    ).bind(...p.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT t.id, t.due_date AS on_date, t.due_time, t.title, t.priority
         FROM tasks t WHERE ${t.sql} AND t.done_at IS NULL AND t.due_date BETWEEN ? AND ?`
    ).bind(...t.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT g.id, g.option_date AS on_date, g.name, g.vendor, g.cabins_held,
              (SELECT COUNT(*) FROM bookings x WHERE x.group_id = g.id
                AND x.status IN ('quoted','booked','travelled')) AS cabins_sold
         FROM travel_groups g WHERE ${g.sql} AND g.status = 'open'
          AND g.option_date BETWEEN ? AND ?`
    ).bind(...g.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT a.id, a.on_date, a.start_time, a.end_time, a.title, a.location,
              cl.name AS client_name
         FROM appointments a
         LEFT JOIN clients cl ON cl.id = a.client_id
        WHERE ${a.sql} AND a.cancelled_at IS NULL AND a.on_date BETWEEN ? AND ?`
    ).bind(...a.binds, from, to).all().catch(() => ({ results: [] })),

    // Somebody who has booked is off the lead board on their own, so they are
    // off this too: the follow-up date stopped mattering when the trip existed.
    env.DB.prepare(
      `SELECT c.id, c.lead_next_step_on AS on_date, c.name, c.lead_next_step
         FROM clients c
        WHERE ${c.sql} AND c.lead_stage IS NOT NULL
          AND c.lead_next_step_on BETWEEN ? AND ?
          AND NOT EXISTS (SELECT 1 FROM bookings x
                           WHERE x.client_id = c.id AND x.status IN ('booked','travelled'))`
    ).bind(...c.binds, from, to).all().catch(() => ({ results: [] })),
  ]);

  const appointmentRows = appts.results || [];
  const leadRows = leadSteps.results || [];

  const out = [];
  for (const r of appointmentRows) {
    const when = [r.start_time, r.end_time].filter(Boolean).join(' to ');
    out.push({ date: r.on_date, kind: 'appointment', title: r.title,
               detail: [when, r.client_name, r.location].filter(Boolean).join(' · '),
               href: '/app/calendar' });
  }
  for (const r of leadRows) {
    out.push({ date: r.on_date, kind: 'lead', title: r.lead_next_step || `Follow up with ${r.name}`,
               detail: r.name, href: '/app/leads' });
  }
  for (const r of departs.results || []) {
    out.push({ date: r.on_date, kind: 'depart', title: r.client_name,
               detail: `Departs${r.supplier ? ' · ' + r.supplier : ''}`, href: '/app/reservation?id=' + r.id });
  }
  for (const r of returns.results || []) {
    out.push({ date: r.on_date, kind: 'return', title: r.client_name,
               detail: `Returns${r.supplier ? ' · ' + r.supplier : ''}`, href: '/app/reservation?id=' + r.id });
  }
  for (const r of payments.results || []) {
    out.push({ date: r.on_date, kind: r.payment_class === 'hard' ? 'hard' : 'soft',
               title: r.client_name, amountCents: r.amount_cents,
               detail: r.payment_class === 'hard' ? `${r.kind} due to vendor` : `chase ${r.kind}`,
               href: '/app/payments' });
  }
  for (const r of tasks.results || []) {
    out.push({ date: r.on_date, at: r.due_time || null, kind: 'task', title: r.title,
               detail: r.priority === 'high' ? 'high priority' : 'task', href: '/app/tasks' });
  }
  for (const r of options.results || []) {
    const left = Math.max(0, (r.cabins_held || 0) - (r.cabins_sold || 0));
    out.push({ date: r.on_date, kind: 'option', title: r.name,
               detail: `${left} unsold cabin${left === 1 ? '' : 's'} released`, href: '/app/groups' });
  }

  // Within a day, the things with a clock on them come first and in order.
  // A departure or a vendor deadline has no time of day, so it sits after the
  // appointments and tasks rather than being given a fictional 00:00.
  out.sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    if (x.at && y.at) return x.at < y.at ? -1 : x.at > y.at ? 1 : 0;
    if (x.at) return -1;
    if (y.at) return 1;
    return 0;
  });
  return out;
}

// Two ways to count a year, and they answer different questions.
//
//   By departure is when the travel happens, which is when commission is
//   earned and when the money actually arrives.
//   By purchase is when the booking was taken, which is what this month's
//   selling actually produced.
//
// An agency needs both. A quiet selling month with a busy departure month
// looks healthy on one and alarming on the other, and only the pair tells you
// which. created_at is unix seconds, so the purchase basis converts it rather
// than comparing an integer to an ISO date, which silently matches nothing.
const BASIS_COLUMN = {
  departure: 'depart_date',
  purchase: "date(created_at, 'unixepoch')",
};

export async function periodTotals(env, scope, basis, from, to, { includePersonal = false } = {}) {
  const scoped = scopeWhere(scope);
  const col = BASIS_COLUMN[basis] || BASIS_COLUMN.departure;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS bookings,
            COALESCE(SUM(gross_cents), 0) AS gross_cents,
            COALESCE(SUM(${EARNED_SQL('commission_cents', 'commission_status')}), 0) AS commission_cents
       FROM bookings
      WHERE ${scoped.sql} AND status IN ('booked','travelled')${personalFilter(includePersonal)}
        AND ${col} IS NOT NULL AND ${col} BETWEEN ? AND ?`
  ).bind(...scoped.binds, from, to).first();
  return {
    bookings: row?.bookings || 0,
    grossCents: row?.gross_cents || 0,
    commissionCents: row?.commission_cents || 0,
  };
}

/** A percentage change, or null when there is no base to compare against. */
function change(now, prev) {
  if (!prev) return null;
  return Math.round(((now - prev) / prev) * 1000) / 10;
}

/**
 * This year against the same days last year, on both bases.
 *
 * Deliberately the same days rather than the whole of last year: comparing
 * eight months against twelve makes every year look like a collapse.
 */
export async function salesComparison(env, scope, today, { includePersonal = false } = {}) {
  const [y, m, dd] = today.split('-').map(Number);
  const ranges = {
    mtd: [`${today.slice(0, 7)}-01`, today],
    ytd: [`${y}-01-01`, today],
  };
  const lastYear = ([from, to]) => [
    `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`,
    `${y - 1}${to.slice(4)}`,
  ];

  const out = {};
  for (const basis of ['departure', 'purchase']) {
    out[basis] = {};
    for (const [key, range] of Object.entries(ranges)) {
      const prevRange = lastYear(range);
      const [now, prev] = await Promise.all([
        periodTotals(env, scope, basis, range[0], range[1], { includePersonal }),
        periodTotals(env, scope, basis, prevRange[0], prevRange[1], { includePersonal }),
      ]);
      out[basis][key] = {
        from: range[0], to: range[1], prevFrom: prevRange[0], prevTo: prevRange[1],
        now, prev,
        change: {
          gross: change(now.grossCents, prev.grossCents),
          commission: change(now.commissionCents, prev.commissionCents),
          bookings: change(now.bookings, prev.bookings),
        },
      };
    }
  }
  return out;
}

/**
 * The three numbers behind whether the selling is any good, as opposed to
 * merely busy. Each is defined here rather than left to the reader, because a
 * rate nobody can define is a rate nobody should act on.
 */
export async function salesMix(env, scope, { from, to, includePersonal = false }) {
  const scoped = scopeWhere(scope);
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT client_name) AS clients,
            COUNT(*) AS bookings,
            COALESCE(SUM(gross_cents), 0) AS gross_cents,
            -- A client counts as insured if any of their reservations in the
            -- window is an insurance line, since insurance is sold as its own
            -- booking rather than as a field on the trip.
            COUNT(DISTINCT CASE WHEN product_type = 'insurance' THEN client_name END) AS insured,
            COUNT(DISTINCT CASE WHEN product_type != 'insurance' THEN client_name END) AS travellers
       FROM bookings
      WHERE ${scoped.sql} AND status IN ('booked','travelled')${personalFilter(includePersonal)}
        AND depart_date IS NOT NULL AND depart_date BETWEEN ? AND ?`
  ).bind(...scoped.binds, from, to).first();

  const repeat = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT client_name FROM bookings
        WHERE ${scoped.sql} AND status IN ('booked','travelled')${personalFilter(includePersonal)}
        GROUP BY client_name HAVING COUNT(*) > 1)`
  ).bind(...scoped.binds).first();

  const allClients = await env.DB.prepare(
    `SELECT COUNT(DISTINCT client_name) AS n FROM bookings
      WHERE ${scoped.sql} AND status IN ('booked','travelled')`
  ).bind(...scoped.binds).first();

  const travellers = row?.travellers || 0;
  const clients = allClients?.n || 0;
  return {
    clients: row?.clients || 0,
    bookings: row?.bookings || 0,
    // Per client rather than per booking: one client buying a cruise, a
    // transfer and insurance is one customer worth three lines, not three
    // customers worth one.
    avgSpendCents: row?.clients ? Math.round((row.gross_cents || 0) / row.clients) : 0,
    insuranceAttach: travellers ? Math.round(((row.insured || 0) / travellers) * 1000) / 10 : null,
    repeatRate: clients ? Math.round(((repeat?.n || 0) / clients) * 1000) / 10 : null,
    repeatClients: repeat?.n || 0,
    totalClients: clients,
  };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
//
// A reservation still carries client_name, because that is what people type
// and what vendors put on a confirmation. resolveClient turns that name into a
// record, creating one the first time it is seen. Nothing in the forms had to
// change: the record appears as a side effect of doing the work.

const CLIENT_COLUMNS = `
  c.id, c.user_id, c.name, c.email, c.phone, c.notes, c.ghl_contact_id,
  c.birthday, c.anniversary, c.household_id, c.pinned_at, c.created_at, c.updated_at,
  c.legal_first, c.legal_middle, c.legal_last, c.gender, c.citizenship,
  c.passport_number, c.passport_country, c.passport_issued, c.passport_expiry,
  c.address1, c.address2, c.city, c.state, c.postcode, c.country,
  c.loyalty_json, c.known_traveler, c.redress, c.nickname, c.source,
  c.source_kind, c.referred_by_client_id,
  c.lead_stage, c.lead_at, c.lead_asked_about, c.lead_next_step, c.lead_next_step_on
`;

/** The client record for a name, made if it is new. Null for a blank name. */
export async function resolveClient(env, userId, name, { ghlContactId } = {}) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) return null;

  const existing = await env.DB.prepare(
    'SELECT id, ghl_contact_id FROM clients WHERE user_id = ? AND name = ?'
  ).bind(userId, clean).first();

  if (existing) {
    // A reservation that knows the CRM contact teaches the client record,
    // which is how a locally created client eventually gets linked up.
    if (ghlContactId && !existing.ghl_contact_id) {
      // Kept catching, and this one is deliberate: it is an opportunistic
      // backfill on the way past, and failing to link a CRM id should not fail
      // the reservation somebody was actually trying to save.
      await env.DB.prepare('UPDATE clients SET ghl_contact_id = ?, updated_at = ? WHERE id = ?')
        .bind(ghlContactId, now(), existing.id).run().catch(() => {});
    }
    return existing.id;
  }

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO clients (id, user_id, name, ghl_contact_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, clean, ghlContactId || null, ts, ts).run();

  // Re-read rather than trusting the insert: two requests naming the same new
  // client at once would otherwise leave one of them holding an id that lost
  // the race and was ignored.
  const row = await env.DB.prepare(
    'SELECT id FROM clients WHERE user_id = ? AND name = ?'
  ).bind(userId, clean).first();
  return row ? row.id : null;
}

export async function listClients(env, scope, { query, pinnedOnly, limit } = {}) {
  const scoped = scopeWhere(scope, 'c.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (pinnedOnly) where.push('c.pinned_at IS NOT NULL');
  if (query) {
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)');
    const like = `%${query}%`;
    binds.push(like, like, like);
  }

  const { results } = await env.DB.prepare(
    `SELECT ${CLIENT_COLUMNS},
            (SELECT COUNT(*) FROM bookings b WHERE b.client_id = c.id
              AND b.status IN ('booked','travelled')) AS trips,
            (SELECT COALESCE(SUM(b.gross_cents), 0) FROM bookings b WHERE b.client_id = c.id
              AND b.status IN ('booked','travelled')) AS lifetime_cents,
            (SELECT MAX(COALESCE(b.return_date, b.depart_date)) FROM bookings b
              WHERE b.client_id = c.id AND b.status IN ('booked','travelled')) AS last_date,
            (SELECT MIN(b.depart_date) FROM bookings b WHERE b.client_id = c.id
              AND b.status IN ('quoted','booked') AND b.depart_date >= date('now')) AS next_date,
            (SELECT h.name FROM households h WHERE h.id = c.household_id) AS household_name
       FROM clients c
      WHERE ${where.join(' AND ')}
      ORDER BY c.pinned_at IS NULL ASC, c.pinned_at ASC, lifetime_cents DESC
      LIMIT ?`
  ).bind(...binds, takeWithProbe(limit, CLIENT_CAP)).all();
  return results || [];
}

/**
 * Every name, email and CRM id already on somebody's client list, agency-wide.
 *
 * Used to decide which CRM contacts are strangers. The question is "has
 * anybody here booked this person", which is deliberately wider than "whose
 * records am I looking at": a contact a colleague booked last year is not a
 * new face, and offering to create a second record for them is how one person
 * becomes two. Widened through scopeWhere rather than by dropping the
 * predicate, so an agency still cannot see past its own fence.
 */
export async function clientKeys(env, scope) {
  const wide = scopeWhere({ all: true, agencyId: scope.agencyId, userId: scope.userId });
  const { results } = await env.DB.prepare(
    `SELECT name, email, ghl_contact_id FROM clients WHERE ${wide.sql}`
  ).bind(...wide.binds).all();

  const keys = new Set();
  for (const r of results || []) {
    if (r.name) keys.add(r.name.trim().toLowerCase());
    if (r.email) keys.add(r.email.trim().toLowerCase());
    if (r.ghl_contact_id) keys.add(r.ghl_contact_id);
  }
  return keys;
}

export async function getClient(env, scope, { id, name }) {
  const scoped = scopeWhere(scope, 'c.user_id');
  const sql = `SELECT ${CLIENT_COLUMNS} FROM clients c
                WHERE ${scoped.sql} AND ${id ? 'c.id = ?' : 'c.name = ?'} LIMIT 1`;
  return env.DB.prepare(sql).bind(...scoped.binds, id || name).first();
}

export async function logActivity(env, userId, kind, subject, meta = null) {
  try {
    await env.DB.prepare(
      'INSERT INTO activity_log (id, user_id, kind, subject, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(uid(), userId, kind, subject || null, meta ? JSON.stringify(meta) : null, now()).run();
  } catch (e) {
    // Activity logging must never break the request that triggered it.
    console.error('logActivity', e);
  }
}

export async function recentActivity(env, scope, limit = 15) {
  const scoped = scopeWhere(scope);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.kind, a.subject, a.meta_json, a.created_at, ${ADVISOR_NAME}
       FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${scopeWhere(scope, 'a.user_id').sql}
      ORDER BY a.created_at DESC LIMIT ?`
  ).bind(...scoped.binds, Math.min(Number(limit) || 15, 100)).all();

  // Every activity line has been written with the id of the thing it happened
  // to, and the feed has never been able to take you there. Unpacked here
  // rather than handed to the page as JSON, so a malformed row costs one
  // missing link instead of a thrown render.
  // Two shapes in the history, because the booking handlers logged { id } and
  // everything else logged { bookingId }. Both are read rather than one of
  // them corrected: the rows already written cannot be changed, and a reader
  // that only understands today's shape would silently drop every link older
  // than the fix.
  return (results || []).map((a) => {
    let bookingId = null;
    try {
      const meta = JSON.parse(a.meta_json || '{}');
      bookingId = meta.bookingId || (String(a.kind || '').startsWith('booking.') ? meta.id : null) || null;
    } catch { bookingId = null; }
    return { id: a.id, kind: a.kind, subject: a.subject, created_at: a.created_at,
      advisor_name: a.advisor_name, booking_id: bookingId };
  });
}

// ---------------------------------------------------------------------------
// Local CRM mirror
//
// Reads come from here rather than the upstream API, so a list renders in a
// few milliseconds and keeps rendering when the upstream is rate limiting or
// down. The sync module keeps these current.
// ---------------------------------------------------------------------------
function hydrateContact(row) {
  if (!row) return null;
  let tags = [];
  try { tags = row.tags_json ? JSON.parse(row.tags_json) : []; } catch { tags = []; }
  return {
    id: row.id,
    name: row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || 'Unnamed contact',
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email || '',
    phone: row.phone || '',
    source: row.source || '',
    tags: Array.isArray(tags) ? tags : [],
    assignedTo: row.assigned_to || null,
    city: row.city || '',
    state: row.state || '',
    country: row.country || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export async function localContacts(env, agencyId, { query, limit = 50, offset = 0 } = {}) {
  const where = ['agency_id = ?'];
  const binds = [agencyId];
  if (query) {
    where.push('(name LIKE ?1x OR email LIKE ?1x OR phone LIKE ?1x)'.replace(/\?1x/g, '?'));
    const like = `%${query}%`;
    binds.push(like, like, like);
  }
  const cap = Math.min(Number(limit) || 50, 200);
  const { results } = await env.DB.prepare(
    `SELECT * FROM crm_contacts WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(created_at, '') DESC LIMIT ? OFFSET ?`
  ).bind(...binds, cap, Number(offset) || 0).all();

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM crm_contacts WHERE ${where.join(' AND ')}`
  ).bind(...binds).first();

  return { contacts: (results || []).map(hydrateContact), total: countRow?.n || 0 };
}







// ---------------------------------------------------------------------------
// Booking payments
//
// One row covers both sides of a payment: due_date with no paid_date is money
// expected, and the same row gains paid_date when it arrives.
// ---------------------------------------------------------------------------
// Exported so the reservation record can select the same columns rather than
// keeping a second list of its own. Two lists of one table's columns is how
// a page ends up never showing a field that was added to both the table and
// the canonical list months earlier.
export const PAYMENT_COLUMNS = `
  p.id, p.booking_id, p.user_id, p.kind, p.payment_class, p.amount_cents,
  p.due_date, p.paid_date, p.method, p.reference, p.notes, p.created_at, p.updated_at,
  p.reminded_at, p.reminder_count, p.auto_lead_sent,
  p.payment_type, p.paid_by, p.credit_id, p.card_last4, p.from_booking
`;

export async function listPayments(env, scope,
  { bookingId, state, paymentClass, query, limit } = {}) {
  const scoped = scopeWhere(scope, 'p.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (bookingId) { where.push('p.booking_id = ?'); binds.push(bookingId); }
  if (state === 'outstanding') where.push('p.paid_date IS NULL');
  if (state === 'paid') where.push('p.paid_date IS NOT NULL');
  if (paymentClass) { where.push('p.payment_class = ?'); binds.push(paymentClass); }
  // By client or by trip, so a payment can be found on a book bigger than the
  // cap. Filtering a list that was already cut is how a search comes back
  // empty for a client who is right there.
  if (query) {
    where.push('(b.client_name LIKE ? OR b.product_name LIKE ? OR b.supplier LIKE ?)');
    binds.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  const { results } = await env.DB.prepare(
    `SELECT ${PAYMENT_COLUMNS},
            b.client_name, b.supplier, b.product_name, b.depart_date, b.status AS booking_status,
            ${ADVISOR_NAME}
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(p.due_date, '9999-12-31') ASC, p.created_at ASC
      LIMIT ?`
  ).bind(...binds, takeWithProbe(limit)).all();
  return results || [];
}

export async function getPayment(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${PAYMENT_COLUMNS} FROM booking_payments p WHERE p.id = ? AND p.user_id = ?`
  ).bind(id, userId).first();
}

export async function createPayment(env, userId, f) {
  const ts = now();
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO booking_payments
       (id, booking_id, user_id, kind, payment_class, amount_cents, due_date,
        paid_date, method, reference, notes, payment_type, paid_by, credit_id,
        card_last4, from_booking, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, f.bookingId, userId, f.kind, f.paymentClass || 'hard', f.amountCents,
         f.dueDate, f.paidDate, f.method || null, f.reference || null,
         f.notes || null, f.paymentType || null, f.paidBy || null, f.creditId || null,
         // Whether this row is a copy of a date on the reservation, and so
         // whether it moves when that date moves. Only the generator sets it.
         f.cardLast4 || null, f.fromBooking ? 1 : 0, ts, ts).run();
  return getPayment(env, id, userId);
}

export async function updatePayment(env, id, userId, f) {
  const res = await env.DB.prepare(
    `UPDATE booking_payments
        SET kind = ?, payment_class = ?, amount_cents = ?, due_date = ?, paid_date = ?,
            method = ?, reference = ?, notes = ?, payment_type = ?, paid_by = ?,
            credit_id = ?, card_last4 = ?,
            -- Edited by hand, so it stops following the reservation. Somebody
            -- has said something more specific than the reservation says, and
            -- moving it out from under them afterwards is how a portal loses
            -- an advisor's trust in one afternoon.
            from_booking = 0, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(f.kind, f.paymentClass || 'hard', f.amountCents, f.dueDate, f.paidDate,
         f.method || null, f.reference || null, f.notes || null,
         f.paymentType || null, f.paidBy || null, f.creditId || null, f.cardLast4 || null,
         now(), id, userId).run();
  if (!res.meta || res.meta.changes === 0) return null;
  return getPayment(env, id, userId);
}

export async function deletePayment(env, id, userId) {
  const res = await env.DB.prepare('DELETE FROM booking_payments WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  return Boolean(res.meta && res.meta.changes > 0);
}

/**
 * The numbers the payments page leads with, split the way the trade splits
 * them: soft, hard and past due.
 *
 * A hard payment is the vendor's deadline and missing it cancels the
 * reservation. A soft payment is the advisor's own earlier reminder, which is
 * the one that gives them room to collect. Reporting the two as one number
 * hides the only distinction that matters.
 */
/**
 * The money figures behind the Payments screen and the dashboard.
 *
 * Hard and soft get their own windows because they answer different
 * questions. A hard date is the vendor's deadline, so the useful horizon is
 * how much could cancel shortly. A soft date is your own reminder to chase,
 * which is only worth surfacing while there is still time to act on it: a
 * fortnight of reminders is a list, a week of them is a plan.
 */
export async function paymentStats(env, scope, { today, soonThrough, softThrough }) {
  const softEnd = softThrough || soonThrough;
  const scoped = scopeWhere(scope);
  const row = await env.DB.prepare(
    `SELECT
       -- Money totals count hard rows only: a soft row is the same balance
       -- again, ahead of it, so including it doubles every final payment.
       -- The soft and hard due figures below are counts within a window
       -- rather than totals owed, and are class filtered for that reason.
       SUM(CASE WHEN payment_class = 'hard' AND paid_date IS NOT NULL THEN amount_cents ELSE 0 END) AS posted,
       SUM(CASE WHEN payment_class = 'hard' AND paid_date IS NULL THEN amount_cents ELSE 0 END) AS outstanding,
       -- Hard rows only, for the same reason as the two above, which the
       -- comment claimed was already true here and was not. A final payment
       -- has two rows: the vendor's deadline and this portal's reminder ten days
       -- earlier for the same balance. Counting both made every late payment
       -- worth twice what it was, and a balance that had been posted stayed in
       -- the past due column because only its hard row had been ticked.
       SUM(CASE WHEN payment_class = 'hard' AND paid_date IS NULL
                     AND due_date IS NOT NULL AND due_date < ?
                THEN amount_cents ELSE 0 END) AS past_due,
       SUM(CASE WHEN payment_class = 'hard' AND paid_date IS NULL
                     AND due_date IS NOT NULL AND due_date < ?
                THEN 1 ELSE 0 END) AS past_due_count,
       SUM(CASE WHEN paid_date IS NULL AND payment_class = 'soft'
                     AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?
                THEN amount_cents ELSE 0 END) AS soft_due,
       SUM(CASE WHEN paid_date IS NULL AND payment_class = 'soft'
                     AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?
                THEN 1 ELSE 0 END) AS soft_count,
       SUM(CASE WHEN paid_date IS NULL AND payment_class = 'hard'
                     AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?
                THEN amount_cents ELSE 0 END) AS hard_due,
       SUM(CASE WHEN paid_date IS NULL AND payment_class = 'hard'
                     AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?
                THEN 1 ELSE 0 END) AS hard_count
     FROM booking_payments WHERE ${scoped.sql}`
  ).bind(today, today, today, softEnd, today, softEnd,
         today, soonThrough, today, soonThrough, ...scoped.binds).first();

  return {
    postedCents: row?.posted || 0,
    outstandingCents: row?.outstanding || 0,
    pastDueCents: row?.past_due || 0,
    pastDueCount: row?.past_due_count || 0,
    softDueCents: row?.soft_due || 0,
    softCount: row?.soft_count || 0,
    hardDueCents: row?.hard_due || 0,
    hardCount: row?.hard_count || 0,
  };
}

/** Per-booking balance: what it is worth, what came in, what is left. */
export async function bookingBalances(env, scope) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.status, b.gross_cents, b.deposit_cents,
            -- Hard rows only. A soft row is a reminder to chase the same
            -- balance ahead of it, not a second sum owed, so counting both
            -- inflates every reservation carrying a final payment.
            COALESCE(SUM(CASE WHEN p.payment_class = 'hard' AND p.paid_date IS NOT NULL
                              THEN p.amount_cents END), 0) AS paid_cents,
            COALESCE(SUM(CASE WHEN p.payment_class = 'hard' AND p.paid_date IS NULL
                              THEN p.amount_cents END), 0) AS scheduled_cents,
            -- Hard rows only, like the two sums above. A soft row is the
            -- reminder in front of the same money, so counting it would say a
            -- reservation has a schedule when all it has is a nudge.
            COUNT(CASE WHEN p.payment_class = 'hard' THEN 1 END) AS payment_count
       FROM bookings b
       LEFT JOIN booking_payments p ON p.booking_id = b.id
      WHERE ${scoped.sql} AND b.status IN ('quoted','booked','travelled')
      GROUP BY b.id
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC
      LIMIT 200`
  ).bind(...scoped.binds).all();
  return results || [];
}

/**
 * Client payments grouped by the month they are due, split into what has been
 * posted and what is still outstanding.
 *
 * Reports previously answered only "what did I sell". This answers "what is
 * landing when", which is the question that decides whether a booking survives
 * its supplier deadline.
 */
export async function paymentsByMonth(env, scope, sinceDate) {
  const scoped = scopeWhere(scope, 'p.user_id');
  const { results } = await env.DB.prepare(
    `SELECT substr(p.due_date, 1, 7) AS month,
            -- Hard rows only, the same as the two sums below it. A final
            -- balance is two rows, the vendor's deadline and this portal's own
            -- reminder ten days ahead of it, and both usually fall in the same
            -- month. Counted whole, one $4,500 balance read as two payments
            -- beside the single figure it actually was.
            COUNT(CASE WHEN p.payment_class = 'hard' THEN 1 END) AS payments,
            SUM(CASE WHEN p.payment_class = 'hard' AND p.paid_date IS NOT NULL
                     THEN p.amount_cents ELSE 0 END) AS posted_cents,
            SUM(CASE WHEN p.payment_class = 'hard' AND p.paid_date IS NULL
                     THEN p.amount_cents ELSE 0 END) AS outstanding_cents
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE ${scoped.sql} AND p.due_date IS NOT NULL AND p.due_date >= ?
        AND b.status IN ('quoted','booked','travelled')
      GROUP BY month ORDER BY month ASC LIMIT 36`
  ).bind(...scoped.binds, sinceDate).all();
  return results || [];
}

/**
 * Recent reservation activity: what was added or last touched.
 * Mirrors the widget an advisor is used to reading first thing.
 */
export async function recentReservations(env, scope, { by = 'added', limit = 8 } = {}) {
  const order = by === 'modified' ? 'b.updated_at DESC' : 'b.created_at DESC';
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.return_date, b.confirmation_number, b.status, b.gross_cents,
            b.created_at, b.updated_at, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql} AND b.status != 'cancelled'
      ORDER BY ${order} LIMIT ?`
  ).bind(...scoped.binds, Math.min(Number(limit) || 8, 25)).all();
  return results || [];
}

/**
 * Current reservation activity: departing soon, away right now, or just back.
 * Recently returned is the one that drives follow-up and reviews.
 */
export async function currentReservations(env, scope, { view = 'upcoming', today, limit = 8 } = {}) {
  let clause;
  let order;
  if (view === 'traveling') {
    clause = "b.depart_date <= ? AND COALESCE(b.return_date, b.depart_date) >= ?";
    order = 'b.depart_date ASC';
  } else if (view === 'returned') {
    clause = "COALESCE(b.return_date, b.depart_date) < ? AND COALESCE(b.return_date, b.depart_date) >= date(?, '-45 days')";
    order = 'COALESCE(b.return_date, b.depart_date) DESC';
  } else {
    clause = "b.depart_date >= ? AND ? IS NOT NULL";
    order = 'b.depart_date ASC';
  }
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.return_date, b.confirmation_number, b.status, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql} AND b.status IN ('booked','travelled') AND b.depart_date IS NOT NULL
        AND ${clause}
      ORDER BY ${order} LIMIT ?`
  ).bind(...scoped.binds, today, today, Math.min(Number(limit) || 8, 25)).all();
  return results || [];
}
