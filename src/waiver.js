// The travel insurance waiver, both sides of it.
//
// A client who declines travel protection has to say so in writing, and until now that happened on a PDF
// from the supplier or not at all. Every quote and reservation can now carry a link to a short page that
// says what travel protection is for, shows the trip it is about, and takes the client's name, email and a
// tick. What they signed, when, and the words in front of them are kept on the reservation. Signing marks
// the reservation's insurance as declined, which takes it off the list of trips where insurance was never
// discussed.
//
// Served at /w/<code> with no sign in: the link is the credential, as for a proposal or a trip page. The
// page shows the trip and the client's name for it and nothing else about the book. It is listed in
// scripts/check-private.mjs, which fails the build if it ever mentions a commission or selects a whole row
// of bookings.

import { json, badRequest, notFound, clean, uid, now, sha256Hex, readJson, escapeHtml as esc, usDate } from './util.js';
import { requireUser, borrowedSeat, SESSION_COOKIE } from './auth.js';
import { brandForUser } from './brand.js';
import { appUrl, page, looksAutomatic } from './share.js';
import {
  WAIVER_VERSION, waiverCode, waiverParagraphs, waiverFinePrint, waiverRecord, DECLINE_STATEMENT, ensureWaiver,
} from './waiverdata.js';
import { sendWaiverEmail, sendWaiverSignedEmail, sendWaiverCopyEmail } from './email.js';
import * as db from './db.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sayDay = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', {
  month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'America/New_York' });
