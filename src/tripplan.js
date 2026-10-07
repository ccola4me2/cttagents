// The trip a client opens: every reservation that belongs to one holiday, on one
// page, in the order they will happen.
//
// A reservation has had its own page for a long time, and that answers "what did
// I buy". It does not answer "what is happening on Tuesday" when Tuesday is a
// hotel check out, a train, a tour and a dinner held as four separate
// reservations. This is the page for that question. Nothing on it is new
// information: it is what the advisor already entered, put in date order.
//
// Served at /i/<code> with no sign in, so the link is the credential. The code
// decides which trip this is and every statement below names the advisor it
// belongs to anyway, so a lookup here can be read once and believed.
//
// Columns by name, always. The reservation row holds figures that are the
// agency's and not the client's, and a page built on a whole row is one careless
// template change from printing them. This module is listed in
// scripts/check-private.mjs, which fails the build if it ever does.

import { clean } from './util.js';
import { brandForUser } from './brand.js';
import { page, money, sayDate, shortDate, appUrl } from './share.js';
import { dateForDay } from './itinerary.js';

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const DAY = 86400000;

// How a reservation reads on the day it begins and on the day it ends. A hotel
// is a check in and a check out, a flight is out and back; anything not listed
// just begins and ends, which is true of everything.
const WORDS = {
  hotel: ['Check in', 'Check out'],
  resort: ['Check in', 'Check out'],
  cruise: ['Embark', 'Disembark'],
  air: ['Outbound flight', 'Return flight'],
  rail: ['Departs', 'Returns'],
  car: ['Pick up', 'Drop off'],
  package: ['Begins', 'Ends'],
};

// What each kind of thing is called where a person scans for it.
const NAMES = {
  cruise: 'Cruise', hotel: 'Hotel', resort: 'Resort', package: 'Package', tour: 'Tour',
  air: 'Flights', rail: 'Rail', car: 'Car', transfer: 'Transfer', excursion: 'Excursion',
  attraction: 'Attraction', event_ticket: 'Tickets', insurance: 'Insurance',
  parking: 'Parking', visa_passport: 'Visa', other: 'Booking',
};

// Places somebody stays, so the days between check in and check out can say
// where they are sleeping instead of leaving the middle of the stay blank.
const STAYS = new Set(['hotel', 'resort']);

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** 09:30 as half past nine, because a client is reading and not filing. */
function sayTime(hhmm) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * Everything on one trip's page, found by the code alone.
 *
 * Only booked and travelled reservations. A quote that has not been accepted is
 * not part of the plan, and one that was cancelled is not part of the trip, so a
 * reservation cancelled after it was put in drops off the page by itself.
 */
