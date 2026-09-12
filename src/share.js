// The page a client can open.
//
// Everything this portal knows about a trip stopped at the advisor's screen.
// The client got a PDF in an email and, three weeks later, asked what they had
// paid and when the balance was due, because the answer was in an inbox rather
// than anywhere they could look. This is that answer, on a link.
//
// Read only, deliberately, and there is nothing to pay here even in principle:
// the client pays the supplier, and the money never passes through the agency.
// The schedule on this page is a record of what the supplier is owed and when,
// not an invoice from the advisor. Saying that plainly matters, because a page
// that lists amounts and due dates without saying who they are paid to reads
// like a bill from whoever's name is at the top.
//
// A client can see what is booked, what is paid, what is due and which options
// were offered; they cannot accept or change anything. What they can do is say
// something, which lands as a message on the reservation and an email to the
// advisor, because "tell me" only works if telling you is easier than not
// bothering.
//
// Three things it must never show, and the reason each is easy to leak:
//   - Commission. It sits on the booking, on every pricing line, and on the
//     agent confirmation PDF the importer reads.
//   - The price breakdown. Every kind is a real charge the client pays, but
//     one of them is called Mark up, and a page that lists it is a page that
//     starts an argument. The total and the schedule are what a client needs.
//   - Passport numbers. Travellers carry them; this shows names.

import { json, badRequest, notFound, clean, cleanText, uid, now, sha256Hex, readJson }
  from './util.js';
