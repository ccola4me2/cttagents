// D1 access layer. Everything that touches the database lives here so the
// route handlers stay readable and the SQL is in one place.
//
// Remember what D1 owns: portal accounts, sessions, and bookings. Contacts,
// opportunities and conversations are read live from GoHighLevel (see ghl.js)
// and are deliberately not mirrored here.

import { uid, now } from './util.js';
import { SPLIT_PCT_SQL, ADVISOR_SHARE_SQL, UNSPLIT_SQL } from './split.js';

const USER_COLUMNS = `
  id, email, first_name, last_name, phone, agency_name, role, status,
  ghl_location_id, ghl_user_id, created_at, updated_at, last_login_at,
  approved_at, approved_by, default_split_pct, agency_address, seller_of_travel,
  notify_email, auto_remind_clients
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
        role, status, ghl_location_id, ghl_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    fields.ghlLocationId || null,
    fields.ghlUserId || null,
    ts,
    ts
  ).run();
  return getUserById(env, id);
}

export async function updateUserProfile(env, id, fields) {
  await env.DB.prepare(
    `UPDATE users
        SET first_name = ?, last_name = ?, phone = ?, agency_name = ?,
            agency_address = ?, seller_of_travel = ?, notify_email = ?,
            auto_remind_clients = ?, updated_at = ?
      WHERE id = ?`
  ).bind(
    fields.firstName || null,
    fields.lastName || null,
    fields.phone || null,
    fields.agencyName || null,
    fields.agencyAddress || null,
    fields.sellerOfTravel || null,
    fields.notifyEmail || null,
    fields.autoRemindClients ? 1 : 0,
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

export async function listUsers(env, { status, role } = {}) {
  const where = [];
  const binds = [];
  if (status) { where.push('status = ?'); binds.push(status); }
  if (role) { where.push('role = ?'); binds.push(role); }
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

/** Bind an advisor to a GoHighLevel sub-account and user id. Admin only. */
export async function setUserGhl(env, id, { locationId, ghlUserId }) {
  await env.DB.prepare(
    'UPDATE users SET ghl_location_id = ?, ghl_user_id = ?, updated_at = ? WHERE id = ?'
  ).bind(locationId || null, ghlUserId || null, now(), id).run();
  return getUserById(env, id);
}

/**
 * An advisor's standing share of the commission they bill.
 *
 * Null clears it, which puts them back on keeping all of it. Stored on the
 * advisor rather than copied onto their reservations, so changing the
 * agreement changes every trip that has not been given its own figure.
 */
export async function setUserSplit(env, id, pct) {
  await env.DB.prepare(
    'UPDATE users SET default_split_pct = ?, updated_at = ? WHERE id = ?'
  ).bind(pct, now(), id).run();
  return getUserById(env, id);
}

export async function countUsers(env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
     FROM users WHERE role = 'advisor'`
  ).first();
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

