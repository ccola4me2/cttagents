// The emails a client gets on their own once a reservation is made.
//
// Until now the only thing that wrote to a client by itself was the payment reminder, and that was a switch each
// advisor had to find. This is the whole run of it, planned the moment a reservation is booked: a note that it is
// booked, a reminder a week and two days before the deposit and the final payment, a nudge about travel documents
// two months out, online check-in two weeks out, bon voyage three days out, and a welcome home the day after.
//
// The decisions that are easy to reverse by accident:
//
//   - Off until an owner turns it on, for the whole agency, and then only for reservations made after that moment
//     (agencies.trip_emails_since). Nobody's existing clients are written to the day it is switched on.
//   - A reservation's emails are rows (trip_emails), planned once and kept in step with the dates on the
//     reservation, so the advisor can see exactly what will go and when, and skip any one of them.
//   - Payment reminders go only where the portal holds a hard, unpaid payment, and are checked again at the moment
//     of sending. An advisor who already has the automatic payment reminders switched on is not sent a second set
//     (see payremind.js).
//   - A late email is worse than none. Anything more than three days past its day is dropped, so switching the
//     cron back on after a pause never sends a week of old reminders at once.
//   - Reminders go in the middle of the day. The booked note goes as soon as it is planned.
//   - Every message carries the way out a client has a right to, and honours it.
//
// The wording is the agency's: one set for everybody, written once by an owner, with the client's own details
// filled in. A line that mentions something the reservation does not have (a confirmation number nobody has typed
// yet) is left out rather than sent with a hole in it.

import { json, badRequest, notFound, clean, cleanText, uid, now, readJson, escapeHtml, usDate, PermanentError }
  from './util.js';
import { requireUser, requireAdmin } from './auth.js';
import { layout, sendHtml } from './email.js';
import { appUrl } from './share.js';
import { brandForUser } from './brand.js';
import { isSuppressed } from './suppression.js';
import * as db from './db.js';

// How late is too late, in days, and the hours of the day (UTC) the reminders go in. Thirteen to twenty-one is
// nine in the morning to five in the afternoon on the east coast, the middle of the day everywhere in the US.
const STALE_DAYS = 3;
const FIRST_HOUR = 13;
const LAST_HOUR = 21;

export const VARIABLES = [
  ['first_name', 'the client\'s first name'],
  ['trip', 'the trip, like Harmony of the Seas cruise'],
  ['start_date', 'the day the trip starts'],
  ['return_date', 'the day it ends'],
  ['days_to_go', 'how many days until it starts'],
  ['confirmation', 'the confirmation number'],
  ['amount', 'the amount due, for the payment emails'],
  ['due_date', 'the day it is due, for the payment emails'],
  ['thanks', 'a line thanking them for the form they filled in, for the first note to a lead'],
  ['advisor', 'the advisor\'s name'],
  ['phone', 'the advisor\'s phone number'],
  ['agency', 'the agency\'s name'],
];

const SIGN = 'Thank you,\n{advisor}\n{agency}\n{phone}';

