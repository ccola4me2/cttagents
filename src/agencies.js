// Agencies, and what each one looks like.
//
// The portal ran as one business for as long as there was one. An agency is
// now a row, and it does two jobs that used to be done badly or not at all.
//
// It is the fence. Before this, an owner saw every advisor on the platform,
// and could suspend or re-split any of them, because the handlers checked that
// the caller was an owner and never which agency they owned. That was fine
// while the answer was always "this one".
//
// And it is the name over the door. The agency name and address were copied
// onto every advisor, so two people at one agency could disagree about what it
// was called, and the public pages a client sees said Trip Vara whoever sent
// them.
//
// Two kinds of owner. `role` is unchanged and still means the owner of one
// agency. The platform operator, who can see across agencies and create them,
// is a separate flag: a third value in a field that fourteen places already
// test against would have changed what all fourteen mean.

import { json, badRequest, notFound, clean, cleanText, uid, now, readJson } from './util.js';
import { requireAdmin } from './auth.js';
import * as db from './db.js';
import {
  AGENCY_COLUMNS as COLUMNS, HEX_COLOR as HEX, getAgency, getAgencyBySlug, brandOf,
} from './brand.js';

function slugify(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agency';
}

async function freeSlug(env, name, exceptId = null) {
  const base = slugify(name);
  for (let i = 0; i < 20; i += 1) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await env.DB.prepare('SELECT id FROM agencies WHERE slug = ?').bind(slug).first();
    if (!clash || clash.id === exceptId) return slug;
  }
  return `${base}-${uid().slice(0, 6)}`;
}

function parse(body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'The agency needs a name.' };

  const color = clean(body.brandColor, 7);
  if (color && !HEX.test(color)) {
    return { error: 'A brand colour is six hex digits after a hash, like #1b3a5f.' };
  }

  const logoUrl = clean(body.logoUrl, 500);
  if (logoUrl && !/^https:\/\//i.test(logoUrl)) {
    // It is loaded on pages served over https to people outside the business,
    // and a http image on one of those is a browser warning on their screen.
    return { error: 'A logo address has to start with https://.' };
  }

  return {
    fields: {
      name,
      ghlLocationId: clean(body.ghlLocationId, 64) || null,
      address: cleanText(body.address, 300),
      phone: clean(body.phone, 40),
      email: clean(body.email, 254),
      website: clean(body.website, 200),
      sellerOfTravel: clean(body.sellerOfTravel, 120),
      logoUrl: logoUrl || null,
      brandColor: color || null,
      tagline: clean(body.tagline, 160),
      joinOpen: body.joinOpen === false ? 0 : 1,
    },
  };
}

/** How many advisors each agency has, so the list says something. */
const HEADCOUNT = `(SELECT COUNT(*) FROM users u WHERE u.agency_id = a.id) AS advisors`;
const ACTIVE = `(SELECT COUNT(*) FROM users u
                  WHERE u.agency_id = a.id AND u.status = 'active') AS active_advisors`;
const WAITING = `(SELECT COUNT(*) FROM users u
                   WHERE u.agency_id = a.id AND u.status = 'pending') AS pending_advisors`;

export async function handleListAgencies(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  // An agency owner sees their own and nothing else. Listing the others would
  // hand them the platform's client list.
  const where = user.platform_owner ? '1 = 1' : 'a.id = ?';
  const binds = user.platform_owner ? [] : [user.agency_id || ''];

  const { results } = await env.DB.prepare(
    `SELECT a.id, a.name, a.slug, a.ghl_location_id, a.address, a.phone, a.email,
            a.website, a.seller_of_travel, a.logo_url, a.brand_color, a.tagline,
            a.join_open, a.created_at, a.updated_at,
            ${HEADCOUNT}, ${ACTIVE}, ${WAITING}
       FROM agencies a WHERE ${where} ORDER BY a.name ASC LIMIT 200`
  ).bind(...binds).all();

  return json({
    agencies: results || [],
    platformOwner: Boolean(user.platform_owner),
    myAgencyId: user.agency_id || null,
    appUrl: (env.APP_URL || 'https://tripvaratravel.com').replace(/\/$/, ''),
  });
}