const sayWhen = (ts) => new Date(ts * 1000).toLocaleString('en-US', {
  month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

/** How a row goes to the advisor's page: the link and where it stands, never the stored wording. */
export function waiverShape(env, row, clientEmail = '') {
  if (!row) return null;
  return {
    code: row.code,
    url: `${appUrl(env)}/w/${row.code}`,
    sentAt: row.sent_at || null,
    sentCount: row.sent_count || 0,
    viewCount: row.view_count || 0,
    firstViewedAt: row.first_viewed_at || null,
    signedAt: row.signed_at || null,
    signerName: row.signer_name || null,
    signerEmail: row.signer_email || null,
    clientEmail,
  };
}

/** What the reservation page is sent. Made on the first look so the link is always already there. */
export async function waiverForBooking(env, booking, { make }) {
  const row = make ? await ensureWaiver(env, booking) : await env.DB.prepare(
    `SELECT id, code, created_at, sent_at, sent_count, view_count, first_viewed_at, signed_at, signer_name,
            signer_email
       FROM insurance_waivers WHERE booking_id = ? AND user_id = ?`
  ).bind(booking.id, booking.user_id).first();
  if (!row) return null;
  const client = booking.client_id
    ? await db.getClient(env, db.selfScope({ id: booking.user_id }), { id: booking.client_id }).catch(() => null)
    : null;
  return waiverShape(env, row, (client && client.email) || '');
}

// ---------------------------------------------------------------------------
// The advisor's side
// ---------------------------------------------------------------------------

/**
 * POST /api/bookings/:id/waiver { action: 'make' | 'renew' | 'send', to?, message? }
 *
 * make   the link, made if it is not there yet
 * renew  a new link, for one nobody has signed; a signed one is a record and stays
 * send   the link to the client by email
 */
export async function handleWaiver(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Reservation not found.');
  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Reservation not found.');

  const body = await readJson(request);
  const action = ['make', 'renew', 'send'].includes(body.action) ? body.action : 'make';
  let row = await ensureWaiver(env, booking);
  if (!row) return badRequest('The waiver link could not be made. Try again.');

  if (action === 'renew') {
    if (row.signed_at) return badRequest('This one has been signed, so it stays as the record. There is nothing to replace.');
    await env.DB.prepare('UPDATE insurance_waivers SET code = ?, sent_at = NULL, sent_count = 0 WHERE id = ? AND user_id = ? AND signed_at IS NULL')
      .bind(waiverCode(), row.id, owner.id).run();
    row = await ensureWaiver(env, booking);
  }

  let emailed = false;
  if (action === 'send') {
    if (borrowedSeat(user)) return badRequest('Stop working as an advisor before sending. The email goes out under their name.');
    if (row.signed_at) return badRequest('This one has already been signed.');
    const client = booking.client_id
      ? await db.getClient(env, db.selfScope(owner), { id: booking.client_id }).catch(() => null)
      : null;
    const to = clean(body.to, 254).toLowerCase() || ((client && client.email) || '').toLowerCase();
    if (!EMAIL.test(to)) return badRequest('Type the email address to send it to.');
    const brand = await brandForUser(env, owner.id);
    const advisorName = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || owner.email;
    const out = await sendWaiverEmail(env, {
      to,
      replyTo: owner.notify_email || owner.email,
      firstName: (booking.client_name || '').split(/\s+/)[0],
      advisorName,
      tripName: tripLine(booking),
      url: `${appUrl(env)}/w/${row.code}`,
      brand,
      agencyId: owner.agency_id || null,
      agencyName: owner.agency_name || '',
    });
    if (!out || out.skipped) return badRequest('Email is not set up on this portal yet, so nothing was sent. You can copy the link and send it yourself.');
    if (out.ok === false) return badRequest('The email could not be sent. Check the address and try again.');
    await env.DB.prepare('UPDATE insurance_waivers SET sent_at = ?, sent_count = sent_count + 1 WHERE id = ? AND user_id = ?')
      .bind(now(), row.id, owner.id).run();
    await db.logActivity(env, owner.id, 'waiver.sent',
      db.byHand(`Sent ${booking.client_name} the travel insurance waiver`, user, owner), { id: bookingId });
    row = await ensureWaiver(env, booking);
    emailed = true;
  }

  const client = booking.client_id
    ? await db.getClient(env, db.selfScope(owner), { id: booking.client_id }).catch(() => null)
    : null;
  return json({ ok: true, emailed, waiver: waiverShape(env, row, (client && client.email) || '') });
}

// ---------------------------------------------------------------------------
// The client's side
// ---------------------------------------------------------------------------

function tripLine(b) {
  const what = [b.supplier, b.product_name].filter(Boolean).join(' ') || b.itinerary || b.destination || 'your trip';
  return b.depart_date ? `${what} on ${usDate(b.depart_date)}` : what;
}

async function loadWaiver(env, code) {
  // Named columns from bookings, never the row: the page prints what the client may read about their own
  // trip and nothing the agency keeps about it.
  return env.DB.prepare(
    `SELECT w.id, w.user_id, w.booking_id, w.signed_at, w.signer_name, w.wording_text,
            b.client_name, b.supplier, b.product_name, b.destination, b.itinerary, b.confirmation_number,
            b.depart_date, b.return_date,
            u.first_name, u.last_name, u.email AS advisor_email, u.notify_email, u.phone AS advisor_phone,
            u.agency_name, u.agency_id
       FROM insurance_waivers w
       JOIN bookings b ON b.id = w.booking_id AND b.user_id = w.user_id
       JOIN users u ON u.id = w.user_id
      WHERE w.code = ?`
  ).bind(String(code || '').toLowerCase()).first();
}

const STYLE = `<style>
  .wv-trip{margin:0 0 1.2rem;padding:.9rem 1.1rem;background:#f7fafb;border:1px solid var(--line);border-radius:10px}
  .wv-trip dt{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-weight:700}
  .wv-trip dd{margin:.1rem 0 .6rem;font-weight:600;color:var(--navy)}
  .wv-trip dd:last-child{margin-bottom:0}
  .wv-text p{margin:0 0 .9rem}
  .wv-tick{display:flex;gap:.7rem;align-items:flex-start;margin:1.2rem 0;padding:1rem;border:1px solid var(--line);border-radius:10px}
  .wv-tick input{margin-top:.3rem;width:1.15rem;height:1.15rem;flex:none}
  .wv-field{margin:0 0 1rem}
  .wv-field label{display:block;font-weight:650;margin-bottom:.3rem;font-size:.92rem}
  .wv-field input{width:100%;padding:.65rem .75rem;font:inherit;border:1px solid #c7d9e9;border-radius:8px}
  .wv-warn{color:#b3382a;font-size:.8rem;font-weight:700;margin:1rem 0;text-transform:uppercase;letter-spacing:.01em}
  .wv-go{border:0;background:#1f7a5a;color:#fff;font:inherit;font-weight:700;padding:.75rem 1.8rem;border-radius:8px;cursor:pointer}
  .wv-go:disabled{opacity:.55;cursor:not-allowed}
  .wv-err{margin:.8rem 0 0;padding:.6rem .8rem;background:#fdeeec;border-radius:8px;color:#b3382a;font-size:.9rem}
  .wv-done{padding:1rem 1.1rem;background:#f1f9f5;border:1px solid #cfe5dc;border-radius:10px;margin:0 0 1.2rem}
  .wv-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  @media print{.wv-go,.wv-noprint{display:none !important}}
</style>`;

const SIGN_SCRIPT = `<scr${''}ipt>
(function () {
  var form = document.getElementById('wv-form');
  if (!form) return;
  var go = document.getElementById('wv-go');
  var err = document.getElementById('wv-err');
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.hidden = true;
    go.disabled = true;
    go.textContent = 'One moment...';
    try {
      var res = await fetch(location.pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agree: document.getElementById('wv-agree').checked,
          name: document.getElementById('wv-name').value,
          email: document.getElementById('wv-email').value,
          company_website: document.getElementById('wv-hp').value,
        }),
      });
      var data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'That did not go through.');
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      go.disabled = false;
      go.textContent = 'Submit';
    }
  });
  var pr = document.getElementById('wv-print');
  if (pr) pr.addEventListener('click', function () { window.print(); });
})();
</scr${''}ipt>`;

function html(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' },
  });
}

