// Who to call this week.
//
// Everything here was already in the database, and most of it was already on
// the dashboard: a rebook panel, a birthdays panel, a welcome-home panel, each
// showing a dozen rows in a corner of a screen you look at once a morning.
// Twelve rows out of six hundred is not a call list, it is a sample, and there
// was no way to work through one or to say you had.
//
// So this composes the queries that already exist rather than writing second
// answers to the same questions. rebookCandidates, upcomingBirthdays and
// welcomeHomeCandidates are the dashboard's, unchanged in meaning; the credits
// come from the credits page. Anniversaries are the only genuinely new one,
// and they are birthdays with a different reason.
//
// Five lists, and each one is a different phone call:
//
//   quiet          travelled with you, nothing on the books: the best lead there is
//   lapsing        money already paid to a vendor, about to be worth nothing
//   home           back in the last month: ask how it went
//   birthdays      a reason to make contact that costs nothing
//   anniversaries  the same, and often the reason for the trip
//
// The half that decides whether any of this gets used is being able to say you
// have done it. Four of the five put a name away for a while: a quarter after
// a rebooking call, a month after chasing a credit that has not expired yet.
// The fifth does not, because "rang them after their trip" is already a fact
// the portal records on the reservation, and a private snooze that left
// welcomed_at empty would be the same work recorded twice and disagreeing.