export async function handleCreateAgency(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  // Only the operator of the portal opens a new one. An agency owner running
  // their own book has no business creating another agency on it.
  if (!user.platform_owner) return json({ error: 'Only the portal owner can add an agency.' }, 403);

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const id = uid();
  const slug = await freeSlug(env, fields.name);
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO agencies (id, name, slug, ghl_location_id, address, phone, email, website,
       seller_of_travel, logo_url, brand_color, tagline, join_open, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, fields.name, slug, fields.ghlLocationId, fields.address, fields.phone,
         fields.email, fields.website, fields.sellerOfTravel, fields.logoUrl,
         fields.brandColor, fields.tagline, fields.joinOpen, ts, ts).run();

  await db.logActivity(env, user.id, 'agency.create', `Added agency ${fields.name}`, { id, slug });
  return json({ ok: true, agency: await getAgency(env, id) }, 201);
}

export async function handleUpdateAgency(request, env, id) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  // Their own, or anybody's if they run the portal.
  if (!user.platform_owner && user.agency_id !== id) {
    return json({ error: 'That is not your agency.' }, 403);
  }

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const before = await getAgency(env, id);
  if (!before) return notFound('Agency not found.');

  // The slug is the join link. It follows a rename, because a link with the
  // old name in it is the confusing half of a rebrand, and the old one stops
  // working, which is the point of taking it down.
  const slug = before.name === fields.name ? before.slug : await freeSlug(env, fields.name, id);

  await env.DB.prepare(
    `UPDATE agencies SET name = ?, slug = ?, ghl_location_id = ?, address = ?, phone = ?,
       email = ?, website = ?, seller_of_travel = ?, logo_url = ?, brand_color = ?,
       tagline = ?, join_open = ?, updated_at = ?
     WHERE id = ?`
  ).bind(fields.name, slug, fields.ghlLocationId, fields.address, fields.phone,
         fields.email, fields.website, fields.sellerOfTravel, fields.logoUrl,
         fields.brandColor, fields.tagline, fields.joinOpen, now(), id).run();

  await db.logActivity(env, user.id, 'agency.update', `Updated agency ${fields.name}`, { id });
  return json({ ok: true, agency: await getAgency(env, id) });
}

/**
 * Which agency an advisor is in, and whether they run the portal.
 *
 * Moving somebody between agencies moves what they can see, not what they own:
 * their reservations travel with them because the fence is drawn through the
 * advisor, not stamped on every row.
 */
export async function handleSetAdvisorAgency(request, env, userId) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.platform_owner) return json({ error: 'Only the portal owner can move an advisor.' }, 403);

  const body = await readJson(request);
  const agencyId = clean(body.agencyId, 64);
  if (agencyId && !(await getAgency(env, agencyId))) return badRequest('No such agency.');

  const target = await db.getUserById(env, userId);
  if (!target) return notFound('Advisor not found.');

  // Making somebody the owner of an agency is the portal operator's call, not
  // the agency's own: an owner who could promote their staff could hand out
  // sight of every book in their agency without anybody outside it knowing.
  const role = body.role === undefined ? target.role
    : (body.role === 'admin' ? 'admin' : 'advisor');

  // Handing out the keys to the whole portal is a decision, and taking your
  // own away by accident locks the last operator out of it.
  const wantsOwner = body.platformOwner === true;
  if (userId === user.id && !wantsOwner) {
    return badRequest('You cannot take the portal away from yourself.');
  }

  await env.DB.prepare(
    'UPDATE users SET agency_id = ?, platform_owner = ?, role = ?, updated_at = ? WHERE id = ?'
  ).bind(agencyId || null,
         body.platformOwner === undefined ? (target.platform_owner || 0) : (wantsOwner ? 1 : 0),
         role, now(), userId).run();

  await db.logActivity(env, user.id, 'admin.agency',
    `Moved ${target.email}`, { userId, agencyId });
  return json({ ok: true, user: await db.getUserById(env, userId) });
}

/** What a join page shows before anybody has typed anything. */
export async function handleJoinInfo(request, env, slug) {
  const agency = await getAgencyBySlug(env, slug);
  if (!agency || !agency.join_open) return notFound('That agency is not taking signups.');
  // The name and the branding only. This answers to anybody with the link, so
  // it says what the page has to show and not one field more.
  return json({ agency: { name: agency.name, slug: agency.slug }, brand: brandOf(agency) });
}
