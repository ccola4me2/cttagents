// Who to write to, worked out from what they have actually booked.
//
// This is the thing a CRM bolted onto a mailing list cannot do. A tag says
// somebody was once labelled "Alaska"; a reservation says they sail on the
// 14th of March, still owe $1,041.70, and their passport expires six weeks
// after they land. Those are different questions and only the second one sells
// travel.
//
// Named rules rather than a query builder. A builder that can express anything
// can express nonsense, needs a UI nobody enjoys, and hands an advisor a way
// to email four hundred people by accident. These are the questions travel
// advisors actually ask, written out, each one a fragment of SQL that has been
// read by somebody. Adding the next one is a small edit here rather than a new
// feature.
//
// Every rule narrows. Combining them is AND, which is what "and" means when
// somebody says "everyone sailing in sixty days who still owes money".

import { json, badRequest, clean, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

/**
 * The rules, in the order they are offered.
 *
 * Every correlated subquery names the owner as well as the client, which is
 * belt and braces: the outer query is already scoped, so a client somebody
 * cannot see contributes nothing. Saying it anyway means each fragment is
 * safe read on its own, by a person or by check-scope, rather than safe
 * because of something written forty lines away.
 *
 * `sql` is a fragment joined against clients c. Anything it needs beyond the
 * client row it reaches with a subquery, so a rule can be read on its own
 * without knowing what the others did to the FROM clause.
 *
 * `n` is the rule's one number, where it has one. Days are days: a rule that
 * asked for a date would need a date picker on a screen somebody uses while
 * thinking about next month.
 */
export const RULES = [
  {
    key: 'sailing_within',
    label: 'Sailing in the next N days',
    hint: 'Everyone with a departure coming up. The list for a pre-trip note.',
    n: { label: 'days', value: 60 },
    sql: (n) => `EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.user_id = c.user_id
      AND b.status IN ('quoted','booked')
      AND b.depart_date BETWEEN date('now') AND date('now', '+${n} day'))`,
  },
  {
    key: 'home_within',
    label: 'Home in the last N days',
    hint: 'Just back. The review, the photos, the "how was it" call.',
    n: { label: 'days', value: 14 },
    sql: (n) => `EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.user_id = c.user_id
      AND b.status IN ('booked','travelled')
      AND b.return_date BETWEEN date('now', '-${n} day') AND date('now'))`,
  },
  {
    key: 'nothing_booked',
    label: 'Nothing booked',
    hint: 'Travelled with you before and has nothing ahead of them.',
    sql: () => `EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.user_id = c.user_id
        AND b.status IN ('booked','travelled'))
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.user_id = c.user_id
        AND b.status IN ('quoted','booked') AND b.depart_date >= date('now'))`,
  },
  {
    key: 'quoted_not_booked',
    label: 'Quoted and never booked',
    hint: 'You sent a price and it went quiet.',
    sql: () => `EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.user_id = c.user_id AND b.status = 'quoted')
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.user_id = c.user_id
        AND b.status IN ('booked','travelled'))`,
  },
  {
    key: 'sailed_with',
    label: 'Has sailed with a supplier',
    hint: 'Everyone who has been on one of their ships. Matched on the name as written.',
    text: { label: 'supplier', value: '' },
    sql: (n, text) => `EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.user_id = c.user_id
      AND b.status IN ('booked','travelled') AND b.supplier LIKE '%${text}%')`,
  },
  {
    key: 'credit_expiring',
    label: 'Credit expiring in N days',
    hint: 'Money with a vendor that runs out if nobody spends it.',
    n: { label: 'days', value: 90 },
    sql: (n) => `EXISTS (SELECT 1 FROM client_credits k WHERE k.client_id = c.id AND k.user_id = c.user_id
      AND k.used_on IS NULL AND k.expires_on IS NOT NULL
      AND k.expires_on BETWEEN date('now') AND date('now', '+${n} day'))`,
  },
  {
    key: 'passport_expiring',
    label: 'Passport expiring in N days',
    hint: 'The six month rule catches these at the desk, not before.',
    n: { label: 'days', value: 180 },
    sql: (n) => `c.passport_expiry IS NOT NULL
      AND c.passport_expiry BETWEEN date('now') AND date('now', '+${n} day')`,
  },
  {
    key: 'birthday_within',
    label: 'Birthday in the next N days',
    hint: 'Matched on the day and month, so the year on the record does not matter.',
    n: { label: 'days', value: 30 },
    sql: (n) => `c.birthday IS NOT NULL AND ${withinAnniversary('c.birthday', n)}`,
  },
  {
    key: 'anniversary_within',
    label: 'Anniversary in the next N days',
    hint: 'The other date worth a card, and the one that sells a cruise.',
    n: { label: 'days', value: 30 },
    sql: (n) => `c.anniversary IS NOT NULL AND ${withinAnniversary('c.anniversary', n)}`,
  },
  {
    key: 'source_is',
    label: 'Came from',
    hint: 'Referral, Facebook, a repeat booking. Whatever is on their record.',
    text: { label: 'source', value: '' },
    sql: (n, text) => `c.source LIKE '%${text}%'`,
  },
  {
    key: 'in_state',
    label: 'Lives in',
    hint: 'For anything local: a ship in their port, an evening at the office.',
    text: { label: 'state or city', value: '' },
    sql: (n, text) => `(c.state LIKE '%${text}%' OR c.city LIKE '%${text}%')`,
  },
];

/**
 * A day and month falling in the next N days, whatever the year.
 *
 * A birthday is a recurring date and the year on it is the year they were
 * born, so a plain BETWEEN finds nobody. Comparing the five characters after
 * the year handles the ordinary case, and the OR handles the window running
 * over New Year, when "the next thirty days" spans 12-20 to 01-19 and a single
 * comparison would return nothing at all for a fortnight.
 */
function withinAnniversary(column, n) {
  const md = `substr(${column}, 6, 5)`;
  return `(
    (strftime('%m-%d', 'now') <= strftime('%m-%d', 'now', '+${n} day')
      AND ${md} BETWEEN strftime('%m-%d', 'now') AND strftime('%m-%d', 'now', '+${n} day'))
    OR
    (strftime('%m-%d', 'now') > strftime('%m-%d', 'now', '+${n} day')
      AND (${md} >= strftime('%m-%d', 'now') OR ${md} <= strftime('%m-%d', 'now', '+${n} day')))
  )`;
}

const BY_KEY = new Map(RULES.map((r) => [r.key, r]));

/**
 * Turn what somebody ticked into a WHERE fragment.
 *
 * Numbers are clamped and text is stripped to what a name can contain, because
 * both are interpolated: SQLite will not take a bound parameter inside the
 * date modifiers these rules are built from. Nothing a caller sends reaches
 * the statement without passing through one of those two.
 */
export function buildWhere(rules) {
  const parts = [];
  for (const r of Array.isArray(rules) ? rules.slice(0, 10) : []) {
    const def = BY_KEY.get(clean(r && r.key, 40));
    if (!def) continue;
    const n = Math.max(0, Math.min(Math.round(Number(r.n) || def.n?.value || 0), 3650));
    // Letters, digits, space and the handful of marks a supplier or a place
    // actually contains. Quotes, percent signs and backslashes are gone, so
    // the interpolation below cannot end the string it sits in.
    const text = String(r.text || def.text?.value || '')
      .replace(/[^A-Za-z0-9 .,&'-]/g, '')
      .replace(/'/g, '')
      .slice(0, 60)
      .trim();
    if (def.text && !text) continue;   // a blank "came from" matches everybody
    parts.push(`(${def.sql(n, text)})`);
  }
  return parts;
}

/** Everyone a set of rules describes, with an email, for this advisor's scope. */
export async function resolveSegment(env, scope, rules, { limit = 500 } = {}) {
  const scoped = db.scopeWhere(scope, 'c.user_id');
  const parts = buildWhere(rules);

  // Named for what its first entry is. The scope predicate leads every one of
  // these queries, and a variable called `where` hid that from anybody reading
  // the statement, including the check that exists to notice.
  const scopedWhere = [scoped.sql, "c.email IS NOT NULL", "TRIM(c.email) != ''", ...parts];

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.nickname, c.email, c.city, c.state
       FROM clients c
      WHERE ${scopedWhere.join(' AND ')}
      ORDER BY c.name
      LIMIT ?`
  ).bind(...scoped.binds, Math.max(1, Math.min(Number(limit) || 500, 2000))).all();

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM clients c WHERE ${scopedWhere.join(' AND ')}`
  ).bind(...scoped.binds).first();

  return { people: results || [], total: count?.n || 0, rulesUsed: parts.length };
}

export async function handleSegmentRules(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  // The page builds itself from this, so a rule added here appears there
  // without a second edit.
  return json({
    rules: RULES.map(({ key, label, hint, n, text }) => ({ key, label, hint, n, text })),
  });
}

export async function handleSegmentPreview(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const scope = db.scopeFor(env, user, request);
  const out = await resolveSegment(env, scope, body.rules, { limit: 25 });

  return json({
    ...out,
    // Named so the page can say "no rules, so this is everybody" rather than
    // showing a number that looks like a segment and is the whole book.
    everybody: out.rulesUsed === 0,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

export async function handleListSegments(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const scoped = db.scopeWhere(db.selfScope(user), 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT id, name, rules_json, created_at, updated_at FROM segments
      WHERE ${scoped.sql} ORDER BY name`
  ).bind(...scoped.binds).all();
  return json({
    segments: (results || []).map((s) => ({
      id: s.id,
      name: s.name,
      rules: safeRules(s.rules_json),
      updatedAt: s.updated_at,
    })),
  });
}

export async function handleSaveSegment(request, env, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 80);
  if (!name) return badRequest('Give the list a name.');

  const rules = Array.isArray(body.rules) ? body.rules.slice(0, 10) : [];
  if (!buildWhere(rules).length) {
    // A saved list that matches everybody is a trap somebody will later send
    // to, so it is refused at the point it is named rather than at the point
    // it is used.
    return badRequest('Add at least one rule, or this list is your whole book.');
  }

  const ts = now();
  if (id) {
    const res = await env.DB.prepare(
      'UPDATE segments SET name = ?, rules_json = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(name, JSON.stringify(rules), ts, id, user.id).run();
    if (!res.meta || !res.meta.changes) return badRequest('That list is not yours.');
    return json({ ok: true, id });
  }

  const newId = uid();
  await env.DB.prepare(
    `INSERT INTO segments (id, user_id, name, rules_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(newId, user.id, name, JSON.stringify(rules), ts, ts).run();
  return json({ ok: true, id: newId }, 201);
}

export async function handleDeleteSegment(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare(
    'DELETE FROM segments WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).run();
  if (!res.meta || !res.meta.changes) return badRequest('That list is not yours.');
  return json({ ok: true });
}

function safeRules(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
