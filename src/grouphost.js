// Serving a group's page by its short name.
//
// One domain, cruisegrouppage.com, serves the groups of both portals, in two areas that do not
// share names. Cruises Tours and Travel's groups are at /<name>. Trip Vara's are at /tv/<name>,
// because Trip Vara is many agencies and each of its pages carries that agency's own name, logo
// and colours. The domain is attached to the CTT Worker, which answers its own area and hands
// everything under /tv to the Trip Vara Worker through a service binding (PEER). The request is
// passed on as it came, so the visitor's address, the form they posted and every header arrive
// untouched. Each Worker is told its own area by GROUP_PREFIX: empty for CTT, /tv for Trip Vara.
//
// The same pages also answer at /gs/<name> on each portal's own address, which is how they
// are tested and how they stay reachable before the shared domain is switched on.
//
//   /<name>            the trip page
//   /<name>/register   registering for it
//
// A name that used to belong to the group redirects to its current one. A name nobody holds
// gets a plain page saying so.

import { cleanSlug, findSlug, withTimeout } from './groupslug.js';
import { renderGroupPage, handleGroupRegistration } from './publicform.js';
import { renderRegisterPage, handleRegister, noGroupPage } from './grouppage.js';
import { renderGroupLanding } from './grouplanding.js';

// Set on a request that has already been handed across, so the two portals can never
// bounce one between them.
const HOP = 'x-group-hop';

/** Is this request for the shared group domain? */
export function isGroupHost(request, env) {
  const host = String(env.GROUP_HOST || '').trim().toLowerCase();
  if (!host) return false;
  return new URL(request.url).hostname.toLowerCase() === host;
}

/** What this portal's links on the shared domain start with: nothing for CTT, /tv for Trip Vara. */
export function groupPrefix(env) {
  return String(env.GROUP_PREFIX || '').replace(/\/+$/, '');
}

/**
 * Everything on the shared domain: the front page, a name, a name and /register, and nothing else. Each Worker answers its own area, and CTT passes the Trip Vara area across.
 */
export async function serveGroupHost(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const mine = groupPrefix(env);
  const inTv = path === '/tv' || path.startsWith('/tv/');

  // The service's own logo and icons, for both areas. They are files shipped with the CTT Worker, which
  // owns the domain, so a request for one never goes to Trip Vara.
  if (path.startsWith('/cgp/') || path === '/favicon.ico') {
    if (!env.ASSETS) return new Response('Not found', { status: 404 });
    const asset = await env.ASSETS.fetch(new Request(new URL(path === '/favicon.ico' ? '/cgp/favicon.ico' : path, request.url)));
    if (!asset.ok) return new Response('Not found', { status: 404 });
    const out = new Response(asset.body, asset);
    out.headers.set('Cache-Control', 'public, max-age=86400');
    return out;
  }

  if (inTv && !mine) {
    // Not this portal's area: Trip Vara answers it, and if it cannot there is nobody else to ask.
    if (env.PEER && !request.headers.get(HOP)) {
      try {
        const headers = new Headers(request.headers);
        headers.set(HOP, '1');
        return await withTimeout(env.PEER.fetch(new Request(request, { headers })), 20000);
      } catch (e) {
        console.error('group page peer', e);
      }
    }
    return noGroupPage(env);
  }
  // Trip Vara answers nothing outside its own area.
  if (mine && !inTv) return noGroupPage(env);

  const rest = inTv ? (path.slice(3) || '/') : path;
  if (rest === '/') return renderGroupLanding(env, { area: inTv ? 'tv' : 'ctt' });
  const m = rest.match(/^\/([^/]+)(?:\/(register))?\/?$/);
  if (!m) return noGroupPage(env);
  return serveSlug(request, env, m[1], m[2] || '', 'host');
}

/**
 * One group's page, found by its short name.
 *
 * mode is where the request arrived: 'host' on the shared domain, whose links start at /<name>,
 * or 'path' on a portal's own address, whose links start at /gs/<name>.
 */
export async function serveSlug(request, env, rawName, tail, mode) {
  let slug = rawName;
  try { slug = decodeURIComponent(rawName); } catch { /* keep it as it came */ }
  slug = cleanSlug(slug);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // A name nobody holds in this area. The two areas do not share names, so nobody else is asked.
  const hit = slug ? await findSlug(env, slug) : null;
  if (!hit) {
    return noGroupPage(env);
  }

  const start = mode === 'host' ? groupPrefix(env) : '/gs';
  // An old name sends a reader to the current one. A form posted to an old name is still
  // taken, because the page that posted it was loaded from there.
  if (hit.status === 'archived' && hit.current && hit.current !== slug && method !== 'POST') {
    const url = new URL(request.url);
    return new Response(null, {
      status: 301,
      headers: { Location: `${start}/${hit.current}${tail ? `/${tail}` : ''}${url.search}` },
    });
  }

  const ref = { groupId: hit.group_id, userId: hit.user_id, slug, base: `${start}/${slug}` };
  if (tail === 'register') {
    return method === 'POST'
      ? handleRegister(request, env, ref)
      : renderRegisterPage(request, env, ref);
  }
  return method === 'POST'
    ? handleGroupRegistration(request, env, ref)
    : renderGroupPage(request, env, ref);
}

/**
 * A group reached by its supplier's number goes to its short name, once the shared domain is
 * switched on (GROUP_REDIRECT) and the group has a name. A form posted to the old address is
 * still taken, so a page already open when this was switched on does not lose what was typed.
 */
export async function redirectForCode(request, env, code, tail) {
  const host = String(env.GROUP_HOST || '').trim();
  if (!host || env.GROUP_REDIRECT !== '1') return null;
  if (request.method.toUpperCase() !== 'GET') return null;
  const row = await env.DB.prepare(
    'SELECT page_slug FROM travel_groups WHERE group_code = ? AND registration_open = 1'
  ).bind(code).first();
  if (!row || !row.page_slug) return null;
  const search = new URL(request.url).search;
  return new Response(null, {
    status: 301,
    headers: { Location: `https://${host}${groupPrefix(env)}/${row.page_slug}${tail}${search}` },
  });
}