export async function getSessionUser(env, tokenHash) {
  if (!tokenHash) return null;
  return env.DB.prepare(
    `SELECT ${USER_COLUMNS_U}
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`
  ).bind(tokenHash, now()).first();
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

/** Resolves what the signed in user may see. */
export function visibilityScope(env, user, advisorId = null) {
  const locationId = user.ghl_location_id || env.GHL_DEFAULT_LOCATION_ID || '';
  if (user.role !== 'admin') return { all: false, userId: user.id, locationId, self: true };
  if (advisorId && advisorId !== 'all') {
    return { all: false, userId: advisorId, locationId, self: advisorId === user.id };
  }
  return { all: true, locationId, self: false };
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
 * How the UI should describe the current scope.
 *
 * Every screen that can show more than your own records says whose they are.
 * A total that silently covers the whole agency looks exactly like a total
 * that covers you, and the difference is the whole point of the number.
 */
export function scopeLabel(scope, user) {
  if (scope.all) return { all: true, advisorId: null, label: 'All advisors', canPick: user.role === 'admin' };
  if (scope.self) return { all: false, advisorId: user.id, label: 'Just me', canPick: user.role === 'admin' };
  return { all: false, advisorId: scope.userId, label: 'One advisor', canPick: user.role === 'admin' };
}

/**
 * The advisors an owner may narrow a screen to. Empty for an associate, whose
 * only scope is themselves, so the picker never appears for them.
 */
export async function advisorOptions(env, user) {
  if (user.role !== 'admin') return [];
  const users = await listUsers(env, {});
  return users
    .filter((u) => u.status === 'active')
    .map((u) => ({
      id: u.id,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
      role: u.role,
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
  // Every advisor bound to this agency. Written as a subquery rather than a
  // list of ids so it stays one statement however many advisors there are,
  // and so an advisor added mid-request cannot fall outside it.
  return {
    sql: `${column} IN (SELECT id FROM users WHERE COALESCE(ghl_location_id, ?) = ?)`,
    binds: [scope.locationId, scope.locationId],
  };
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
// Falls back to the email so a row is never attributed to nobody.
const ADVISOR_NAME =
  "COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS advisor_name";

const BOOKING_COLUMNS = `
  id, user_id, ghl_contact_id, ghl_opportunity_id, client_name, supplier,
  product_type, product_name, destination, confirmation_number, depart_date,
  return_date, deposit_due, final_payment_due, travellers, gross_cents, deposit_cents,
  commission_cents, commission_status, status, notes, group_id, client_id, vendor_id,
  cabin, cabin_category, itinerary, booking_method, insurance_status, advisor_split_pct,
  quote_sent_at, quote_sent_count, statement_sent_at, welcomed_at,
  invoice_no, invoice_issued_at, invoice_notes, personal,
  created_at, updated_at, share_code, shared_at, statement_hash
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
    `SELECT ${BOOKING_COLUMNS_B}, ${ADVISOR_NAME}
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
        booking_method, insurance_status, advisor_split_pct, personal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, userId, f.ghlContactId || null, f.ghlOpportunityId || null,
    f.clientName, f.supplier || null, f.productType, f.productName || null,
    f.destination || null, f.confirmationNumber || null,
    f.departDate, f.returnDate, f.depositDue, f.finalPaymentDue,
    f.travellers, f.grossCents, f.depositCents || 0, f.commissionCents, f.commissionStatus,
    f.status, f.notes || null, f.groupId || null, f.clientId || null, f.vendorId || null,
    f.cabin || null, f.cabinCategory || null, f.itinerary || null, f.bookingMethod || null,
    f.insuranceStatus || 'unknown', f.advisorSplitPct == null ? null : f.advisorSplitPct,
    f.personal ? 1 : 0, ts, ts
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
  const share = ADVISOR_SHARE_SQL('b.commission_cents',
    SPLIT_PCT_SQL('b.advisor_split_pct', 'u.default_split_pct'), UNSPLIT_SQL('b.id'));
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN b.status = 'booked' THEN 1 ELSE 0 END) AS booked,
       SUM(CASE WHEN b.status = 'quoted' THEN 1 ELSE 0 END) AS quoted,
       SUM(CASE WHEN b.status = 'travelled' THEN 1 ELSE 0 END) AS travelled,
       SUM(CASE WHEN b.status IN ('booked','travelled') THEN b.gross_cents ELSE 0 END) AS gross_cents,
       SUM(CASE WHEN b.status IN ('booked','travelled') THEN b.commission_cents ELSE 0 END) AS commission_cents,
       SUM(CASE WHEN b.status IN ('booked','travelled') THEN ${share} ELSE 0 END) AS commission_share_cents,
       SUM(CASE WHEN b.commission_status = 'paid' THEN b.commission_cents ELSE 0 END) AS commission_paid_cents,
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
            SUM(commission_cents) AS commission_cents
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
            COALESCE(SUM(b.commission_cents), 0) AS commission_cents,
            COALESCE(SUM(CASE WHEN b.commission_status = 'paid' THEN b.commission_cents END), 0)
              AS commission_paid_cents,
            -- What this advisor keeps, and what the agency keeps out of what
            -- they billed. An owner reading a combined report needs both: the
            -- agency is owed the whole commission and pays out only part of it.
            COALESCE(SUM(${ADVISOR_SHARE_SQL('b.commission_cents',
              SPLIT_PCT_SQL('b.advisor_split_pct', 'u.default_split_pct'), UNSPLIT_SQL('b.id'))}), 0)
              AS advisor_share_cents,
            u.default_split_pct
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
    `SELECT ${BOOKING_COLUMNS_B}, ${ADVISOR_NAME}, u.default_split_pct
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
            SUM(commission_cents) AS commission_cents
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
export async function calendarMonth(env, scope, { from, to }) {
  const b = scopeWhere(scope, 'b.user_id');
  const p = scopeWhere(scope, 'p.user_id');
  const t = scopeWhere(scope, 't.user_id');
  const g = scopeWhere(scope, 'g.user_id');

  const [departs, returns, payments, tasks, options] = await Promise.all([
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
      `SELECT t.id, t.due_date AS on_date, t.title, t.priority
         FROM tasks t WHERE ${t.sql} AND t.done_at IS NULL AND t.due_date BETWEEN ? AND ?`
    ).bind(...t.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT g.id, g.option_date AS on_date, g.name, g.vendor, g.cabins_held,
              (SELECT COUNT(*) FROM bookings x WHERE x.group_id = g.id
                AND x.status IN ('quoted','booked','travelled')) AS cabins_sold
         FROM travel_groups g WHERE ${g.sql} AND g.status = 'open'
          AND g.option_date BETWEEN ? AND ?`
    ).bind(...g.binds, from, to).all().catch(() => ({ results: [] })),
  ]);

  const out = [];
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
    out.push({ date: r.on_date, kind: 'task', title: r.title,
               detail: r.priority === 'high' ? 'high priority' : 'task', href: '/app/tasks' });
  }
  for (const r of options.results || []) {
    const left = Math.max(0, (r.cabins_held || 0) - (r.cabins_sold || 0));
    out.push({ date: r.on_date, kind: 'option', title: r.name,
               detail: `${left} unsold cabin${left === 1 ? '' : 's'} released`, href: '/app/groups' });
  }

  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
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
            COALESCE(SUM(commission_cents), 0) AS commission_cents
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
  c.birthday, c.anniversary, c.pinned_at, c.created_at, c.updated_at
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
              AND b.status IN ('quoted','booked') AND b.depart_date >= date('now')) AS next_date
       FROM clients c
      WHERE ${where.join(' AND ')}
      ORDER BY c.pinned_at IS NULL ASC, c.pinned_at ASC, lifetime_cents DESC
      LIMIT ?`
  ).bind(...binds, takeWithProbe(limit, CLIENT_CAP)).all();
  return results || [];
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

export async function localContacts(env, locationId, { query, limit = 50, offset = 0 } = {}) {
  const where = ['location_id = ?'];
  const binds = [locationId];
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

export async function localContact(env, id) {
  return hydrateContact(await env.DB.prepare('SELECT * FROM crm_contacts WHERE id = ?').bind(id).first());
}

export async function localPipelines(env, locationId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM crm_pipelines WHERE location_id = ? ORDER BY name'
  ).bind(locationId).all();
  return (results || []).map((r) => {
    let stages = [];
    try { stages = r.stages_json ? JSON.parse(r.stages_json) : []; } catch { stages = []; }
    return { id: r.id, name: r.name || 'Pipeline', stages };
  });
}

export async function localOpportunities(env, locationId, { pipelineId, status, query } = {}) {
  const where = ['location_id = ?'];
  const binds = [locationId];
  if (pipelineId) { where.push('pipeline_id = ?'); binds.push(pipelineId); }
  if (status) { where.push('status = ?'); binds.push(status); }
  if (query) {
    where.push('(name LIKE ? OR contact_name LIKE ?)');
    const like = `%${query}%`;
    binds.push(like, like);
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM crm_opportunities WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(updated_at, created_at, '') DESC LIMIT 500`
  ).bind(...binds).all();
  return (results || []).map((r) => ({
    id: r.id,
    name: r.name || 'Untitled opportunity',
    status: r.status || '',
    stageId: r.stage_id || null,
    pipelineId: r.pipeline_id || null,
    monetaryValue: Number(r.monetary_value || 0),
    contactId: r.contact_id || null,
    contactName: r.contact_name || '',
    contactEmail: r.contact_email || '',
    contactPhone: r.contact_phone || '',
    assignedTo: r.assigned_to || null,
    source: r.source || '',
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  }));
}