// The built-in wording. `when` is how the advisor and the owner read it, `heading` the line at the top of the
// message. The five payment emails share two texts apart from how far off the day is.
export const KINDS = [
  { kind: 'confirmed', label: 'Your trip is booked', when: 'Right after the reservation is booked',
    heading: 'Your trip is booked',
    subject: 'Your trip is booked: {trip}',
    body: 'Hello {first_name},\n\nGood news: your trip is booked. {trip} starts on {start_date} and ends on {return_date}.\n\n'
      + 'Your confirmation number is {confirmation}.\n\n'
      + 'I will keep an eye on every date from here and send you a note before anything is due. '
      + 'If you have a question, reply to this email.\n\n' + SIGN },
  { kind: 'deposit_7', label: 'Deposit due in a week', when: '7 days before the deposit is due',
    heading: 'Deposit due soon',
    subject: 'Your deposit for {trip} is due {due_date}',
    body: 'Hello {first_name},\n\nA friendly reminder that the deposit of {amount} for {trip} is due on {due_date}.\n\n'
      + 'If you have already sent it, thank you, and please ignore this note. If not, reply here and I will '
      + 'take care of it with you.\n\n' + SIGN },
  { kind: 'deposit_2', label: 'Deposit due in two days', when: '2 days before the deposit is due',
    heading: 'Deposit due in two days',
    subject: 'Two days left: your deposit for {trip}',
    body: 'Hello {first_name},\n\nYour deposit of {amount} for {trip} is due in two days, on {due_date}.\n\n'
      + 'If you have already sent it, thank you, and please ignore this note. If not, reply here and I will '
      + 'help you finish it today.\n\n' + SIGN },
  { kind: 'final_7', label: 'Final payment due in a week', when: '7 days before the final payment is due',
    heading: 'Final payment due soon',
    subject: 'Your final payment for {trip} is due {due_date}',
    body: 'Hello {first_name},\n\nA friendly reminder that the final payment of {amount} for {trip} is due on {due_date}.\n\n'
      + 'The supplier sets this date, and the booking can be cancelled if it passes unpaid. If you have already '
      + 'sent it, thank you. If not, reply here and I will take care of it with you.\n\n' + SIGN },
  { kind: 'final_2', label: 'Final payment due in two days', when: '2 days before the final payment is due',
    heading: 'Final payment due in two days',
    subject: 'Two days left: your final payment for {trip}',
    body: 'Hello {first_name},\n\nYour final payment of {amount} for {trip} is due in two days, on {due_date}.\n\n'
      + 'The supplier sets this date, and the booking can be cancelled if it passes unpaid. If you have already '
      + 'sent it, thank you. If not, reply here and I will help you finish it today.\n\n' + SIGN },
  { kind: 'docs_60', label: 'Check your travel documents', when: '60 days before the trip',
    heading: 'Check your travel documents',
    subject: 'Time to check your travel documents for {trip}',
    body: 'Hello {first_name},\n\n{trip} starts on {start_date}, {days_to_go} days from now. This is a good week to look '
      + 'at everyone\'s travel documents.\n\n'
      + 'Please check that each passport is valid for at least six months after the trip ends, and that every '
      + 'name matches the booking exactly. If anything needs fixing, tell me now, while it is easy.\n\n' + SIGN },
  { kind: 'checkin_14', label: 'Online check-in', when: '14 days before the trip',
    heading: 'Online check-in',
    subject: 'Online check-in for {trip}',
    body: 'Hello {first_name},\n\nYour trip starts on {start_date}. Most cruise lines and travel suppliers open online '
      + 'check-in about now, and finishing it early makes the day you leave much quicker.\n\n'
      + 'If you would like help with it, reply here and I will walk you through it.\n\n' + SIGN },
  { kind: 'bonvoyage_3', label: 'Bon voyage', when: '3 days before the trip',
    heading: 'Bon voyage',
    subject: 'Bon voyage! {trip} starts in three days',
    body: 'Hello {first_name},\n\nYour trip starts in three days, on {start_date}. I hope you are as excited as I am for you.\n\n'
      + 'Have your documents handy, pack a little sunscreen, and enjoy every minute. If anything comes up '
      + 'before you leave, reply to this email.\n\n' + SIGN },
  { kind: 'home_1', label: 'Welcome home', when: 'The day after the trip ends',
    heading: 'Welcome home',
    subject: 'Welcome home from {trip}',
    body: 'Hello {first_name},\n\nWelcome home! I hope {trip} was everything you hoped for.\n\n'
      + 'I would love to hear how it went, and what you would do again. Just reply to this email.\n\n'
      + 'When you are ready to start planning the next one, I am here.\n\n' + SIGN },
];

// The first note to somebody who filled in a form, sent from the Leads page. Not planned against a reservation like the
// rest, so it is kept apart from KINDS, but the words are the agency's in the same way and are edited on the same page.
export const LEAD_HELLO = {
  kind: 'lead_hello', label: 'First note to a new lead', when: 'When you answer a new lead on the Leads page',
  heading: 'Thank you for getting in touch',
  subject: 'Thanks for getting in touch, {first_name}',
  body: 'Hello {first_name},\n\n{thanks}\n\nI am {advisor} at {agency}, and I would love to help you plan your next trip.\n\n'
    + 'Do you already have somewhere in mind, or a time of year you would like to travel? Even a rough idea is enough to start, '
    + 'and there is no obligation.\n\nJust reply to this email and I will take it from there.\nYou can also call me on {phone}.\n\n'
    + 'Thank you,\n{advisor}\n{agency}',
};

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));
const ALL_KINDS = [...KINDS, LEAD_HELLO];
const PAYMENT_KINDS = new Set(['deposit_7', 'deposit_2', 'final_7', 'final_2']);

const STATUS_LABEL = {
  scheduled: 'Will go out', sent: 'Sent', skipped: 'Skipped', expired: 'Too late, not sent',
  not_needed: 'Not needed', failed: 'Could not send',
};

