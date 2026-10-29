// A forwarded confirmation that reads cleanly becomes a reservation without anybody pressing anything.
//
// Everything the Import page does when its button is pressed is done here, in the same order and through the same
// handlers: the reservation, the guests as travellers and as clients, the price guest by guest, what the client has
// already paid, the cancellation terms and the dates they put on the task list, the day by day ports, and the PDF kept
// on the reservation. It is done by asking the portal's own API as the advisor, under a session that lives for ten
// minutes and is deleted afterwards, so every rule that governs a person pressing the button (a lapsed membership, a
// date that is not a date, a pricing grid that does not add up) governs this too. Nothing here writes a table directly.
//
// It only ever acts when it is sure, and "sure" is deliberately narrow:
//
//   - The message came from the advisor themself. The address a confirmation is forwarded to is a first name, which is
//     guessable, so a stranger who knows it could otherwise put reservations on somebody's books and, once the client
//     emails are on, put an email to any address they like in the advisor's name. The sender has to be the advisor's own
//     address, and the mail system has to say it checked that (SPF or DKIM pass).
//   - Every essential was read: the client, the confirmation number, the cruise line, the ship, both dates and the total.
//   - It is a booking, not an offer, and the sailing has not already happened.
//   - A deposit says whether it comes back, and a price split into lines adds up to the total and names every guest.
//   - Nothing on the advisor's books already carries that confirmation number.
//   - No more than twenty in a day, so a loop or a flood stops at twenty.
//
// Anything else is held on the Import page exactly as before, with the reason, and the advisor is told it is waiting.

import { randomToken, sha256Hex } from './util.js';
import { SESSION_COOKIE } from './auth.js';
import * as db from './db.js';
import { looksLikeHeading } from './namecheck.js';

const DAILY_LIMIT = 20;
const cents = (v) => Math.round(Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) * 100) || 0;
const MONEY_KINDS = ['fare', 'taxes', 'insurance', 'gratuities'];

// ---------------------------------------------------------------------------
// Who sent it
// ---------------------------------------------------------------------------

const bareAddress = (v) => {
  const m = String(v || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(v || '')).trim().toLowerCase();
};

/**
 * Whether the mail system vouches for the sender. Looks for the verdict the receiving server wrote into the message and
 * for nothing weaker: a header that is simply absent is treated as not vouched for.
 */
export function senderVouched(headers) {
  const get = (k) => String((headers && headers.get && headers.get(k)) || '').toLowerCase();
  const results = get('authentication-results');
  if (/\b(?:dkim|spf)=pass\b/.test(results) && !/\b(?:dkim|spf)=(?:fail|softfail|temperror|permerror)\b/.test(results)) return true;
  return /^pass\b/.test(get('received-spf'));
}

