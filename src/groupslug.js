// A group's short name: the part of the link that follows the domain.
//
// A group's page used to live at /g/<group number>. That number is the supplier's reference
// for the block, it is often long, and it was never meant to be typed into a text message.
// The page now has a short name of its own, kept apart from the supplier's number, so the
// address people are sent can be as small as the advisor wants.
//
// Three promises sit on top of that, and the table is what keeps them:
//
//   1. A name means one group in its area: CTT's names are at /<name> and Trip Vara's at /tv/<name>,
//      so the two portals never share a name and never have to ask each other.
//   2. A link that was sent keeps working. Changing a name archives the old one rather than
//      dropping it: it redirects to the group and stays reserved to the advisor, so nobody
//      else can take it and catch the people who still hold the old link.
//   3. The same advisor can reuse an archived name on a newer group, after being told that
//      the old links will then lead to the new one. The old group keeps it in its history.
//
// Statuses on group_slugs:
//   current   the name the group is shared under now
//   archived  a name it used to have; still redirects to the group
//   released  a name it had and no longer has; resolves to nothing

import { json, badRequest, notFound, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

export const SLUG_MIN = 3;
export const SLUG_MAX = 30;
// The suggestion is shorter than the most somebody may type: the point is a link that fits
// in a text message.
const SUGGEST_MAX = 20;
// Old names one group keeps. Past this the oldest is released, so one group cannot hold a
// run of short names.
export const MOST_OLD_NAMES = 5;

// Words the site itself might one day answer to, and words that make a link look official.
const RESERVED = new Set([
  'about', 'admin', 'api', 'app', 'assets', 'billing', 'blog', 'c', 'contact', 'dashboard',
  'favicon', 'forgot', 'g', 'gs', 'help', 'home', 'i', 'index', 'join', 'login', 'logout',
  'mail', 'portal', 'pricing', 'privacy', 'register', 'reset', 'robots', 's', 'settings',
  'sitemap', 'static', 'support', 't', 'terms', 'trip', 'tv', 'u', 'www', 'cgp',
]);

// Left out of a suggestion: they say nothing about which group this is.
const FILLER = new Set([
  'a', 'an', 'and', 'at', 'cruise', 'cruises', 'for', 'group', 'groups', 'in', 'of', 'on',
  'sailing', 'the', 'to', 'trip', 'with',
]);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MON = MONTHS.map((m) => m.slice(0, 3));

/** What somebody typed, made into a name: lower case letters, numbers and single hyphens. */
export function cleanSlug(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .toLowerCase().trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

/** Why a cleaned name cannot be used, in words for the person typing it. Null when it can. */
export function slugProblem(slug) {
  if (!slug || slug.length < SLUG_MIN) return `Use at least ${SLUG_MIN} letters or numbers.`;
  if (/^\d+$/.test(slug)) return 'Add at least one letter.';
  if (RESERVED.has(slug)) return 'That name is kept for the site itself. Try another.';
  return null;
}

/**
 * A short name from a group's name and sailing date.
 *
 * Filler words, the month and the year come out of the name, then the date goes back in
 * short: "Margaritaville at Sea Oct 2027" becomes margaritaville-oct27. A suggestion, which
 * the advisor can replace with anything they like.
 */
export function suggestSlug(name, departDate) {
  const d = /^(\d{4})-(\d{2})-\d{2}$/.exec(departDate || '');
  const suffix = d ? `${MON[Number(d[2]) - 1] || ''}${d[1].slice(2)}` : '';
  const words = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .filter((w) => !FILLER.has(w) && !MONTHS.includes(w) && !MON.includes(w)
      && !/^(19|20)\d{2}$/.test(w));

  const room = SUGGEST_MAX - (suffix ? suffix.length + 1 : 0);
  let base = '';
  for (const w of words) {
    const next = base ? `${base}-${w}` : w;
    if (next.length > room) break;
    base = next;
  }
  if (!base) base = (words[0] || 'group').slice(0, room);

  const out = cleanSlug(suffix ? `${base}-${suffix}` : base);
  return slugProblem(out) ? cleanSlug(`${out}-grp`) : out;
}

/**
 * Who holds a name here, if anybody. Released names are history and hold nothing.
 *
 * Found by the name alone on purpose: the name is the address that was handed out, and it
 * is unique across every advisor, so the question is whose it is and not whether it is
 * theirs. user_id is read, not tested; what makes this safe is the same thing that makes
 * /g/<code> safe, which is that the name is the credential and only says what the page
 * would have said to anybody.
 */
async function localHolder(env, slug) {
  const row = await env.DB.prepare(
    `SELECT id, slug, group_id, user_id, status FROM group_slugs
      WHERE slug = ? AND status IN ('current', 'archived')`
  ).bind(slug).first();
  return row || null;
}

/** A call to the other portal that gives up rather than holding a page or a save for ever. */
export function withTimeout(promise, ms) {
  let timer;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, stop]).finally(() => clearTimeout(timer));
}

