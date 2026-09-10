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
import { sendTripMessageEmail } from './email.js';

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
  const [travellers, components, options, payments, documents] = await Promise.all([
    // Names only. The row carries passport numbers and dates of birth, and a
    // page that selects * is a page one careless template change away from
    // publishing them.
    env.DB.prepare(`SELECT name, is_lead FROM travellers
                     WHERE booking_id = ? AND user_id = ? ORDER BY is_lead DESC, name ASC`)
      .bind(booking.id, owner).all(),
    env.DB.prepare(`SELECT kind, product_name, supplier, start_date, end_date, confirmation_number
                      FROM components WHERE booking_id = ? AND user_id = ? ORDER BY sort_order ASC`)
      .bind(booking.id, owner).all(),
    env.DB.prepare(`SELECT label, detail, amount_cents, chosen FROM quote_options
                     WHERE booking_id = ? AND user_id = ? ORDER BY sort_order ASC`)
      .bind(booking.id, owner).all(),
    env.DB.prepare(`SELECT kind, amount_cents, due_date, paid_date FROM booking_payments
                     WHERE booking_id = ? AND user_id = ? ORDER BY COALESCE(due_date, paid_date) ASC`)
      .bind(booking.id, owner).all(),
    env.DB.prepare(`SELECT id, filename, category, size_bytes FROM documents
                     WHERE booking_id = ? AND user_id = ? AND shared = 1 ORDER BY created_at ASC`)
      .bind(booking.id, owner).all(),
  ]);

  return {
    booking,
    travellers: travellers.results || [],
    components: components.results || [],
    options: options.results || [],
    payments: payments.results || [],
    documents: documents.results || [],
  };
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

    ${trip.components.length ? `<section class="card pad">
      <h2>Also on this trip</h2>
      <ul class="plain">${trip.components.map((c) => `<li>
        <strong>${esc(c.product_name || c.kind)}</strong>
        ${c.supplier ? `<span class="dim"> · ${esc(c.supplier)}</span>` : ''}
        ${c.start_date ? `<div class="dim">${esc(shortDate(c.start_date))}${
          c.end_date ? ` to ${esc(shortDate(c.end_date))}` : ''}</div>` : ''}
      </li>`).join('')}</ul>
    </section>` : ''}

    ${trip.options.length ? `<section class="card pad">
      <h2>What was offered</h2>
      <p class="dim">If you would rather have one of the others, tell ${esc(advisor)} below.</p>
      <div class="options">${trip.options.map((o) => `<div class="option${o.chosen ? ' on' : ''}">
        ${o.chosen ? '<span class="tick">Chosen</span>' : ''}
        <p class="olabel">${esc(o.label)}</p>
        ${o.amount_cents ? `<p class="oamount">${esc(money(o.amount_cents))}</p>` : ''}
        ${o.detail ? `<p class="dim">${esc(o.detail)}</p>` : ''}
      </div>`).join('')}</div>
    </section>` : ''}

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
    ${SAY_SCRIPT}`;

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
