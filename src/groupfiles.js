// PDFs a group's page offers for download: a flyer, an itinerary, a brochure.
//
// Kept in the private bucket like every other file here, and shown on the public page through the
// Worker at /gf/<id>, and only while that group's page is on. Only PDFs, and only ones whose first
// bytes say so, so a file cannot arrive under a PDF's name and be handed to a traveller as something
// else. A few per group, because a page with a dozen downloads is a filing cabinet and not a page.

import { json, badRequest, notFound, clean, uid, now } from './util.js';
import { requireUser } from './auth.js';
import { appUrl } from './share.js';
import { docsReady } from './documents.js';
import * as db from './db.js';

export const MAX_FILES = 6;
const MAX_BYTES = 10 * 1024 * 1024;

/** Whether bytes begin the way a PDF does. */
export function looksLikePdf(bytes) {
  const b = bytes || [];
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
}

/** A group's files, oldest first, for its screen and its page. */
export async function listGroupFiles(env, groupId, userId) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, filename, size_bytes FROM group_files
      WHERE group_id = ? AND user_id = ? ORDER BY sort_order ASC, created_at ASC`
  ).bind(groupId, userId).all().catch(() => ({ results: [] }));
  return (results || []).map((f) => ({
    id: f.id, title: f.title, filename: f.filename, bytes: f.size_bytes,
    // Absolute, because the page may be shown on the shared domain, which has no such address.
    url: `${appUrl(env)}/gf/${encodeURIComponent(f.id)}`,
  }));
}

const safeName = (raw) => (clean(raw, 120) || 'file.pdf').replace(/[^A-Za-z0-9._ -]+/g, '_');

/** POST /api/groups/:id/files : a multipart upload with the PDF as "file" and a "title". */
export async function handleUploadGroupFile(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', groupId);
  if (!owner) return notFound('Group not found.');
  if (!docsReady(env)) return badRequest('File storage is not set up yet, so a file cannot be uploaded.');

  let form;
  try { form = await request.formData(); } catch { form = null; }
  const file = form && form.get('file');
  if (!file || typeof file === 'string' || !file.arrayBuffer) return badRequest('Choose a PDF to upload.');
  if (!file.size) return badRequest('That file is empty.');
  if (file.size > MAX_BYTES) {
    return badRequest(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 10 MB.`);
  }

  const have = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM group_files WHERE group_id = ? AND user_id = ?'
  ).bind(groupId, owner.id).first();
  if ((have && have.n) >= MAX_FILES) return badRequest(`A group's page offers at most ${MAX_FILES} downloads. Remove one first.`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikePdf(bytes)) return badRequest('That is not a PDF.');

  const filename = safeName(file.name).replace(/\.pdf$/i, '') + '.pdf';
  const title = clean(form.get('title'), 80) || filename.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
  const id = uid();
  const key = `${owner.id}/groups/${groupId}/file-${id}.pdf`;
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  await env.DB.prepare(
    `INSERT INTO group_files (id, group_id, user_id, title, filename, object_key, size_bytes, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, groupId, owner.id, title, filename, key, bytes.length, Number(have && have.n) || 0, now()).run();

  await db.logActivity(env, user.id, 'group.file', 'Added a download to a group page', { id: groupId });
  return json({ ok: true, files: await listGroupFiles(env, groupId, owner.id) }, 201);
}

/** DELETE /api/groups/:id/files/:fileId */
export async function handleDeleteGroupFile(request, env, groupId, fileId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'travel_groups', groupId);
  if (!owner) return notFound('Group not found.');

  const row = await env.DB.prepare(
    'SELECT id, object_key FROM group_files WHERE id = ? AND group_id = ? AND user_id = ?'
  ).bind(fileId, groupId, owner.id).first();
  if (!row) return notFound('That file is not on this group.');

  if (docsReady(env)) await env.DOCS.delete(row.object_key).catch(() => {});
  await env.DB.prepare('DELETE FROM group_files WHERE id = ? AND user_id = ?').bind(fileId, owner.id).run();
  return json({ ok: true, files: await listGroupFiles(env, groupId, owner.id) });
}

/** A group's files all go with it: the objects in the bucket, which nothing else would ever remove. */
export async function removeGroupFiles(env, groupId, userId) {
  const { results } = await env.DB.prepare(
    'SELECT id, object_key FROM group_files WHERE group_id = ? AND user_id = ?'
  ).bind(groupId, userId).all().catch(() => ({ results: [] }));
  for (const f of results || []) {
    if (docsReady(env)) await env.DOCS.delete(f.object_key).catch(() => {});
  }
  await env.DB.prepare('DELETE FROM group_files WHERE group_id = ? AND user_id = ?').bind(groupId, userId).run();
}

/**
 * GET /gf/<file id> : the PDF, for anybody, while its group's page is on.
 *
 * Found by the file's id, which is the address the page handed out; user_id is read and not tested,
 * like the other public lookups of something by an address that was given.
 */
export async function serveGroupFile(request, env, fileId) {
  if (!docsReady(env)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare(
    `SELECT f.object_key, f.filename, f.user_id FROM group_files f
       JOIN travel_groups g ON g.id = f.group_id
      WHERE f.id = ? AND g.registration_open = 1 AND g.status <> 'cancelled'`
  ).bind(fileId).first();
  if (!row) return new Response('Not found', { status: 404 });

  const object = await env.DOCS.get(row.object_key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${String(row.filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