import { brandForUser, DEFAULT_BRAND, HEX_COLOR } from './brand.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { sendTripMessageEmail, sendOptionChosenEmail } from './email.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (cents) => (Number(cents) || 0) / 100 === 0 ? '$0'
  : (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function sayDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US',
    { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function shortDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function nights(from, to) {
  if (!from || !to) return null;
  const n = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  return n > 0 && n < 400 ? n : null;
}

/**
 * The address, which is not the booking id.
 *
 * A trip page reachable by counting is not a page, and the id already appears
 * in links the advisor opens with somebody looking over their shoulder.
 */
function shareCode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

// ---------------------------------------------------------------------------
// The advisor's side: turning it on, and choosing what the client sees
// ---------------------------------------------------------------------------

export async function handleShareTrip(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const on = body.on !== false;

  const booking = await db.getBooking(env, id, user.id);
  if (!booking) return notFound('Reservation not found.');

  if (!on) {
    // The code is dropped rather than kept and hidden. A link that stops
    // working and then starts working again months later, pointing at a trip
    // whose details have moved on, is worse than a link that is gone.
    await env.DB.prepare(
      'UPDATE bookings SET share_code = NULL, shared_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(now(), id, user.id).run();
    await db.logActivity(env, user.id, 'trip.unshare',
      `Stopped sharing ${booking.client_name}'s trip`, { id });
    return json({ ok: true, shared: false, code: null });
  }

  const code = booking.share_code || shareCode();
  await env.DB.prepare(
    'UPDATE bookings SET share_code = ?, shared_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(code, booking.shared_at || now(), now(), id, user.id).run();
  await db.logActivity(env, user.id, 'trip.share',
    `Shared ${booking.client_name}'s trip`, { id });

  return json({ ok: true, shared: true, code, url: `${appUrl(env)}/t/${code}` });
}

/** Which documents the client may download. Off until said otherwise. */
export async function handleShareDocument(request, env, docId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);
  const res = await env.DB.prepare(
    'UPDATE documents SET shared = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(body.shared ? 1 : 0, now(), docId, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Document not found.');
  return json({ ok: true, shared: Boolean(body.shared) });
}

/** What the client has said back. */
export async function handleTripMessages(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'm.user_id');
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.body, m.read_at, m.created_at FROM trip_messages m
      WHERE m.booking_id = ? AND ${scoped.sql} ORDER BY m.created_at DESC LIMIT 100`
  ).bind(id, ...scoped.binds).all();
  return json({ messages: results || [] });
}

export async function handleReadTripMessage(request, env, msgId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  await env.DB.prepare(
    'UPDATE trip_messages SET read_at = ? WHERE id = ? AND user_id = ?'
  ).bind(now(), msgId, user.id).run();
  return json({ ok: true });
}

function appUrl(env) {
  return (env.APP_URL || 'https://cttagents.com').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// The client's side
// ---------------------------------------------------------------------------

async function loadTrip(env, code) {
  const booking = await env.DB.prepare(
    `SELECT b.*, u.first_name, u.last_name, u.email AS advisor_email,
            u.notify_email, u.phone AS advisor_phone, u.agency_name,
            u.agency_address, u.seller_of_travel
       FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.share_code = ?`
  ).bind(code).first();
  if (!booking) return null;

  // Every one names the owner as well as the booking. The share code already
  // decided which trip this is, so the owner is redundant in the sense that it
  // cannot change the answer — and that is exactly why it belongs here: a
  // query on a public page that says whose rows it wants can be read once and
  // believed, and one that does not has to be traced back to the lookup above.
  const owner = booking.user_id;
  const [travellers, components, options, payments, documents, itinerary] = await Promise.all([
    // Names only. The row carries passport numbers and dates of birth, and a
    // page that selects * is a page one careless template change away from
    // publishing them.
    env.DB.prepare(`SELECT name, is_lead FROM travellers
                     WHERE booking_id = ? AND user_id = ? ORDER BY is_lead DESC, name ASC`)
      .bind(booking.id, owner).all(),
    env.DB.prepare(`SELECT kind, product_name, supplier, start_date, end_date, confirmation_number
                      FROM components WHERE booking_id = ? AND user_id = ? ORDER BY sort_order ASC`)
      .bind(booking.id, owner).all(),
    // The id is needed now that the client can choose one, and the picture and
    // inclusions are what make three lines of text into a choice anybody
    // enjoys making.
    env.DB.prepare(`SELECT id, label, detail, amount_cents, chosen, image_url, inclusions,
                           chosen_at, chosen_by
                      FROM quote_options
                     WHERE booking_id = ? AND user_id = ? ORDER BY sort_order ASC`)
      .bind(booking.id, owner).all(),
    env.DB.prepare(`SELECT kind, amount_cents, due_date, paid_date FROM booking_payments
                     WHERE booking_id = ? AND user_id = ? ORDER BY COALESCE(due_date, paid_date) ASC`)
      .bind(booking.id, owner).all(),
    env.DB.prepare(`SELECT id, filename, category, size_bytes FROM documents
                     WHERE booking_id = ? AND user_id = ? AND shared = 1 ORDER BY created_at ASC`)
      .bind(booking.id, owner).all(),
    // Only when the advisor has said it is ready. A half-written itinerary is
    // worse than none: four days filled in and three blank reads as a trip
    // with nothing planned after Wednesday.
    booking.itinerary_shared
      ? env.DB.prepare(`SELECT day_number, start_time, end_time, kind, title, location,
                               detail, confirmation, image_url
                          FROM itinerary_items WHERE booking_id = ? AND user_id = ?
                         ORDER BY day_number IS NULL ASC, day_number ASC,
                                  start_time IS NULL ASC, start_time ASC, sort_order ASC`)
        .bind(booking.id, owner).all()
      : Promise.resolve({ results: [] }),
  ]);

  return {
    booking,
    travellers: travellers.results || [],
    components: components.results || [],
    options: options.results || [],
    payments: payments.results || [],
    documents: documents.results || [],
    itinerary: itinerary.results || [],
  };
}

// What each kind of line looks like at a glance. The client is scanning for
// "when is the flight", not reading a list of nouns.
const KIND_MARK = {
  flight: '\u2708', cruise: '\u2693', hotel: '\u1F6CF', transfer: '\u1F698',
  activity: '\u2600', meal: '\u1F374', free: '\u263A', note: '\u2139',
};
const KIND_WORD = {
  flight: 'Flight', cruise: 'Cruise', hotel: 'Hotel', transfer: 'Transfer',
  activity: 'Activity', meal: 'Meal', free: 'Free time', note: 'Note',
};

/** 09:30 as half past nine, because a client is reading, not filing. */
function sayTime(hhmm) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return '';
  let h = Number(m[1]);
  const suffix = h < 12 ? 'am' : 'pm';
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${m[2]}${suffix}`;
}

/**
 * The trip day by day.
 *
 * Every day between departure and return appears, including the ones with
 * nothing on them. A numbered list with a gap in it is a question the client
 * has to ask; a day that says "nothing planned" is an answer they can act on,
 * and on a cruise it is usually the best day of the week.
 */
function itineraryBlock(trip) {
  const items = trip.itinerary || [];
  if (!items.length) return '';

  const b = trip.booking;
  const total = tripDays(b.depart_date, b.return_date);
  const anytime = items.filter((i) => !i.day_number);
  const byDay = [];
  for (let n = 1; n <= total; n += 1) {
    byDay.push({ n, date: dayDate(b.depart_date, n), on: items.filter((i) => i.day_number === n) });
  }
  // A day number past the return date is still somebody's plan, and dropping
  // it because the maths says the trip ended would be losing the client's
  // itinerary to a typo in a return date.
  const strays = items.filter((i) => i.day_number && i.day_number > total);
  for (const i of strays) {
    if (!byDay.some((d) => d.n === i.day_number)) {
      byDay.push({ n: i.day_number, date: dayDate(b.depart_date, i.day_number), on: [] });
    }
  }
  for (const d of byDay) d.on = items.filter((i) => i.day_number === d.n);
  byDay.sort((x, y) => x.n - y.n);

  const line = (i) => `<li class="itin-item">
    <span class="itin-when">${i.start_time ? esc(sayTime(i.start_time)) : ''}${
  i.end_time ? ` - ${esc(sayTime(i.end_time))}` : ''}</span>
    <span class="itin-what">
      <span class="itin-kind">${esc(KIND_WORD[i.kind] || 'Item')}</span>
      <strong>${esc(i.title)}</strong>
      ${i.location ? `<span class="itin-where">${esc(i.location)}</span>` : ''}
      ${i.detail ? `<span class="itin-detail">${esc(i.detail)}</span>` : ''}
      ${i.confirmation ? `<span class="itin-conf">Reference ${esc(i.confirmation)}</span>` : ''}
    </span>
    ${i.image_url ? `<img class="itin-pic" src="${esc(i.image_url)}" alt="" loading="lazy">` : ''}
  </li>`;

  return `<section class="card pad">
    <h2>Your itinerary</h2>
    ${anytime.length ? `<ul class="itin-list anytime">${anytime.map(line).join('')}</ul>` : ''}
    ${byDay.map((d) => `<div class="itin-day">
      <p class="itin-daylabel"><strong>Day ${d.n}</strong>${
  d.date ? `<span>${esc(sayDate(d.date))}</span>` : ''}</p>
      ${d.on.length
    ? `<ul class="itin-list">${d.on.map(line).join('')}</ul>`
    : '<p class="itin-empty">Nothing planned. The day is yours.</p>'}
    </div>`).join('')}
  </section>`;
}

/** How many days the trip runs. Mirrors itinerary.js, which the client page
 *  cannot import without pulling the whole admin module onto a public page. */
function tripDays(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a || '')) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b || '')) return 1;
  const n = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
  return n > 0 && n < 400 ? n : 1;
}

