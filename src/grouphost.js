// Serving a group's page by its short name.
//
// One domain, cruisegrouppage.com, serves the groups of both portals: the name follows the
// domain, so the address carries no hint of which portal a group lives in. The domain is
// attached to one Worker. That Worker answers for its own groups and, when a name is not
// one of theirs, hands the request on to the other portal through a service binding (PEER),
// which answers for its own. The request is passed on as it came, so the visitor's address,
// the form they posted and every header arrive untouched.
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

// Set on a request that has already been handed across, so the two portals can never
// bounce one between them.
const HOP = 'x-group-hop';

/** Is this request for the shared group domain? */
export function isGroupHost(request, env) {
  const host = String(env.GROUP_HOST || '').trim().toLowerCase();
  if (!host) return false;
  return new URL(request.url).hostname.toLowerCase() === host;
}

/** Everything on the shared domain: a name, a name and /register, and nothing else. */
export async function serveGroupHost(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const m = path.match(/^\/([^/]+)(?:\/(register))?\/?$/);
  if (!m) {
    return noGroupPage(env, path === '/'
      ? 'This address serves group trip pages. Use the link you were sent.' : '');
  }
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

  const hit = slug ? await findSlug(env, slug) : null;
  if (!hit) {
    // Not ours. On the shared domain the other portal may hold it.
    if (mode === 'host' && env.PEER && !request.headers.get(HOP)) {
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

  const start = mode === 'host' ? '' : '/gs';
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
    headers: { Location: `https://${host}/${row.page_slug}${tail}${search}` },
  });
}
