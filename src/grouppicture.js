// A picture across the top of a group's page, uploaded instead of pasted as a link.
//
// The bucket is private on purpose: nothing in it has an address of its own. A picture for a
// public page is the one thing that has to be seen by people with no account, so it is not served
// from the bucket but through the Worker, at /gi/<group id>, and only while that group's page is
// switched on. The group record then points at that address, which is what the page and a pasted
// link's preview both read.
//
// Only pictures, and only ones whose first bytes say they are: a file that calls itself a JPEG and
// is something else is refused, and what is served is sent with the type it was found to be and
// with sniffing switched off, so it can never run as anything but an image.

import { json, badRequest, notFound, uid, now } from './util.js';
import { requireUser } from './auth.js';
import { appUrl } from './share.js';
import { docsReady } from './documents.js';
import * as db from './db.js';

const MAX_BYTES = 5 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE_OF_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** What a picture is, from its first bytes. Null for anything that is not one of the four. */
export function sniffPicture(bytes) {
  const b = bytes || [];
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

const notReady = () => badRequest('File storage is not set up yet, so a picture cannot be uploaded.');

/** POST /api/groups/:id/picture : a multipart upload with the picture as "file". */
export async function handleUploadPicture(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', id);
  if (!owner) return notFound('Group not found.');
  if (!docsReady(env)) return notReady();

  let form;
  try { form = await request.formData(); } catch { form = null; }
  const file = form && form.get('file');
  if (!file || typeof file === 'string' || !file.arrayBuffer) return badRequest('Choose a picture to upload.');
  if (!file.size) return badRequest('That file is empty.');
  if (file.size > MAX_BYTES) {
    return badRequest(`That picture is ${(file.size / 1048576).toFixed(1)} MB. The limit is 5 MB.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffPicture(bytes);
  if (!type) return badRequest('That is not a JPEG, PNG, WebP or GIF picture.');

  const group = await env.DB.prepare(
    'SELECT id, hero_image_key FROM travel_groups WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!group) return notFound('Group not found.');

  const key = `${owner.id}/groups/${id}/hero-${uid()}.${EXT[type]}`;
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: type } });

  const ts = now();
  const url = `${appUrl(env)}/gi/${encodeURIComponent(id)}?v=${ts}`;
  await env.DB.prepare(
    'UPDATE travel_groups SET hero_image_key = ?, hero_image_url = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(key, url, ts, id, owner.id).run();

  // The one it replaces, once the new one is safely in. A failure here leaves a stray file and nothing else.
  if (group.hero_image_key) await env.DOCS.delete(group.hero_image_key).catch(() => {});

  await db.logActivity(env, user.id, 'group.picture', 'Uploaded a picture for a group page', { id });
  return json({ ok: true, url });
}

/** DELETE /api/groups/:id/picture : takes the uploaded picture off the group. */
export async function handleRemovePicture(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', id);
  if (!owner) return notFound('Group not found.');

  const group = await env.DB.prepare(
    'SELECT id, hero_image_key, hero_image_url FROM travel_groups WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!group) return notFound('Group not found.');

  if (group.hero_image_key && docsReady(env)) await env.DOCS.delete(group.hero_image_key).catch(() => {});
  // The address is cleared only if it is the uploaded one: a link somebody pasted is left alone.
  const own = String(group.hero_image_url || '').includes(`/gi/${id}`);
  await env.DB.prepare(
    `UPDATE travel_groups SET hero_image_key = NULL, hero_image_url = CASE WHEN ? = 1 THEN NULL ELSE hero_image_url END,
            updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(own ? 1 : 0, now(), id, owner.id).run();
  return json({ ok: true, cleared: own });
}

/**
 * GET /gi/<group id> : the picture, for anybody, while the group's page is on.
 *
 * Found by the group's id, which is the address that was handed out in the page; user_id is read
 * and not tested, like the other public lookups of a group by something it was given.
 */
export async function serveGroupPicture(request, env, id) {
  if (!docsReady(env)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare(
    'SELECT hero_image_key, user_id FROM travel_groups WHERE id = ? AND registration_open = 1 AND hero_image_key IS NOT NULL'
  ).bind(id).first();
  if (!row) return new Response('Not found', { status: 404 });

  const object = await env.DOCS.get(row.hero_image_key);
  if (!object) return new Response('Not found', { status: 404 });
  const type = TYPE_OF_EXT[String(row.hero_image_key).split('.').pop()] || 'application/octet-stream';
  return new Response(object.body, {
    headers: {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      // The address carries a version, so it can be kept for a while and a new picture still shows.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
