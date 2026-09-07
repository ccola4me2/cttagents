// Publicly hosted forms at /f/<slug>.
//
// Rendered by the Worker rather than served as a static file, because the
// markup depends on the field definitions in D1. Deliberately self-contained:
// no external fonts, no scripts from anywhere else, so it loads fast and
// cannot be broken by a third party going down.
//
// These pages are unauthenticated by design. Everything below assumes hostile
// input.

import { json, badRequest, notFound, uid, now, clean, cleanText, isValidEmail, normalizeEmail, sha256Hex, readJson } from './util.js';
import * as ghl from './ghl.js';
import { upsertContact } from './sync.js';
import { hydrateForm } from './formbuilder.js';
import { fireTrigger } from './automations.js';
import { sendSignupNoticeEmail } from './email.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function loadForm(env, slug) {
  const row = await env.DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(slug).first();
  return row ? { row, form: hydrateForm(row) } : null;
}

function fieldMarkup(f) {
  const id = `f_${esc(f.key)}`;
  const req = f.required ? ' required' : '';
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  let input;
  if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${esc(f.key)}"${req}${ph}></textarea>`;
  } else if (f.type === 'select') {
    input = `<select id="${id}" name="${esc(f.key)}"${req}>
      <option value="">Choose one</option>
      ${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
    </select>`;
  } else if (f.type === 'checkbox') {
    return `<label class="check"><input type="checkbox" id="${id}" name="${esc(f.key)}" value="yes"${req}>
      <span>${esc(f.label)}</span></label>`;
  } else {
    input = `<input type="${esc(f.type)}" id="${id}" name="${esc(f.key)}"${req}${ph}>`;
  }
  return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;
}