import { json, badRequest, clean, cleanText, oneOf, uid, now, nextAnnual, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { upcomingBirthdays } from './travellers.js';
import { listCredits } from './credits.js';

/**
 * The lists, in the order they are read.
 *
 * `snooze` is how long ticking one off puts it away, in days, chosen against
 * the window that list looks over: birthdays look thirty days ahead, so ninety
 * clears this year's without reaching next year's.
 *
 * `done` is what ticking one off actually does. Everything is a snooze except
 * the welcome-home call, which has somewhere real to be written down.
 */
export const LISTS = [
  { key: 'quiet', label: 'Gone quiet', snooze: 90, done: 'snooze' },
  { key: 'lapsing', label: 'Money lapsing', snooze: 30, done: 'snooze' },
  { key: 'home', label: 'Just home', snooze: 0, done: 'welcomed' },
  { key: 'birthdays', label: 'Birthdays', snooze: 90, done: 'snooze' },
  { key: 'anniversaries', label: 'Anniversaries', snooze: 90, done: 'snooze' },
];

export const LIST_KEYS = LISTS.map((l) => l.key);
const SNOOZED = LISTS.filter((l) => l.done === 'snooze').map((l) => l.key);

// How far each list looks. Not settings: a birthday you hear about the day
// before is no use, and one you hear about in April is not a reason to ring
// anybody. Thirty days is a fortnight to plan and a fortnight to forget.
const AHEAD_DAYS = 30;
const HOME_DAYS = 30;
const LAPSING_DAYS = 90;

// How long a client has to have been quiet before there is a call to make.
// Offered on the page because it is a real judgement, not a constant: nine
// months suits somebody who cruises yearly and is far too soon for somebody
// who goes every other year.
const QUIET_MONTHS = [6, 9, 12, 18, 24];

// Each list is a call list, not a report. Past a couple of hundred names it is
// neither, and the page says there are more rather than trimming quietly.
const CAP = 200;

const isoToday = () => new Date().toISOString().slice(0, 10);

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const between = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------------------
// Rows
//
// One shape for all five, because the page draws one row and the differences
// are what it says rather than how it is put together. `subjectId` is what
// comes back when the row is ticked off, and every list picks its own: the
// booking for a welcome-home call, the credit for a lapsing one, and for the
// two that group by name, the advisor and the name together.

function quietRow(r, today) {
  const back = between(today, r.last_travelled);
  return {
    subjectId: `${r.user_id}|${r.client_name}`,
    name: r.client_name, email: r.email || null, phone: r.phone || null,
    userId: r.user_id, advisor: r.advisor_name || null,
    date: r.last_travelled, days: -back,
    clientId: r.client_id || null,
    trips: r.trips, lifetimeCents: r.lifetime_cents || 0, supplier: r.last_vendor || null,
  };
}

function homeRow(b) {
  return {
    subjectId: b.id,
    name: b.client_name, email: null, phone: null,
    userId: b.user_id, advisor: b.advisor_name || null,
    date: b.return_date || b.depart_date, days: -b.back_days,
    clientId: b.client_id || null, bookingId: b.id,
    supplier: b.supplier || null, product: b.product_name || null,
  };
}

function birthdayRow(r) {
  return {
    subjectId: `${r.user_id}|${r.dob}|${r.name}`,
    name: r.name, email: r.email || null, phone: r.phone || null,
    userId: r.user_id, advisor: null,
    date: r.on, days: r.in_days,
    clientId: r.client_id || null,
    turning: r.turning, forClient: r.client_name !== r.name ? r.client_name : null,
  };
}

const KIND_WORD = { credit: 'credit', deposit: 'deposit', certificate: 'certificate' };

function creditRow(c, today) {
  return {
    subjectId: c.id,
    name: c.client_name, email: c.client_email || null, phone: c.client_phone || null,
    userId: c.user_id, advisor: c.advisor_name || null,
    date: c.expires_on, days: between(c.expires_on, today),
    clientId: c.client_id || null,
    amountCents: c.amount_cents || 0, vendor: c.vendor || null,
    kind: KIND_WORD[c.kind] || 'credit', reference: c.reference || null,
  };
}

// ---------------------------------------------------------------------------

/** Anniversaries, which only ever come from the client record. */
async function upcomingAnniversaries(env, scope, today) {
  const scoped = db.scopeWhere(scope, 'c.user_id');
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.user_id, c.name, c.email, c.phone, c.anniversary
       FROM clients c
      WHERE ${scoped.sql} AND c.anniversary IS NOT NULL AND c.anniversary != ''
      LIMIT 2000`
  ).bind(...scoped.binds).all();

  const out = [];
  for (const c of results || []) {
    const on = nextAnnual(c.anniversary, today);
    if (!on) continue;
    const days = between(on, today);
    if (days > AHEAD_DAYS) continue;
    out.push({
      subjectId: c.id,
      name: c.name, email: c.email || null, phone: c.phone || null,
      userId: c.user_id, advisor: null,
      date: on, days, clientId: c.id,
      years: Number(c.anniversary.slice(0, 4)) > 1900
        ? Number(on.slice(0, 4)) - Number(c.anniversary.slice(0, 4)) : null,
    });
  }
  return out.sort((a, b) => a.days - b.days);
}

/** What this advisor has already ticked off and not yet earned back. */
async function liveSnoozes(env, userId, today) {
  const { results } = await env.DB.prepare(
    `SELECT list_key, subject_id FROM hotlist_actions
      WHERE user_id = ? AND until_date > ? LIMIT 5000`
  ).bind(userId, today).all();
  const out = new Set();
  for (const r of results || []) out.add(`${r.list_key}:${r.subject_id}`);
  return out;
}

export async function buildHotLists(env, scope, userId, { today = isoToday(), quietMonths = 9 } = {}) {
  const months = QUIET_MONTHS.includes(Number(quietMonths)) ? Number(quietMonths) : 9;

  const [quiet, credits, home, birthdays, anniversaries, snoozed] = await Promise.all([
    // No floor on how far back. A client from four years ago is still somebody
    // who bought from you, and a truthful "there are more" beats an invented
    // cut-off that quietly loses them.
    db.rebookCandidates(env, scope, {
      today, before: addDays(today, -Math.round(months * 30.44)), limit: CAP + 1,
    }),
    listCredits(env, scope, { state: 'open', limit: 500 }),
    db.welcomeHomeCandidates(env, scope, { today, days: HOME_DAYS, limit: CAP + 1 }),
    upcomingBirthdays(env, scope, { today, days: AHEAD_DAYS, limit: CAP + 1 }),
    upcomingAnniversaries(env, scope, today),
    liveSnoozes(env, userId, today),
  ]);

  const lapseBy = addDays(today, LAPSING_DAYS);
  const built = {
    quiet: quiet.map((r) => quietRow(r, today)),
    lapsing: credits
      .filter((c) => c.expires_on && c.expires_on >= today && c.expires_on <= lapseBy)
      .map((c) => creditRow(c, today)),
    home: home.map(homeRow),
    birthdays: birthdays.map(birthdayRow),
    anniversaries,
  };

  const lists = {};
  for (const { key, done } of LISTS) {
    const live = done === 'snooze'
      ? built[key].filter((r) => !snoozed.has(`${key}:${r.subjectId}`))
      : built[key];
    lists[key] = { rows: live.slice(0, CAP), truncated: live.length > CAP };
  }
  return { lists, today, quietMonths: months };
}

export async function handleHotLists(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const scope = db.scopeFor(env, user, request);
  const built = await buildHotLists(env, scope, user.id, {
    quietMonths: Number(url.searchParams.get('quiet')) || 9,
  });

  return json({
    today: built.today,
    quietMonths: built.quietMonths,
    lists: LISTS.map((l) => ({
      key: l.key, label: l.label, snooze: l.snooze, done: l.done,
      rows: built.lists[l.key].rows,
      truncated: built.lists[l.key].truncated,
    })),
    quietOptions: QUIET_MONTHS,
    windows: { ahead: AHEAD_DAYS, home: HOME_DAYS, lapsing: LAPSING_DAYS },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * Put one away for a while.
 *
 * Written against the advisor doing the ticking rather than whoever owns the
 * client, because this is a personal call list: an owner looking across the
 * agency and clearing a name they have handled should not take it off the list
 * of the advisor whose client it is.
 */
export async function handleHotListDone(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const listKey = oneOf(body.list, SNOOZED);
  if (body.list && listKey !== body.list) {
    // Named rather than accepted quietly. Asking to snooze the welcome-home
    // list is a page calling the wrong endpoint, and answering 200 to it would
    // leave a row nothing ever reads.
    return badRequest('That list is not one you can put away here.');
  }
  const subjectId = clean(body.subjectId, 200);
  if (!subjectId) return badRequest('Which one?');

  const list = LISTS.find((l) => l.key === listKey);
  const until = addDays(isoToday(), list.snooze);

  await env.DB.prepare(
    `INSERT INTO hotlist_actions (id, user_id, list_key, subject_id, until_date, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, list_key, subject_id)
       DO UPDATE SET until_date = excluded.until_date, note = excluded.note,
                     created_at = excluded.created_at`
  ).bind(uid(), user.id, listKey, subjectId, until, cleanText(body.note, 500) || null, now()).run();

  return json({ ok: true, until, snooze: list.snooze });
}

/** Undo the last tick, for the one that was a mis-click. */
export async function handleHotListUndo(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const listKey = oneOf(body.list, SNOOZED);
  const subjectId = clean(body.subjectId, 200);
  if (!subjectId) return badRequest('Which one?');

  await env.DB.prepare(
    'DELETE FROM hotlist_actions WHERE user_id = ? AND list_key = ? AND subject_id = ?'
  ).bind(user.id, listKey, subjectId).run();

  return json({ ok: true });
}
