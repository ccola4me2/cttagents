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
import { listGroupFiles } from './groupfiles.js';

// What differs between the two portals, in one place so the rest of the file reads the same
// in both.
const LOGO_PATH = '/logo-mark.png';
const LOGO_TYPE = 'image/png';
const POWERED_BY = '';
const DEFAULT_APP_URL = 'https://cttagents.com';

// How many people one registration may name. Four is a family and eight is a
// reunion booking two cabins together; past that somebody is filling the form
// in wrongly and should be ringing the agency.
const MAX_TRAVELLERS = 8;

// Registrations from one address in an hour. The same number the short enquiry
// form uses, for the same reason.
const PER_HOUR = 5;

const STATUSES = ['new', 'contacted', 'confirmed', 'cancelled'];

export { STATUSES as REGISTRATION_STATUSES };

function appUrl(env) {
  return (env.APP_URL || DEFAULT_APP_URL).replace(/\/$/, '');
}

/**
 * Where a page is being asked for, and what its links should start with.
 *
 * A group is reached three ways: by the supplier's group number at /g/<number>, by its short
 * name at /gs/<name> on the portal's own address, and by its short name straight after the
 * shared domain. Everything below is the same page; only the way the group is found and the
 * start of its links change, so both are carried in one small object.
 *
 *   { code, base }                 found by group number
 *   { groupId, userId, slug, base } found by short name, already looked up
 */
export function refOf(ref) {
  if (ref && typeof ref === 'object') return ref;
  const code = String(ref === undefined || ref === null ? '' : ref);
  return { code, base: `/g/${encodeURIComponent(code)}` };
}

// What the page reads off the group.
const PAGE_COLUMNS = [
  'id', 'user_id', 'name', 'vendor', 'product_name', 'destination', 'departure_port',
  'depart_date', 'return_date', 'registration_open', 'registration_blurb', 'status',
  'deposit_due', 'final_payment_due', 'passport_due', 'faq_json', 'terms',
  'agency_fee_cents', 'fee_terms', 'trip_terms', 'group_type', 'deposit_per_guest_cents',
  'page_slug', 'headline', 'hero_image_url', 'perks_json', 'itinerary_json',
  'amenities_json', 'drinks_json', 'enhancements_json',
].join(', ');

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
 *
 * A short name is looked up first, in groupslug.js, and arrives here as the group's id and
 * its owner, so the second form below names user_id for real.
 */
export async function loadGroup(env, rawRef) {
  const ref = refOf(rawRef);
  const row = ref.groupId
    ? await env.DB.prepare(
      `SELECT ${PAGE_COLUMNS} FROM travel_groups
        WHERE id = ? AND user_id = ? AND registration_open = 1`
    ).bind(ref.groupId, ref.userId).first()
    : await env.DB.prepare(
      `SELECT ${PAGE_COLUMNS} FROM travel_groups WHERE group_code = ? AND registration_open = 1`
    ).bind(ref.code).first();
  return row || null;
}