export async function renderPublicForm(request, env, slug) {
  const found = await loadForm(env, slug);
  if (!found || !found.form.active) {
    return new Response(page('Form unavailable',
      '<h1>This form is not available</h1><p>The link may be out of date. Please get in touch and we will send you a new one.</p>'),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const f = found.form;
  const body = `
    <h1>${esc(f.headline || f.name)}</h1>
    ${f.description ? `<p class="lede">${esc(f.description)}</p>` : ''}
    <div class="note error" id="err" hidden></div>
    <div class="note ok" id="ok" hidden></div>
    <form id="form" novalidate>
      ${f.fields.map(fieldMarkup).join('')}
      <!-- Honeypot: a real person never fills this in, a naive bot fills everything. -->
      <div class="hp" aria-hidden="true">
        <label for="company_website">Company website</label>
        <input type="text" id="company_website" name="company_website" tabindex="-1" autocomplete="off">
      </div>
      <button type="submit">${esc(f.submitLabel)}</button>
    </form>
    <script>
      const form = document.getElementById('form');
      const err = document.getElementById('err');
      const ok = document.getElementById('ok');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button');
        btn.disabled = true;
        err.hidden = true;
        try {
          const data = Object.fromEntries(new FormData(form).entries());
          const res = await fetch(${JSON.stringify(`/api/public/forms/${f.slug}`)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          const out = await res.json();
          if (!res.ok) throw new Error(out.error || 'Something went wrong.');
          if (out.redirect) { window.location.href = out.redirect; return; }
          form.hidden = true;
          ok.textContent = out.message;
          ok.hidden = false;
        } catch (e2) {
          err.textContent = e2.message;
          err.hidden = false;
          btn.disabled = false;
        }
      });
    </script>`;

  return new Response(page(f.name, body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * A group's own page, where people put their name down for the trip.
 *
 * A group cruise is sold by telling people about it and collecting names, and
 * that was happening in an inbox: the advisor posts about a sailing, replies
 * arrive as email, and who is interested lives in their head. This is a link
 * they can put anywhere, and every name lands attached to the group.
 *
 * Public by design, so it asks for as little as it can: who you are, how to
 * reach you, how many of you. Nothing about payment, nothing about passports.
 */
// Kept as its own constant so the closing script tag is never written inside
// another template literal, which is how a page silently ends early.
const GROUP_SCRIPT = ['<scr', 'ipt>',
  "const f=document.getElementById('f');",
  "f.addEventListener('submit', async (e) => {",
  '  e.preventDefault();',
  "  const err = document.getElementById('err');",
  '  err.hidden = true;',
  '  const body = Object.fromEntries(new FormData(f).entries());',
  "  const res = await fetch(location.pathname, { method: 'POST',",
  "    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });",
  '  const data = await res.json().catch(() => ({}));',
  '  if (!res.ok) {',
  "    err.textContent = data.error || 'Something went wrong.';",
  '    err.hidden = false;',
  '    return;',
  '  }',
  '  f.outerHTML = \'<h2>Thanks, you are on the list</h2><p>\' +',
  "    (data.message || 'We will be in touch shortly.') + '</p>';",
  '});',
  '</scr', 'ipt>'].join('\n');

async function loadGroup(env, code) {
  const row = await env.DB.prepare(
    `SELECT id, user_id, name, vendor, product_name, destination, depart_date,
            return_date, registration_open, registration_blurb, status
       FROM travel_groups WHERE group_code = ? AND registration_open = 1`
  ).bind(code).first();
  return row || null;
}

/**
 * A date the way somebody says it out loud.
 *
 * The advisor's own pages format dates in script; this one is server-rendered
 * for people with no account, and 2026-12-29 on a page inviting them on a
 * cruise reads like a database. Built in UTC so the day never shifts.
 */
function sayDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || '';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US',
    { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The advisor's own words, kept in the shape they typed them.
 *
 * They write the blurb in a textarea with a blank line between thoughts, and
 * running that into one block loses the only formatting the page offers.
 * Escaped first, so this splits text that can no longer carry markup.
 */
function paragraphs(text) {
  if (!text) return '';
  return String(text).split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export async function renderGroupPage(request, env, code) {
  const g = await loadGroup(env, code);
  if (!g || g.status === 'cancelled') {
    return new Response(page('Not available',
      '<h1>This trip is not taking names</h1><p>The link may be out of date. Get in touch and '
      + 'we will tell you what is going out next.</p>'),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const facts = [g.vendor, g.product_name, g.destination].filter(Boolean);
  const when = g.depart_date
    ? `<p>${esc(sayDate(g.depart_date))}${
        g.return_date ? ` to ${esc(sayDate(g.return_date))}` : ''}</p>` : '';

  const body = [
    `<h1>${esc(g.name)}</h1>`,
    facts.length ? `<p>${esc(facts.join(' \u00b7 '))}</p>` : '',
    when,
    paragraphs(g.registration_blurb),
    '<form id="f" novalidate>',
    '<label for="name">Your name</label><input id="name" name="name" required maxlength="120">',
    '<label for="email">Email</label><input id="email" name="email" type="email" required maxlength="254">',
    '<label for="phone">Mobile</label><input id="phone" name="phone" type="tel" maxlength="40">',
    '<label for="party_size">How many of you</label><input id="party_size" name="party_size" type="number" min="1" max="99">',
    '<label for="notes">Anything you want us to know</label><textarea id="notes" name="notes" maxlength="1000"></textarea>',
    '<div class="hp"><label>Company website<input name="company_website" tabindex="-1" autocomplete="off"></label></div>',
    '<button type="submit">Put me down</button>',
    '<p class="err" id="err" hidden></p>',
    '</form>',
    GROUP_SCRIPT,
  ].join('\n');

  return new Response(page(g.name, body),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function appUrl(env) {
  return (env.APP_URL || 'https://tripvaratravel.com').replace(/\/$/, '');
}

/**
 * Let the advisor know somebody got in touch.
 *
 * A public page that quietly files names into a screen nobody has open is the
 * inbox problem again with an extra step. Everything here is best effort and
 * nothing it does can fail the submission: the name is already saved, and a
 * lead lost because Resend was rate limiting would be a far worse trade than
 * a notice that did not arrive.
 */
async function notifyOwner(env, userId, { to, ...details }) {
  try {
    const owner = userId ? await env.DB.prepare(
      'SELECT email, first_name, notify_email FROM users WHERE id = ?'
    ).bind(userId).first() : null;
    // The address they asked to be told on, then the one they sign in with.
    // A form that names its own address still wins over both.
    const address = to || owner?.notify_email || owner?.email;
    if (!address) return;
    await sendSignupNoticeEmail(env, {
      to: address, advisorFirstName: owner?.first_name, ...details,
    });
  } catch (e) {
    console.error('signup notice', e);
  }
}

export async function handleGroupRegistration(request, env, code) {
  const g = await loadGroup(env, code);
  if (!g || g.status === 'cancelled') return notFound('This trip is not taking names.');

  const body = await readJson(request);

  // The same honeypot and rate limit as a hosted form, for the same reason:
  // this page is open to the internet.
  if (clean(body.company_website, 200)) return json({ ok: true, message: 'Thanks.' });

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`group:${code}:${ip}`)).slice(0, 32) : null;
  if (ipHash) {
    const seen = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM group_registrations
        WHERE group_id = ? AND ip_hash = ? AND created_at > ?`
    ).bind(g.id, ipHash, now() - 3600).first();
    if ((seen?.n || 0) >= 5) {
      return json({ error: 'Too many from here. Please try again later.' }, 429);
    }
  }

  const name = clean(body.name, 120);
  const email = normalizeEmail(clean(body.email, 254));
  if (!name) return badRequest('Your name is required.');
  if (!email || !isValidEmail(email)) return badRequest('A working email address is required.');

  const phone = clean(body.phone, 40) || null;
  const partySize = Math.max(0, Math.min(Number(body.party_size) || 0, 99)) || null;
  const notes = cleanText(body.notes, 1000) || null;

  await env.DB.prepare(
    `INSERT INTO group_registrations
       (id, group_id, user_id, name, email, phone, party_size, notes, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uid(), g.id, g.user_id, name, email, phone, partySize, notes, ipHash, now()).run();

  // Tell the advisor. The row is already written, so a mail failure loses the
  // notice and not the lead: this is a best-effort nudge towards a page that
  // has the name on it either way.
  await notifyOwner(env, g.user_id, {
    what: g.name,
    href: `${appUrl(env)}/app/group?id=${encodeURIComponent(g.id)}`,
    name, email, phone, partySize, notes,
  });

  return json({ ok: true, message: 'We will be in touch with the details shortly.' });
}


/**
 * A deal's own page.
 *
 * Server rendered like the group page and for the same reason: it gets posted
 * to Facebook and pasted into an email, so it has to be a real page to
 * somebody with no account and no JavaScript worth waiting for.
 *
 * An expired deal is not a 404. Somebody has clicked a link the advisor put
 * out, and telling them the page does not exist reads like a broken business;
 * telling them the offer has gone and asking what they were after keeps the
 * enquiry, which is the entire point of the page.
 */
async function loadSpecial(env, code) {
  const row = await env.DB.prepare(
    `SELECT id, user_id, code, headline, vendor, ship, destination, depart_date,
            return_date, nights, price_cents, price_basis, inclusions, terms,
            blurb, starts_on, ends_on, published
       FROM specials WHERE code = ? AND published = 1`
  ).bind(code).first();
  return row || null;
}

const SPECIAL_MONEY = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', {
  minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export async function renderSpecialPage(request, env, code) {
  const s = await loadSpecial(env, code);
  if (!s) {
    return new Response(page('Not available',
      '<h1>This deal is not showing</h1><p>The link may be out of date. Get in touch and we '
      + 'will tell you what is going out next.</p>'),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const today = new Date().toISOString().slice(0, 10);
  const gone = Boolean(s.ends_on && s.ends_on < today);

  const facts = [
    s.vendor, s.ship, s.destination,
    s.nights ? `${s.nights} nights` : null,
  ].filter(Boolean);

  const when = s.depart_date
    ? `<p>Sailing ${esc(sayDate(s.depart_date))}${
      s.return_date ? ` to ${esc(sayDate(s.return_date))}` : ''}</p>` : '';

  const price = s.price_cents
    ? `<p style="font-size:1.9rem;font-weight:650;color:var(--navy);margin:.4rem 0 0;">
         ${esc(SPECIAL_MONEY(s.price_cents))}
         <span style="font-size:.85rem;font-weight:400;color:#5c7286;">${
  esc(s.price_basis || 'per person')}</span></p>` : '';

  const list = (title, text) => (text
    ? `<h2 style="font-size:1rem;color:var(--navy);margin:1.6rem 0 .4rem;">${esc(title)}</h2>`
      + paragraphs(text)
    : '');

  const deadline = gone
    ? '<div class="note error">This offer has closed. Tell us what you were after and we will '
      + 'find you the nearest thing going now.</div>'
    : (s.ends_on
      ? `<div class="note ok">Book by ${esc(sayDate(s.ends_on))}.</div>` : '');

  const body = [
    deadline,
    `<h1>${esc(s.headline)}</h1>`,
    facts.length ? `<p class="lede">${esc(facts.join(' · '))}</p>` : '',
    price,
    when,
    paragraphs(s.blurb),
    list("What's included", s.inclusions),
    list('The small print', s.terms),
    '<h2 style="font-size:1rem;color:var(--navy);margin:1.8rem 0 .6rem;">'
      + (gone ? 'Tell us what you are after' : 'Ask about this one') + '</h2>',
    '<form id="f" novalidate>',
    '<label for="name">Your name</label><input id="name" name="name" required maxlength="120">',
    '<label for="email">Email</label><input id="email" name="email" type="email" required maxlength="254">',
    '<label for="phone">Mobile</label><input id="phone" name="phone" type="tel" maxlength="40">',
    '<label for="party_size">How many travelling</label><input id="party_size" name="party_size" type="number" min="1" max="99">',
    '<label for="notes">Anything you want us to know</label><textarea id="notes" name="notes" maxlength="1000"></textarea>',
    '<div class="hp"><label>Company website<input name="company_website" tabindex="-1" autocomplete="off"></label></div>',
    `<button type="submit">${gone ? 'Send it over' : 'Ask about this deal'}</button>`,
    '<p class="err" id="err" hidden></p>',
    '</form>',
    SPECIAL_SCRIPT,
  ].filter(Boolean).join('\n');

  return new Response(page(s.headline, body),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const SPECIAL_SCRIPT = ['<scr', 'ipt>',
  "const f=document.getElementById('f');",
  "f.addEventListener('submit', async (e) => {",
  '  e.preventDefault();',
  "  const err = document.getElementById('err');",
  '  err.hidden = true;',
  '  const body = Object.fromEntries(new FormData(f).entries());',
  "  const res = await fetch(location.pathname, { method: 'POST',",
  "    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });",
  '  const data = await res.json().catch(() => ({}));',
  '  if (!res.ok) {',
  "    err.textContent = data.error || 'Something went wrong.';",
  '    err.hidden = false;',
  '    return;',
  '  }',
  '  f.outerHTML = \'<h2>Thanks, we have got that</h2><p>\' +',
  "    (data.message || 'We will be in touch shortly.') + '</p>';",
  '});',
  '</scr', 'ipt>'].join('\n');

export async function handleSpecialEnquiry(request, env, code) {
  const s = await loadSpecial(env, code);
  if (!s) return notFound('This deal is not showing.');

  const body = await readJson(request);

  // The same honeypot and rate limit as every other page open to the internet.
  if (clean(body.company_website, 200)) return json({ ok: true, message: 'Thanks.' });

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`special:${code}:${ip}`)).slice(0, 32) : null;
  if (ipHash) {
    const seen = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM special_leads
        WHERE special_id = ? AND ip_hash = ? AND created_at > ?`
    ).bind(s.id, ipHash, now() - 3600).first();
    if ((seen?.n || 0) >= 5) {
      return json({ error: 'Too many from here. Please try again later.' }, 429);
    }
  }

  const name = clean(body.name, 120);
  const email = normalizeEmail(clean(body.email, 254));
  if (!name) return badRequest('Your name is required.');
  if (!email || !isValidEmail(email)) return badRequest('A working email address is required.');

  await env.DB.prepare(
    `INSERT INTO special_leads
       (id, special_id, user_id, name, email, phone, party_size, notes, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uid(), s.id, s.user_id, name, email, clean(body.phone, 40) || null,
         Math.max(0, Math.min(Number(body.party_size) || 0, 99)) || null,
         cleanText(body.notes, 1000) || null, ipHash, now()).run();

  await notifyOwner(env, s.user_id, {
    what: s.headline,
    href: `${appUrl(env)}/app/special?id=${encodeURIComponent(s.id)}`,
    name, email,
    phone: clean(body.phone, 40) || null,
    partySize: Math.max(0, Math.min(Number(body.party_size) || 0, 99)) || null,
    notes: cleanText(body.notes, 1000) || null,
  });

  const gone = Boolean(s.ends_on && s.ends_on < new Date().toISOString().slice(0, 10));
  return json({
    ok: true,
    message: gone
      ? 'We will come back to you with what is going now.'
      : 'We will be in touch with the details shortly.',
  });
}

export async function handlePublicSubmit(request, env, slug) {
  const found = await loadForm(env, slug);
  if (!found || !found.form.active) return notFound('This form is not available.');
  const { form, row } = found;

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  // Rate limit before doing any work. These pages are unauthenticated, so the
  // honeypot below is the only other thing standing between them and a script.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`${slug}:${ip}`)).slice(0, 32) : null;
  if (ipHash) {
    const since = now() - 3600;
    const seen = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ? AND ip_hash = ? AND created_at > ?'
    ).bind(form.id, ipHash, since).first();
    if ((seen?.n || 0) >= 10) {
      return json({ error: 'Too many submissions from here. Please try again later.' }, 429);
    }
  }

  // Honeypot. Answer as if it worked so a bot learns nothing.
  if (clean(body.company_website, 200)) {
    return json({ ok: true, message: form.successMessage || 'Thanks, we have got it.' });
  }

  const data = {};
  for (const f of form.fields) {
    const raw = clean(body[f.key], f.type === 'textarea' ? 4000 : 300);
    if (f.required && !raw) return badRequest(`${f.label} is required.`);
    if (f.type === 'email' && raw && !isValidEmail(raw)) {
      return badRequest(`${f.label} needs a valid email address.`);
    }
    if (raw) data[f.key] = raw;
  }

  // Pull out whatever looks like identity, whatever the field keys are called.
  const pick = (types, names) => {
    for (const f of form.fields) {
      if (types.includes(f.type) && data[f.key]) return data[f.key];
    }
    for (const f of form.fields) {
      if (names.some((n) => f.key.includes(n) || f.label.toLowerCase().includes(n)) && data[f.key]) {
        return data[f.key];
      }
    }
    return '';
  };
  const email = normalizeEmail(pick(['email'], ['email']));
  const phone = pick(['tel'], ['phone', 'mobile', 'cell']);

  // Name is built from first and last when the form asks for them separately,
  // which is the common case. A single "name" or "full name" field wins only
  // when there is no split pair, otherwise matching on "name" grabs
  // "first_name" and silently drops the surname.
  const byKey = (...names) => {
    for (const f of form.fields) {
      const k = f.key.toLowerCase();
      const l = f.label.toLowerCase();
      if (names.some((n) => k === n || k.includes(n) || l.includes(n)) && data[f.key]) return data[f.key];
    }
    return '';
  };
  const first = byKey('first_name', 'firstname', 'first name');
  const last = byKey('last_name', 'lastname', 'last name');
  const name = (first || last)
    ? [first, last].filter(Boolean).join(' ')
    : byKey('full_name', 'full name', 'your name', 'name');

  const submissionId = uid();
  await env.DB.prepare(
    `INSERT INTO form_submissions
       (id, form_id, location_id, contact_id, name, email, phone, data_json, source, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(submissionId, form.id, row.location_id, null, name || null, email || null,
         phone || null, JSON.stringify(data), `form:${form.slug}`, ipHash, now()).run();

  // Push the contact upstream so messaging and automations still see it. Best
  // effort on purpose: losing a lead because the CRM was rate limiting would
  // be far worse than a contact arriving a few minutes late.
  let contactId = null;
  if (email || phone) {
    try {
      const parts = (name || '').split(/\s+/);
      const contact = await ghl.createContact(env, row.location_id, {
        firstName: parts[0] || undefined,
        lastName: parts.slice(1).join(' ') || undefined,
        email: email || undefined,
        phone: phone || undefined,
        source: `Trip Vara form: ${form.name}`,
      });
      if (contact && contact.id) {
        contactId = contact.id;
        await upsertContact(env, row.location_id, contact);
        await env.DB.prepare('UPDATE form_submissions SET contact_id = ? WHERE id = ?')
          .bind(contact.id, submissionId).run();
      }
    } catch (e) {
      console.error('form contact push', e);
    }
  }

  // Kick off any automations listening for this. Enqueue only, never execute
  // inline: a misconfigured automation must not slow down or fail a lead
  // submission.
  const context = {
    formId: form.id, formName: form.name, formSlug: form.slug,
    contactId: contactId || null, name, email, phone, ...data,
  };
  await fireTrigger(env, row.location_id, 'form.submitted', context);

  // A form submission that produced a new contact is also a new contact, and
  // someone building a "welcome new contact" automation reasonably expects it
  // to cover leads that arrive by form. Only fires when a contact was actually
  // created, so it never double-fires for an anonymous submission.
  if (contactId) {
    await fireTrigger(env, row.location_id, 'contact.created', context);
  }

  // The form has carried a "notify" address since it got its settings, and
  // nothing has ever read it: a lead arrived, the row was written, and the
  // person who asked to be told was not. Where no address is set the form's
  // author is told instead, which is what somebody building a form expects
  // and is the same rule the group pages follow.
  await notifyOwner(env, row.created_by, {
    to: form.notifyEmail || null,
    what: form.name,
    href: `${appUrl(env)}/app/forms`,
    name: name || 'Someone',
    email, phone,
    notes: Object.entries(data)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `${k}: ${v}`).join('\n') || null,
  });

  return json({
    ok: true,
    message: form.successMessage || 'Thanks, we have got it. We will be in touch shortly.',
    redirect: form.redirectUrl || null,
  }, 201);
}

/** Standalone page shell. No external requests at all. */
function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Trip Vara</title>
<link rel="icon" href="/logo-mark.svg" type="image/svg+xml">
<style>
  :root { --navy:#1b3a5f; --navy-d:#12294a; --coral:#f1705b; --ink:#2f4459;
          --line:#e4edf5; --shell:#fbf9f5; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--shell);color:var(--ink);
       font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased;padding:2rem 1rem}
  .wrap{max-width:560px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:.6rem;margin-bottom:2rem}
  .brand img{width:36px;height:36px}
  .brand b{font-size:1rem;letter-spacing:.26em;text-transform:uppercase;color:var(--navy);font-weight:650}
  .brand small{display:block;font-size:.62rem;letter-spacing:.06em;color:var(--coral)}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:2rem;
        box-shadow:0 1px 2px rgba(15,28,43,.05)}
  h1{margin:0 0 .5rem;font-size:1.6rem;line-height:1.25;color:var(--navy);font-weight:650}
  .lede{margin:0 0 1.6rem;color:#5c7286}
  .field{margin-bottom:1.1rem}
  label{display:block;font-size:.85rem;font-weight:600;color:var(--navy);margin-bottom:.35rem}
  .req{color:var(--coral)}
  input,select,textarea{width:100%;font:inherit;padding:.65rem .8rem;border:1px solid #c7d9e9;
        border-radius:9px;background:#fff;color:#0f1c2b}
  input:focus,select:focus,textarea:focus{outline:2px solid var(--coral);outline-offset:1px;border-color:transparent}
  textarea{min-height:110px;resize:vertical}
  .check{display:flex;gap:.6rem;align-items:flex-start;font-weight:400;margin-bottom:1.1rem}
  .check input{width:auto;margin-top:.25rem}
  button{width:100%;background:var(--coral);color:#fff;border:0;border-radius:999px;
         padding:.85rem 1.4rem;font:inherit;font-weight:650;cursor:pointer}
  button:hover{background:#e55942}
  button:disabled{opacity:.6;cursor:not-allowed}
  .note{border-radius:10px;padding:.85rem 1rem;font-size:.9rem;margin-bottom:1.2rem}
  .note.error{background:#fdeeec;color:#b3382a}
  .note.ok{background:#e8f5f0;color:#1f7a5a}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .foot{text-align:center;margin-top:1.5rem;font-size:.78rem;color:#8395a5}
  [hidden]{display:none!important}
</style></head>
<body><div class="wrap">
  <div class="brand"><img src="/logo-mark.svg" alt="">
    <span><b>TripVara</b><small>From first inquiry to welcome home.</small></span></div>
  <div class="card">${body}</div>
  <p class="foot">&copy; ${new Date().getFullYear()} Trip Vara Travel</p>
</div></body></html>`;
}