const isoDay = (secs) => new Date(secs * 1000).toISOString().slice(0, 10);
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const money = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** Every {word} in a text, lower case. */
function wordsIn(text) {
  const found = [];
  String(text || '').replace(/\{([a-z_]+)\}/gi, (all, w) => { found.push(w.toLowerCase()); return all; });
  return found;
}

/**
 * Fill a text in. A paragraph that names something the reservation does not have is left out whole, so a message
 * never reads "Your confirmation number is ." Returns the subject, and the body as a list of paragraphs.
 */
export function fillWords(subject, body, vars) {
  const put = (text) => String(text || '').replace(/\{([a-z_]+)\}/gi, (all, w) => {
    const v = vars[w.toLowerCase()];
    return v == null ? all : String(v);
  });
  const has = (text) => wordsIn(text).every((w) => !(w in vars) || String(vars[w] || '').trim() !== '');
  // A line that names something missing goes, and a paragraph with no lines left goes with it, so a sign off
  // without an agency name still shows the advisor's.
  const paragraphs = String(body || '').split(/\n{2,}/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter((l) => l && has(l)).map(put).join('\n'))
    .filter(Boolean);
  return { subject: put(subject).replace(/\s+/g, ' ').trim(), paragraphs };
}

/** What this agency says for one kind: its own words where an owner has written them, else the built-in. */
export async function wordingFor(env, agencyId) {
  const rows = agencyId
    ? await env.DB.prepare('SELECT kind, subject, body FROM trip_email_wording WHERE agency_id = ?')
      .bind(agencyId).all().catch(() => ({ results: [] }))
    : { results: [] };
  const custom = new Map((rows.results || []).map((r) => [r.kind, r]));
  const out = new Map();
  for (const k of ALL_KINDS) {
    const c = custom.get(k.kind);
    out.set(k.kind, {
      subject: (c && c.subject) || k.subject,
      body: (c && c.body) || k.body,
      custom: Boolean(c && (c.subject || c.body)),
    });
  }
  return out;
}