/**
 * Where a name stands for this advisor and this group:
 *   free          nobody holds it
 *   current       this group is shared under it already
 *   own-archived  this group used to be, and can go back to it
 *   recyclable    archived on another of this advisor's groups; reuse needs a yes
 *   taken         somebody else's
 */
export async function slugState(env, slug, userId, groupId) {
  const row = await localHolder(env, slug);
  if (row) {
    if (row.group_id === groupId) {
      return { state: row.status === 'current' ? 'current' : 'own-archived', row };
    }
    if (row.user_id === userId && row.status === 'archived') return { state: 'recyclable', row };
    return { state: 'taken', row };
  }
  return { state: 'free', row: null };
}

async function freeAlternatives(env, slug, userId, groupId, wanted = 3) {
  const out = [];
  for (let n = 2; n <= 12 && out.length < wanted; n += 1) {
    const tail = `-${n}`;
    const candidate = `${slug.slice(0, SLUG_MAX - tail.length)}${tail}`.replace(/-{2,}/g, '-');
    if (slugProblem(candidate)) continue;
    if ((await slugState(env, candidate, userId, groupId)).state === 'free') out.push(candidate);
  }
  return out;
}

/** Writes a name as the group's current one. False when the name was taken in the meantime. */
async function insertCurrent(env, userId, groupId, slug) {
  const ts = now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO group_slugs (id, slug, group_id, user_id, status, created_at)
         VALUES (?, ?, ?, ?, 'current', ?)`
      ).bind(uid(), slug, groupId, userId, ts),
      env.DB.prepare('UPDATE travel_groups SET page_slug = ? WHERE id = ? AND user_id = ?')
        .bind(slug, groupId, userId),
    ]);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Gives a group its first name: what was asked for if it is free, otherwise a suggestion,
 * with a number on the end if the suggestion is taken. Returns the name, or null.
 */
export async function assignSlug(env, { userId, groupId, name, departDate, preferred }) {
  const tries = [];
  const asked = cleanSlug(preferred);
  if (asked) tries.push(asked);
  const base = suggestSlug(name, departDate);
  tries.push(base);
  for (let n = 2; n <= 20; n += 1) {
    const tail = `-${n}`;
    tries.push(`${base.slice(0, SLUG_MAX - tail.length)}${tail}`);
  }
  for (const slug of tries) {
    if (slugProblem(slug)) continue;
    if ((await slugState(env, slug, userId, groupId)).state !== 'free') continue;
    if (await insertCurrent(env, userId, groupId, slug)) return slug;
  }
  return null;
}

/** The name, its link, and every name the group has held. */
export async function linkInfo(env, group) {
  const { results } = await env.DB.prepare(
    `SELECT slug, status, created_at, retired_at FROM group_slugs
      WHERE group_id = ? AND user_id = ? ORDER BY created_at DESC`
  ).bind(group.id, group.user_id).all().catch(() => ({ results: [] }));
  const host = env.GROUP_HOST || '';
  const prefix = String(env.GROUP_PREFIX || '').replace(/\/+$/, '');
  const slug = group.page_slug || null;
  return {
    slug,
    host,
    // What the link starts with after the domain: nothing for CTT's groups, /tv for Trip Vara's.
    prefix,
    url: slug && host ? `https://${host}${prefix}/${slug}` : null,
    suggestion: slug ? null : suggestSlug(group.name, group.depart_date),
    history: results || [],
    mostOld: MOST_OLD_NAMES,
  };
}