export async function loadPlan(env, code) {
  const trip = await env.DB.prepare(
    `SELECT t.id, t.name, t.intro, t.tips, t.share_code, t.user_id,
            u.first_name, u.last_name, u.email AS advisor_email, u.notify_email,
            u.phone AS advisor_phone, u.agency_name, u.seller_of_travel
       FROM trips t JOIN users u ON u.id = t.user_id
      WHERE t.share_code = ?`
  ).bind(code).first();
  if (!trip) return null;

  const owner = trip.user_id;
  const { results: bookings } = await env.DB.prepare(
    `SELECT id, share_code, status, supplier, product_type, product_name, destination,
            confirmation_number, depart_date, return_date, gross_cents, itinerary_shared
       FROM bookings
      WHERE trip_id = ? AND user_id = ? AND status IN ('booked','travelled')
      ORDER BY COALESCE(depart_date, '9999-12-31') ASC, created_at ASC`
  ).bind(trip.id, owner).all().catch(() => ({ results: [] }));
  const rows = bookings || [];
  const ids = rows.map((b) => b.id);
  if (!ids.length) return { trip, bookings: rows, items: [], travellers: [], paid: new Map() };

  const holes = ids.map(() => '?').join(', ');
  const sharedIds = rows.filter((b) => b.itinerary_shared).map((b) => b.id);
  const sharedHoles = sharedIds.map(() => '?').join(', ');

  const [items, travellers, due] = await Promise.all([
    // Only where the advisor has said the day by day is ready. A half written
    // itinerary reads as a trip with nothing planned after Wednesday.
    sharedIds.length
      ? env.DB.prepare(
        `SELECT booking_id, day_number, start_time, end_time, kind, title, location, detail,
                confirmation
           FROM itinerary_items WHERE user_id = ? AND booking_id IN (${sharedHoles})
          ORDER BY start_time IS NULL ASC, start_time ASC, sort_order ASC`
      ).bind(owner, ...sharedIds).all().catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
    // Names only. The row carries passport numbers and dates of birth.
    env.DB.prepare(
      `SELECT name, is_lead FROM travellers
        WHERE user_id = ? AND booking_id IN (${holes}) ORDER BY is_lead DESC, name ASC`
    ).bind(owner, ...ids).all().catch(() => ({ results: [] })),
    // Hard rows only: a soft row is the same balance shown early so somebody
    // rings in time, and counting both would tell a client they owe twice.
    env.DB.prepare(
      `SELECT booking_id,
              COALESCE(SUM(CASE WHEN paid_date IS NOT NULL THEN amount_cents END), 0) AS paid_cents,
              COALESCE(SUM(CASE WHEN paid_date IS NULL THEN amount_cents END), 0) AS due_cents,
              MIN(CASE WHEN paid_date IS NULL THEN due_date END) AS next_due
         FROM booking_payments
        WHERE user_id = ? AND payment_class = 'hard' AND booking_id IN (${holes})
        GROUP BY booking_id`
    ).bind(owner, ...ids).all().catch(() => ({ results: [] })),
  ]);

  const paid = new Map();
  for (const r of due.results || []) paid.set(r.booking_id, r);
  return { trip, bookings: rows, items: items.results || [], travellers: travellers.results || [], paid };
}

/**
 * The days of the trip, each with what happens on it.
 *
 * Every day from the first reservation to the last appears, empty ones too. A gap
 * in a list is a question ("what happened to Tuesday?") and a day that says
 * nothing is planned is an answer somebody can act on.
 */
export function planDays(bookings, items) {
  const dated = bookings.filter((b) => isDate(b.depart_date));
  if (!dated.length) return [];
  const starts = dated.map((b) => b.depart_date);
  const ends = dated.map((b) => (isDate(b.return_date) && b.return_date >= b.depart_date
    ? b.return_date : b.depart_date));
  const first = starts.reduce((a, b) => (a < b ? a : b));
  const last = ends.reduce((a, b) => (a > b ? a : b));
  // Nobody is taking a 150 day trip off one page. A range that long is a date
  // typed wrong, and it is shown as far as it is sensible rather than as a
  // wall of empty days.
  const total = Math.min(dayDiff(first, last) + 1, 150);

  const days = [];
  for (let n = 0; n < total; n += 1) {
    const date = plusDays(first, n);
    const out = [];
    const middle = [];
    const back = [];
    const staying = [];

    for (const b of dated) {
      const end = isDate(b.return_date) && b.return_date >= b.depart_date ? b.return_date : b.depart_date;
      const words = WORDS[b.product_type] || ['Begins', 'Ends'];
      const title = b.product_name || b.supplier || NAMES[b.product_type] || 'Booking';
      const line = { word: '', title, place: b.destination || '', conf: b.confirmation_number || '',
        supplier: b.supplier && b.supplier !== title ? b.supplier : '' };
      if (date === b.depart_date) {
        back.push({ ...line, word: end === b.depart_date && !WORDS[b.product_type] ? (NAMES[b.product_type] || '') : words[0] });
      } else if (date === end) {
        out.push({ ...line, word: words[1] });
      } else if (date > b.depart_date && date < end) {
        if (STAYS.has(b.product_type)) staying.push(title);
        else if (b.product_type === 'cruise') staying.push(`on board ${title}`);
      }
    }

    for (const i of items) {
      const b = dated.find((x) => x.id === i.booking_id);
      if (!b || !i.day_number || dateForDay(b.depart_date, i.day_number) !== date) continue;
      middle.push({ word: i.kind || 'note', title: i.title, place: i.location || '', detail: i.detail || '',
        conf: i.confirmation || '', time: i.start_time || '', until: i.end_time || '' });
    }
    middle.sort((x, y) => (x.time ? 0 : 1) - (y.time ? 0 : 1) || String(x.time).localeCompare(String(y.time)));

    days.push({ n: n + 1, date, events: [...out, ...middle, ...back], staying });
  }
  return days;
}