/** GET /w/<code> */
export async function renderWaiverPage(request, env, code) {
  const w = await loadWaiver(env, code);
  if (!w) {
    return html(page('Not found', `<div class="card pad"><h1>This page is not available</h1>
      <p class="lede">The link may be mistyped or out of date. Ask your travel advisor for the current one.</p></div>`), 404);
  }
  const brand = await brandForUser(env, w.user_id);
  const advisor = [w.first_name, w.last_name].filter(Boolean).join(' ') || brand.name;
  const agency = w.agency_name || brand.name;

  // Counted when a person opens it, and not for the advisor's own look or a mail scanner.
  try {
    const signedIn = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`).test(request.headers.get('Cookie') || '');
    if (request.method === 'GET' && !signedIn && !looksAutomatic(request)) {
      await env.DB.prepare(
        `UPDATE insurance_waivers SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, ?)
          WHERE id = ? AND user_id = ?`
      ).bind(now(), w.id, w.user_id).run();
    }
  } catch (e) {
    console.error('waiver view count', e);
  }

  const trip = `<dl class="wv-trip">
      <dt>Prepared for</dt><dd>${esc(w.client_name)}</dd>
      <dt>Trip</dt><dd>${esc(tripLine(w))}${w.confirmation_number ? ` <span style="font-weight:400">(#${esc(w.confirmation_number)})</span>` : ''}</dd>
      <dt>Your travel advisor</dt><dd>${esc(advisor)}${agency && agency !== advisor ? ` at ${esc(agency)}` : ''}</dd>
    </dl>`;

  const contact = w.notify_email || w.advisor_email;
  let main;
  if (w.signed_at) {
    // The record, as it was signed. The stored words, not today's: a later edit to the wording must not
    // change what somebody agreed to.
    const paragraphs = String(w.wording_text || waiverRecord(agency, advisor)).split(/\n{2,}/);
    main = `<div class="wv-done"><strong>Signed.</strong> ${esc(w.signer_name)} declined travel protection for this trip on ${esc(sayWhen(w.signed_at))} (Eastern time).</div>
      ${trip}
      <div class="wv-text dim">${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
      <p class="wv-noprint"><button type="button" class="wv-go" id="wv-print" style="background:var(--navy)">Print or save a copy</button></p>
      <p class="dim small wv-noprint">Changed your mind? Tell ${esc(advisor)} and they will send you a quote.${
  contact ? ` <a href="mailto:${esc(contact)}">${esc(contact)}</a>` : ''}</p>`;
  } else {
    main = `${trip}
      <div class="wv-text">${waiverParagraphs(agency).map((p) => `<p>${esc(p)}</p>`).join('')}</div>
      <form id="wv-form" novalidate>
        <label class="wv-tick"><input type="checkbox" id="wv-agree"><span>${esc(DECLINE_STATEMENT)}</span></label>
        <p class="dim small" style="margin:0 0 .8rem;"><span style="color:#b3382a;">*</span> required</p>
        <div class="wv-field"><label for="wv-name"><span style="color:#b3382a;">*</span> Your name</label>
          <input id="wv-name" autocomplete="name" maxlength="120"></div>
        <div class="wv-field"><label for="wv-email"><span style="color:#b3382a;">*</span> Your email address</label>
          <input id="wv-email" type="email" autocomplete="email" maxlength="254" inputmode="email"></div>
        <div class="wv-field"><label>Date</label><div>${esc(sayWhen(now()))}</div></div>
        <div class="wv-hp" aria-hidden="true"><label>Company website<input id="wv-hp" tabindex="-1" autocomplete="off"></label></div>
        <p class="wv-warn">${esc(waiverFinePrint(advisor))}</p>
        <button class="wv-go" id="wv-go" type="submit">Submit</button>
        <p class="wv-err" id="wv-err" hidden></p>
      </form>
      ${contact ? `<p class="dim small" style="margin-top:1.4rem;">Want a quote for insurance instead? Write to <a href="mailto:${esc(contact)}">${esc(contact)}</a>${
  w.advisor_phone ? ` or call <a href="tel:${esc(String(w.advisor_phone).replace(/[^\d+]/g, ''))}">${esc(w.advisor_phone)}</a>` : ''}.</p>` : ''}`;
  }

  return html(page('Travel insurance', `${STYLE}<div class="card pad">
      <p class="eyebrow">${w.signed_at ? 'Travel insurance' : 'One last step'}</p>
      <h1>${w.signed_at ? 'Travel insurance declined' : 'Decline travel insurance'}</h1>
      ${main}</div>${SIGN_SCRIPT}`, brand));
}

/** POST /w/<code> { agree, name, email, company_website } */
export async function handleSignWaiver(request, env, code) {
  const w = await loadWaiver(env, code);
  if (!w) return notFound('This page is not available.');
  const body = await readJson(request);
  if (clean(body.company_website, 200)) return json({ ok: true });

  if (w.signed_at) return badRequest('This has already been signed.');
  if (body.agree !== true) return badRequest('Tick the box to say you decline, then sign below.');
  const name = clean(body.name, 120);
  if (name.length < 2) return badRequest('Type your name.');
  const email = clean(body.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return badRequest('Type your email address.');

  const brand = await brandForUser(env, w.user_id);
  const advisor = [w.first_name, w.last_name].filter(Boolean).join(' ') || brand.name;
  const agency = w.agency_name || brand.name;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`waiver:${code}:${ip}`)).slice(0, 32) : null;
  const ts = now();

  // Only while it is still unsigned, so two taps cannot make two records.
  const res = await env.DB.prepare(
    `UPDATE insurance_waivers SET signed_at = ?, signer_name = ?, signer_email = ?, ip_hash = ?,
            wording_version = ?, wording_text = ?
      WHERE id = ? AND user_id = ? AND signed_at IS NULL`
  ).bind(ts, name, email, ipHash, WAIVER_VERSION, waiverRecord(agency, advisor), w.id, w.user_id).run();
  if (!res.meta || !res.meta.changes) return badRequest('This has already been signed.');

  // Declined, unless something firmer is already on the reservation: a policy bought is not undone by a
  // form about declining one.
  await env.DB.prepare(
    `UPDATE bookings SET insurance_status = 'declined', updated_at = ?
      WHERE id = ? AND user_id = ? AND (insurance_status IS NULL OR insurance_status = 'unknown')`
  ).bind(ts, w.booking_id, w.user_id).run();

  await env.DB.prepare(
    `INSERT INTO trip_messages (id, booking_id, user_id, body, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(uid(), w.booking_id, w.user_id, `${name} signed the travel insurance waiver.`, ipHash, ts).run();
  await db.logActivity(env, w.user_id, 'waiver.signed', `${w.client_name} signed the travel insurance waiver`,
    { id: w.booking_id });

  const tripName = tripLine(w);
  try {
    await sendWaiverSignedEmail(env, {
      to: w.notify_email || w.advisor_email,
      firstName: w.first_name,
      clientName: w.client_name,
      signerName: name,
      tripName,
      href: `${appUrl(env)}/app/reservation?id=${encodeURIComponent(w.booking_id)}`,
    });
  } catch (e) {
    console.error('waiver signed mail', e);
  }
  try {
    await sendWaiverCopyEmail(env, {
      to: email,
      replyTo: w.notify_email || w.advisor_email,
      name,
      advisorName: advisor,
      tripName,
      signedOn: sayDay(ts),
      url: `${appUrl(env)}/w/${String(code).toLowerCase()}`,
      brand,
      agencyId: w.agency_id || null,
      agencyName: w.agency_name || '',
    });
  } catch (e) {
    console.error('waiver copy mail', e);
  }
  return json({ ok: true });
}