/** The names of whatever authentication headers did arrive, for the log, so a refusal can be understood. */
export function authHeadersSeen(headers) {
  const seen = [];
  if (headers && headers.forEach) {
    headers.forEach((value, key) => { if (/auth|spf|dkim|dmarc/i.test(key)) seen.push(key); });
  }
  return seen.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Is it clean
// ---------------------------------------------------------------------------

/** How the price is split: one column per guest the document prices, else the trip as one. */
export function priceColumns(read) {
  const pr = read.pricing;
  if (!pr || !pr.lines || !pr.lines.length) return null;
  // The first guest on a confirmation that prints no names is the person the booking is for.
  if (pr.guests && pr.guests.length > 1) {
    const lead = read.fields && read.fields.clientName;
    return pr.guests.map((g, i) => (i === 0 && lead && !String(g.name || '').trim() ? { ...g, name: lead } : g));
  }
  const one = { name: '', fare: '', taxes: '', insurance: '', gratuities: '', commission: (read.fields && read.fields.commission) || '' };
  for (const l of pr.lines) one[l.kind] = l.amount;
  return [one];
}

/** Whether a reading is clean enough to make a reservation from. `why` says what is wrong when it is not. */
export function verdict(read, today) {
  const f = read.fields || {};
  const needs = [['clientName', 'the client'], ['confirmationNumber', 'the confirmation number'], ['supplier', 'the cruise line'],
    ['productName', 'the ship'], ['departDate', 'the departure date'], ['returnDate', 'the return date'], ['gross', 'the trip total']];
  // The cruise line's guest copy carries no commission, and every reservation is made from the agent copy.
  if (read.notice) return { ok: false, why: 'This is the cruise line\u2019s Guest Copy, which has no commission. Forward or upload the Agent Copy for this booking instead.' };
  // The reader said its own read is not whole.
  if (Array.isArray(read.problems) && read.problems.length) return { ok: false, why: read.problems[0] };
  const missing = needs.filter(([k]) => !f[k]).map(([, l]) => l);
  if (missing.length) return { ok: false, why: `I could not read ${missing.join(', ')}.` };
  // A heading read as a name would be filed as a real client and a real reservation.
  if (looksLikeHeading(f.clientName)) return { ok: false, why: 'The name I found, ' + f.clientName + ', looks like a heading and not a guest.' };
  if (cents(f.gross) <= 0) return { ok: false, why: 'I could not read a trip total.' };
  // Worked out and not printed: fine to show for checking, never enough to make a reservation on its own.
  if (Array.isArray(read.derived) && read.derived.includes('returnDate')) {
    return { ok: false, why: 'The return date was worked out from the length of the cruise, not printed, so please check it.' };
  }
  if (String(f.departDate) < today) return { ok: false, why: 'The sailing date has already passed.' };
  if (String(f.returnDate) < String(f.departDate)) return { ok: false, why: 'The return date is before the departure.' };
  if (f.status === 'quoted') return { ok: false, why: 'This one is an offer, not a booking yet.' };
  if (cents(f.deposit) > 0 && !f.depositRefundable) return { ok: false, why: 'It does not say whether the deposit is refundable.' };

  const cols = priceColumns(read);
  if (cols) {
    const sum = cols.reduce((n, c) => n + MONEY_KINDS.reduce((m, k) => m + cents(c[k]), 0), 0);
    if (sum > 0 && Math.abs(sum - cents(f.gross)) > 1) return { ok: false, why: 'The price lines do not add up to the trip total.' };
    if (cols.length > 1 && cols.some((c) => !String(c.name || '').trim())) return { ok: false, why: 'A guest on the price lines has no name.' };
  }
  return { ok: true, why: '' };
}

// ---------------------------------------------------------------------------
// Making it
// ---------------------------------------------------------------------------

/** The advisor's own API for a few minutes: a session made here, used through the router, and deleted at the end. */
async function asAdvisor(env, userId, dispatch, base) {
  const token = randomToken();
  const hash = await sha256Hex(token);
  await db.createSession(env, userId, hash, 600);
  const call = async (method, path, body, form) => {
    const headers = { Cookie: `${SESSION_COOKIE}=${token}` };
    const init = { method, headers };
    if (form) init.body = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await dispatch(new Request(`${base}${path}`, init));
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw new Error((data && data.error) || `That failed with status ${res.status}.`);
    return data;
  };
  return { call, end: () => db.deleteSession(env, hash).catch(() => {}) };
}

/** The guests to file, the client first, with what is known about each. */
function guestsToFile(read, clientName, people) {
  const priced = (read.pricing && read.pricing.guests) || [];
  const names = people.length ? people.map((g) => ({ name: g.name, dob: g.dob }))
    : (read.guests || []).map((n, i) => ({ name: n, dob: (priced[i] || {}).dob || null }));
  const contact = read.client || {};
  const lead = String(clientName || '').trim().toLowerCase();
  const list = names.filter((g) => g.name);
  const at = list.findIndex((g) => g.name.trim().toLowerCase() === lead);
  if (at > 0) list.unshift(list.splice(at, 1)[0]);
  if (!list.length && lead) list.push({ name: String(clientName).trim(), dob: contact.birthday || null });
  return list.map((g, i) => ({
    name: g.name, birthday: g.dob || (i === 0 ? contact.birthday : null) || null,
    email: i === 0 ? contact.email || null : null, phone: i === 0 ? contact.phone || null : null,
  }));
}

/** The pricing grid body the portal expects. `ids` are the new travellers by column, or null for one price. */
function pricingBody(read, cols, ids) {
  const cells = [];
  cols.forEach((c, i) => {
    for (const kind of MONEY_KINDS) {
      const v = cents(c[kind]);
      if (v > 0) cells.push({ travellerId: ids ? ids[i] : null, kind, amount: String(v / 100), commissionable: kind === 'fare' });
    }
  });
  const commissions = [];
  cols.forEach((c, i) => {
    const v = cents(c.commission);
    if (v > 0) commissions.push({ travellerId: ids ? ids[i] : null, kind: 'base', amount: String(v / 100) });
  });
  const guests = (read.pricing && read.pricing.guests) || [];
  if (ids) {
    guests.forEach((g, i) => {
      const v = cents(g.commissionPackage);
      if (v > 0) commissions.push({ travellerId: ids[i], kind: 'package', amount: String(v / 100) });
    });
  } else {
    const v = cents(read.fields && read.fields.commissionPackage);
    if (v > 0) commissions.push({ travellerId: null, kind: 'package', amount: String(v / 100) });
  }
  const rate = Number(read.pricing && read.pricing.ratePct);
  return { cells, commissions, rates: Number.isFinite(rate) && rate > 0 ? [{ kind: 'fare', pct: rate }] : [] };
}

/** What the client has already paid goes onto the schedule, earliest payment first, and any rest is a payment of its own. */
async function recordPaid(call, bookingId, body) {
  let left = cents(body.paid);
  if (left <= 0) return;
  const paidOn = body.paidOn || new Date().toISOString().slice(0, 10);
  const rec = await call('GET', `/api/bookings/${encodeURIComponent(bookingId)}/record`);
  const open = (rec.payments || []).filter((p) => p.payment_class === 'hard' && !p.paid_date && p.kind !== 'refund')
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  for (const p of open) {
    if (left <= 0) break;
    const part = Math.min(left, p.amount_cents || 0);
    if (part <= 0) continue;
    await call('POST', `/api/payments/${encodeURIComponent(p.id)}/paid`, { paidDate: paidOn, amount: (part / 100).toFixed(2) });
    left -= part;
  }
  if (left > 0) {
    const total = cents(body.gross);
    const kind = total > 0 && left >= total ? 'final' : (cents(body.deposit) > 0 && left <= cents(body.deposit) ? 'deposit' : 'installment');
    await call('POST', '/api/payments', { bookingId, kind, amount: (left / 100).toFixed(2), dueDate: paidOn, paidDate: paidOn, paymentClass: 'hard' });
  }
}

/** The cancellation rows: what the confirmation printed, else the supplier's standard terms from its vendor page. */
async function penaltyRowsFor(call, read) {
  const f = read.fields;
  const rows = [];
  const tiers = read.penalties || [];
  for (const t of tiers) {
    const amt = t.perGuestCents !== null && t.perGuestCents !== undefined;
    const value = amt ? t.perGuestCents / 100 : Number(t.pct);
    if (Number.isFinite(value) && value > 0) rows.push({ fromDays: Number(t.fromDays), value, kind: amt ? 'amt' : 'pct', date: t.date || null });
  }
  if (rows.length || !f.supplier) return rows;
  try {
    const found = await call('GET', `/api/vendors?q=${encodeURIComponent(f.supplier)}`);
    const vendor = (found.vendors || []).find((v) => String(v.name).toLowerCase() === String(f.supplier).toLowerCase());
    if (!vendor) return rows;
    const saved = (await call('GET', `/api/penalties?vendor=${encodeURIComponent(vendor.id)}`)).tiers || [];
    const guests = Number(f.travellers) || (read.guests || []).length || 1;
    for (const t of saved) {
      const date = f.departDate ? new Date(Date.parse(`${f.departDate}T00:00:00Z`) - t.from_days * 86400000).toISOString().slice(0, 10) : null;
      const amt = t.amount_cents ? Math.round(t.amount_cents / guests) : null;
      const value = amt ? amt / 100 : Number(t.pct);
      if (Number.isFinite(value) && value > 0) rows.push({ fromDays: Number(t.from_days), value, kind: amt ? 'amt' : 'pct', date });
    }
  } catch { /* none to add; the advisor can type them */ }
  return rows;
}

const sayDay = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/** Saves the cancellation terms and puts the deposit, the final payment and each cancellation date on the task list. */
async function saveTermsAndTasks(call, bookingId, body, rows, guests) {
  const failed = [];
  for (const r of rows) {
    const note = r.date ? `Starts ${sayDay(r.date)}` : '';
    const send = r.kind === 'amt'
      ? { bookingId, fromDays: r.fromDays, amount: (r.value * guests).toFixed(2), note: `${note}${note ? ', ' : ''}${r.value.toFixed(2)} a guest`.trim() }
      : { bookingId, fromDays: r.fromDays, pct: r.value, note };
    try { await call('POST', '/api/penalties', send); } catch { failed.push('a cancellation term'); }
  }
  const today = new Date().toISOString().slice(0, 10);
  const who = body.clientName || 'the client';
  const dates = [];
  if (body.depositDue) dates.push([body.depositDue, `Deposit due for ${who}`]);
  if (body.finalPaymentDue) dates.push([body.finalPaymentDue, `Final payment due for ${who}`]);
  for (const r of rows) {
    if (r.date) dates.push([r.date, r.kind === 'amt' ? `Cancelling now costs ${r.value.toFixed(2)} a guest for ${who}` : `Cancelling now costs ${r.value}% for ${who}`]);
  }
  for (const [due, title] of dates.filter(([d]) => d >= today)) {
    try { await call('POST', '/api/tasks', { title, dueDate: due, bookingId }); } catch { failed.push('a task'); }
  }
  return failed;
}

/**
 * Make the reservation from a reading. Returns { held: true, reason } when it did not, having made nothing, or
 * { created: true, bookingId, problems } when it did, where problems lists any step after the reservation that did not
 * go through, in words the advisor can act on.
 */
export async function autoCreate(env, { user, read, pdf, headers, from, dispatch, base }) {
  const today = new Date().toISOString().slice(0, 10);
  const f = read.fields || {};

  const a = verdict(read, today);
  if (!a.ok) return { held: true, reason: a.why };

  const mine = new Set([user.email, user.notify_email].filter(Boolean).map((e) => String(e).toLowerCase()));
  if (!mine.has(bareAddress(from))) return { held: true, reason: 'It did not come from your own email address.' };
  if (!senderVouched(headers)) return { held: true, reason: 'The mail system did not confirm who sent it.', seen: authHeadersSeen(headers) };

  const dup = await env.DB.prepare(
    'SELECT id FROM bookings WHERE user_id = ? AND confirmation_number = ? LIMIT 1'
  ).bind(user.id, String(f.confirmationNumber)).first().catch(() => null);
  if (dup) return { held: true, reason: `You already have a reservation with confirmation number ${f.confirmationNumber}.` };

  const day = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ? AND kind = 'inbox.autocreated' AND created_at > ?"
  ).bind(user.id, Math.floor(Date.now() / 1000) - 86400).first().catch(() => ({ n: 0 }));
  if ((day && day.n) >= DAILY_LIMIT) return { held: true, reason: `That is more than ${DAILY_LIMIT} in a day, so the rest wait for you.` };

  const session = await asAdvisor(env, user.id, dispatch, base);
  const { call } = session;
  const problems = [];
  let bookingId = null;
  try {
    // As the page sends it: every value a string, and only what was read.
    const body = { status: 'booked' };
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') body[k] = typeof v === 'string' ? v : String(v);
    body.status = 'booked';
    const made = await call('POST', '/api/bookings', body);
    bookingId = made.booking.id;

    const cols = priceColumns(read);
    const splitByGuest = Boolean(cols && cols.length > 1);
    const people = splitByGuest ? cols.map((c) => ({ name: String(c.name).trim(), dob: c.dob || null })) : [];
    const hasLines = Boolean(cols && cols.some((c) => MONEY_KINDS.some((k) => cents(c[k]) > 0)));
    const filing = guestsToFile(read, f.clientName, people);

    let travellersMade = false;
    if (hasLines) {
      try {
        let ids = null;
        if (splitByGuest) {
          ids = [];
          for (let i = 0; i < people.length; i += 1) {
            const t = await call('POST', `/api/bookings/${encodeURIComponent(bookingId)}/travellers`,
              { name: people[i].name, dob: people[i].dob, isLead: i === 0 });
            ids.push(t.id);
          }
          travellersMade = true;
        }
        await call('PUT', `/api/bookings/${encodeURIComponent(bookingId)}/pricing`, pricingBody(read, cols, ids));
      } catch (e) { problems.push(`the price was not saved on the Pricing tab: ${e.message}`); }
    }
    if (!travellersMade) {
      for (let i = 0; i < filing.length; i += 1) {
        try {
          await call('POST', `/api/bookings/${encodeURIComponent(bookingId)}/travellers`, {
            name: filing[i].name, dob: filing[i].birthday, email: filing[i].email, phone: filing[i].phone, isLead: i === 0 });
        } catch { /* they can be added on the Travellers tab */ }
      }
    }
    if (filing.length) {
      // Somebody already on the books keeps what is on file: nothing is accepted for them. New people are added whole.
      try { await call('POST', '/api/import/guests', { guests: filing, preview: false, accept: [], household: true }); }
      catch (e) { problems.push(`the guests were not filed as clients: ${e.message}`); }
    }
    if (cents(f.paid) > 0) {
      try { await recordPaid(call, bookingId, body); } catch (e) { problems.push(`the payments already made were not recorded: ${e.message}`); }
    }
    const rows = await penaltyRowsFor(call, read);
    const guests = Number(f.travellers) || (read.guests || []).length || 1;
    const failed = await saveTermsAndTasks(call, bookingId, body, rows, guests);
    if (failed.length) problems.push(`${failed.length} of the cancellation terms or tasks were not saved`);
    if (!rows.length) problems.push('there are no cancellation terms to save, so add them from the supplier');

    if (read.itinerary && read.itinerary.length) {
      try {
        for (const item of read.itinerary) await call('POST', `/api/bookings/${encodeURIComponent(bookingId)}/itinerary`, item);
      } catch (e) { problems.push(`the itinerary was not saved: ${e.message}`); }
    }
    if (pdf && pdf.bytes && pdf.bytes.length) {
      try {
        const form = new FormData();
        form.append('file', new Blob([pdf.bytes], { type: 'application/pdf' }), pdf.filename || 'confirmation.pdf');
        form.append('category', 'confirmation');
        await call('POST', `/api/bookings/${encodeURIComponent(bookingId)}/documents`, undefined, form);
      } catch (e) { problems.push(`the PDF was not kept: ${e.message}`); }
    }
    await db.logActivity(env, user.id, 'inbox.autocreated',
      `Made a reservation for ${f.clientName} from a forwarded confirmation`, { id: bookingId, problems: problems.length });
    return { created: true, bookingId, problems };
  } catch (e) {
    // Once the reservation exists it is never reported as held, or the advisor would make it a second time from the
    // Import page. Whatever stopped the rest is said, and they finish it on the reservation.
    if (bookingId) return { created: true, bookingId, problems: [...problems, `something stopped the rest: ${String((e && e.message) || e).slice(0, 120)}`] };
    return { held: true, reason: String((e && e.message) || e).slice(0, 200) };
  } finally {
    await session.end();
  }
}
