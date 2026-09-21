// One page a client opens to see everything we hold for them.
//
// A reservation has been shareable for a while: a code on the booking, served
// at /t/<code>, no login, the link is the credential. It works, and it answers
// one trip. Scott Weidman has eight reservations that are one holiday in
// Spain, so answering one trip eight times is not the same as answering the
// question he actually has, which is "what is happening in November".
//
// The same model one level up. A code on the client, served at /c/<code>,
// listing every trip they have with us, grouped into the holidays they
// actually are. Nothing to log into, nothing to reset, and the same thing to
// be careful about as the trip page: a link that reaches more is a link worth
// guarding, so it is minted deliberately by an advisor and can be revoked.
//
// What is on it is what a client already knows or is entitled to: where they
// are going, what it costs, what they have paid, what is still outstanding.
// What is not on it is everything about what we earn. This module selects
// columns by name for that reason and never `*`: the bookings row carries the
// commission, the split and the lead source, and a page built on `*` is one
// careless template change away from publishing them.

import { json, notFound, clean, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import { brandForUser } from './brand.js';
import * as db from './db.js';
import { page, money, sayDate, shortDate, shareCode, appUrl } from './share.js';

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Turn the page on for one client, or off again.
 *
 * Turning it on shares their reservations too. That is the feature rather
 * than a side effect: the page lists their trips and every row opens the trip
 * page we already build, so a row that could not be opened would be a list of
 * things they are told they cannot look at. Said plainly on the button.
 *
 * Off drops the code rather than hiding it. A link that stops working and
 * then starts working again months later, pointing at trips that have moved
 * on, is worse than a link that is gone. The trips stay shared: they were
 * shareable before this existed and each has its own code to revoke.
 */
export async function handleShareClient(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('Client not found.');

  const client = await env.DB.prepare(
    'SELECT id, name, hub_code, hub_at FROM clients WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!client) return notFound('Client not found.');

  const on = (await readJson(request)).on !== false;
  const ts = now();

  if (!on) {
    await env.DB.prepare(
      'UPDATE clients SET hub_code = NULL, hub_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(ts, id, owner.id).run();
    await db.logActivity(env, owner.id, 'client.unshare',
      db.byHand(`Stopped sharing ${client.name}'s page`, user, owner), { clientId: id });
    return json({ ok: true, shared: false, code: null, shared_trips: 0 });
  }

  const code = client.hub_code || shareCode();

  // Booked and travelled only. Never a quote.
  //
  // A quoted reservation without a share code is a proposal the advisor has
  // not sent, and minting one here would put a price in front of a client
  // because somebody pressed a button about a different thing entirely. A
  // quote reaches a client when somebody presses send on that quote, and at
  // no other time; the page shows the ones that have been.
  const { results: unshared } = await env.DB.prepare(
    `SELECT id FROM bookings
      WHERE client_id = ? AND user_id = ? AND share_code IS NULL
        AND status IN ('booked','travelled')`
  ).bind(id, owner.id).all().catch(() => ({ results: [] }));

  const writes = [env.DB.prepare(
    'UPDATE clients SET hub_code = ?, hub_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  // hub_at is the day it was first shared, kept through a re-share: turning
  // it off and on again is the same page rather than a new one.
  ).bind(code, client.hub_at || ts, ts, id, owner.id)];
  for (const b of unshared || []) {
    writes.push(env.DB.prepare(
      'UPDATE bookings SET share_code = ?, shared_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(shareCode(), ts, ts, b.id, owner.id));
  }
  await env.DB.batch(writes);

  await db.logActivity(env, owner.id, 'client.share',
    db.byHand(`Shared ${client.name}'s page`, user, owner),
    { clientId: id, trips: (unshared || []).length });

  return json({
    ok: true,
    shared: true,
    code,
    url: `${appUrl(env)}/c/${code}`,
    // How many trips this turned on with it, so the page can say so rather
    // than leaving somebody to notice later.
    shared_trips: (unshared || []).length,
  });
}

/**
 * Everything on one client's page, found by the code alone.
 *
 * The code decides which client this is, which is why the owner is named in
 * every query underneath it: a public lookup that says whose rows it wants
 * can be read once and believed.
 *
 * Columns by name. The bookings row holds the commission, the split, the
 * lead source and the internal notes, and none of them belong here.
 */
async function loadHub(env, code) {
  const client = await env.DB.prepare(
    `SELECT c.id, c.name, c.user_id, c.hub_code,
            u.first_name, u.last_name, u.email AS advisor_email, u.notify_email,
            u.phone AS advisor_phone, u.agency_name, u.seller_of_travel
       FROM clients c JOIN users u ON u.id = c.user_id
      WHERE c.hub_code = ?`
  ).bind(code).first();
  if (!client) return null;

  const owner = client.user_id;
  const { results: bookings } = await env.DB.prepare(
    `SELECT id, share_code, status, supplier, product_name, destination, itinerary,
            depart_date, return_date, confirmation_number, gross_cents, travellers
       FROM bookings
      WHERE client_id = ? AND user_id = ? AND status != 'cancelled'
        -- A quote is on this page only once the advisor has sent it. The
        -- share code is what "sent" means, so it is also the test.
        AND (share_code IS NOT NULL OR status IN ('booked','travelled'))
      ORDER BY COALESCE(depart_date, '9999-12-31') ASC`
  ).bind(client.id, owner).all().catch(() => ({ results: [] }));

  const ids = (bookings || []).map((b) => b.id);
  const paid = new Map();
  if (ids.length) {
    const holes = ids.map(() => '?').join(', ');
    const { results: rows } = await env.DB.prepare(
      // Hard rows only. A soft row is the same balance shown early so somebody
      // rings in time, and counting both would tell the client they owe twice.
      `SELECT booking_id,
              COALESCE(SUM(CASE WHEN paid_date IS NOT NULL THEN amount_cents END), 0) AS paid_cents,
              COALESCE(SUM(CASE WHEN paid_date IS NULL THEN amount_cents END), 0) AS due_cents,
              MIN(CASE WHEN paid_date IS NULL THEN due_date END) AS next_due
         FROM booking_payments
        WHERE user_id = ? AND payment_class = 'hard' AND booking_id IN (${holes})
        GROUP BY booking_id`
    ).bind(owner, ...ids).all().catch(() => ({ results: [] }));
    for (const r of rows || []) paid.set(r.booking_id, r);
  }

  return { client, bookings: bookings || [], paid };
}

/**
 * The holidays a list of reservations actually is.
 *
 * Eight rows for one fortnight in Spain is one trip to the person taking it.
 * Two reservations belong together when their dates touch or nearly do, which
 * is a guess the portal makes rather than a fact it holds, so the grouping is
 * generous by a couple of days and every reservation is still listed on its
 * own underneath.
 */
function group(bookings) {
  const DAY = 86400000;
  const at = (iso) => (iso ? Date.parse(`${iso}T00:00:00Z`) : null);
  const trips = [];
  for (const b of bookings) {
    const from = at(b.depart_date);
    const to = at(b.return_date) || from;
    const near = from === null ? null : trips.find((t) => t.from !== null
      && from <= t.to + 2 * DAY && to >= t.from - 2 * DAY);
    if (near) {
      near.from = Math.min(near.from, from);
      near.to = Math.max(near.to, to);
      near.rows.push(b);
    } else {
      trips.push({ from, to, rows: [b] });
    }
  }
  return trips;
}

/** What to call a holiday made of several bookings. */
function tripName(rows) {
  const places = rows.map((b) => b.destination).filter(Boolean);
  if (places.length) {
    // The shortest is usually the country rather than the city, which is what
    // somebody calls the trip: "Spain", not "Madrid to Antequera Spain".
    const words = places.map((p) => p.trim().split(/\s+/).pop());
    const common = words.find((w) => words.filter((x) => x === w).length > 1);
    if (common) return common;
    return places.sort((a, b) => a.length - b.length)[0];
  }
  return rows[0].itinerary || rows[0].product_name || 'Your trip';
}

export async function renderHubPage(request, env, code) {
  const hub = await loadHub(env, clean(code, 40));
  if (!hub) {
    return new Response(page('Not available', `<div class="wrap"><div class="card pad">
      <h1>This page is not available</h1>
      <p class="dim">The link may have been turned off, or it may have a typo in it.
        Ask whoever sent it for a new one.</p></div></div>`, null),
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  const { client, bookings, paid } = hub;
  const advisor = [client.first_name, client.last_name].filter(Boolean).join(' ')
    || client.advisor_email;
  const contact = client.notify_email || client.advisor_email;
  const today = new Date().toISOString().slice(0, 10);

  const quotes = bookings.filter((b) => b.status === 'quoted');
  const trips = group(bookings.filter((b) => b.status !== 'quoted'));
  const upcoming = trips.filter((t) => !t.rows.every((b) => (b.return_date || b.depart_date || '') < today));
  const past = trips.filter((t) => t.rows.every((b) => (b.return_date || b.depart_date || '') < today));

  const sum = (rows, pick) => rows.reduce((n, b) => n + pick(b), 0);
  const owedOn = (b) => (paid.get(b.id) || {}).due_cents || 0;
  const paidOn = (b) => (paid.get(b.id) || {}).paid_cents || 0;

  // The code goes with the link so the trip page can offer a way back. It is
  // the code they already hold: nothing is revealed by passing it on.
  const row = (b) => `<li class="trip-row">
    ${b.share_code ? `<a href="/t/${esc(b.share_code)}?c=${esc(client.hub_code)}">` : '<span>'}
      <span class="t">${esc(b.product_name || b.supplier || 'Booking')}</span>
      <span class="m">${esc(b.depart_date ? shortDate(b.depart_date) : 'no date')}${
        b.return_date && b.return_date !== b.depart_date ? ` to ${esc(shortDate(b.return_date))}` : ''
      }${b.supplier ? ` &middot; ${esc(b.supplier)}` : ''}${
        b.confirmation_number ? ` &middot; ${esc(b.confirmation_number)}` : ''}</span>
    ${b.share_code ? '</a>' : '</span>'}
  </li>`;

  const tripCard = (t) => {
    const owed = sum(t.rows, owedOn);
    const total = sum(t.rows, (b) => b.gross_cents || 0);
    const next = t.rows.map((b) => (paid.get(b.id) || {}).next_due).filter(Boolean).sort()[0];
    return `<section class="card pad">
      <h2>${esc(tripName(t.rows))}</h2>
      <p class="lede">${esc(t.from ? sayDate(new Date(t.from).toISOString().slice(0, 10)) : 'Dates to come')}${
        t.to && t.to !== t.from ? ` to ${esc(sayDate(new Date(t.to).toISOString().slice(0, 10)))}` : ''
      } &middot; ${t.rows.length} booking${t.rows.length === 1 ? '' : 's'}</p>
      <div class="totals">
        <div><p class="tlabel">Trip total</p><p class="tvalue">${esc(money(total))}</p></div>
        <div><p class="tlabel">Paid</p><p class="tvalue">${esc(money(sum(t.rows, paidOn)))}</p></div>
        <div><p class="tlabel">Still to pay</p>
          <p class="tvalue${owed > 0 ? ' owing' : ''}">${esc(money(owed))}</p></div>
      </div>
      ${owed > 0 && next ? `<p class="dim small">Next payment due ${esc(sayDate(next))}.</p>` : ''}
      <ul class="plain trips">${t.rows.map(row).join('')}</ul>
    </section>`;
  };

  const body = `<div class="wrap">
    <header class="head">
      <h1>${esc(client.name)}</h1>
      <p class="dim">Everything ${esc(client.agency_name || 'we')} hold for you</p>
    </header>

    ${upcoming.length ? upcoming.map(tripCard).join('')
      : `<section class="card pad"><h2>Nothing booked yet</h2>
          <p class="dim">When something is booked it will appear here.</p></section>`}

    ${quotes.length ? `<section class="card pad">
      <h2>Quoted, waiting on you</h2>
      <ul class="plain trips">${quotes.map(row).join('')}</ul>
    </section>` : ''}

    ${past.length ? `<section class="card pad">
      <h2>Where you have been</h2>
      <ul class="plain trips">${past.map((t) => `<li class="trip-row"><span>
        <span class="t">${esc(tripName(t.rows))}</span>
        <span class="m">${esc(t.from ? sayDate(new Date(t.from).toISOString().slice(0, 10)) : '')}
          &middot; ${t.rows.length} booking${t.rows.length === 1 ? '' : 's'}</span></span></li>`).join('')}</ul>
    </section>` : ''}

    <section class="card pad">
      <h2>Questions</h2>
      <p class="lede">${esc(advisor)}${client.agency_name ? ` at ${esc(client.agency_name)}` : ''} is
        looking after you.</p>
      <p class="contact">
        ${contact ? `<a href="mailto:${esc(contact)}">${esc(contact)}</a>` : ''}
        ${client.advisor_phone ? `<span class="dim"> &middot; </span><a href="tel:${
          esc(client.advisor_phone)}">${esc(client.advisor_phone)}</a>` : ''}
      </p>
      <p class="dim small">Open any trip above for the full itinerary, the payment schedule and
        your documents.</p>
    </section>

    <footer class="foot">
      <p class="dim small">${esc(client.agency_name || '')}${
        client.seller_of_travel ? ` &middot; ${esc(client.seller_of_travel)}` : ''}</p>
    </footer>
  </div>`;

  return new Response(
    page(client.name, body, await brandForUser(env, client.user_id)),
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}