function dayDate(depart, n) {
  if (!n || !/^\d{4}-\d{2}-\d{2}$/.test(depart || '')) return null;
  const d = new Date(`${depart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * The options, and a way to answer them.
 *
 * These were read only for a long time, under "tell your advisor below", so
 * the client typed their pick into a message box and somebody transcribed it.
 * Now they can say it here. Choosing does not book anything and does not move
 * a price: it records the answer and tells the advisor, which is exactly what
 * the message box was doing, minus the transcription.
 */
function optionsBlock(trip, advisor) {
  const list = trip.options || [];
  if (!list.length) return '';
  const open = Boolean(trip.booking.options_open);
  const taken = list.find((o) => o.chosen);

  const card = (o) => `<div class="option${o.chosen ? ' on' : ''}">
    ${o.chosen ? '<span class="tick">Chosen</span>' : ''}
    ${o.image_url ? `<img class="opic" src="${esc(o.image_url)}" alt="" loading="lazy">` : ''}
    <p class="olabel">${esc(o.label)}</p>
    ${o.amount_cents ? `<p class="oamount">${esc(money(o.amount_cents))}</p>` : ''}
    ${o.detail ? `<p class="dim">${esc(o.detail)}</p>` : ''}
    ${o.inclusions ? `<p class="oinc">${esc(o.inclusions)}</p>` : ''}
    ${open && !o.chosen
    ? `<button class="obtn" type="button" data-choose="${esc(o.id)}">Choose this one</button>`
    : ''}
  </div>`;

  return `<section class="card pad" id="options">
    <h2>${open ? 'Choose your trip' : 'What was offered'}</h2>
    <p class="dim">${open
    ? `Pick the one you want and ${esc(advisor)} will confirm it. Nothing is booked and nothing `
      + 'is paid by choosing.'
    : `If you would rather have one of the others, tell ${esc(advisor)} below.`}</p>
    ${taken && taken.chosen_by === 'client'
    ? `<p class="ochose">You chose <strong>${esc(taken.label)}</strong>. ${esc(advisor)} will
        confirm it with you.</p>` : ''}
    <div class="options">${list.map(card).join('')}</div>
    <div id="choose-said"></div>
  </section>`;
}

export async function renderTripPage(request, env, code) {
  const trip = await loadTrip(env, clean(code, 40));
  if (!trip) {
    return html(page('Not found', `
      <div class="card pad">
        <h1>This trip page is not available</h1>
        <p class="lede">The link may be out of date, or your advisor may have turned it off.
          Get in touch with them and they will send a new one.</p>
      </div>`), 404);
  }

  const b = trip.booking;
  const advisor = [b.first_name, b.last_name].filter(Boolean).join(' ') || b.agency_name || 'your advisor';
  const nn = nights(b.depart_date, b.return_date);

  const paid = trip.payments.filter((p) => p.paid_date && p.kind !== 'refund')
    .reduce((n, p) => n + (p.amount_cents || 0), 0);
  const refunded = trip.payments.filter((p) => p.paid_date && p.kind === 'refund')
    .reduce((n, p) => n + (p.amount_cents || 0), 0);
  const total = b.gross_cents || 0;
  const owed = Math.max(0, total - paid + refunded);
  const today = new Date().toISOString().slice(0, 10);

  const facts = [
    ['Departs', sayDate(b.depart_date)],
    ['Returns', sayDate(b.return_date)],
    ['Nights', nn ? String(nn) : ''],
    ['Destination', b.destination],
    ['Cabin', [b.cabin_category, b.cabin].filter(Boolean).join(' · ')],
    ['Confirmation', b.confirmation_number],
  ].filter(([, v]) => v);

  const body = `
    <header class="hero">
      <p class="eyebrow">${esc(b.supplier || 'Your trip')}</p>
      <h1>${esc(b.itinerary || b.product_name || 'Your trip')}</h1>
      ${b.product_name && b.itinerary ? `<p class="lede">${esc(b.product_name)}</p>` : ''}
      ${b.depart_date ? `<p class="lede">${esc(sayDate(b.depart_date))}${
        b.return_date ? ` to ${esc(sayDate(b.return_date))}` : ''}</p>` : ''}
    </header>

    ${facts.length ? `<section class="card">
      <dl class="facts">${facts.map(([k, v]) => `<div>
        <dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    </section>` : ''}

    ${trip.travellers.length ? `<section class="card pad">
      <h2>Who is travelling</h2>
      <ul class="plain">${trip.travellers.map((t) => `<li>${esc(t.name)}</li>`).join('')}</ul>
    </section>` : ''}

    ${itineraryBlock(trip)}

    ${trip.components.length ? `<section class="card pad">
      <h2>Also on this trip</h2>
      <ul class="plain">${trip.components.map((c) => `<li>
        <strong>${esc(c.product_name || c.kind)}</strong>
        ${c.supplier ? `<span class="dim"> · ${esc(c.supplier)}</span>` : ''}
        ${c.start_date ? `<div class="dim">${esc(shortDate(c.start_date))}${
          c.end_date ? ` to ${esc(shortDate(c.end_date))}` : ''}</div>` : ''}
      </li>`).join('')}</ul>
    </section>` : ''}

    ${optionsBlock(trip, advisor)}

    ${total || trip.payments.length ? `<section class="card pad">
      <h2>What it costs</h2>
      <div class="totals">
        <div><p class="tlabel">Trip total</p><p class="tvalue">${esc(money(total))}</p></div>
        <div><p class="tlabel">Paid so far</p><p class="tvalue">${esc(money(paid - refunded))}</p></div>
        <div><p class="tlabel">Still to pay</p>
          <p class="tvalue${owed > 0 ? ' owing' : ''}">${esc(money(owed))}</p></div>
      </div>
      ${trip.payments.length ? `<table class="sched">
        <thead><tr><th>Payment</th><th>Date</th><th class="r">Amount</th></tr></thead>
        <tbody>${trip.payments.map((p) => {
          const late = !p.paid_date && p.due_date && p.due_date < today;
          return `<tr>
            <td>${esc(PAYMENT_WORD[p.kind] || 'Payment')}
              ${p.paid_date ? '<span class="pill ok">paid</span>'
                : late ? '<span class="pill late">overdue</span>'
                : '<span class="pill">due</span>'}</td>
            <td>${esc(shortDate(p.paid_date || p.due_date))}</td>
            <td class="r">${esc(money(p.amount_cents))}</td>
          </tr>`;
        }).join('')}</tbody></table>` : ''}
      <p class="dim small">Payments go to ${esc(b.supplier || 'the supplier')}.
        ${esc(advisor)} takes care of each one with you as it falls due, and records it here,
        so this is where to look for what has been paid and what is still outstanding.</p>
    </section>` : ''}

    ${trip.documents.length ? `<section class="card pad">
      <h2>Your documents</h2>
      <ul class="plain docs">${trip.documents.map((d) => `<li>
        <a href="/t/${esc(code)}/d/${esc(d.id)}">${esc(d.filename)}</a>
        ${d.category ? `<span class="dim"> · ${esc(d.category)}</span>` : ''}
      </li>`).join('')}</ul>
    </section>` : ''}

    <section class="card pad">
      <h2>Questions</h2>
      <p class="lede">${esc(advisor)}${b.agency_name ? ` at ${esc(b.agency_name)}` : ''} is
        looking after this trip.</p>
      <p class="contact">
        ${b.notify_email || b.advisor_email
          ? `<a href="mailto:${esc(b.notify_email || b.advisor_email)}">${
              esc(b.notify_email || b.advisor_email)}</a>` : ''}
        ${b.advisor_phone ? `<span class="dim"> · </span><a href="tel:${esc(b.advisor_phone)}">${
          esc(b.advisor_phone)}</a>` : ''}
      </p>
      <form id="say" novalidate>
        <label for="body">Or leave a note and they will come back to you</label>
        <textarea id="body" name="body" rows="4" maxlength="2000"
          placeholder="Anything you want to ask or change."></textarea>
        <div class="hp"><label>Company website<input name="company_website" tabindex="-1"
          autocomplete="off"></label></div>
        <button type="submit">Send it</button>
        <p class="err" id="err" hidden></p>
      </form>
    </section>

    <footer class="foot">
      ${b.agency_name ? `<p>${esc(b.agency_name)}</p>` : ''}
      ${b.agency_address ? `<p class="dim">${esc(b.agency_address)}</p>` : ''}
      ${b.seller_of_travel ? `<p class="dim">${esc(b.seller_of_travel)}</p>` : ''}
    </footer>
    ${SAY_SCRIPT}
    ${CHOOSE_SCRIPT}`;

  return html(page(b.itinerary || b.product_name || 'Your trip', body,
    await brandForUser(env, b.user_id)));
}

const PAYMENT_WORD = {
  deposit: 'Deposit', installment: 'Instalment', final: 'Final payment', refund: 'Refund',
};

export async function handleTripMessage(request, env, code) {
  const trip = await loadTrip(env, clean(code, 40));
  if (!trip) return notFound('This trip page is not available.');

  const body = await readJson(request);
  // A bot fills every field it finds. Thanked rather than told, so it learns
  // nothing about which of the two it was.
  if (clean(body.company_website, 200)) return json({ ok: true, message: 'Thanks.' });

  const text = cleanText(body.body, 2000);
  if (!text) return badRequest('Write something first.');

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`trip:${code}:${ip}`)).slice(0, 32) : null;
  if (ipHash) {
    const seen = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM trip_messages
        WHERE booking_id = ? AND user_id = ? AND ip_hash = ? AND created_at > ?`
    ).bind(trip.booking.id, trip.booking.user_id, ipHash, now() - 3600).first();
    if ((seen?.n || 0) >= 10) {
      return json({ error: 'That is a lot of notes. Give them a ring instead.' }, 429);
    }
  }

  await env.DB.prepare(
    `INSERT INTO trip_messages (id, booking_id, user_id, body, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(uid(), trip.booking.id, trip.booking.user_id, text, ipHash, now()).run();

  // Best effort, and after the row: a note that is saved but not announced is
  // a note the advisor finds; one that is announced but not saved is gone.
  try {
    await sendTripMessageEmail(env, {
      to: trip.booking.notify_email || trip.booking.advisor_email,
      firstName: trip.booking.first_name,
      clientName: trip.booking.client_name,
      tripName: trip.booking.itinerary || trip.booking.product_name || 'their trip',
      body: text,
      href: `${appUrl(env)}/app/reservation?id=${encodeURIComponent(trip.booking.id)}`,
    });
  } catch (e) {
    console.error('trip message mail', e);
  }

  return json({ ok: true, message: 'Sent. They will come back to you.' });
}

/**
 * The client picks one of the options.
 *
 * The page has shown these for a long time and asked the client to describe
 * their pick in a message, which the advisor then transcribed. That is a
 * proposal stopping one step short of the only thing a proposal is for.
 *
 * Deliberately does not set the price on the reservation, and does not book
 * anything. A client tapping a button is a decision to confirm, not money
 * moving, and this portal never moves money on its own: the advisor applies
 * the price, exactly as they do when they take the answer over the phone.
 */
export async function handleClientChoose(request, env, code) {
  const trip = await loadTrip(env, clean(code, 40));
  if (!trip) return notFound('This trip page is not available.');

  // Shut unless the advisor opened it. A quote still being written should not
  // be answerable, and one already settled on the phone should not be
  // contradicted by the page.
  if (!trip.booking.options_open) {
    return badRequest('This quote is not taking answers. Get in touch and they will sort it.');
  }

  const body = await readJson(request);
  if (clean(body.company_website, 200)) return json({ ok: true, message: 'Thanks.' });

  const optionId = clean(body.optionId, 64);
  const option = trip.options.find((o) => o.id === optionId);
  if (!option) return badRequest('That is not one of the options.');

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`choose:${code}:${ip}`)).slice(0, 32) : null;

  const owner = trip.booking.user_id;
  const ts = now();

  // One at a time. Two chosen options is not a client who wants both, it is a
  // record nobody can read.
  await env.DB.prepare(
    `UPDATE quote_options SET chosen = 0, chosen_at = NULL, chosen_by = NULL, updated_at = ?
      WHERE booking_id = ? AND user_id = ?`
  ).bind(ts, trip.booking.id, owner).run();

  await env.DB.prepare(
    `UPDATE quote_options SET chosen = 1, chosen_at = ?, chosen_by = 'client', updated_at = ?
      WHERE id = ? AND booking_id = ? AND user_id = ?`
  ).bind(ts, ts, option.id, trip.booking.id, owner).run();

  // Written into the conversation as well, so the choice and everything else
  // they have said sit in one place rather than two.
  await env.DB.prepare(
    `INSERT INTO trip_messages (id, booking_id, user_id, body, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(uid(), trip.booking.id, owner,
         `Chose "${option.label}" from the options.`, ipHash, ts).run();

  try {
    await sendOptionChosenEmail(env, {
      to: trip.booking.notify_email || trip.booking.advisor_email,
      firstName: trip.booking.first_name,
      clientName: trip.booking.client_name,
      tripName: trip.booking.itinerary || trip.booking.product_name || 'their trip',
      optionLabel: option.label,
      amountCents: option.amount_cents,
      href: `${appUrl(env)}/app/reservation?id=${encodeURIComponent(trip.booking.id)}`,
    });
  } catch (e) {
    console.error('option chosen mail', e);
  }

  return json({
    ok: true,
    chosen: option.id,
    message: 'Thank you. They will confirm it with you shortly.',
  });
}

/** One shared document, fetched through the trip page rather than by key. */
export async function serveTripDocument(request, env, code, docId) {
  const trip = await loadTrip(env, clean(code, 40));
  if (!trip) return notFound('Not available.');
  const doc = trip.documents.find((d) => d.id === docId);
  if (!doc) return notFound('Not available.');

  const row = await env.DB.prepare(
    `SELECT object_key, filename, content_type FROM documents
      WHERE id = ? AND booking_id = ? AND user_id = ? AND shared = 1`
  ).bind(docId, trip.booking.id, trip.booking.user_id).first();
  if (!row) return notFound('Not available.');

  const object = await env.DOCS.get(row.object_key);
  if (!object) return notFound('That file is no longer stored.');

  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${row.filename.replace(/["\\]/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

function html(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' },
  });
}

// Split so it cannot close the page early if this file is ever templated into
// something else. The same trick the group page uses.
const CHOOSE_SCRIPT = `<scr${''}ipt>
document.querySelectorAll('[data-choose]').forEach(function (b) {
  b.addEventListener('click', async function () {
    var said = document.getElementById('choose-said');
    // Every button, not just this one: two requests in flight would race to
    // decide which option is the chosen one.
    var all = document.querySelectorAll('[data-choose]');
    all.forEach(function (x) { x.disabled = true; });
    b.textContent = 'One moment...';
    try {
      var res = await fetch(location.pathname + '/choose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: b.dataset.choose, company_website: '' }),
      });
      var data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'That did not go through.');
      said.innerHTML = '<p class="ochose">' + data.message + '</p>';
      // Reloaded rather than patched, so the page they are looking at is the
      // page the advisor is looking at.
      setTimeout(function () { location.reload(); }, 1200);
    } catch (ex) {
      said.innerHTML = '<p class="oerr">' + ex.message + '</p>';
      all.forEach(function (x) { x.disabled = false; });
      b.textContent = 'Choose this one';
    }
  });
});
</scr${''}ipt>`;

const SAY_SCRIPT = `<scr${''}ipt>
document.getElementById('say').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button');
  const err = document.getElementById('err');
  err.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch(location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: form.body.value,
        company_website: form.company_website.value,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'That did not send.');
    form.innerHTML = '<p class="sent">' + data.message + '</p>';
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    button.disabled = false;
  }
});
</scr${''}ipt>`;

function page(title, body, brand) {
  const b = brand || DEFAULT_BRAND;
  const accent = HEX_COLOR.test(b.color || '') ? b.color : DEFAULT_BRAND.color;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} | ${esc(b.name)}</title>
<link rel="icon" href="/logo-mark.png" type="image/png">
<style>
  :root {
    --navy:${accent}; --navy-d:#0d2347; --teal:#14788a; --ink:#2f4459;
    --dim:#5c7286; --line:#e2ebf4; --shell:#f7fafb; --ok:#1f7a5a; --late:#b3382a;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--shell);color:var(--ink);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;padding:2rem 1rem 4rem}
  .wrap{max-width:720px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:.6rem;margin-bottom:2rem}
  .brand img{width:36px;height:36px}
  .brand b{font-size:1rem;letter-spacing:.26em;text-transform:uppercase;color:var(--navy);font-weight:650}
  .brand small{display:block;font-size:.62rem;letter-spacing:.06em;color:var(--teal)}
  /* The itinerary. A time rail down the left so the eye can run the day
     without reading it, and the day heading sticky enough to stay useful on a
     fourteen night sailing. */
  .itin-day{margin:0 0 1.4rem}
  .itin-daylabel{display:flex;align-items:baseline;gap:.6rem;margin:0 0 .5rem;
    padding-bottom:.35rem;border-bottom:1px solid var(--line);font-size:.95rem}
  .itin-daylabel strong{color:var(--navy)}
  .itin-daylabel span{font-size:.8rem;color:var(--dim)}
  .itin-list{list-style:none;margin:0;padding:0}
  .itin-list.anytime{margin:0 0 1.4rem;padding-bottom:1rem;border-bottom:1px solid var(--line)}
  .itin-item{display:grid;grid-template-columns:5.2rem 1fr auto;gap:.7rem;
    padding:.6rem 0;align-items:start}
  .itin-when{font-size:.82rem;color:var(--dim);font-variant-numeric:tabular-nums;
    padding-top:.1rem;white-space:nowrap}
  .itin-what{display:flex;flex-direction:column;gap:.15rem;min-width:0}
  .itin-kind{font-size:.66rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
    color:var(--teal)}
  .itin-what strong{color:var(--navy);font-weight:600}
  .itin-where{font-size:.85rem;color:var(--dim)}
  .itin-detail{font-size:.9rem;white-space:pre-wrap;margin-top:.15rem}
  .itin-conf{font-size:.78rem;color:var(--dim);margin-top:.2rem}
  .itin-pic{width:84px;height:62px;object-fit:cover;border-radius:8px;flex:none}
  .itin-empty{margin:.2rem 0 0;font-size:.9rem;color:var(--dim)}
  @media (max-width:560px){
    .itin-item{grid-template-columns:4.2rem 1fr}
    .itin-pic{display:none}
  }

  .hero{margin:0 0 1.6rem}
  .eyebrow{margin:0 0 .3rem;font-size:.72rem;font-weight:700;letter-spacing:.16em;
    text-transform:uppercase;color:var(--teal)}
  h1{margin:0 0 .4rem;font-size:2rem;line-height:1.15;color:var(--navy);font-weight:650;
    text-wrap:balance}
  h2{margin:0 0 .9rem;font-size:1.05rem;color:var(--navy);font-weight:650}
  .lede{margin:0 0 .2rem;color:var(--dim)}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:1rem;
    box-shadow:0 1px 2px rgba(15,28,43,.05)}
  .pad{padding:1.5rem}
  .dim{color:var(--dim)}
  .small{font-size:.82rem}
  .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0;margin:0}
  .facts>div{padding:1.1rem 1.5rem;border-top:1px solid var(--line);border-right:1px solid var(--line)}
  .facts>div:nth-child(-n+2){border-top:0}
  dt{font-size:.68rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
  dd{margin:.25rem 0 0;font-size:.98rem;color:var(--navy);font-weight:600}
  ul.plain{list-style:none;margin:0;padding:0}
  ul.plain li{padding:.5rem 0;border-bottom:1px solid var(--line)}
  ul.plain li:last-child{border-bottom:0}
  .options{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.7rem}
  .option{border:1px solid var(--line);border-radius:11px;padding:1rem;position:relative}
  .option.on{border-color:var(--navy);box-shadow:0 0 0 1px var(--navy)}
  .tick{position:absolute;top:-.6rem;left:1rem;background:var(--navy);color:#fff;
    font-size:.64rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
    padding:.15rem .45rem;border-radius:4px}
  .opic{width:100%;height:104px;object-fit:cover;border-radius:8px;margin:0 0 .6rem;display:block}
  .oinc{margin:.4rem 0 0;font-size:.85rem;white-space:pre-wrap;color:var(--ink)}
  .obtn{margin-top:.7rem;width:100%;border:1px solid var(--navy);background:#fff;
    color:var(--navy);font:inherit;font-size:.85rem;font-weight:650;padding:.5rem .8rem;
    border-radius:999px;cursor:pointer}
  .obtn:hover{background:var(--navy);color:#fff}
  .obtn:disabled{opacity:.55;cursor:not-allowed}
  .oerr{margin:.7rem 0 0;padding:.6rem .8rem;background:#fdeeec;border-radius:8px;
    font-size:.9rem;color:var(--late)}
  .ochose{margin:0 0 .8rem;padding:.6rem .8rem;background:#eef6f1;border-radius:8px;
    font-size:.9rem;color:var(--ok)}
  .olabel{margin:0;font-weight:650;color:var(--navy)}
  .oamount{margin:.2rem 0;font-size:1.25rem;font-weight:650;color:var(--navy);
    font-variant-numeric:tabular-nums}
  .totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;
    margin-bottom:1.2rem}
  .tlabel{margin:0;font-size:.68rem;font-weight:700;letter-spacing:.12em;
    text-transform:uppercase;color:var(--dim)}
  .tvalue{margin:.2rem 0 0;font-size:1.55rem;font-weight:650;color:var(--navy);
    font-variant-numeric:tabular-nums}
  .tvalue.owing{color:var(--teal)}
  table.sched{width:100%;border-collapse:collapse;font-size:.92rem}
  .sched th{text-align:left;font-size:.68rem;font-weight:700;letter-spacing:.12em;
    text-transform:uppercase;color:var(--dim);padding:.4rem 0;border-bottom:1px solid var(--line)}
  .sched td{padding:.55rem 0;border-bottom:1px solid var(--line)}
  .sched .r{text-align:right;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;margin-left:.4rem;font-size:.66rem;font-weight:700;
    letter-spacing:.06em;text-transform:uppercase;background:var(--line);color:var(--navy);
    border-radius:999px;padding:.1rem .45rem}
  .pill.ok{background:#e8f5f0;color:var(--ok)}
  .pill.late{background:#fdeeec;color:var(--late)}
  .docs a{color:var(--navy);font-weight:600}
  .contact{margin:.2rem 0 1.2rem}
  .contact a{color:var(--teal);font-weight:600;text-decoration:none}
  label{display:block;font-size:.85rem;font-weight:600;color:var(--navy);margin-bottom:.35rem}
  textarea{width:100%;padding:.6rem .7rem;border:1px solid #c2d6e8;border-radius:8px;
    font:inherit;color:inherit;resize:vertical}
  textarea:focus{outline:2px solid var(--teal);outline-offset:1px}
  button{margin-top:.7rem;background:var(--teal);color:#fff;border:0;border-radius:8px;
    padding:.6rem 1.2rem;font:inherit;font-weight:650;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .err{color:var(--late);font-size:.88rem;margin:.6rem 0 0}
  .sent{margin:0;color:var(--ok);font-weight:600}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .foot{margin-top:2rem;text-align:center;font-size:.82rem;color:var(--dim)}
  .foot p{margin:.15rem 0}
  @media (max-width:520px){ h1{font-size:1.55rem} .pad{padding:1.2rem} }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <img src="${esc(b.logoUrl || '/logo-mark.png')}" alt="">
    <span><b>${esc(b.name)}</b><small>${esc(b.tagline || '')}</small></span>
  </div>
  ${body}
</div>
</body></html>`;
}