function htmlOf(paragraphs) {
  return paragraphs.map((p) => `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// ---------------------------------------------------------------------------
// What is planned for a reservation
// ---------------------------------------------------------------------------

/**
 * The emails a reservation should have and the day each goes. Pure: the reservation, its payments and today in,
 * a list out, so it can be run on any set of dates.
 *
 * `pays` are booking_payments rows. A payment email is planned only against a hard, unpaid payment with a date,
 * the earliest of its kind.
 */
export function planFor(b, pays, today) {
  // The booked note goes the day the reservation is first planned as booked, not the day it was made, so a quote
  // that is accepted a week later still gets its note. A trip that has already started gets none.
  const out = [];
  if (!b.depart_date || b.depart_date >= today) out.push({ kind: 'confirmed', dueOn: today });
  const earliest = (kind) => (pays || [])
    .filter((p) => p.kind === kind && p.payment_class === 'hard' && !p.paid_date && p.due_date)
    .sort((x, y) => (x.due_date < y.due_date ? -1 : 1))[0];

  const dep = earliest('deposit');
  if (dep) {
    out.push({ kind: 'deposit_7', dueOn: addDays(dep.due_date, -7) });
    out.push({ kind: 'deposit_2', dueOn: addDays(dep.due_date, -2) });
  }
  const fin = earliest('final');
  if (fin) {
    out.push({ kind: 'final_7', dueOn: addDays(fin.due_date, -7) });
    out.push({ kind: 'final_2', dueOn: addDays(fin.due_date, -2) });
  }
  if (b.depart_date) {
    out.push({ kind: 'docs_60', dueOn: addDays(b.depart_date, -60) });
    out.push({ kind: 'checkin_14', dueOn: addDays(b.depart_date, -14) });
    out.push({ kind: 'bonvoyage_3', dueOn: addDays(b.depart_date, -3) });
  }
  if (b.return_date) out.push({ kind: 'home_1', dueOn: addDays(b.return_date, 1) });
  return out;
}

/** The state a newly planned email starts in. */
function startingState(entry, today, advisorReminds) {
  if (PAYMENT_KINDS.has(entry.kind) && advisorReminds) {
    return { status: 'not_needed', note: 'Your automatic payment reminders already cover this.' };
  }
  if (entry.kind !== 'confirmed' && entry.dueOn < today) {
    return { status: 'expired', note: 'That day had already passed when the reservation was set up.' };
  }
  return { status: 'scheduled', note: null };
}

const IN_SCOPE = `a.trip_emails_since IS NOT NULL AND b.created_at > a.trip_emails_since AND b.emails_off = 0
        AND b.status IN ('booked', 'travelled') AND (b.return_date IS NULL OR b.return_date >= ?)`;

/**
 * Plan the emails of every reservation made since an agency switched them on, and keep the planned ones in step
 * with the dates on the reservation. Safe to run every few minutes: nothing is ever planned twice.
 */
export async function planTripEmails(env, { at = now(), bookingId = null } = {}) {
  const today = isoDay(at);
  const cutoff = addDays(today, -7);
  // One reservation, when the advisor has just opened it; everything in scope otherwise.
  const only = bookingId ? ' AND b.id = ?' : '';
  const binds = bookingId ? [cutoff, bookingId] : [cutoff];
  const out = { planned: 0, moved: 0, retired: 0, considered: 0 };

  const { results: books } = await env.DB.prepare(
    `SELECT b.id, b.user_id, b.depart_date, b.return_date, b.created_at, u.auto_remind_clients
       FROM bookings b
       JOIN users u ON u.id = b.user_id
       JOIN agencies a ON a.id = u.agency_id
      WHERE ${IN_SCOPE}${only}
      ORDER BY b.created_at DESC LIMIT 400`
  ).bind(...binds).all();
  if (!(books || []).length) return out;
  out.considered = books.length;

  const [pays, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT p.booking_id, p.kind, p.payment_class, p.due_date, p.paid_date, p.user_id
         FROM booking_payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN users u ON u.id = b.user_id
         JOIN agencies a ON a.id = u.agency_id
        WHERE ${IN_SCOPE}${only}`
    ).bind(...binds).all(),
    env.DB.prepare(
      `SELECT te.booking_id, te.kind, te.status, te.due_on, te.user_id
         FROM trip_emails te
         JOIN bookings b ON b.id = te.booking_id
         JOIN users u ON u.id = b.user_id
         JOIN agencies a ON a.id = u.agency_id
        WHERE ${IN_SCOPE}${only}`
    ).bind(...binds).all(),
  ]);

  const paysOf = new Map();
  for (const p of pays.results || []) {
    if (!paysOf.has(p.booking_id)) paysOf.set(p.booking_id, []);
    paysOf.get(p.booking_id).push(p);
  }
  const haveOf = new Map();
  for (const r of rows.results || []) {
    if (!haveOf.has(r.booking_id)) haveOf.set(r.booking_id, new Map());
    haveOf.get(r.booking_id).set(r.kind, r);
  }

  const ts = now();
  const writes = [];
  for (const b of books) {
    const plan = planFor(b, paysOf.get(b.id) || [], today);
    const have = haveOf.get(b.id) || new Map();
    const wanted = new Set(plan.map((e) => e.kind));

    for (const e of plan) {
      const row = have.get(e.kind);
      if (!row) {
        const s = startingState(e, today, Boolean(b.auto_remind_clients));
        writes.push(env.DB.prepare(
          `INSERT OR IGNORE INTO trip_emails (id, booking_id, user_id, kind, due_on, status, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(uid(), b.id, b.user_id, e.kind, e.dueOn, s.status, s.note, ts, ts));
        out.planned += 1;
      } else if (row.status === 'scheduled' && row.due_on !== e.dueOn && e.kind !== 'confirmed') {
        writes.push(env.DB.prepare(
          `UPDATE trip_emails SET due_on = ?, updated_at = ?
            WHERE booking_id = ? AND user_id = ? AND kind = ? AND status = 'scheduled'`
        ).bind(e.dueOn, ts, b.id, b.user_id, e.kind));
        out.moved += 1;
      }
    }
    // A payment that was paid, or a date that was cleared, takes its reminder with it.
    for (const [kind, row] of have) {
      if (row.status === 'scheduled' && !wanted.has(kind)) {
        writes.push(env.DB.prepare(
          `UPDATE trip_emails SET status = 'not_needed', note = ?, updated_at = ?
            WHERE booking_id = ? AND user_id = ? AND kind = ? AND status = 'scheduled'`
        ).bind('There is nothing due any more.', ts, b.id, b.user_id, kind));
        out.retired += 1;
      }
    }
  }
  for (let i = 0; i < writes.length; i += 80) await env.DB.batch(writes.slice(i, i + 80));
  return out;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function tripName(b) {
  return b.product_name || [b.supplier, b.destination].filter(Boolean).join(' ') || 'your trip';
}

function varsFor(b, client, today, pay) {
  const full = [b.first_name, b.last_name].filter(Boolean).join(' ') || b.advisor_email || '';
  const who = (client && client.name) || b.client_name || '';
  return {
    first_name: String(who).trim().split(/\s+/)[0] || 'there',
    trip: tripName(b),
    start_date: b.depart_date ? usDate(b.depart_date) : '',
    return_date: b.return_date ? usDate(b.return_date) : '',
    days_to_go: b.depart_date ? String(Math.max(daysBetween(today, b.depart_date), 0)) : '',
    confirmation: b.confirmation_number || '',
    amount: pay ? money(pay.amount_cents) : '',
    due_date: pay ? usDate(pay.due_date) : '',
    advisor: full,
    phone: b.advisor_phone || '',
    agency: b.agency_name || '',
  };
}

/** The finished message for one email, from the agency's wording. */
export async function composeEmail(env, { kind, wording, vars, userId }) {
  const def = BY_KIND.get(kind) || (kind === LEAD_HELLO.kind ? LEAD_HELLO : null);
  const w = wording.get(kind);
  const filled = fillWords(w.subject, w.body, vars);
  const brand = await brandForUser(env, userId);
  const showTrip = kind === 'confirmed' || PAYMENT_KINDS.has(kind);
  const html = layout(env, {
    brand,
    heading: def.heading,
    body: htmlOf(filled.paragraphs),
    cta: showTrip ? { label: 'See your trip', href: `${appUrl(env)}/portal` } : undefined,
  });
  return { subject: filled.subject, html, paragraphs: filled.paragraphs };
}

async function settle(env, row, status, note, sentAt = null) {
  await env.DB.prepare(
    `UPDATE trip_emails SET status = ?, note = ?, sent_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(status, note, sentAt, now(), row.id, row.user_id).run();
}

/** The hard, unpaid payment a payment email is about, as it stands right now. */
async function openPayment(env, row) {
  const wanted = row.kind.startsWith('deposit') ? 'deposit' : 'final';
  const { results } = await env.DB.prepare(
    `SELECT amount_cents, due_date FROM booking_payments
      WHERE booking_id = ? AND user_id = ? AND kind = ? AND payment_class = 'hard'
        AND paid_date IS NULL AND due_date IS NOT NULL
      ORDER BY due_date ASC LIMIT 1`
  ).bind(row.booking_id, row.user_id, wanted).all();
  return (results || [])[0] || null;
}

/** Send whatever is due. One client's bounced address never stops the others. */
export async function sendDueTripEmails(env, { at = now(), limit = 40 } = {}) {
  const today = isoDay(at);
  const hour = new Date(at * 1000).getUTCHours();
  const daytime = hour >= FIRST_HOUR && hour <= LAST_HOUR ? 1 : 0;
  const out = { sent: 0, failed: 0, expired: 0, dropped: 0, waiting: 0, considered: 0 };

  const { results } = await env.DB.prepare(
    `SELECT te.id, te.booking_id, te.user_id, te.kind, te.due_on,
            b.status, b.product_name, b.supplier, b.destination, b.client_name, b.client_id,
            b.confirmation_number, b.depart_date, b.return_date,
            u.first_name, u.last_name, u.email AS advisor_email, u.notify_email, u.agency_id, u.agency_name,
            u.phone AS advisor_phone
       FROM trip_emails te
       JOIN bookings b ON b.id = te.booking_id
       JOIN users u ON u.id = te.user_id
       JOIN agencies a ON a.id = u.agency_id
      WHERE te.status = 'scheduled' AND te.due_on <= ? AND a.trip_emails_since IS NOT NULL
        AND b.emails_off = 0 AND (te.kind = 'confirmed' OR ? = 1)
      ORDER BY te.due_on ASC LIMIT ?`
  ).bind(today, daytime, limit).all();

  out.considered = (results || []).length;
  const wordings = new Map();

  for (const row of results || []) {
    // Too late is worse than never.
    if (daysBetween(row.due_on, today) > STALE_DAYS) {
      await settle(env, row, 'expired', 'It was not sent in time, so it was dropped.');
      out.expired += 1;
      continue;
    }
    const okStatus = row.kind === 'home_1' ? ['booked', 'travelled'] : ['booked'];
    if (!okStatus.includes(row.status)) {
      await settle(env, row, 'not_needed', 'The reservation is not booked any more.');
      out.dropped += 1;
      continue;
    }

    let pay = null;
    if (PAYMENT_KINDS.has(row.kind)) {
      pay = await openPayment(env, row);
      if (!pay) {
        await settle(env, row, 'not_needed', 'There was nothing left to pay.');
        out.dropped += 1;
        continue;
      }
    }

    const client = row.client_id
      ? await db.getClient(env, db.selfScope({ id: row.user_id }), { id: row.client_id }).catch(() => null)
      : null;
    const to = client && client.email;
    // No address yet: leave it. The advisor may add one, and the three day rule ends it if they do not.
    if (!to) { out.waiting += 1; continue; }

    if (await isSuppressed(env, row.agency_id, to)) {
      await settle(env, row, 'skipped', 'The client asked not to get automatic email.');
      out.dropped += 1;
      continue;
    }

    if (!wordings.has(row.agency_id)) wordings.set(row.agency_id, await wordingFor(env, row.agency_id));
    const vars = varsFor(row, client, today, pay);
    try {
      const msg = await composeEmail(env, {
        kind: row.kind, wording: wordings.get(row.agency_id), vars, userId: row.user_id });
      await sendHtml(env, {
        to,
        replyTo: row.notify_email || row.advisor_email,
        subject: msg.subject,
        html: msg.html,
        unsubscribe: { agencyId: row.agency_id || null, agencyName: row.agency_name || '' },
      });
      await settle(env, row, 'sent', null, now());
      out.sent += 1;
    } catch (e) {
      if (e instanceof PermanentError) {
        await settle(env, row, 'failed', String(e.message || e).slice(0, 200));
        out.failed += 1;
      } else {
        // A hiccup on the mail provider's side: leave it for the next pass.
        console.error('trip email', row.id, e);
        out.waiting += 1;
      }
    }
  }
  return out;
}

/** The cron job: plan, then send. */
export async function runTripEmails(env) {
  const planned = await planTripEmails(env);
  const sent = await sendDueTripEmails(env);
  return { planned, sent };
}

// ---------------------------------------------------------------------------
// The reservation page
// ---------------------------------------------------------------------------

async function agencySwitch(env, agencyId) {
  const row = agencyId
    ? await env.DB.prepare('SELECT trip_emails_since FROM agencies WHERE id = ?').bind(agencyId).first()
    : null;
  return row && row.trip_emails_since ? Number(row.trip_emails_since) : null;
}

async function shapeForBooking(env, owner, booking) {
  const since = await agencySwitch(env, owner.agency_id);
  const client = booking.client_id
    ? await db.getClient(env, db.selfScope({ id: owner.id }), { id: booking.client_id }).catch(() => null)
    : null;
  const base = {
    on: Boolean(since), emailsOff: Boolean(booking.emails_off), clientEmail: (client && client.email) || '',
    items: [], reason: '',
  };
  if (!since) {
    base.reason = 'Automatic client emails are switched off for your agency. Your owner can switch them on.';
    return base;
  }
  if (booking.created_at <= since) {
    base.reason = 'The automatic emails were switched on after this reservation was made, so none go out for it.';
    return base;
  }
  if (booking.status === 'quoted') {
    base.reason = 'The emails are planned once this is a booked reservation.';
    return base;
  }
  // Planned the moment it is looked at, so an advisor who has just booked a trip sees what will go without waiting
  // for the next pass. The pass does the same thing for everything else.
  await planTripEmails(env, { bookingId: booking.id }).catch((e) => console.error('trip email plan', e));
  const { results } = await env.DB.prepare(
    `SELECT kind, due_on, status, sent_at, note FROM trip_emails WHERE booking_id = ? AND user_id = ?`
  ).bind(booking.id, owner.id).all();
  const order = new Map(KINDS.map((k, i) => [k.kind, i]));
  base.items = (results || []).filter((r) => BY_KIND.has(r.kind))
    .sort((a, b) => (a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : order.get(a.kind) - order.get(b.kind)))
    .map((r) => ({
      kind: r.kind, label: BY_KIND.get(r.kind).label, dueOn: r.due_on, status: r.status,
      statusLabel: STATUS_LABEL[r.status] || r.status, sentAt: r.sent_at || null, note: r.note || '',
      canSkip: r.status === 'scheduled', canRestore: r.status === 'skipped',
    }));
  if (!base.items.length) base.reason = 'The emails for this reservation will be planned within a few minutes.';
  return base;
}

/** GET /api/bookings/:id/trip-emails */
export async function handleGetBookingTripEmails(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');
  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');
  return json(await shapeForBooking(env, owner, booking));
}

/** GET /api/bookings/:id/trip-emails/preview?kind= : one email as this client would be sent it, so nobody has to guess. */
export async function handlePreviewBookingTripEmail(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');
  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');
  const kind = new URL(request.url).searchParams.get('kind');
  if (!BY_KIND.has(kind)) return badRequest('Which email?');

  const client = booking.client_id
    ? await db.getClient(env, db.selfScope({ id: owner.id }), { id: booking.client_id }).catch(() => null)
    : null;
  const today = new Date().toISOString().slice(0, 10);
  const pay = PAYMENT_KINDS.has(kind) ? await openPayment(env, { kind, booking_id: booking.id, user_id: owner.id }) : null;
  const vars = varsFor({
    ...booking, first_name: owner.first_name, last_name: owner.last_name, advisor_email: owner.email, agency_name: owner.agency_name,
    advisor_phone: owner.phone,
  }, client, today, pay);
  const msg = await composeEmail(env, { kind, wording: await wordingFor(env, owner.agency_id), vars, userId: owner.id });
  return json({ subject: msg.subject, paragraphs: msg.paragraphs, to: (client && client.email) || '' });
}

/** PUT /api/bookings/:id/trip-emails { emailsOff?, skip?, restore? } */
export async function handleSaveBookingTripEmails(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');
  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');
  const body = await readJson(request);
  const ts = now();

  if (typeof body.emailsOff === 'boolean') {
    await env.DB.prepare('UPDATE bookings SET emails_off = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(body.emailsOff ? 1 : 0, ts, bookingId, owner.id).run();
    booking.emails_off = body.emailsOff ? 1 : 0;
  }
  if (body.skip && BY_KIND.has(body.skip)) {
    await env.DB.prepare(
      `UPDATE trip_emails SET status = 'skipped', note = 'You skipped this one.', updated_at = ?
        WHERE booking_id = ? AND user_id = ? AND kind = ? AND status = 'scheduled'`
    ).bind(ts, bookingId, owner.id, body.skip).run();
  }
  if (body.restore && BY_KIND.has(body.restore)) {
    await env.DB.prepare(
      `UPDATE trip_emails SET status = 'scheduled', note = NULL, updated_at = ?
        WHERE booking_id = ? AND user_id = ? AND kind = ? AND status = 'skipped'`
    ).bind(ts, bookingId, owner.id, body.restore).run();
  }
  return json({ ok: true, ...(await shapeForBooking(env, owner, booking)) });
}

// ---------------------------------------------------------------------------
// The owner's page
// ---------------------------------------------------------------------------

const SAMPLE = {
  first_name: 'Alex', thanks: 'Thank you for filling in our Free Guide form.', trip: 'Harmony of the Seas cruise', start_date: '03/13/2027', return_date: '03/20/2027',
  days_to_go: '60', confirmation: '9746343', amount: '$1,000.00', due_date: '12/13/2026',
  advisor: 'Your Advisor', phone: '(555) 123-4567', agency: 'Your Agency',
};

async function settingsFor(env, user) {
  const since = await agencySwitch(env, user.agency_id);
  const wording = await wordingFor(env, user.agency_id);
  const thirty = now() - 30 * 86400;
  const sent = await env.DB.prepare(
    `SELECT te.kind AS kind, COUNT(*) AS n
       FROM trip_emails te
       JOIN users u ON u.id = te.user_id
      WHERE u.agency_id = ? AND te.status = 'sent' AND te.sent_at >= ?
      GROUP BY te.kind`
  ).bind(user.agency_id, thirty).all().catch(() => ({ results: [] }));
  const counts = new Map((sent.results || []).map((r) => [r.kind, r.n]));
  // The last few that went, or could not, so an owner can see what clients were actually sent and by whom.
  const recent = await env.DB.prepare(
    `SELECT te.kind AS kind, te.status AS status, te.sent_at AS sent_at, te.updated_at AS at, te.note AS note,
            te.booking_id AS booking_id, b.client_name AS client_name,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email) AS advisor
       FROM trip_emails te
       JOIN bookings b ON b.id = te.booking_id
       JOIN users u ON u.id = te.user_id
      WHERE u.agency_id = ? AND te.status IN ('sent', 'failed')
      ORDER BY COALESCE(te.sent_at, te.updated_at) DESC LIMIT 25`
  ).bind(user.agency_id).all().catch(() => ({ results: [] }));
  return {
    recent: (recent.results || []).filter((r) => BY_KIND.has(r.kind)).map((r) => ({
      label: BY_KIND.get(r.kind).label, status: r.status, at: r.sent_at || r.at, note: r.note || '',
      bookingId: r.booking_id, client: r.client_name || '', advisor: r.advisor || '',
    })),
    on: Boolean(since), since,
    variables: VARIABLES.map(([name, what]) => ({ name, what })),
    kinds: ALL_KINDS.map((k) => {
      const w = wording.get(k.kind);
      return {
        kind: k.kind, label: k.label, when: k.when, subject: w.subject, body: w.body, custom: w.custom,
        defaultSubject: k.subject, defaultBody: k.body, sent30: counts.get(k.kind) || 0,
      };
    }),
  };
}

function checkWords(text, label) {
  const known = new Set(VARIABLES.map(([n]) => n));
  for (const w of wordsIn(text)) {
    if (!known.has(w)) return `${label} uses {${w}}, which is not one of the words that get filled in.`;
  }
  return '';
}

/** GET /api/trip-emails/settings : an owner's. */
export async function handleGetTripEmailSettings(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('This account is not part of an agency.');
  return json(await settingsFor(env, user));
}

/** PUT /api/trip-emails/settings { on?, wording?: { kind: { subject, body } } } */
export async function handleSaveTripEmailSettings(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('This account is not part of an agency.');
  const body = await readJson(request);
  const ts = now();

  if (body.wording && typeof body.wording === 'object') {
    const writes = [];
    for (const k of ALL_KINDS) {
      const w = body.wording[k.kind];
      if (!w) continue;
      const subject = clean(w.subject, 160);
      const text = cleanText(w.body, 4000);
      const problem = checkWords(subject, `The subject of "${k.label}"`) || checkWords(text, `The message of "${k.label}"`);
      if (problem) return badRequest(problem);
      const sameSubject = !subject || subject === k.subject;
      const sameBody = !text || text === k.body;
      if (sameSubject && sameBody) {
        writes.push(env.DB.prepare('DELETE FROM trip_email_wording WHERE agency_id = ? AND kind = ?')
          .bind(user.agency_id, k.kind));
      } else {
        writes.push(env.DB.prepare(
          `INSERT INTO trip_email_wording (agency_id, kind, subject, body, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (agency_id, kind) DO UPDATE SET subject = excluded.subject, body = excluded.body,
             updated_at = excluded.updated_at`
        ).bind(user.agency_id, k.kind, sameSubject ? null : subject, sameBody ? null : text, ts));
      }
    }
    if (writes.length) await env.DB.batch(writes);
    await db.logActivity(env, user.id, 'tripemails.wording', 'Changed the wording of the automatic client emails');
  }

  if (typeof body.on === 'boolean') {
    const current = await agencySwitch(env, user.agency_id);
    if (body.on && !current) {
      // Only reservations made from this moment are planned. See the header.
      await env.DB.prepare('UPDATE agencies SET trip_emails_since = ?, updated_at = ? WHERE id = ?')
        .bind(ts, ts, user.agency_id).run();
      await db.logActivity(env, user.id, 'tripemails.on', 'Switched on the automatic client emails');
    } else if (!body.on && current) {
      await env.DB.prepare('UPDATE agencies SET trip_emails_since = NULL, updated_at = ? WHERE id = ?')
        .bind(ts, user.agency_id).run();
      await db.logActivity(env, user.id, 'tripemails.off', 'Switched off the automatic client emails');
    }
  }
  return json({ ok: true, ...(await settingsFor(env, user)) });
}

/** POST /api/trip-emails/test { kind, subject?, body?, send? } : how one reads, and optionally to the owner. */
export async function handleTestTripEmail(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('This account is not part of an agency.');
  const body = await readJson(request);
  const def = BY_KIND.get(body.kind) || (body.kind === LEAD_HELLO.kind ? LEAD_HELLO : null);
  if (!def) return badRequest('Which email?');

  const wording = await wordingFor(env, user.agency_id);
  const subject = clean(body.subject, 160) || wording.get(def.kind).subject;
  const text = cleanText(body.body, 4000) || wording.get(def.kind).body;
  const problem = checkWords(subject, 'The subject') || checkWords(text, 'The message');
  if (problem) return badRequest(problem);
  wording.set(def.kind, { subject, body: text, custom: true });

  const advisor = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
  const vars = { ...SAMPLE, advisor, phone: user.phone || SAMPLE.phone, agency: user.agency_name || SAMPLE.agency };
  const msg = await composeEmail(env, { kind: def.kind, wording, vars, userId: user.id });

  if (body.send) {
    const to = user.notify_email || user.email;
    try {
      await sendHtml(env, {
        to, subject: `[Test] ${msg.subject}`, html: msg.html,
        unsubscribe: { agencyId: user.agency_id, agencyName: user.agency_name || '' },
      });
    } catch (e) {
      return badRequest(e instanceof PermanentError ? String(e.message) : 'The test could not be sent. Try again in a minute.');
    }
    return json({ ok: true, sentTo: to, subject: msg.subject, paragraphs: msg.paragraphs });
  }
  return json({ ok: true, subject: msg.subject, paragraphs: msg.paragraphs });
}
