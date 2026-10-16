// A group trip's own page, and registering for one.
//
// What was here before took a name, an email and "how many of you". That is an
// enquiry form with a cruise name on it, and it is the right thing for "we are
// thinking about something in the autumn, tell me more". It is the wrong thing
// for a trip that is real: a block of cabins at three grades, a deposit date,
// a passport deadline, and a question about what happens if somebody pulls out.
//
// Somebody deciding whether to put money down asks for the same five things
// every time, and until now none of them were on the record at all, let alone
// on the page. They are now, on the group, so this can show them.
//
// Server rendered with no framework and no external stylesheet, the same as
// the rest of the public pages here. Somebody opens this on a phone, from a
// link in a WhatsApp group, on whatever signal they have. The only script from
// anywhere else is Turnstile's, and only when it is switched on.
//
// Two separate totals, deliberately. The trip cost goes to the travel supplier
// through the agency and follows the supplier's cancellation tiers. The
// agency's own fee is the agency's and usually does not come back. A form that
// shows one number is hiding the half somebody will be angry about later.
//
// The portal takes no money here, in principle and in fact. There is no card
// field, no checkout and no payment provider: the agency tells them how to pay
// in their own words, through the link on the agency record.

import {
  json, badRequest, notFound, clean, cleanText, cleanDate, uid, now,
  sha256Hex, isValidEmail, normalizeEmail, readJson, escapeHtml as esc, usDate,
} from './util.js';
import { brandForUser, DEFAULT_BRAND, HEX_COLOR, readableOnWhite } from './brand.js';
import { seal, piiReady } from './pii.js';
import { turnstileWidget, verifyTurnstile, TURNSTILE_FAILED } from './turnstile.js';
import { sendSignupNoticeEmail } from './email.js';

// How many people one registration may name. Four is a family and eight is a
// reunion booking two cabins together; past that somebody is filling the form
// in wrongly and should be ringing the agency.
const MAX_TRAVELLERS = 8;

// Registrations from one address in an hour. The same number the short enquiry
// form uses, for the same reason.
const PER_HOUR = 5;

const STATUSES = ['new', 'contacted', 'confirmed', 'cancelled'];

export { STATUSES as REGISTRATION_STATUSES };

/**
 * The group behind a public address.
 *
 * Found by its code across every advisor on purpose: the code is a web address
 * that was handed out, so it has to be unique platform wide rather than within
 * one book. Everything below names the owner this returns, so the fence closes
 * again on the next statement.
 *
 * Note for anyone changing this: user_id appears here as a column being read,
 * not as a predicate. check-scope looks for the name in the statement text and
 * is therefore satisfied by that, which is the right answer for the wrong
 * reason. What actually makes this safe is the code being the credential and
 * registration_open having to be 1, not anything the checker can see.
 */
async function loadGroup(env, code) {
  const row = await env.DB.prepare(
    `SELECT id, user_id, name, vendor, product_name, destination, departure_port,
            depart_date, return_date, registration_open, registration_blurb, status,
            deposit_due, final_payment_due, passport_due, faq_json, terms,
            agency_fee_cents, fee_terms, trip_terms
       FROM travel_groups WHERE group_code = ? AND registration_open = 1`
  ).bind(code).first();
  return row || null;
}

/**
 * The rate bands, and how many of each are gone.
 *
 * Taken is counted rather than stored, because two numbers that can disagree
 * eventually will. One registration is one cabin: party size says how many
 * people are in it, and somebody who wants two cabins registers twice, which
 * is also how they end up with two cabin numbers from the supplier.
 */