/** Something to key a per-visitor limit on that is the same however the group was reached. */
function refKey(ref) {
  return ref.groupId || ref.code || '';
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
            r.extra_adult_cents, r.extra_child_cents,
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

/** Who to name as the host, and how to reach the agency. Best effort: a page needs neither. */
async function contactFor(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT u.first_name, u.last_name, a.phone, a.email
         FROM users u LEFT JOIN agencies a ON a.id = u.agency_id WHERE u.id = ?`
    ).bind(userId).first();
    return {
      advisor: row ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : '',
      phone: (row && row.phone) || '',
      email: (row && row.email) || '',
    };
  } catch {
    return { advisor: '', phone: '', email: '' };
  }
}

/**
 * The address people are meant to share. The short one when the shared domain is set up and
 * the group has a name; otherwise the portal's own address for this page.
 */
function canonicalOf(env, g, ref, tail = '') {
  const host = String(env.GROUP_HOST || '').trim();
  if (host && g.page_slug) return `https://${host}${prefixOf(env)}/${g.page_slug}${tail}`;
  return `${appUrl(env)}${ref.base}${tail}`;
}

/** What a text message or Facebook shows when the link is pasted, and what a search sees. */
function shareTags({ title, description, url, image }) {
  const tags = [
    // A group page is for the people it was sent to. Prices are real, so it is not for search.
    '<meta name="robots" content="noindex, nofollow">',
    `<link rel="canonical" href="${esc(url)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta name="description" content="${esc(description)}">`,
  ];
  if (image) {
    tags.push(`<meta property="og:image" content="${esc(image)}">`,
      '<meta name="twitter:card" content="summary_large_image">');
  }
  return tags.join('\n');
}

function logoOf(brand, env) {
  const url = brand.logoUrl || LOGO_PATH;
  return /^\//.test(url) ? `${appUrl(env)}${url}` : url;
}

// ---------------------------------------------------------------- layout --

/**
 * The shell these two pages share.
 *
 * Its own rather than the one in publicform.js, which is a 560px single card
 * built for a form. This is a page somebody reads before they decide, so it is
 * wider and carries panels and cards that a form page has no use for.
 *
 * Links to the portal's own files are absolute: the page is also served from the shared
 * group domain, which has none of them.
 */
function page(title, body, brand, { wide = true, env = {}, hero = false, head = '', neutral = false } = {}) {
  const b = brand || DEFAULT_BRAND;
  const accent = HEX_COLOR.test(b.color || '') && readableOnWhite(b.color)
    ? b.color : DEFAULT_BRAND.color;
  const home = appUrl(env);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(b.name)}</title>
${neutral
    ? `<link rel="icon" type="image/png" sizes="32x32" href="${esc(neutralAsset(env, 'icon-32.png'))}">
<link rel="apple-touch-icon" href="${esc(neutralAsset(env, 'icon-180.png'))}">`
    : `<link rel="icon" href="${esc(home + LOGO_PATH)}" type="${LOGO_TYPE}">`}
${head}
<style>
  :root { --navy:${accent}; --coral:#e55942; --ink:#2f4459; --soft:#5c7286;
          --line:#e4edf5; --shell:#fbf9f5; --amber-bg:#fdf4e3; --amber:#9a6b12; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--shell);color:var(--ink);
       font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased;padding:0 0 3rem}
  .wrap{max-width:${wide ? '48rem' : '34rem'};margin:0 auto;padding:1.6rem 1rem 0}
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
  .blurb p:last-child{margin-bottom:0}
  /* The top of the page. */
  .hero{background:var(--navy);color:#fff}
  .hero.photo{background:linear-gradient(rgba(10,25,40,.55),rgba(10,25,40,.72)),var(--hero) center/cover no-repeat,var(--navy)}
  .hero-in{max-width:48rem;margin:0 auto;padding:1.1rem 1rem 2.2rem}
  .hero-brand{display:flex;align-items:center;gap:.6rem;font-size:.85rem;font-weight:700;margin-bottom:1.8rem}
  .hero-brand img{width:30px;height:30px;border-radius:7px;background:#fff;padding:2px;object-fit:contain}
  .hero-by{margin-left:auto;font-weight:400;color:rgba(255,255,255,.82)}
  .eyebrow{margin:0 0 .3rem;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;
           color:rgba(255,255,255,.78);font-weight:700}
  .hero h1{color:#fff;font-size:2rem;margin:0 0 .45rem}
  .hero-sub{margin:0 0 1.3rem;color:rgba(255,255,255,.9)}
  .hero-cta{display:flex;gap:.6rem;flex-wrap:wrap}
  .hero .cta{display:inline-block;margin:0;padding:.8rem 1.5rem}
  .ghost{display:inline-block;border:1px solid rgba(255,255,255,.75);color:#fff;text-decoration:none;
         border-radius:999px;padding:.8rem 1.3rem;font-weight:700}
  .ghost:hover{background:rgba(255,255,255,.12)}
  /* The bar that stays with you down the page. */
  html{scroll-behavior:smooth}
  [id]{scroll-margin-top:4.4rem}
  .subnav{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.95);
          -webkit-backdrop-filter:saturate(1.4) blur(10px);backdrop-filter:saturate(1.4) blur(10px);
          border-bottom:1px solid var(--line)}
  .subnav-in{max-width:48rem;margin:0 auto;padding:.35rem 1rem;display:flex;align-items:center;gap:.8rem}
  .subnav .links{display:flex;gap:.2rem;overflow-x:auto;flex:1;scrollbar-width:none}
  .subnav .links::-webkit-scrollbar{display:none}
  .subnav .links a{white-space:nowrap;text-decoration:none;color:var(--ink);font-size:.86rem;font-weight:600;
                   padding:.5rem .7rem;border-radius:8px}
  .subnav .links a:hover{background:#eef4fa;color:var(--navy)}
  .nav-cta{flex:none;background:var(--coral);color:#fff;text-decoration:none;border-radius:999px;
           padding:.5rem 1.05rem;font-size:.86rem;font-weight:700;white-space:nowrap}
  .nav-cta:hover{background:#c94430}
  .hero-where{margin:-.9rem 0 1.1rem;color:rgba(255,255,255,.75);font-size:.9rem}
  .hero-price{margin:0 0 1.2rem;color:rgba(255,255,255,.9);font-size:.95rem}
  .hero-price b{font-size:1.6rem;color:#fff;font-variant-numeric:tabular-nums;margin:0 .15rem}
  .hero-price span{display:block;font-size:.78rem;color:rgba(255,255,255,.7)}
  .facts-list{margin:0;display:grid;gap:.1rem 1.5rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}
  .facts-list div{padding:.6rem 0;border-top:1px solid var(--line)}
  .facts-list dt{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--soft)}
  .facts-list dd{margin:.1rem 0 0;font-weight:600;color:var(--navy)}
  .terms-d summary{cursor:pointer;font-weight:700;color:var(--navy)}
  .terms-d p{font-size:.9rem;color:var(--soft)}
  .mbar{display:none}
  @media (max-width:40rem){
    .nav-cta{display:none}
    .extra{grid-template-columns:1fr}
    .extra .ep{text-align:left}
    body{padding-bottom:4.6rem}
    .mbar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:40;align-items:center;gap:1rem;
          justify-content:space-between;background:#fff;border-top:1px solid var(--line);
          padding:.7rem 1rem calc(.7rem + env(safe-area-inset-bottom));box-shadow:0 -4px 16px rgba(15,28,43,.08)}
    .mbar span{font-size:.9rem;color:var(--ink)}
    .mbar b{font-size:1.1rem;color:var(--navy)}
    .mbar a{background:var(--coral);color:#fff;text-decoration:none;border-radius:999px;padding:.7rem 1.4rem;font-weight:700}
  }
  /* Four facts at a glance. */
  .tiles{display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));margin:0 0 1.2rem}
  .tile{background:#fff;border:1px solid var(--line);border-radius:12px;padding:.7rem .9rem;
        box-shadow:0 1px 2px rgba(15,28,43,.05)}
  .tile .lbl{display:block;font-size:.68rem;font-weight:700;letter-spacing:.1em;
             text-transform:uppercase;color:var(--soft)}
  .tile .val{display:block;font-size:1.02rem;font-weight:700;color:var(--navy);
             font-variant-numeric:tabular-nums}
  .tile.low{background:var(--amber-bg);border-color:#f1dfb8}
  .tile.low .val{color:var(--amber)}
  /* Rate bands. */
  .rates{display:grid;gap:.9rem}
  .rate{border:1px solid var(--line);border-radius:11px;padding:1rem}
  .rate.gone{opacity:.62}
  .rate-top{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap}
  .rate b{font-size:1.02rem;color:var(--navy)}
  .rate .price{font-size:1.15rem;font-weight:700;color:var(--navy);
               font-variant-numeric:tabular-nums;white-space:nowrap}
  .rate .per{font-size:.76rem;font-weight:400;color:var(--soft)}
  .rate .meta{margin:.45rem 0 0;font-size:.86rem;color:var(--soft)}
  .rate-foot{display:flex;justify-content:space-between;align-items:center;gap:.8rem;
             flex-wrap:wrap;margin-top:.7rem}
  .left{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.06em;
        text-transform:uppercase;padding:.2rem .55rem;border-radius:999px;
        background:var(--amber-bg);color:var(--amber)}
  .left.plenty{background:#e8f5f0;color:#1f7a5a}
  .left.gone{background:#fdeeec;color:#b3382a}
  .pick-btn{display:inline-block;background:var(--coral);color:#fff;text-decoration:none;
            border-radius:999px;padding:.55rem 1.15rem;font-weight:700;font-size:.9rem}
  .pick-btn:hover{background:#c94430}
  .pick-btn.wait{background:#fff;color:var(--navy);border:1px solid #c7d9e9}
  /* How to book. */
  .steps{list-style:none;margin:0;padding:0;display:grid;gap:.7rem;
         grid-template-columns:repeat(auto-fit,minmax(10rem,1fr))}
  .steps li{border:1px solid var(--line);border-radius:11px;padding:.85rem;
            display:flex;flex-direction:column;gap:.2rem}
  .steps .n{width:1.7rem;height:1.7rem;border-radius:50%;background:var(--navy);color:#fff;
            font-size:.8rem;font-weight:700;display:flex;align-items:center;justify-content:center;
            margin-bottom:.3rem}
  .s-title{font-weight:700;color:var(--navy)}
  .s-text{font-size:.9rem;color:var(--soft);font-variant-numeric:tabular-nums}
  .perks{list-style:none;margin:0;padding:0;display:grid;gap:.55rem}
  .files{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
  .files a{display:flex;align-items:center;gap:.8rem;border:1px solid var(--line);border-radius:11px;
           padding:.8rem 1rem;text-decoration:none;color:var(--navy);font-weight:600}
  .files a:hover{background:#f2f7fb}
  .files .pdf{flex:none;background:var(--coral);color:#fff;font-size:.68rem;font-weight:700;
              letter-spacing:.08em;border-radius:6px;padding:.25rem .45rem}
  .files .ft{flex:1}
  .files small{color:var(--soft);font-weight:400}
  .perks .ck{color:#1f7a5a;font-weight:700;margin-right:.6rem}
  /* What the group is paying and when, and the amenities worth leading with. */
  .pay{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))}
  .pay .cell{border:1px solid var(--line);border-radius:11px;padding:.85rem 1rem}
  .pay .cell.main{background:var(--navy);border-color:var(--navy);color:#fff}
  .pay .lbl{display:block;font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--soft)}
  .pay .main .lbl{color:#c9d8e8}
  .pay .amt{display:block;font-size:1.7rem;font-weight:800;line-height:1.15;margin:.2rem 0;
            font-variant-numeric:tabular-nums}
  .pay .per{font-size:.85rem;font-weight:500}
  .pay .when{display:block;font-size:.95rem;font-weight:600;font-variant-numeric:tabular-nums}
  .perk-cards{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))}
  .perk-card{border:1px solid #cfe5dc;background:#f1f9f5;border-radius:11px;padding:.85rem 1rem}
  .perk-card .pv{display:block;font-size:1.25rem;font-weight:800;color:#1f7a5a;line-height:1.2}
  .perk-card .pn{display:block;font-weight:700;color:var(--navy);margin-top:.15rem}
  .perk-card .pt{display:block;font-size:.88rem;color:var(--soft);margin-top:.2rem}
  .extras{display:grid;gap:0}
  .extra{display:grid;grid-template-columns:1fr auto;gap:.1rem 1rem;padding:.75rem 0;border-top:1px solid var(--line)}
  .extra:first-child{border-top:0;padding-top:0}
  .extra .en{font-weight:700;color:var(--navy)}
  .extra .ep{font-weight:700;color:var(--navy);text-align:right;font-variant-numeric:tabular-nums}
  .extra .et{grid-column:1/-1;color:var(--soft);font-size:.9rem}
  .itin{position:relative}
  .itin .day{display:grid;grid-template-columns:5.2rem 1fr;gap:.1rem .8rem;padding:.65rem 0 .65rem 1.1rem;
             border-left:2px solid #cfe0ee;margin-left:.3rem;position:relative}
  .itin .day::before{content:"";position:absolute;left:-.42rem;top:1rem;width:.7rem;height:.7rem;border-radius:50%;
                     background:var(--coral);border:2px solid #fff}
  .itin .d{font-weight:700;color:var(--navy)}
  .itin .p{font-weight:600}
  .itin .t{grid-column:2;color:var(--soft);font-size:.9rem}
  .two{display:grid;gap:.8rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}
  .half{border:1px solid var(--line);border-radius:11px;padding:.85rem}
  .half b{color:var(--navy)}
  .half p{margin:.3rem 0 0;color:var(--soft);font-size:.92rem}
  .faq details{border-top:1px solid var(--line);padding:.75rem 0}
  .faq details:first-child{border-top:0;padding-top:0}
  .faq summary{cursor:pointer;font-weight:700;color:var(--navy)}
  .faq details p{margin:.5rem 0 0}
  .contact{display:flex;gap:.9rem;align-items:center}
  .avatar{width:46px;height:46px;border-radius:50%;background:var(--navy);color:#fff;flex:none;
          display:flex;align-items:center;justify-content:center;font-weight:700}
  .share-row{display:flex;gap:.6rem;flex-wrap:wrap}
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
  button.alt{width:auto;background:#fff;color:var(--navy);border:1px solid #c7d9e9}
  button.alt:hover{background:#f2f7fb}
  .note{border-radius:10px;padding:.85rem 1rem;font-size:.9rem;margin-bottom:1.1rem}
  .note.error{background:#fdeeec;color:#b3382a}
  .note.warn{background:var(--amber-bg);color:var(--amber)}
  .note.pay{background:#f2f7fb;border-left:3px solid var(--navy);border-radius:4px}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .foot{text-align:center;margin-top:1.4rem;font-size:.78rem;color:#8395a5}
  .foot a{color:#8395a5}
  [hidden]{display:none!important}
</style></head>
<body>${hero ? '' : `<div class="wrap"><div class="brand">${neutral
    ? `<a href="${esc(neutralHome(env))}"><img src="${esc(neutralAsset(env, 'logo.png'))}" alt="Cruise Group Page" width="164" height="52" style="display:block;width:164px;height:auto;"></a>`
    : `<img src="${esc(logoOf(b, env))}" alt="">
    <span><b>${esc(b.name)}</b><small>${esc(b.tagline || '')}</small></span>`}</div>`}
  ${body}
  ${neutral ? '' : `<p class="foot">&copy; ${new Date().getFullYear()} ${esc(b.name)}
    &middot; <a href="${esc(home)}/privacy">Privacy policy</a>${POWERED_BY}</p>`}
${hero ? '' : '</div>'}</body></html>`;
}

/** The service's own files, from the shared domain when there is one, so a page on any address finds them. */
function neutralAsset(env, file) {
  const host = String(env.GROUP_HOST || '').trim();
  return host ? `https://${host}/cgp/${file}` : `${appUrl(env)}/logo-mark.png`;
}

/** Where the service's own logo goes: its front page on the shared domain. */
function neutralHome(env) {
  const host = String(env.GROUP_HOST || '').trim();
  return host ? `https://${host}${prefixOf(env)}/` : appUrl(env);
}

function gone(brand, env, message) {
  return new Response(page('Not available',
    `<div class="card"><h1>This trip is not taking names</h1><p>${esc(message)}</p></div>`,
    brand, { env }),
  { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/**
 * A page for an address that is not any group's. Branded as the service and not as either portal: the
 * shared domain hands a name it does not know to the other portal, so without this a mistyped name
 * was told "Powered by Trip Vara" or carried the other agency's name, whichever portal answered.
 */
export function noGroupPage(env, message) {
  const home = String(env.GROUP_HOST || '').trim();
  return new Response(page('Page not found',
    `<div class="card"><h1>We could not find that group</h1><p>${esc(message
      || 'The link may be mistyped or out of date. Ask whoever sent it for the current one.')}</p>${
  home ? `<p><a class="cta" href="https://${esc(home)}/">Look for it by name</a></p>` : ''}</div>`,
    { name: 'Cruise Group Page', tagline: '', logoUrl: null, color: '#0f2747' },
    { env, neutral: true }),
  { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ------------------------------------------------------- the landing page --

const TYPE_WORDS = {
  cruise: 'Group cruise', package: 'Group package', lodging: 'Group stay',
  tour: 'Group tour', other: 'Group trip',
};

function nightsOf(g) {
  if (!g.depart_date || !g.return_date) return 0;
  const a = Date.parse(`${g.depart_date}T00:00:00Z`);
  const b = Date.parse(`${g.return_date}T00:00:00Z`);
  const n = Math.round((b - a) / 86400000);
  return n > 0 && n < 400 ? n : 0;
}

function daysUntil(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const today = new Date().toISOString().slice(0, 10);
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/** A group that is closed or has sailed takes no more registrations. */
function closedTo(g) {
  return g.status === 'closed' || Boolean(g.depart_date && daysUntil(g.depart_date) < 0);
}

/**
 * Where this group stands, for the page: open, full, closed, or already sailed.
 * Full is every cabin grade that has a block size being used up; a grade with no block size
 * recorded is not counted, because the page would be inventing a limit.
 */
function standing(g, rates) {
  if (g.depart_date && daysUntil(g.depart_date) < 0) return 'departed';
  if (g.status === 'closed') return 'closed';
  const metered = rates.filter((r) => r.metered);
  if (metered.length && metered.length === rates.length && metered.every((r) => r.left === 0)) {
    return 'full';
  }
  return 'open';
}

function listOf(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The group this one was repeated as, if it is open for names. What a sailed group's page points
 * people to, so an old link leads to the next sailing and not to a dead end.
 */
async function nextSailing(env, g) {
  const row = await env.DB.prepare(
    `SELECT name, page_slug FROM travel_groups
      WHERE repeated_from = ? AND user_id = ? AND registration_open = 1
        AND page_slug IS NOT NULL AND status <> 'cancelled'
      ORDER BY depart_date ASC LIMIT 1`
  ).bind(g.id, g.user_id).first();
  return row || null;
}

/** Where another group's page is, from the one being read: the shared domain when there is one. */
function pageUrlFor(env, slug) {
  const host = String(env.GROUP_HOST || '').trim();
  return host ? `https://${host}${prefixOf(env)}/${slug}` : `/gs/${slug}`;
}

/** The start of this portal's links on the shared domain: nothing for CTT, /tv for Trip Vara. */
function prefixOf(env) {
  return String(env.GROUP_PREFIX || '').replace(/\/+$/, '');
}

function heroBlock(g, brand, contact, state, base, env, next, rates = []) {
  const kind = TYPE_WORDS[g.group_type] || TYPE_WORDS.other;
  const where = [g.vendor, g.product_name, g.destination].filter(Boolean).join(' · ');
  const sub = g.headline || where;
  const lowest = fromPrice(rates);
  const hasPhoto = Boolean(g.hero_image_url);
  const by = contact.advisor ? `<span class="hero-by">Hosted by ${esc(contact.advisor)}</span>` : '';
  const buttons = state === 'open'
    ? `<a class="cta" href="${base}/register">Reserve your cabin</a>
       <a class="ghost" href="#ask">Ask a question</a>`
    : state === 'full'
      ? `<a class="cta" href="${base}/register">Join the waitlist</a>
         <a class="ghost" href="#ask">Ask a question</a>`
      : next
        ? `<a class="cta" href="${esc(pageUrlFor(env, next.page_slug))}">See the next sailing</a>
           <a class="ghost" href="#ask">Ask a question</a>`
        : '<a class="ghost" href="#ask">Ask about the next sailing</a>';
  return `<header class="hero${hasPhoto ? ' photo' : ''}"${
    hasPhoto ? ` style="--hero:url('${esc(g.hero_image_url)}')"` : ''}>
    <div class="hero-in">
      <div class="hero-brand"><img src="${esc(logoOf(brand, env))}" alt="">
        <span>${esc(brand.name)}</span>${by}</div>
      <p class="eyebrow">${esc(kind)}</p>
      <h1>${esc(g.name)}</h1>
      ${sub ? `<p class="hero-sub">${esc(sub)}</p>` : ''}
      ${g.headline && where ? `<p class="hero-where">${esc(where)}</p>` : ''}
      ${lowest && state !== 'departed' ? `<p class="hero-price">From <b>${esc(money(lowest))}</b> per guest
        <span>taxes and fees included</span></p>` : ''}
      <div class="hero-cta">${buttons}</div>
    </div></header>`;
}

/** The lowest all in price per guest, or 0 when no grade has one yet. */
function fromPrice(rates) {
  const all = (rates || []).filter((r) => Number(r.per_guest_cents) > 0)
    .map((r) => Number(r.per_guest_cents) + (Number(r.taxes_cents) || 0));
  return all.length ? Math.min(...all) : 0;
}

/** Everything about the sailing itself, always, whether or not there is a headline over it. */
function detailsBlock(g) {
  const nights = nightsOf(g);
  const rows = [
    ['Cruise line', g.vendor],
    ['Ship', g.product_name],
    ['Itinerary', g.destination],
    ['Sails', g.depart_date ? sayDate(g.depart_date) : ''],
    ['Returns', g.return_date ? sayDate(g.return_date) : ''],
    ['Length', nights ? `${nights} night${nights === 1 ? '' : 's'}` : ''],
    ['Sailing from', g.departure_port],
  ].filter(([, v]) => v);
  if (rows.length < 2) return '';
  return `<div class="card"><h2>The sailing</h2><dl class="facts-list">${
    rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></div>`;
}

function glance(g, rates) {
  const left = rates.filter((r) => r.metered).reduce((n, r) => n + r.left, 0);
  const held = rates.filter((r) => r.metered).reduce((n, r) => n + (Number(r.cabins) || 0), 0);
  const nights = nightsOf(g);
  const tiles = [
    g.depart_date ? ['Sails', sayDate(g.depart_date), ''] : null,
    nights ? ['Nights', String(nights), ''] : null,
    held ? ['Cabins available', String(left), left <= 3 ? 'low' : ''] : null,
    g.departure_port ? ['Sailing from', g.departure_port, ''] : null,
  ].filter(Boolean).slice(0, 4);
  if (!tiles.length) return '';
  return `<div class="tiles">${tiles.map(([label, value, tone]) =>
    `<div class="tile${tone ? ` ${tone}` : ''}"><span class="lbl">${esc(label)}</span>
      <span class="val">${esc(value)}</span></div>`).join('')}</div>`;
}

function rateCards(rates, base, state) {
  if (!rates.length) return '';
  return `<div class="card"><h2>What is still available</h2>
    <p class="muted" style="margin:-.4rem 0 1rem;">Prices are per guest and include taxes and
      fees. Gratuities are not included, and neither is anything bought separately. The trip is
      paid to the travel supplier through us, and never on this page.</p><div class="rates">${
  rates.map((r) => {
    const out = r.metered && r.left === 0;
    const tag = !r.metered
      ? ''
      : out
        ? '<span class="left gone">None left</span>'
        : `<span class="left${r.left > 3 ? ' plenty' : ''}">${r.left} cabin${r.left === 1 ? '' : 's'} available</span>`;
    const meta = [
      r.occupancy ? `${esc(r.occupancy)} occupancy` : '',
      r.per_guest_cents ? 'taxes and fees included' : '',
    ].filter(Boolean).join(' · ');
    const extras = [
      Number(r.extra_adult_cents) > 0 ? `Third or fourth adult: ${esc(money(r.extra_adult_cents))}` : '',
      Number(r.extra_child_cents) > 0 ? `Child: ${esc(money(r.extra_child_cents))}` : '',
    ].filter(Boolean).join(' &middot; ');
    const action = state === 'open' || state === 'full'
      ? `<a class="pick-btn${out ? ' wait' : ''}" href="${base}/register?rate=${encodeURIComponent(r.id)}">${
        out ? 'Join the waitlist' : 'Book this cabin'}</a>`
      : '';
    return `<div class="rate${out ? ' gone' : ''}">
      <div class="rate-top"><b>${esc(r.room_type)}</b>
        ${r.per_guest_cents
    ? `<span class="price">${money(r.per_guest_cents + (Number(r.taxes_cents) || 0))}<span class="per"> per guest</span></span>`
    : '<span class="price"><span class="per">Price to come</span></span>'}</div>
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      ${extras ? `<p class="meta">${extras} per guest</p>` : ''}
      <div class="rate-foot">${tag}${action}</div>
    </div>`;
  }).join('')
}</div></div>`;
}

function stepsBlock(g, base, state) {
  if (state !== 'open' && state !== 'full') return '';
  const steps = [
    ['Choose your cabin', 'Pick a cabin below and tell us who is travelling. Nothing is charged on this page.'],
    ['Pay your deposit', g.deposit_per_guest_cents
      ? `${money(g.deposit_per_guest_cents)} per guest holds your place${g.deposit_due ? `, due ${sayDate(g.deposit_due)}` : ''}.`
      : g.deposit_due ? `Due ${sayDate(g.deposit_due)}.` : 'We tell you how much and when.'],
    ['Pay the balance', g.final_payment_due ? `Due ${sayDate(g.final_payment_due)}.` : 'We confirm the date with you.'],
  ];
  return `<div class="card"><h2>How to book</h2><ol class="steps">${
    steps.map(([title, text], i) => `<li><span class="n">${i + 1}</span>
      <span class="s-title">${esc(title)}</span><span class="s-text">${esc(text)}</span></li>`).join('')
  }</ol></div>`;
}

/** What is due and when. The deposit leads, with what it is per guest, since that is the question. */
function paymentsBlock(g) {
  const cells = [];
  if (g.deposit_due || g.deposit_per_guest_cents) {
    cells.push(`<div class="cell main"><span class="lbl">Deposit to hold your cabin</span>${
      g.deposit_per_guest_cents
        ? `<span class="amt">${esc(money(g.deposit_per_guest_cents))}<span class="per"> per guest</span></span>`
        : ''}${g.deposit_due ? `<span class="when">Due ${esc(sayDate(g.deposit_due))}</span>` : ''}</div>`);
  }
  if (g.final_payment_due) {
    cells.push(`<div class="cell"><span class="lbl">Final payment</span>
      <span class="when">Due ${esc(sayDate(g.final_payment_due))}</span></div>`);
  }
  if (g.passport_due) {
    cells.push(`<div class="cell"><span class="lbl">Passports</span>
      <span class="when">In by ${esc(sayDate(g.passport_due))}</span></div>`);
  }
  if (!cells.length) return '';
  const next = [g.deposit_due, g.final_payment_due, g.passport_due]
    .filter((d) => d && daysUntil(d) >= 0).sort()[0];
  const count = next
    ? `${daysUntil(next) === 0 ? 'The next date is today. ' : `The next date is in ${daysUntil(next)} day${
      daysUntil(next) === 1 ? '' : 's'}. `}` : '';
  return `<div class="card"><h2>What you pay and when</h2><div class="pay">${cells.join('')}</div>
    <p class="muted" style="margin:.8rem 0 0;">${count}Paid to the travel supplier through us, never on this page.</p></div>`;
}

function extrasList(json) {
  return listOf(json).filter((x) => x && x.name);
}

/** Amenities worth leading with, such as onboard credit: the value first, big, then what it is. */
function amenitiesBlock(g) {
  const items = extrasList(g.amenities_json);
  if (!items.length) return '';
  return `<div class="card"><h2>What your group gets</h2><div class="perk-cards">${
    items.map((x) => `<div class="perk-card">${x.price ? `<span class="pv">${esc(x.price)}</span>` : ''}
      <span class="pn">${esc(x.name)}</span>${x.note ? `<span class="pt">${esc(x.note)}</span>` : ''}</div>`).join('')
  }</div></div>`;
}

/** A priced list: drink packages, enhancements. */
function extrasBlock(title, lead, json) {
  const items = extrasList(json);
  if (!items.length) return '';
  return `<div class="card"><h2>${esc(title)}</h2>${lead
    ? `<p class="muted" style="margin:-.4rem 0 1rem;">${esc(lead)}</p>` : ''}<div class="extras">${
    items.map((x) => `<div class="extra"><span class="en">${esc(x.name)}</span>
      <span class="ep">${esc(x.price || '')}</span>${x.note ? `<span class="et">${esc(x.note)}</span>` : ''}</div>`).join('')
  }</div></div>`;
}

function perksBlock(g) {
  const perks = listOf(g.perks_json).map((p) => String(p || '').trim()).filter(Boolean);
  if (!perks.length) return '';
  return `<div class="card"><h2>What is included</h2><ul class="perks">${
    perks.map((p) => `<li><span class="ck" aria-hidden="true">&#10003;</span>${esc(p)}</li>`).join('')}</ul></div>`;
}

function itineraryBlock(g) {
  const days = listOf(g.itinerary_json).filter((d) => d && (d.port || d.note));
  if (!days.length) return '';
  return `<div class="card"><h2>Your itinerary</h2><div class="itin">${
    days.map((d) => `<div class="day"><span class="d">${esc(d.day || '')}</span>
      <span class="p">${esc(d.port || '')}</span>${d.note ? `<span class="t">${esc(d.note)}</span>` : ''}</div>`).join('')
  }</div></div>`;
}

function filesBlock(files) {
  if (!files.length) return '';
  const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  return `<div class="card"><h2>Downloads</h2><ul class="files">${
    files.map((f) => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener"><span class="pdf">PDF</span>
      <span class="ft">${esc(f.title)}</span><small>${esc(size(f.bytes))}</small></a></li>`).join('')
  }</ul></div>`;
}

function moneyBlock(g) {
  const fee = Number(g.agency_fee_cents) || 0;
  if (!fee && !g.trip_terms && !g.fee_terms) return '';
  return `<div class="card"><h2>What it costs and what comes back</h2><div class="two">
    <div class="half"><b>Trip cost</b><p>${esc(g.trip_terms
    || 'Paid to the travel supplier through us. It follows the supplier\'s cancellation schedule.')}</p></div>
    ${fee || g.fee_terms ? `<div class="half"><b>Our fee${fee ? `, ${money(fee)} per guest` : ''}</b>
      <p>${esc(g.fee_terms || 'This is the agency\'s own fee.')}</p></div>` : ''}
    </div></div>`;
}

function termsBlock(g) {
  if (!g.terms) return '';
  return `<div class="card"><details class="terms-d"><summary>Group terms</summary>${paragraphs(g.terms)}</details></div>`;
}

function faqBlock(faq) {
  if (!faq.length) return '';
  return `<div class="card"><h2>Questions people ask</h2><div class="faq">${
    faq.map((p) => `<details><summary>${esc(p.q)}</summary><p>${esc(p.a)}</p></details>`).join('')
  }</div></div>`;
}

function contactBlock(contact, brand) {
  const bits = [];
  if (contact.phone) bits.push(`<a href="tel:${esc(String(contact.phone).replace(/[^\d+]/g, ''))}">${esc(contact.phone)}</a>`);
  if (contact.email) bits.push(`<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>`);
  if (brand.website) bits.push(`<a href="${esc(brand.website)}" rel="noopener">${esc(brand.website.replace(/^https?:\/\//, ''))}</a>`);
  if (!contact.advisor && !bits.length) return '';
  const initials = (contact.advisor || brand.name).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `<div class="card contact"><span class="avatar">${esc(initials)}</span>
    <div><b>${esc(contact.advisor || brand.name)}</b>
      <p class="muted" style="margin:.1rem 0 0;">Your group's travel advisor at ${esc(brand.name)}${
  bits.length ? `<br>${bits.join(' &middot; ')}` : ''}</p></div></div>`;
}

export async function renderGroupTripPage(request, env, rawRef) {
  const ref = refOf(rawRef);
  const g = await loadGroup(env, ref);
  const brand = g ? await brandForUser(env, g.user_id) : null;
  if (!g || g.status === 'cancelled') {
    return gone(brand, env, 'The link may be out of date. Get in touch and we will tell you what is '
      + 'going out next.');
  }

  const base = ref.base;
  const rates = await loadRates(env, g.id, g.user_id);
  const contact = await contactFor(env, g.user_id);
  const files = await listGroupFiles(env, g.id, g.user_id);
  const state = standing(g, rates);
  const canonical = canonicalOf(env, g, ref);
  const next = state === 'departed' ? await nextSailing(env, g) : null;

  const notice = state === 'departed'
    ? 'This sailing has departed. Get in touch about the next one.'
    : state === 'closed'
      ? 'Booking on this group has closed. Get in touch and we will tell you what is open.'
      : state === 'full'
        ? 'Every cabin in this group is taken. Join the waitlist and we will tell you if one opens up.'
        : '';

  const live = state !== 'departed';
  const section = (id, html) => (html ? html.replace('<div class="card', `<div id="${id}" class="card`) : '');
  const parts = {
    cabins: live ? section('cabins', rateCards(rates, base, state)) : '',
    group: live ? section('group', amenitiesBlock(g)) : '',
    pay: live ? paymentsBlock(g) : '',
    plan: itineraryBlock(g) ? section('itinerary', itineraryBlock(g)) : '',
    drinks: live ? section('extras', extrasBlock('Drink packages',
      'Ask us to add one to your booking.', g.drinks_json)) : '',
    add: live ? extrasBlock('Enhancements and add-ons',
      'Ask us to add any of these to your booking.', g.enhancements_json) : '',
    faq: faqBlock(faqOf(g)) ? section('faq', faqBlock(faqOf(g))) : '',
  };
  const nav = [
    parts.group && ['group', 'What you get'],
    parts.cabins && ['cabins', 'Cabins'],
    parts.plan && ['itinerary', 'Itinerary'],
    (parts.drinks || parts.add) && ['extras', 'Extras'],
    parts.faq && ['faq', 'Questions'],
    ['ask', 'Contact'],
  ].filter(Boolean);
  const reserve = state === 'open' || state === 'full';
  const subnav = `<nav class="subnav" aria-label="On this page"><div class="subnav-in">
    <div class="links">${nav.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join('')}</div>${
  reserve ? `<a class="nav-cta" href="${base}/register">${state === 'full' ? 'Join the waitlist' : 'Reserve your cabin'}</a>` : ''}
    </div></nav>`;
  const lowest = fromPrice(rates);
  const mbar = reserve ? `<div class="mbar"><span>${lowest
    ? `From <b>${esc(money(lowest))}</b> per guest` : 'Cabins available'}</span>
    <a href="${base}/register">${state === 'full' ? 'Waitlist' : 'Reserve'}</a></div>` : '';

  const body = [
    heroBlock(g, brand, contact, state, base, env, next, rates),
    subnav,
    '<main class="wrap">',
    next
      ? `<div class="note warn">This sailing has departed. The next one is
         <a href="${esc(pageUrlFor(env, next.page_slug))}">${esc(next.name)}</a>.</div>`
      : notice ? `<div class="note warn">${esc(notice)}</div>` : '',
    glance(g, rates),
    g.registration_blurb ? `<div class="card blurb">${paragraphs(g.registration_blurb)}</div>` : '',
    detailsBlock(g),
    parts.group,
    parts.cabins,
    parts.pay,
    live ? stepsBlock(g, base, state) : '',
    parts.plan,
    parts.drinks,
    parts.add,
    perksBlock(g),
    filesBlock(files),
    moneyBlock(g),
    parts.faq,
    termsBlock(g),
    // The short enquiry stays. Not everybody reading this is ready to name
    // four passports, and losing "send me more" because the only button was
    // "register" would cost the agency the easier half of the list.
    `<div class="card" id="ask"><h2>${state === 'open' ? 'Not ready yet? Ask a question'
      : 'Ask us a question'}</h2>
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
    contactBlock(contact, brand),
    `<div class="card share"><b>Share this page</b>
      <p class="muted" style="margin:.2rem 0 .8rem;">Send the link to anybody who might want to come.</p>
      <div class="share-row"><button type="button" id="copy" class="alt">Copy link</button>
        <button type="button" id="share" class="alt" hidden>Share</button></div></div>`,
    '</main>',
    mbar,
    ENQUIRY_SCRIPT,
    shareScript(canonical),
  ].filter(Boolean).join('\n');

  const description = [g.headline, g.depart_date ? `Sailing ${sayDate(g.depart_date)}` : '',
    'See what is available and how to book.'].filter(Boolean).join('. ').slice(0, 200);
  return new Response(page(g.name, body, brand, {
    env, hero: true,
    head: shareTags({ title: g.name, description, url: canonical, image: g.hero_image_url }),
  }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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

// Copy and share, for the person who wants to pass the page on. The address is the short
// one even when the page was opened on another, so a pasted link is the one worth keeping.
function shareScript(url) {
  return `<scr${''}ipt>
const link = ${JSON.stringify(url).replace(/</g, '\\u003c')};
const copy = document.getElementById('copy');
const share = document.getElementById('share');
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(link);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy link'; }, 1600);
  } catch (ex) {
    copy.textContent = 'Press Cmd-C or long press to copy';
  }
});
if (navigator.share) {
  share.hidden = false;
  share.addEventListener('click', () => {
    navigator.share({ title: document.title, url: link }).catch(() => {});
  });
}
</scr${''}ipt>`;
}

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

function ratePicker(rates, wanted = '') {
  if (!rates.length) {
    return '<p class="muted">No cabin grades have been loaded for this trip yet. Register '
      + 'anyway and we will come back to you with what is available.</p>';
  }
  return rates.map((r) => {
    const out = r.metered && r.left === 0;
    // What a guest pays for the cabin, taxes and fees included, as the page says everywhere.
    const all = r.per_guest_cents ? r.per_guest_cents + (Number(r.taxes_cents) || 0) : 0;
    const perGuest = all ? `${money(all)} per guest` : 'Price to come';
    const taxes = all ? ', taxes and fees included' : '';
    return `<label class="pick${out ? ' gone' : ''}">
      <input type="radio" name="rate" value="${esc(r.id)}"${out ? ' disabled' : ''}${
  !out && wanted && wanted === r.id ? ' checked' : ''}
        data-guest="${all}" data-tax="0">
      <span class="pick-body"><b>${esc(r.room_type)}</b>
        <span class="muted" style="display:block;">${perGuest}${taxes}${
  r.occupancy ? ` · ${esc(r.occupancy)} occupancy` : ''}</span>
        <span class="muted" style="display:block;">${
  out ? 'None left' : r.metered ? `${r.left} cabin${r.left === 1 ? '' : 's'} available` : 'Ask us about availability'}</span>
      </span></label>`;
  }).join('');
}

export async function renderRegisterPage(request, env, rawRef) {
  const ref = refOf(rawRef);
  const g = await loadGroup(env, ref);
  const brand = g ? await brandForUser(env, g.user_id) : null;
  if (!g || g.status === 'cancelled' || closedTo(g)) {
    return gone(brand, env, 'Registration for this trip has closed.');
  }
  const wanted = new URL(request.url).searchParams.get('rate') || '';

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
    `<div class="card"><p class="muted" style="margin:0 0 .6rem;"><a href="${ref.base}">Back to the trip page</a></p>
    <h1>Register for ${esc(g.name)}</h1>`,
    `<p class="muted">${esc([g.vendor, g.product_name].filter(Boolean).join(' · '))}${
      g.depart_date ? `, sailing ${esc(sayDate(g.depart_date))}` : ''}</p></div>`,

    '<form id="reg" novalidate><div class="card">',
    '<div class="note error" id="err" hidden></div>',
    '<h2>Which cabin</h2>',
    ratePicker(rates, wanted),
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
    '<p class="terms">Taxes and fees are included. Gratuities are not included.</p>',
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

  return new Response(page(`Register for ${g.name}`, body, brand, {
    wide: false, env,
    head: shareTags({ title: `Register for ${g.name}`, description: 'Reserve your cabin.',
      url: canonicalOf(env, g, ref, '/register'), image: g.hero_image_url }),
  }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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

// The trip cost follows the chosen band, with taxes and fees included in the number a guest is shown.
// The reservation made from a registration still keeps the fare and the taxes apart, which is what a
// refund and a commission are worked out on; this is only what the page says.
form.addEventListener('change', (e) => {
  if (e.target.name !== 'rate') return;
  const guest = Number(e.target.dataset.guest) || 0;
  const tax = Number(e.target.dataset.tax) || 0;
  tripCell.textContent = guest
    ? cash(guest) + (tax ? ' plus ' + cash(tax) + ' taxes and fees' : '')
    : 'Price to come';
});

// A cabin picked on the trip page arrives already chosen, so the total has to follow it.
const chosen = form.querySelector('input[name="rate"]:checked');
if (chosen) chosen.dispatchEvent(new Event('change', { bubbles: true }));

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

export async function handleRegister(request, env, rawRef) {
  const ref = refOf(rawRef);
  const g = await loadGroup(env, ref);
  if (!g || g.status === 'cancelled') return notFound('This trip is not taking registrations.');
  if (closedTo(g)) return badRequest('Registration for this trip has closed.');

  const body = await readJson(request);

  // Cheapest check first, and it answers success on purpose: a script that is
  // told it failed tries again differently.
  if (clean(body.company_website, 200)) {
    return json({ ok: true, message: 'Thanks, we will be in touch.' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`group:${refKey(ref)}:${ip}`)).slice(0, 32) : null;
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