export async function localOpportunitiesForContact(env, contactId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM crm_opportunities WHERE contact_id = ? ORDER BY COALESCE(updated_at, "") DESC LIMIT 50'
  ).bind(contactId).all();
  return (results || []).map((r) => ({
    id: r.id, name: r.name || 'Untitled opportunity', status: r.status || '',
    monetaryValue: Number(r.monetary_value || 0), contactId: r.contact_id,
  }));
}

/**
 * How opportunities finished, for a closing rate.
 *
 * The rate counts won against won plus lost. Abandoned deals are reported but
 * kept out of the denominator: a lead that went quiet was never a decision,
 * and folding it in makes an advisor who chases plenty of cold leads look
 * worse than one who chases none.
 */
export async function localOpportunityOutcomes(env, locationId, sinceIso) {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(monetary_value), 0) AS value
       FROM crm_opportunities
      WHERE location_id = ? AND status IS NOT NULL AND status != 'open'
        AND COALESCE(updated_at, created_at, '') >= ?
      GROUP BY status`
  ).bind(locationId, sinceIso).all().catch(() => ({ results: [] }));

  const by = Object.fromEntries((results || []).map((r) => [r.status, r]));
  const won = by.won?.n || 0;
  const lost = by.lost?.n || 0;
  const decided = won + lost;
  return {
    won,
    lost,
    abandoned: by.abandoned?.n || 0,
    wonValue: by.won?.value || 0,
    closingRate: decided > 0 ? Math.round((won / decided) * 1000) / 10 : null,
  };
}

export async function crmCounts(env, locationId) {
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM crm_contacts WHERE location_id = ?').bind(locationId).first();
  const o = await env.DB.prepare('SELECT COUNT(*) AS n FROM crm_opportunities WHERE location_id = ?').bind(locationId).first();
  const p = await env.DB.prepare('SELECT COUNT(*) AS n FROM crm_pipelines WHERE location_id = ?').bind(locationId).first();
  return { contacts: c?.n || 0, opportunities: o?.n || 0, pipelines: p?.n || 0 };
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
  p.payment_type, p.paid_by, p.credit_id, p.card_last4
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
        card_last4, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, f.bookingId, userId, f.kind, f.paymentClass || 'hard', f.amountCents,
         f.dueDate, f.paidDate, f.method || null, f.reference || null,
         f.notes || null, f.paymentType || null, f.paidBy || null, f.creditId || null,
         f.cardLast4 || null, ts, ts).run();
  return getPayment(env, id, userId);
}

export async function updatePayment(env, id, userId, f) {
  const res = await env.DB.prepare(
    `UPDATE booking_payments
        SET kind = ?, payment_class = ?, amount_cents = ?, due_date = ?, paid_date = ?,
            method = ?, reference = ?, notes = ?, payment_type = ?, paid_by = ?,
            credit_id = ?, card_last4 = ?, updated_at = ?
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
       -- again, a week earlier, so including it doubles every final payment.
       -- The soft and hard due figures below are counts within a window
       -- rather than totals owed, so they are class filtered already.
       SUM(CASE WHEN payment_class = 'hard' AND paid_date IS NOT NULL THEN amount_cents ELSE 0 END) AS posted,
       SUM(CASE WHEN payment_class = 'hard' AND paid_date IS NULL THEN amount_cents ELSE 0 END) AS outstanding,
       SUM(CASE WHEN paid_date IS NULL AND due_date IS NOT NULL AND due_date < ?
                THEN amount_cents ELSE 0 END) AS past_due,
       SUM(CASE WHEN paid_date IS NULL AND due_date IS NOT NULL AND due_date < ?
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
            -- balance a week earlier, not a second sum owed, so counting both
            -- inflates every reservation carrying a final payment.
            COALESCE(SUM(CASE WHEN p.payment_class = 'hard' AND p.paid_date IS NOT NULL
                              THEN p.amount_cents END), 0) AS paid_cents,
            COALESCE(SUM(CASE WHEN p.payment_class = 'hard' AND p.paid_date IS NULL
                              THEN p.amount_cents END), 0) AS scheduled_cents,
            COUNT(p.id) AS payment_count
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
            COUNT(*) AS payments,
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
