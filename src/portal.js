// The pages a signed-in client sees.
//
// Server rendered with no JavaScript at all, including the sign-in form. A
// client opens this on a phone in an airport on somebody else's wifi, and the
// less that has to load before they can see what they owe, the better. It also
// means the sign-in form works with scripts blocked, which is not exotic on a
// work laptop.
//
// The link pages at /t/<code> and /c/<code> are unchanged and still work. This
// is a second way in for people who would rather not keep a link, not a
// replacement for the first.
//
// Nothing here may read a commission field. check-private.mjs holds that line
// and this file is on its list.

import { clean } from './util.js';
import { page } from './share.js';
import { escapeHtml as esc } from './util.js';
import { brandForUser } from './brand.js';
import { loadBookFor, bookBody } from './hub.js';
import { currentClient, clientRowsFor, requestLink, normaliseEmail } from './clientauth.js';

const html = (body, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});

/**
 * The sign-in page.
 *
 * `note` is what just happened, if anything. An expired link and a sent link
 * both land here, and saying nothing would leave somebody pressing the button
 * again.
 */
function signInPage(note = '') {
  const body = `<div class="wrap">
    <header class="head">
      <h1>Your trips</h1>
      <p class="dim">Sign in to see everything we hold for you.</p>
    </header>
    <section class="card pad">
      ${note}
      <form method="post" action="/portal">
        <p class="lede" style="margin-top:0;">Type the email address your advisor has for you
          and we will send you a link. No password to remember.</p>
        <label for="email" class="tlabel">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email"
          inputmode="email" placeholder="you@example.com"
          style="width:100%;padding:.8rem;font-size:1rem;border:1px solid #c7d9e9;
                 border-radius:8px;margin:.4rem 0 1rem;">
        <button type="submit"
          style="width:100%;padding:.85rem;font-size:1rem;font-weight:600;border:0;
                 border-radius:8px;background:#1b3a5f;color:#fff;cursor:pointer;">
          Email me a link</button>
      </form>
      <p class="dim small" style="margin-bottom:0;">The link works once and lasts twenty
        minutes. If you already have a link to a trip, that still works too.</p>
    </section>
  </div>`;
  return html(page('Your trips', body, null));
}

/** GET /portal */
export async function renderPortal(request, env) {
  const who = await currentClient(request, env);
  if (!who) {
    const why = clean(new URL(request.url).searchParams.get('e'), 20);
    return signInPage(why === 'expired'
      ? `<p class="lede" style="margin-top:0;color:#b3382a;">That link has been used already or
         has run out. Ask for another and it will be with you in a moment.</p>`
      : '');
  }

  const rows = await clientRowsFor(env, who);
  if (!rows.length) {
    // Signed in, but the advisor has since changed the address on the record.
    // Saying so is better than an empty page that looks broken.
    return html(page('Your trips', `<div class="wrap"><div class="card pad">
      <h1>Nothing here yet</h1>
      <p class="dim">We could not find anything under ${esc(who.email)}. If your advisor has
        you down under a different address, ask them and sign in with that one.</p>
      <form method="post" action="/portal/out"><button type="submit"
        style="padding:.7rem 1.1rem;border:1px solid #c7d9e9;background:#fff;border-radius:8px;
               cursor:pointer;">Sign out</button></form>
    </div></div>`, null));
  }

  const { bookings, paid } = await loadBookFor(env, rows);

  // One person, possibly several client records. The name on the page is the
  // one their advisor uses; the rest of the identity is the address they
  // signed in with, which is already on screen at the bottom.
  const client = {
    id: rows[0].id,
    name: rows[0].name,
    user_id: rows[0].user_id,
    hub_code: null,
    agency_name: null,
  };

  const brandOwner = rows[0].user_id;
  const extra = await env.DB.prepare(
    `SELECT u.first_name, u.last_name, u.email AS advisor_email, u.notify_email,
            u.phone AS advisor_phone, u.agency_name, u.seller_of_travel
       FROM users u WHERE u.id = ?`
  ).bind(brandOwner).first().catch(() => null);
  Object.assign(client, extra || {});

  const body = bookBody({ client, bookings, paid, portal: true })
    + `<div class="wrap"><section class="card pad">
        <p class="dim small" style="margin:0 0 .6rem;">Signed in as ${esc(who.email)}.</p>
        <form method="post" action="/portal/out"><button type="submit"
          style="padding:.7rem 1.1rem;border:1px solid #c7d9e9;background:#fff;
                 border-radius:8px;cursor:pointer;">Sign out</button></form>
      </section></div>`;

  return html(page(client.name, body, await brandForUser(env, brandOwner)));
}

/**
 * POST /portal, the sign-in form.
 *
 * Always says the same thing. Whether or not the address is one of ours is a
 * fact about the client, and a page that answered differently would hand it to
 * anybody who asked.
 */
export async function handlePortalSignIn(request, env) {
  const form = await request.formData().catch(() => null);
  const email = normaliseEmail(form && form.get('email'));
  if (email && email.includes('@')) {
    await requestLink(env, email, new URL(request.url).origin);
  }
  return signInPage(`<p class="lede" style="margin-top:0;">If we have
    ${esc(email || 'that address')} on a client record, a link is on its way. It works once and
    lasts twenty minutes.</p>`);
}