function tripSpan(bookings) {
  const dated = bookings.filter((b) => isDate(b.depart_date));
  if (!dated.length) return { from: '', to: '', nights: 0 };
  const from = dated.map((b) => b.depart_date).reduce((a, b) => (a < b ? a : b));
  const to = dated.map((b) => (isDate(b.return_date) ? b.return_date : b.depart_date))
    .reduce((a, b) => (a > b ? a : b));
  return { from, to, nights: Math.max(0, dayDiff(from, to)) };
}

// Split so it cannot close the page early if this file is ever templated into
// something else.
// The costs are the client's own business and not something to hand round at
// the airport, so the printed itinerary leaves them out.
const PRINT_SCRIPT = `<style>@media print{.hp-cost{display:none !important}}</style><scr${''}ipt>
document.getElementById('print-it').addEventListener('click', function () {
  window.print();
});
</scr${''}ipt>`;

export function planBody(env, plan) {
  const { trip, bookings, items, travellers, paid } = plan;
  const span = tripSpan(bookings);
  const days = planDays(bookings, items);
  const advisor = [trip.first_name, trip.last_name].filter(Boolean).join(' ') || trip.advisor_email;
  const contact = trip.notify_email || trip.advisor_email;
  const names = [...new Set(travellers.map((t) => t.name).filter(Boolean))];

  const total = bookings.reduce((n, b) => n + (b.gross_cents || 0), 0);
  const paidCents = bookings.reduce((n, b) => n + ((paid.get(b.id) || {}).paid_cents || 0), 0);
  const owed = bookings.reduce((n, b) => n + ((paid.get(b.id) || {}).due_cents || 0), 0);
  const next = bookings.map((b) => (paid.get(b.id) || {}).next_due).filter(Boolean).sort()[0];

  const event = (e) => `<li class="itin-item">
    <span class="itin-when">${e.time ? `<span>${esc(sayTime(e.time))}${e.until ? ' -' : ''}</span>` : ''}${
  e.until ? ` <span>${esc(sayTime(e.until))}</span>` : ''}</span>
    <span class="itin-what">
      ${e.word ? `<span class="itin-kind">${esc(e.word)}</span>` : ''}
      <strong>${esc(e.title)}</strong>
      ${e.supplier ? `<span class="itin-where">${esc(e.supplier)}</span>` : ''}
      ${e.place ? `<span class="itin-where">${esc(e.place)}</span>` : ''}
      ${e.detail ? `<span class="itin-detail">${esc(e.detail)}</span>` : ''}
      ${e.conf ? `<span class="itin-conf">Reference ${esc(e.conf)}</span>` : ''}
    </span>
  </li>`;

  const dayBlock = (d) => `<div class="itin-day">
    <p class="itin-daylabel"><strong>Day ${d.n}</strong><span>${esc(sayDate(d.date))}</span></p>
    ${d.staying.length ? `<p class="itin-empty" style="margin:0 0 .4rem;">Staying: ${esc(d.staying.join(', '))}</p>` : ''}
    ${d.events.length ? `<ul class="itin-list">${d.events.map(event).join('')}</ul>`
    : (d.staying.length ? '' : '<p class="itin-empty">Nothing planned. The day is yours.</p>')}
  </div>`;

  const undated = bookings.filter((b) => !isDate(b.depart_date));

  const row = (b) => `<li class="trip-row">
    ${b.share_code ? `<a href="/t/${esc(b.share_code)}">` : '<span>'}
      <span class="t">${esc(b.product_name || b.supplier || NAMES[b.product_type] || 'Booking')}</span>
      <span class="m">${esc(NAMES[b.product_type] || '')}${b.supplier ? ` &middot; ${esc(b.supplier)}` : ''}${
  isDate(b.depart_date) ? ` &middot; ${esc(shortDate(b.depart_date))}${
    isDate(b.return_date) && b.return_date !== b.depart_date ? ` to ${esc(shortDate(b.return_date))}` : ''}` : ' &middot; dates to come'}${
  b.confirmation_number ? ` &middot; ${esc(b.confirmation_number)}` : ''}</span>
    ${b.share_code ? '</a>' : '</span>'}
  </li>`;

  return `<div class="wrap">
    <header class="hero">
      <p class="eyebrow">Your trip</p>
      <h1>${esc(trip.name)}</h1>
      <p class="lede">${span.from ? `${esc(sayDate(span.from))}${span.to !== span.from ? ` to ${esc(sayDate(span.to))}` : ''}${
  span.nights ? ` &middot; ${span.nights} night${span.nights === 1 ? '' : 's'}` : ''}` : 'Dates to come'}</p>
      ${names.length ? `<p class="lede">${esc(names.join(', '))}</p>` : ''}
    </header>

    ${trip.intro ? `<section class="card pad"><p style="margin:0;white-space:pre-wrap;">${esc(trip.intro)}</p></section>` : ''}

    <div class="printbar">
      <button type="button" id="print-it">Print or save as PDF</button>
      <span class="dim small">Takes the whole itinerary. Leaves out the costs.</span>
    </div>

    ${days.length ? `<section class="card pad itin">
      <h2>Day by day</h2>
      ${days.map(dayBlock).join('')}
    </section>` : ''}

    <section class="card pad">
      <h2>Everything booked</h2>
      <ul class="plain trips">${bookings.map(row).join('') || '<li class="dim">Nothing is booked on this trip yet.</li>'}</ul>
      ${undated.length ? '<p class="dim small">Bookings with dates still to come are listed here and not in the days above.</p>' : ''}
      <p class="dim small">Open any booking for its documents, its payments and to message us about it.</p>
    </section>

    ${trip.tips ? `<section class="card pad">
      <h2>Good to know</h2>
      <p style="margin:0;white-space:pre-wrap;">${esc(trip.tips)}</p>
    </section>` : ''}

    ${total || owed || paidCents ? `<section class="card pad hp-cost">
      <h2>What it costs</h2>
      <div class="totals">
        <div><p class="tlabel">Trip total</p><p class="tvalue">${esc(money(total))}</p></div>
        <div><p class="tlabel">Paid</p><p class="tvalue">${esc(money(paidCents))}</p></div>
        <div><p class="tlabel">Still to pay</p>
          <p class="tvalue${owed > 0 ? ' owing' : ''}">${esc(money(owed))}</p></div>
      </div>
      ${owed > 0 && next ? `<p class="dim small">Next payment due ${esc(sayDate(next))}.</p>` : ''}
    </section>` : ''}

    <section class="card pad">
      <h2>Questions</h2>
      <p class="lede">${esc(advisor)}${trip.agency_name ? ` at ${esc(trip.agency_name)}` : ''} is looking after you.</p>
      <p class="contact">
        ${contact ? `<a href="mailto:${esc(contact)}">${esc(contact)}</a>` : ''}
        ${trip.advisor_phone ? `<span class="dim"> &middot; </span><a href="tel:${esc(trip.advisor_phone)}">${esc(trip.advisor_phone)}</a>` : ''}
      </p>
    </section>

    <footer class="foot" data-url="${esc(`${appUrl(env)}/i/${trip.share_code}`)}">
      <p class="dim small">${esc(trip.agency_name || '')}${
  trip.seller_of_travel ? ` &middot; ${esc(trip.seller_of_travel)}` : ''}</p>
      <p class="dim small"><a href="/privacy">Privacy policy</a></p>
    </footer>
  </div>${PRINT_SCRIPT}`;
}

export async function renderPlanPage(request, env, code) {
  const plan = await loadPlan(env, clean(code, 40));
  if (!plan) {
    return new Response(page('Not available', `<div class="wrap"><div class="card pad">
      <h1>This page is not available</h1>
      <p class="dim">The link may have been turned off, or it may have a typo in it.
        Ask whoever sent it for a new one.</p></div></div>`, null),
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } });
  }
  const body = planBody(env, plan);
  return new Response(
    page(plan.trip.name, body, await brandForUser(env, plan.trip.user_id)),
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } }
  );
}