/** A group's names no longer mean anything, because the group is gone. */
export async function releaseAllFor(env, groupId, userId) {
  await env.DB.prepare(
    `UPDATE group_slugs SET status = 'released', retired_at = ?
      WHERE group_id = ? AND user_id = ? AND status IN ('current', 'archived')`
  ).bind(now(), groupId, userId).run();
}

/**
 * What the public pages need from a name: which group it is, and what that group is called
 * now, so an archived name can send people to the current one.
 */
export async function findSlug(env, slug) {
  const hit = await localHolder(env, slug);
  if (!hit) return null;
  const g = await env.DB.prepare('SELECT page_slug FROM travel_groups WHERE id = ? AND user_id = ?')
    .bind(hit.group_id, hit.user_id).first();
  return { ...hit, current: g ? g.page_slug : null };
}

// ------------------------------------------------------------- handlers --

/** GET /api/public/group-slug-taken?name= : the other portal's question, and nothing else. */
export async function handlePublicSlugTaken(request, env) {
  const slug = cleanSlug(new URL(request.url).searchParams.get('name'));
  if (!slug) return json({ taken: false });
  return json({ taken: RESERVED.has(slug) || Boolean(await localHolder(env, slug)) });
}

/** GET /api/group-slugs/check?name=&groupId= : is this name usable, as the advisor types. */
export async function handleSlugCheck(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const params = new URL(request.url).searchParams;
  const slug = cleanSlug(params.get('name'));
  const groupId = params.get('groupId') || null;

  let userId = user.id;
  if (groupId) {
    const owner = await db.writerFor(env, user, 'travel_groups', groupId);
    if (!owner) return notFound('Group not found.');
    userId = owner.id;
  }

  const problem = slugProblem(slug);
  if (problem) return json({ slug, available: false, problem });

  const { state, row } = await slugState(env, slug, userId, groupId);
  if (state === 'taken') {
    return json({
      slug, available: false, state,
      problem: 'That name is taken. Try another.',
      suggestions: await freeAlternatives(env, slug, userId, groupId),
    });
  }
  let from = null;
  if (state === 'recyclable') {
    const other = await env.DB.prepare('SELECT name FROM travel_groups WHERE id = ? AND user_id = ?')
      .bind(row.group_id, userId).first();
    from = other ? other.name : 'another of your groups';
  }
  return json({ slug, available: true, state, needsRecycle: state === 'recyclable', from });
}

/**
 * POST /api/group-slugs/release { groupId, slug }
 *
 * Lets an old name go: it stops redirecting and anybody may take it. For the advisor whose group it
 * was, and for an owner on any advisor's group, which is who db.writerFor lets through. Only an old
 * name: the one a group is shared under now is changed, not released.
 */
export async function handleReleaseSlug(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', String(body.groupId || ''));
  if (!owner) return notFound('Group not found.');

  const slug = cleanSlug(body.slug);
  const row = await env.DB.prepare(
    `SELECT id FROM group_slugs WHERE slug = ? AND group_id = ? AND user_id = ? AND status = 'archived'`
  ).bind(slug, String(body.groupId), owner.id).first();
  if (!row) return notFound('That is not an old name of this group.');

  await env.DB.prepare(
    `UPDATE group_slugs SET status = 'released', retired_at = ? WHERE id = ? AND user_id = ?`
  ).bind(now(), row.id, owner.id).run();
  await db.logActivity(env, user.id, 'group.slug.release', `Let an old group link go: ${slug}`,
    { id: body.groupId });

  const group = await env.DB.prepare(
    'SELECT id, user_id, name, page_slug, depart_date FROM travel_groups WHERE id = ? AND user_id = ?'
  ).bind(String(body.groupId), owner.id).first();
  return json({ ok: true, link: await linkInfo(env, group) });
}

