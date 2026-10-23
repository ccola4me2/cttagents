// How one person's pages read, when it should not be the agency's.
//
// A page a client opens carries a name, a logo, a colour and a way to reach somebody. Until now those came
// from the agency, so everybody in it spoke as the agency. A person who shares groups with others, and whose
// own agency is somewhere else, needs their pages to say who they are: their name, their logo, their phone and
// email. Each field is optional and a blank one is the agency's, so nothing changes for anybody who sets
// nothing.
//
// The logo is kept in the private bucket and served through the Worker at /ub/<user id>, because a logo on a
// public page has to be seen by people with no account and the bucket has no addresses of its own. Only
// pictures, and only ones whose first bytes say they are.

import { json, badRequest, clean, isValidEmail, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import { HEX_COLOR, readableOnWhite } from './brand.js';
import { sniffPicture } from './grouppicture.js';
import { docsReady } from './documents.js';
import * as db from './db.js';

const MAX_BYTES = 2 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE_OF_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

function shape(row) {
  return {
    name: (row && row.name) || '',
    tagline: (row && row.tagline) || '',
    color: (row && row.color) || '',
    phone: (row && row.phone) || '',
    email: (row && row.email) || '',
    website: (row && row.website) || '',
    hasLogo: Boolean(row && row.logo_key),
    logoUrl: row && row.logo_key ? `/ub/${encodeURIComponent(row.user_id)}?v=${row.updated_at}` : '',
  };
}

async function load(env, userId) {
  return env.DB.prepare(
    `SELECT user_id, name, tagline, color, phone, email, website, logo_key, updated_at
       FROM user_brand WHERE user_id = ?`
  ).bind(userId).first();
}

/** GET /api/brand : the signed in person's own page identity. */
export async function handleGetBrand(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  return json({ brand: shape(await load(env, user.id)) });
}

/** PUT /api/brand { name, tagline, color, phone, email, website } : blank clears a field. */
export async function handleSaveBrand(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);

  const color = clean(body.color, 7);
  if (color && !HEX_COLOR.test(color)) return badRequest('A colour is six hex digits after a hash, like #1b3a5f.');
  if (color && !readableOnWhite(color)) {
    return badRequest('That colour is too pale to read on a white page. Pick a darker one.');
  }
  const email = clean(body.email, 254).toLowerCase();
  if (email && !isValidEmail(email)) return badRequest('That email address does not look right.');
  let website = clean(body.website, 200);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;

  await env.DB.prepare(
    `INSERT INTO user_brand (user_id, name, tagline, color, phone, email, website, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, tagline = excluded.tagline,
       color = excluded.color, phone = excluded.phone, email = excluded.email,
       website = excluded.website, updated_at = excluded.updated_at`
  ).bind(user.id, clean(body.name, 120) || null, clean(body.tagline, 160) || null, color || null,
    clean(body.phone, 40) || null, email || null, website || null, now()).run();
  await db.logActivity(env, user.id, 'brand.save', 'Changed how their pages read');
  return json({ ok: true, brand: shape(await load(env, user.id)) });
}

/** POST /api/brand/logo : a multipart upload with the picture as "file". */
export async function handleUploadLogo(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!docsReady(env)) return badRequest('File storage is not set up yet, so a logo cannot be uploaded.');

  let form;
  try { form = await request.formData(); } catch { form = null; }
  const file = form && form.get('file');
  if (!file || typeof file === 'string' || !file.arrayBuffer) return badRequest('Choose a logo to upload.');
  if (!file.size) return badRequest('That file is empty.');
  if (file.size > MAX_BYTES) {
    return badRequest(`That logo is ${(file.size / 1048576).toFixed(1)} MB. The limit is 2 MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffPicture(bytes);
  if (!type) return badRequest('That is not a JPEG, PNG, WebP or GIF picture.');

  const before = await load(env, user.id);
  const key = `${user.id}/brand/logo-${uid()}.${EXT[type]}`;
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: type } });
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO user_brand (user_id, logo_key, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET logo_key = excluded.logo_key, updated_at = excluded.updated_at`
  ).bind(user.id, key, ts).run();
  // The one it replaces, once the new one is safely in.
  if (before && before.logo_key) await env.DOCS.delete(before.logo_key).catch(() => {});
  await db.logActivity(env, user.id, 'brand.logo', 'Uploaded a logo for their pages');
  return json({ ok: true, brand: shape(await load(env, user.id)) });
}

/** DELETE /api/brand/logo */
export async function handleRemoveLogo(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const before = await load(env, user.id);
  if (before && before.logo_key && docsReady(env)) await env.DOCS.delete(before.logo_key).catch(() => {});
  await env.DB.prepare('UPDATE user_brand SET logo_key = NULL, updated_at = ? WHERE user_id = ?')
    .bind(now(), user.id).run();
  return json({ ok: true, brand: shape(await load(env, user.id)) });
}

/**
 * GET /ub/<user id> : the logo, for anybody.
 *
 * Found by the person's id, which is the address the page was given. Served with the type it was found to be
 * and with sniffing switched off, so it can never run as anything but an image.
 */
export async function serveUserLogo(request, env, userId) {
  if (!docsReady(env)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare('SELECT logo_key FROM user_brand WHERE user_id = ? AND logo_key IS NOT NULL')
    .bind(userId).first();
  if (!row) return new Response('Not found', { status: 404 });
  const object = await env.DOCS.get(row.logo_key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'Content-Type': TYPE_OF_EXT[String(row.logo_key).split('.').pop()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