async function loadRates(env, groupId, userId) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.room_type, r.occupancy, r.guests, r.cabins,
            r.per_guest_cents, r.taxes_cents, r.total_cents, r.sort_order,
            (SELECT COUNT(*) FROM group_registrations gr
              WHERE gr.rate_id = r.id AND gr.user_id = r.user_id
                AND gr.status <> 'cancelled') AS taken
       FROM group_rates r
      WHERE r.group_id = ? AND r.user_id = ?
      ORDER BY r.sort_order ASC`
  ).bind(groupId, userId).all().catch(() => ({ results: [] }));

  return (results || []).map((r) => ({
    ...r,
    left: Math.max(0, (Number(r.cabins) || 0) - (Number(r.taken) || 0)),
    // A band with no block size recorded is not sold out, it is unmetered. The
    // advisor has not said how many they hold, and refusing registrations
    // because of a blank field would be the page inventing a limit.
    metered: Number(r.cabins) > 0,
  }));
}

function faqOf(row) {
  if (!row || !row.faq_json) return [];
  try {
    const parsed = JSON.parse(row.faq_json);
    return Array.isArray(parsed) ? parsed.filter((p) => p && p.q && p.a) : [];
  } catch {
    return [];
  }
}

/** Always both digits, including the nought ones. */
function money(cents) {
  const n = Number(cents || 0) / 100;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sayDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  return usDate(iso);
}

function paragraphs(text) {
  if (!text) return '';
  return String(text).split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// ---------------------------------------------------------------- layout --

/**
 * The shell these two pages share.
 *
 * Its own rather than the one in publicform.js, which is a 560px single card
 * built for a form. This is a page somebody reads before they decide, so it is
 * wider and carries panels and cards that a form page has no use for.
 */
function page(title, body, brand, { wide = true } = {}) {
  const b = brand || DEFAULT_BRAND;
  const accent = HEX_COLOR.test(b.color || '') && readableOnWhite(b.color)
    ? b.color : DEFAULT_BRAND.color;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(b.name)}</title>
<link rel="icon" href="/logo-mark.png" type="image/png">
<style>
  :root { --navy:${accent}; --coral:#e55942; --ink:#2f4459; --soft:#5c7286;
          --line:#e4edf5; --shell:#fbf9f5; --amber-bg:#fdf4e3; --amber:#9a6b12; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--shell);color:var(--ink);
       font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased;padding:1.6rem 1rem 3rem}
  .wrap{max-width:${wide ? '48rem' : '34rem'};margin:0 auto}
  .brand{display:flex;align-items:center;gap:.6rem;margin-bottom:1.8rem}
  .brand img{width:36px;height:36px}
  .brand b{font-size:1rem;letter-spacing:.24em;text-transform:uppercase;color:var(--navy);font-weight:700}
  .brand small{display:block;font-size:.62rem;letter-spacing:.06em;color:var(--coral)}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:1.6rem;
        box-shadow:0 1px 2px rgba(15,28,43,.05);margin-bottom:1.2rem}
  h1{margin:0 0 .4rem;font-size:1.75rem;line-height:1.2;color:var(--navy);font-weight:700}
  h2{margin:0 0 .9rem;font-size:1.1rem;color:var(--navy);font-weight:700}
  .facts{margin:0 0 .3rem;color:var(--soft);font-size:.95rem}
  .when{margin:0;font-weight:600;color:var(--ink)}
  .blurb p{margin:0 0 .8rem}
  /* Key dates. A list rather than a table: four rows of two on a phone is a
     table that has to scroll sideways. */
  .dates{list-style:none;margin:0;padding:0;display:grid;gap:.7rem;
         grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))}
  .dates li{border-top:2px solid var(--line);padding-top:.6rem}
  .dates .lbl{display:block;font-size:.7rem;font-weight:700;letter-spacing:.1em;
              text-transform:uppercase;color:var(--soft);margin-bottom:.2rem}
  .dates .val{font-size:1rem;font-weight:700;color:var(--navy);font-variant-numeric:tabular-nums}
  .dates .none{font-weight:400;color:var(--soft)}
  /* Rate bands. */
  .rates{display:grid;gap:.9rem}
  .rate{border:1px solid var(--line);border-radius:11px;padding:1rem}
  .rate.gone{opacity:.55}
  .rate-top{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap}
  .rate b{font-size:1.02rem;color:var(--navy)}
  .rate .price{font-size:1.15rem;font-weight:700;color:var(--navy);
               font-variant-numeric:tabular-nums;white-space:nowrap}
  .rate .per{font-size:.76rem;font-weight:400;color:var(--soft)}
  .rate .meta{margin:.45rem 0 0;font-size:.86rem;color:var(--soft)}
  .left{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.06em;
        text-transform:uppercase;padding:.2rem .55rem;border-radius:999px;
        background:var(--amber-bg);color:var(--amber);margin-top:.5rem}
  .left.plenty{background:#e8f5f0;color:#1f7a5a}
  .left.gone{background:#fdeeec;color:#b3382a}
  .faq dt{font-weight:700;color:var(--navy);margin-top:1rem}
  .faq dt:first-child{margin-top:0}
  .faq dd{margin:.3rem 0 0}
  .cta{display:block;text-align:center;background:var(--coral);color:#fff;text-decoration:none;
       border-radius:999px;padding:.9rem 1.4rem;font-weight:700;margin-top:.4rem}
  .cta:hover{background:#c94430}
  .muted{color:var(--soft);font-size:.88rem}
  .field{margin-bottom:1rem}
  label{display:block;font-size:.85rem;font-weight:600;color:var(--navy);margin-bottom:.3rem}
  .req{color:var(--coral)}
  input,select,textarea{width:100%;font:inherit;padding:.65rem .8rem;border:1px solid #c7d9e9;
        border-radius:9px;background:#fff;color:#0f1c2b;min-height:44px}
  input:focus,select:focus,textarea:focus{outline:2px solid var(--coral);outline-offset:1px;
        border-color:transparent}
  textarea{min-height:80px;resize:vertical}
  fieldset{border:1px solid #d9e2ec;border-radius:10px;padding:1rem 1rem .2rem;margin:0 0 1rem}
  legend{font-size:.74rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
         color:var(--soft);padding:0 .4rem}
  .grid2{display:grid;gap:0 1rem;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))}
  .pick{display:flex;gap:.7rem;align-items:flex-start;border:1px solid var(--line);
        border-radius:11px;padding:.9rem;margin-bottom:.7rem;cursor:pointer;font-weight:400}
  .pick input{width:auto;min-height:0;margin-top:.25rem;flex:none}
  .pick.gone{opacity:.55;cursor:not-allowed}
  .pick-body{flex:1}
  .check{display:flex;gap:.6rem;align-items:flex-start;font-weight:400;margin-bottom:1rem}
  .check input{width:auto;min-height:0;margin-top:.25rem;flex:none}
  .totals{border-top:2px solid var(--line);margin-top:1rem;padding-top:1rem}
  .totals .row{display:flex;justify-content:space-between;gap:1rem;margin-bottom:.5rem}
  .totals .row b{font-variant-numeric:tabular-nums}
  .totals .terms{font-size:.82rem;color:var(--soft);margin:-.25rem 0 .8rem}
  button{width:100%;background:var(--coral);color:#fff;border:0;border-radius:999px;
         padding:.9rem 1.4rem;font:inherit;font-weight:700;cursor:pointer;min-height:44px}
  button:hover{background:#c94430}
  button:disabled{opacity:.6;cursor:not-allowed}
  .note{border-radius:10px;padding:.85rem 1rem;font-size:.9rem;margin-bottom:1.1rem}
  .note.error{background:#fdeeec;color:#b3382a}
  .note.pay{background:#f2f7fb;border-left:3px solid var(--navy);border-radius:4px}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .foot{text-align:center;margin-top:1.4rem;font-size:.78rem;color:#8395a5}
  .foot a{color:#8395a5}
  [hidden]{display:none!important}
</style></head>
<body><div class="wrap">
  <div class="brand"><img src="${esc(b.logoUrl || '/logo-mark.png')}" alt="">
    <span><b>${esc(b.name)}</b><small>${esc(b.tagline || '')}</small></span></div>
  ${body}
  <p class="foot">&copy; ${new Date().getFullYear()} ${esc(b.name)}
    &middot; <a href="/privacy">Privacy policy</a></p>
</div></body></html>`;
}