/** PUT /api/groups/:id/slug : name the group's page, or change the name it has. */
export async function handleSetSlug(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', id);
  if (!owner) return notFound('Group not found.');

  const body = await readJson(request);
  const slug = cleanSlug(body.slug);
  const problem = slugProblem(slug);
  if (problem) return badRequest(problem);

  const group = await env.DB.prepare(
    'SELECT id, user_id, name, page_slug, depart_date FROM travel_groups WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!group) return notFound('Group not found.');
  if (group.page_slug === slug) return json({ ok: true, link: await linkInfo(env, group) });

  const { state, row } = await slugState(env, slug, owner.id, id);
  if (state === 'taken') {
    return json({
      error: 'That name is taken. Try another.',
      suggestions: await freeAlternatives(env, slug, owner.id, id),
    }, 409);
  }
  if (state === 'recyclable' && body.recycle !== true) {
    const other = await env.DB.prepare('SELECT name FROM travel_groups WHERE id = ? AND user_id = ?')
      .bind(row.group_id, owner.id).first();
    return json({
      error: 'That name is still held by an older group, and its links are out there.',
      needsRecycle: true,
      from: other ? other.name : 'another of your groups',
    }, 409);
  }

  const ts = now();
  const steps = [];
  // The name it has now becomes an old one.
  steps.push(env.DB.prepare(
    `UPDATE group_slugs SET status = 'archived', retired_at = ?
      WHERE group_id = ? AND user_id = ? AND status = 'current'`
  ).bind(ts, id, owner.id));
  if (state === 'recyclable') {
    // The older group keeps it in its history, as a name it had.
    steps.push(env.DB.prepare(
      `UPDATE group_slugs SET status = 'released', retired_at = ? WHERE id = ? AND user_id = ?`
    ).bind(ts, row.id, owner.id));
  }
  if (state === 'own-archived') {
    steps.push(env.DB.prepare(
      `UPDATE group_slugs SET status = 'current', retired_at = NULL WHERE id = ? AND user_id = ?`
    ).bind(row.id, owner.id));
  } else {
    steps.push(env.DB.prepare(
      `INSERT INTO group_slugs (id, slug, group_id, user_id, status, created_at)
       VALUES (?, ?, ?, ?, 'current', ?)`
    ).bind(uid(), slug, id, owner.id, ts));
  }
  steps.push(env.DB.prepare('UPDATE travel_groups SET page_slug = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(slug, ts, id, owner.id));

  try {
    await env.DB.batch(steps);
  } catch (e) {
    // Somebody took it between the check and the write.
    return json({ error: 'That name was just taken. Try another.' }, 409);
  }

  // Past the cap, the oldest archived name is let go.
  const { results: old } = await env.DB.prepare(
    `SELECT id, slug FROM group_slugs WHERE group_id = ? AND user_id = ? AND status = 'archived'
      ORDER BY retired_at DESC, created_at DESC`
  ).bind(id, owner.id).all();
  const extra = (old || []).slice(MOST_OLD_NAMES);
  for (const e of extra) {
    await env.DB.prepare(
      `UPDATE group_slugs SET status = 'released', retired_at = ? WHERE id = ? AND user_id = ?`
    ).bind(ts, e.id, owner.id).run();
  }

  await db.logActivity(env, user.id, 'group.slug', `Group link is now ${slug}`, { id });
  return json({
    ok: true,
    link: await linkInfo(env, { ...group, page_slug: slug }),
    released: extra.map((e) => e.slug),
  });
}
