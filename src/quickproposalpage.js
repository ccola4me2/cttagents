// What a client sees when they open a proposal's link.
//
// Served at /p/<code> with no sign in: the link is the credential. Only what the advisor chose to put on
// it is shown, by column name and never by whole row, and nothing about the advisor's book, a reservation
// or what the agency earns can reach this file. It is listed in scripts/check-private.mjs, which fails the
// build if it ever mentions one.
//
// The pictures are served through the Worker at /pi/<id> for as long as the proposal is live, because the
// bucket they are kept in is private and has no addresses of its own.

import { escapeHtml as esc, now } from './util.js';
import { brandForUser, DEFAULT_BRAND, HEX_COLOR, readableOnWhite } from './brand.js';
import { appUrl } from './share.js';
import { docsReady } from './documents.js';

const TYPE_OF_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const NOT_A_PERSON = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|monitor/i;

function paragraphs(text) {
  return String(text || '').split(/\n{2,}/).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

const sayDate = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', {
  month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC' });

function shell(title, body, brand, { env, head = '' }) {
  const b = brand || DEFAULT_BRAND;
  const accent = HEX_COLOR.test(b.color || '') && readableOnWhite(b.color) ? b.color : DEFAULT_BRAND.color;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(b.name)}</title>
<meta name="robots" content="noindex, nofollow">
${head}
<style>
  :root{--navy:${accent};--coral:#e55942;--ink:#2f4459;--soft:#5c7286;--line:#e4edf5;--shell:#fbf9f5}
  *{box-sizing:border-box}
  body{margin:0;background:var(--shell);color:var(--ink);
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased;padding-bottom:3rem}
  .hero{background:var(--navy);color:#fff}
  .hero.photo{background:linear-gradient(rgba(10,25,40,.45),rgba(10,25,40,.75)),var(--cover) center/cover no-repeat,var(--navy)}
  .hero-in{max-width:46rem;margin:0 auto;padding:1.2rem 1rem 3rem}
  .brand{display:flex;align-items:center;gap:.6rem;font-size:.9rem;font-weight:700;margin-bottom:3.4rem}
  .brand img{width:32px;height:32px;border-radius:7px;background:#fff;padding:2px;object-fit:contain}
  .eyebrow{margin:0 0 .35rem;font-size:.74rem;letter-spacing:.14em;text-transform:uppercase;opacity:.85;font-weight:700}
  h1{margin:0;font-size:2.1rem;line-height:1.15;font-weight:750}
  .wrap{max-width:46rem;margin:0 auto;padding:1.2rem 1rem 0}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:1.1rem;
        box-shadow:0 1px 2px rgba(15,28,43,.05);overflow:hidden}
  .pad{padding:1.4rem}
  .note p{margin:0 0 .8rem}.note p:last-child{margin:0}
  .from{display:flex;gap:.8rem;align-items:center;margin-top:1rem;color:var(--soft);font-size:.9rem}
  .avatar{width:42px;height:42px;border-radius:50%;background:var(--navy);color:#fff;display:flex;
          align-items:center;justify-content:center;font-weight:700;flex:none}
  .sec img{display:block;width:100%;max-height:26rem;object-fit:cover}
  .sec h2{margin:0 0 .5rem;font-size:1.25rem;color:var(--navy)}
  .sec p{margin:0 0 .7rem}.sec p:last-child{margin-bottom:0}
  .price{display:inline-block;margin-top:.5rem;background:#f1f9f5;border:1px solid #cfe5dc;color:#1f7a5a;
         font-weight:750;border-radius:999px;padding:.3rem .9rem}
  .total{background:var(--navy);color:#fff;border-radius:14px;padding:1.4rem;margin-bottom:1.1rem}
  .total .lbl{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;opacity:.8;font-weight:700}
  .total .amt{font-size:1.7rem;font-weight:800;margin-top:.2rem}
  .contact{display:flex;gap:.9rem;align-items:center;flex-wrap:wrap}
  .btns{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.8rem}
  .btn{display:inline-block;background:var(--coral);color:#fff;text-decoration:none;border-radius:999px;
       padding:.7rem 1.3rem;font-weight:700}
  .btn.alt{background:#fff;color:var(--navy);border:1px solid #c7d9e9}
  .fine{color:var(--soft);font-size:.82rem;text-align:center;margin:1.4rem 1rem 0}
  @media(max-width:40rem){h1{font-size:1.7rem}.brand{margin-bottom:2.2rem}}
</style></head><body>${body}</body></html>`;
}

function gone(brand, env, message) {
  return new Response(shell('This proposal', `<div class="wrap"><div class="card pad"><h1 style="color:var(--navy);font-size:1.5rem;">This proposal is not available</h1>
    <p>${esc(message)}</p></div></div>`, brand, { env }),
  { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** GET /p/<code> */
export async function renderQuickProposal(request, env, code) {
  const row = await env.DB.prepare(
    `SELECT id, user_id, title, for_name, note, cover_image_id, sections_json, total_text, expires_at
       FROM quick_proposals WHERE code = ?`
  ).bind(String(code || '').toLowerCase()).first();
  if (!row) return gone(null, env, 'The link may be mistyped. Ask whoever sent it for the current one.');

  const brand = await brandForUser(env, row.user_id);
  const advisor = await env.DB.prepare(
    'SELECT first_name, last_name, phone, email, notify_email FROM users WHERE id = ?'
  ).bind(row.user_id).first().catch(() => null);
  const name = advisor ? [advisor.first_name, advisor.last_name].filter(Boolean).join(' ') : brand.name;
  const email = advisor ? (advisor.notify_email || advisor.email || '') : '';
  const phone = advisor ? (advisor.phone || '') : '';

  if (row.expires_at && row.expires_at < now()) {
    return gone(brand, env, `This proposal has expired. Get in touch with ${name || brand.name} for an up to date one.`);
  }

  // A view is counted for a person, not for a message app's preview of the link.
  if (request.method === 'GET' && !NOT_A_PERSON.test(request.headers.get('User-Agent') || '')) {
    await env.DB.prepare(
      `UPDATE quick_proposals SET view_count = view_count + 1,
              first_viewed_at = COALESCE(first_viewed_at, ?) WHERE id = ?`
    ).bind(now(), row.id).run().catch(() => {});
  }

  let sections = [];
  try { sections = JSON.parse(row.sections_json || '[]'); } catch { sections = []; }
  const pic = (id) => (id ? `${appUrl(env)}/pi/${encodeURIComponent(id)}` : '');
  const cover = pic(row.cover_image_id);
  const initials = (name || brand.name).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const logo = brand.logoUrl || '';

  const body = `<header class="hero${cover ? ' photo' : ''}"${cover ? ` style="--cover:url('${esc(cover)}')"` : ''}>
    <div class="hero-in">
      <div class="brand">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<span>${esc(brand.name)}</span></div>
      ${row.for_name ? `<p class="eyebrow">Prepared for ${esc(row.for_name)}</p>` : '<p class="eyebrow">A proposal</p>'}
      <h1>${esc(row.title)}</h1>
    </div></header>
  <main class="wrap">
    ${row.note ? `<div class="card pad note">${paragraphs(row.note)}
      <div class="from"><span class="avatar">${esc(initials)}</span><span>${esc(name || brand.name)}</span></div></div>` : ''}
    ${sections.map((s) => `<div class="card sec">${s.imageId ? `<img src="${esc(pic(s.imageId))}" alt="${esc(s.heading || '')}" loading="lazy">` : ''}
      <div class="pad">${s.heading ? `<h2>${esc(s.heading)}</h2>` : ''}${paragraphs(s.body)}${
  s.price ? `<span class="price">${esc(s.price)}</span>` : ''}</div></div>`).join('')}
    ${row.total_text ? `<div class="total"><div class="lbl">Total</div><div class="amt">${esc(row.total_text)}</div></div>` : ''}
    <div class="card pad contact">
      <span class="avatar">${esc(initials)}</span>
      <div style="flex:1;min-width:12rem;"><strong>${esc(name || brand.name)}</strong>
        <div style="color:var(--soft);font-size:.9rem;">Your travel advisor at ${esc(brand.name)}</div>
        <div class="btns">${phone ? `<a class="btn" href="tel:${esc(String(phone).replace(/[^\d+]/g, ''))}">Call ${esc(phone)}</a>` : ''}${
  email ? `<a class="btn alt" href="mailto:${esc(email)}?subject=${encodeURIComponent(`About ${row.title}`)}">Email me</a>` : ''}</div></div>
    </div>
    <p class="fine">Prices and availability are subject to change and are not guaranteed until booked.${
  row.expires_at ? ` This link is open until ${esc(sayDate(row.expires_at))}.` : ''}</p>
  </main>`;

  const head = `<link rel="canonical" href="${esc(`${appUrl(env)}/p/${String(code).toLowerCase()}`)}">
<meta property="og:title" content="${esc(row.title)}">
<meta property="og:description" content="${esc(`A proposal from ${name || brand.name}`)}">
${cover ? `<meta property="og:image" content="${esc(cover)}"><meta name="twitter:card" content="summary_large_image">` : ''}`;
  return new Response(shell(row.title, body, brand, { env, head }),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** GET /pi/<image id> : a picture on a live proposal, for anybody with the link. */
export async function serveProposalImage(request, env, id) {
  if (!docsReady(env)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare(
    `SELECT i.r2_key FROM quick_proposal_images i JOIN quick_proposals p ON p.id = i.proposal_id
      WHERE i.id = ? AND (p.expires_at IS NULL OR p.expires_at >= ?)`
  ).bind(id, now()).first();
  if (!row) return new Response('Not found', { status: 404 });
  const object = await env.DOCS.get(row.r2_key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'Content-Type': TYPE_OF_EXT[String(row.r2_key).split('.').pop()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