function gone(brand, message) {
  return new Response(page('Not available',
    `<div class="card"><h1>This trip is not taking names</h1><p>${esc(message)}</p></div>`, brand),
  { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ------------------------------------------------------- the landing page --

function dateList(g) {
  const rows = [
    ['Sails', g.depart_date],
    ['Deposit due', g.deposit_due],
    ['Balance due', g.final_payment_due],
    ['Passports in by', g.passport_due],
  ].filter(([, iso]) => iso);
  if (!rows.length) return '';
  return `<div class="card"><h2>Dates to keep</h2><ul class="dates">${
    rows.map(([label, iso]) => `<li><span class="lbl">${esc(label)}</span>
      <span class="val">${esc(sayDate(iso))}</span></li>`).join('')
  }</ul></div>`;
}

function rateCards(rates) {
  if (!rates.length) return '';
  return `<div class="card"><h2>What is held</h2><div class="rates">${
    rates.map((r) => {
      const out = r.metered && r.left === 0;
      const tag = !r.metered
        ? ''
        : out
          ? '<span class="left gone">None left</span>'
          : `<span class="left${r.left > 2 ? ' plenty' : ''}">${r.left} of ${r.cabins} left</span>`;
      const meta = [
        r.occupancy ? `${esc(r.occupancy)} occupancy` : '',
        r.guests ? `${r.guests} guest${r.guests === 1 ? '' : 's'}` : '',
        r.taxes_cents ? `taxes and fees ${money(r.taxes_cents)} each` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="rate${out ? ' gone' : ''}">
        <div class="rate-top"><b>${esc(r.room_type)}</b>
          <span class="price">${money(r.per_guest_cents)}<span class="per"> per guest</span></span></div>
        ${meta ? `<p class="meta">${meta}</p>` : ''}
        ${tag}
      </div>`;
    }).join('')
  }</div><p class="muted" style="margin:1rem 0 0;">Prices are per guest and do not include
    anything bought separately. The trip is paid to the travel supplier through us, and
    never on this page.</p></div>`;
}

function faqBlock(faq) {
  if (!faq.length) return '';
  return `<div class="card"><h2>Questions people ask</h2><dl class="faq">${
    faq.map((p) => `<dt>${esc(p.q)}</dt><dd>${esc(p.a)}</dd>`).join('')
  }</dl></div>`;
}

export async function renderGroupTripPage(request, env, code) {
  const g = await loadGroup(env, code);
  const brand = g ? await brandForUser(env, g.user_id) : null;
  if (!g || g.status === 'cancelled') {
    return gone(brand, 'The link may be out of date. Get in touch and we will tell you what is '
      + 'going out next.');
  }

  const rates = await loadRates(env, g.id, g.user_id);
  const facts = [g.vendor, g.product_name, g.destination, g.departure_port].filter(Boolean);
  const when = g.depart_date
    ? `${sayDate(g.depart_date)}${g.return_date ? ` to ${sayDate(g.return_date)}` : ''}`
    : '';

  const body = [
    '<div class="card">',
    `<h1>${esc(g.name)}</h1>`,
    facts.length ? `<p class="facts">${esc(facts.join(' · '))}</p>` : '',
    when ? `<p class="when">${esc(when)}</p>` : '',
    '</div>',
    g.registration_blurb ? `<div class="card blurb">${paragraphs(g.registration_blurb)}</div>` : '',
    dateList(g),
    rateCards(rates),
    faqBlock(faqOf(g)),
    `<div class="card"><h2>Coming with us</h2>
      <p class="muted" style="margin-top:0;">Tell us who is travelling and which cabin you want.
        It takes a couple of minutes and nothing is charged here.</p>
      <a class="cta" href="/g/${encodeURIComponent(code)}/register">Register for this trip</a></div>`,
    // The short enquiry stays. Not everybody reading this is ready to name
    // four passports, and losing "send me more" because the only button was
    // "register" would cost the agency the easier half of the list.
    `<div class="card"><h2>Not ready yet?</h2>
      <p class="muted" style="margin-top:0;">Leave your name and we will send you the details.</p>
      <form id="f" novalidate>
        <div class="note error" id="err" hidden></div>
        <div class="field"><label for="name">Your name <span class="req">*</span></label>
          <input id="name" name="name" required maxlength="120" autocomplete="name"></div>
        <div class="field"><label for="email">Email <span class="req">*</span></label>
          <input id="email" name="email" type="email" required maxlength="254" autocomplete="email"></div>
        <div class="field"><label for="phone">Mobile</label>
          <input id="phone" name="phone" type="tel" maxlength="40" autocomplete="tel"></div>
        <div class="field"><label for="party_size">How many of you</label>
          <input id="party_size" name="party_size" type="number" min="1" max="99"></div>
        <div class="field"><label for="notes">Anything you want us to know</label>
          <textarea id="notes" name="notes" maxlength="1000"></textarea></div>
        <div class="hp" aria-hidden="true"><label>Company website
          <input name="company_website" tabindex="-1" autocomplete="off"></label></div>
        ${turnstileWidget(env)}
        <button type="submit">Send me the details</button>
      </form></div>`,
    ENQUIRY_SCRIPT,
  ].filter(Boolean).join('\n');

  return new Response(page(g.name, body, brand),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const ENQUIRY_SCRIPT = `<scr${''}ipt>
const f = document.getElementById('f');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.hidden = true;
  const body = Object.fromEntries(new FormData(f).entries());
  const res = await fetch(location.pathname, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    err.textContent = data.error || 'Something went wrong.';
    err.hidden = false;
    return;
  }
  f.outerHTML = '<h2>Thanks, you are on the list</h2><p>' +
    (data.message || 'We will be in touch shortly.') + '</p>';
});
</scr${''}ipt>`;

// --------------------------------------------------------- registering --

function travellerBlock(i, withPassport) {
  const n = i + 1;
  const req = i === 0 ? ' <span class="req">*</span>' : '';
  return `<fieldset>
    <legend>${n === 1 ? 'Traveller 1' : `Traveller ${n}`}</legend>
    <div class="field"><label for="t${i}name">Full name, as it is on the passport${req}</label>
      <input id="t${i}name" name="t${i}name" maxlength="120"${i === 0 ? ' required' : ''}
        autocomplete="off"></div>
    <div class="grid2">
      <div class="field"><label for="t${i}dob">Date of birth</label>
        <input id="t${i}dob" name="t${i}dob" type="date"></div>
      <div class="field"><label for="t${i}email">Email</label>
        <input id="t${i}email" name="t${i}email" type="email" maxlength="254"></div>
    </div>
    ${withPassport ? `<div class="grid2">
      <div class="field"><label for="t${i}passport">Passport number</label>
        <input id="t${i}passport" name="t${i}passport" maxlength="40" autocomplete="off"></div>
      <div class="field"><label for="t${i}expiry">Passport expires</label>
        <input id="t${i}expiry" name="t${i}expiry" type="date"></div>
      <div class="field"><label for="t${i}country">Country of issue</label>
        <input id="t${i}country" name="t${i}country" maxlength="60" autocomplete="off"></div>
    </div>` : ''}
    <div class="field"><label for="t${i}dietary">Anything you cannot eat</label>
      <input id="t${i}dietary" name="t${i}dietary" maxlength="300"></div>
    <div class="field"><label for="t${i}access">Anything that would make the trip easier</label>
      <input id="t${i}access" name="t${i}access" maxlength="300"></div>
  </fieldset>`;
}

function ratePicker(rates) {
  if (!rates.length) {
    return '<p class="muted">No cabin grades have been loaded for this trip yet. Register '
      + 'anyway and we will come back to you with what is available.</p>';
  }
  return rates.map((r) => {
    const out = r.metered && r.left === 0;
    const perGuest = money(r.per_guest_cents);
    const taxes = r.taxes_cents ? ` plus ${money(r.taxes_cents)} taxes and fees` : '';
    return `<label class="pick${out ? ' gone' : ''}">
      <input type="radio" name="rate" value="${esc(r.id)}"${out ? ' disabled' : ''}
        data-guest="${Number(r.per_guest_cents) || 0}" data-tax="${Number(r.taxes_cents) || 0}">
      <span class="pick-body"><b>${esc(r.room_type)}</b>
        <span class="muted" style="display:block;">${perGuest} per guest${taxes}${
  r.occupancy ? ` · ${esc(r.occupancy)} occupancy` : ''}</span>
        <span class="muted" style="display:block;">${
  out ? 'None left' : r.metered ? `${r.left} of ${r.cabins} left` : 'Ask us about availability'}</span>
      </span></label>`;
  }).join('');
}

export async function renderRegisterPage(request, env, code) {
  const g = await loadGroup(env, code);
  const brand = g ? await brandForUser(env, g.user_id) : null;
  if (!g || g.status === 'cancelled') {
    return gone(brand, 'Registration for this trip has closed.');
  }

  const rates = await loadRates(env, g.id, g.user_id);
  // No key, no boxes. A form that takes a passport number it cannot encrypt
  // has to either write it in the clear or throw it away, and both are worse
  // than asking for it later by email. See docs/encryption.md.
  const withPassport = piiReady(env);
  const fee = Number(g.agency_fee_cents) || 0;

  const blocks = [];
  for (let i = 0; i < MAX_TRAVELLERS; i += 1) {
    // Two shown, the rest added by the button. A reunion party of six should
    // not have to scroll past four empty passports to find the submit.
    blocks.push(`<div class="tblock"${i > 1 ? ' hidden' : ''}>${travellerBlock(i, withPassport)}</div>`);
  }

  const body = [
    `<div class="card"><h1>Register for ${esc(g.name)}</h1>`,
    `<p class="muted">${esc([g.vendor, g.product_name].filter(Boolean).join(' · '))}${
      g.depart_date ? `, sailing ${esc(sayDate(g.depart_date))}` : ''}</p></div>`,

    '<form id="reg" novalidate><div class="card">',
    '<div class="note error" id="err" hidden></div>',
    '<h2>Which cabin</h2>',
    ratePicker(rates),
    '</div>',

    '<div class="card"><h2>Who to contact</h2>',
    '<div class="field"><label for="lead_name">Your name <span class="req">*</span></label>',
    '<input id="lead_name" name="lead_name" required maxlength="120" autocomplete="name"></div>',
    '<div class="grid2">',
    '<div class="field"><label for="lead_email">Email <span class="req">*</span></label>',
    '<input id="lead_email" name="lead_email" type="email" required maxlength="254" autocomplete="email"></div>',
    '<div class="field"><label for="lead_phone">Mobile</label>',
    '<input id="lead_phone" name="lead_phone" type="tel" maxlength="40" autocomplete="tel"></div>',
    '</div></div>',

    '<div class="card"><h2>Who is travelling</h2>',
    withPassport
      ? '<p class="muted" style="margin-top:0;">Names have to match the passport exactly, because '
        + 'that is what the supplier checks against. Passport details can be left blank now and '
        + 'sent later if you do not have them to hand.</p>'
      : '<p class="muted" style="margin-top:0;">Names have to match the passport exactly, because '
        + 'that is what the supplier checks against. We will ask for passport details separately.</p>',
    blocks.join('\n'),
    `<button type="button" id="more" style="width:auto;background:#fff;color:var(--navy);
      border:1px solid #c7d9e9;">Add another traveller</button>`,
    '</div>',

    '<div class="card"><h2>Who to ring if something happens</h2>',
    '<p class="muted" style="margin-top:0;">Somebody not travelling with you.</p>',
    '<div class="grid2">',
    '<div class="field"><label for="em_name">Name</label>',
    '<input id="em_name" name="em_name" maxlength="120"></div>',
    '<div class="field"><label for="em_phone">Phone</label>',
    '<input id="em_phone" name="em_phone" type="tel" maxlength="40"></div>',
    '<div class="field"><label for="em_rel">How you know them</label>',
    '<input id="em_rel" name="em_rel" maxlength="60" placeholder="Sister, neighbour"></div>',
    '</div></div>',

    '<div class="card"><h2>What this costs</h2>',
    '<div class="totals" id="totals">',
    '<div class="row"><span>Trip cost, per guest</span><b id="t-trip">Pick a cabin</b></div>',
    g.trip_terms ? `<p class="terms">${esc(g.trip_terms)}</p>` : '',
    fee ? `<div class="row"><span>Our fee, per guest</span><b>${money(fee)}</b></div>` : '',
    fee && g.fee_terms ? `<p class="terms">${esc(g.fee_terms)}</p>` : '',
    '</div>',
    '<div class="note pay"><b>How you pay.</b> Nothing is charged on this page and we do not '
      + 'take card details here. The trip is paid to the travel supplier through us, and we will '
      + 'send you the instructions once your cabin is held.</div>',
    g.terms ? `<div class="check"><input type="checkbox" id="agree" name="agree" required>
      <label for="agree" style="font-weight:400;margin:0;">${esc(g.terms)}</label></div>` : '',
    '<div class="hp" aria-hidden="true"><label>Company website',
    '<input name="company_website" tabindex="-1" autocomplete="off"></label></div>',
    turnstileWidget(env),
    '<button type="submit" id="go">Register</button>',
    '</div></form>',
    registerScript(fee),
  ].filter(Boolean).join('\n');

  return new Response(page(`Register for ${g.name}`, body, brand, { wide: false }),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function registerScript(feeCents) {
  return `<scr${''}ipt>
const form = document.getElementById('reg');
const err = document.getElementById('err');
const tripCell = document.getElementById('t-trip');
const blocks = [...document.querySelectorAll('.tblock')];

function cash(cents) {
  return '$' + (cents / 100).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// The trip cost follows the chosen band. Taxes are shown beside it rather than
// folded in, because the fare is the commissionable half and the taxes are not,
// and a single number hides which part a refund would be calculated on.
form.addEventListener('change', (e) => {
  if (e.target.name !== 'rate') return;
  const guest = Number(e.target.dataset.guest) || 0;
  const tax = Number(e.target.dataset.tax) || 0;
  tripCell.textContent = cash(guest) + (tax ? ' plus ' + cash(tax) + ' taxes and fees' : '');
});

document.getElementById('more').addEventListener('click', () => {
  const next = blocks.find((b) => b.hidden);
  if (!next) return;
  next.hidden = false;
  if (!blocks.some((b) => b.hidden)) document.getElementById('more').hidden = true;
  next.querySelector('input').focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const go = document.getElementById('go');
  const raw = Object.fromEntries(new FormData(form).entries());

  // Only the blocks somebody opened, and only the ones with a name in them. An
  // empty traveller block is not a traveller.
  const travellers = [];
  for (let i = 0; i < ${MAX_TRAVELLERS}; i += 1) {
    const name = (raw['t' + i + 'name'] || '').trim();
    if (!name) continue;
    travellers.push({
      name,
      dob: raw['t' + i + 'dob'] || '',
      email: raw['t' + i + 'email'] || '',
      passportNumber: raw['t' + i + 'passport'] || '',
      passportExpiry: raw['t' + i + 'expiry'] || '',
      passportCountry: raw['t' + i + 'country'] || '',
      dietary: raw['t' + i + 'dietary'] || '',
      accessibility: raw['t' + i + 'access'] || '',
    });
  }

  // Bracketed throughout, like the traveller fields above. These are form
  // field names rather than properties of anything the server sends, and
  // check-reads scans this file for raw.<name> looking for a column or an
  // alias behind it. There is none: the page itself is what builds them.
  const body = {
    rate: raw['rate'] || '',
    leadName: raw['lead_name'] || '',
    leadEmail: raw['lead_email'] || '',
    leadPhone: raw['lead_phone'] || '',
    emergencyName: raw['em_name'] || '',
    emergencyPhone: raw['em_phone'] || '',
    emergencyRelation: raw['em_rel'] || '',
    agree: Boolean(raw['agree']),
    company_website: raw['company_website'] || '',
    'cf-turnstile-response': raw['cf-turnstile-response'] || '',
    travellers,
  };

  go.disabled = true;
  try {
    const res = await fetch(location.pathname, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = data.error || 'Something went wrong.';
      err.hidden = false;
      go.disabled = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    form.outerHTML = '<div class="card"><h1>You are registered</h1><p>' +
      (data.message || 'We will be in touch shortly.') + '</p></div>';
  } catch (ex) {
    err.textContent = 'That did not send. Check your connection and try again.';
    err.hidden = false;
    go.disabled = false;
  }
});
</scr${''}ipt>`;
}

// ----------------------------------------------------------- writing it --

async function tooMany(env, group, ipHash) {
  if (!ipHash) return false;
  const seen = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM group_registrations
      WHERE group_id = ? AND user_id = ? AND ip_hash = ? AND created_at > ?`
  ).bind(group.id, group.user_id, ipHash, now() - 3600).first();
  return (seen?.n || 0) >= PER_HOUR;
}

function appUrl(env) {
  return (env.APP_URL || 'https://cttagents.com').replace(/\/$/, '');
}

/**
 * Tell the advisor somebody registered.
 *
 * Best effort, and nothing it does can fail the registration: the rows are
 * already written, and a party lost because a mail service was rate limiting
 * would be a far worse trade than a notice that did not arrive.
 */
async function notifyOwner(env, group, details) {
  try {
    const owner = await env.DB.prepare(
      'SELECT email, first_name, notify_email FROM users WHERE id = ?'
    ).bind(group.user_id).first();
    const address = owner?.notify_email || owner?.email;
    if (!address) return;
    await sendSignupNoticeEmail(env, {
      to: address,
      advisorFirstName: owner?.first_name,
      what: group.name,
      href: `${appUrl(env)}/app/group?id=${encodeURIComponent(group.id)}`,
      ...details,
    });
  } catch (e) {
    console.error('group registration notice', e);
  }
}

export async function handleRegister(request, env, code) {
  const g = await loadGroup(env, code);
  if (!g || g.status === 'cancelled') return notFound('This trip is not taking registrations.');

  const body = await readJson(request);

  // Cheapest check first, and it answers success on purpose: a script that is
  // told it failed tries again differently.
  if (clean(body.company_website, 200)) {
    return json({ ok: true, message: 'Thanks, we will be in touch.' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`group:${code}:${ip}`)).slice(0, 32) : null;
  if (await tooMany(env, g, ipHash)) {
    return json({ error: 'Too many from here. Please try again later.' }, 429);
  }

  if (!await verifyTurnstile(env, body['cf-turnstile-response'], ip)) {
    return badRequest(TURNSTILE_FAILED);
  }

  const leadName = clean(body.leadName, 120);
  const leadEmail = normalizeEmail(clean(body.leadEmail, 254));
  if (!leadName) return badRequest('Your name is required.');
  if (!leadEmail || !isValidEmail(leadEmail)) {
    return badRequest('A working email address is required.');
  }

  // The terms are only required when there are any. A group with nothing
  // written has nothing to agree to, and demanding a tick for an empty box
  // would be a dark pattern in reverse.
  if (g.terms && !body.agree) {
    return badRequest('Please confirm you have read the terms before registering.');
  }

  const rates = await loadRates(env, g.id, g.user_id);
  let rate = null;
  if (body.rate) {
    rate = rates.find((r) => r.id === body.rate) || null;
    // A rate id that is not one of this group's is not a validation message, it
    // is somebody poking. The same answer either way, and no row is written.
    if (!rate) return badRequest('That cabin grade is not on this trip.');
    if (rate.metered && rate.left <= 0) {
      return badRequest(`${rate.room_type} has gone. Pick another grade and we will see what we can do.`);
    }
  }

  const travellers = Array.isArray(body.travellers)
    ? body.travellers.slice(0, MAX_TRAVELLERS) : [];
  const named = travellers.filter((t) => clean(t && t.name, 120));
  if (!named.length) return badRequest('Tell us at least one person who is travelling.');

  // Refused rather than quietly dropped. Somebody who typed a passport number
  // in deserves to know it was not kept, and this cannot happen through the
  // form, which leaves the boxes out when there is no key.
  const sealing = piiReady(env);
  if (!sealing && named.some((t) => clean(t.passportNumber, 40))) {
    return badRequest('Passport details cannot be taken on this form yet. Leave them blank and '
      + 'we will ask for them separately.');
  }

  const ts = now();
  const registrationId = uid();

  await env.DB.prepare(
    `INSERT INTO group_registrations
       (id, group_id, user_id, name, email, phone, party_size, notes, ip_hash,
        rate_id, status, terms_at, terms_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`
  ).bind(registrationId, g.id, g.user_id, leadName, leadEmail,
         clean(body.leadPhone, 40) || null, named.length, null, ipHash,
         rate ? rate.id : null,
         // What was on screen, not a pointer to what it says now. The group's
         // terms can be edited afterwards and the only useful record is the
         // words somebody actually agreed to.
         g.terms ? ts : null, g.terms || null, ts, ts).run();

  for (const [i, t] of named.entries()) {
    await env.DB.prepare(
      `INSERT INTO group_travellers
         (id, registration_id, group_id, user_id, name, email, phone,
          dob_enc, passport_number_enc, passport_expiry_enc, passport_country,
          dietary, accessibility, emergency_name, emergency_phone, emergency_relation,
          is_lead, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uid(), registrationId, g.id, g.user_id,
           clean(t.name, 120), normalizeEmail(clean(t.email, 254)) || null, null,
           sealing ? await seal(env, cleanDate(t.dob)) : null,
           sealing ? await seal(env, clean(t.passportNumber, 40)) : null,
           sealing ? await seal(env, cleanDate(t.passportExpiry)) : null,
           clean(t.passportCountry, 60) || null,
           cleanText(t.dietary, 300) || null,
           cleanText(t.accessibility, 300) || null,
           // One emergency contact for the party, kept on the first traveller.
           // Asking six people for the same sister's phone number is how a
           // form gets abandoned half way down.
           i === 0 ? clean(body.emergencyName, 120) || null : null,
           i === 0 ? clean(body.emergencyPhone, 40) || null : null,
           i === 0 ? clean(body.emergencyRelation, 60) || null : null,
           i === 0 ? 1 : 0, ts, ts).run();
  }

  await notifyOwner(env, g, {
    name: leadName,
    email: leadEmail,
    phone: clean(body.leadPhone, 40) || null,
    partySize: named.length,
    notes: rate ? `Wants ${rate.room_type}` : 'No cabin grade chosen',
  });

  return json({
    ok: true,
    message: 'We have your details. We will hold what we can and come back to you with how to pay.',
  });
}
