// The paperwork a trip generates.
//
// Every booking produces documents: the vendor confirmation, the insurance
// policy, air tickets, a visa letter. They live in the advisor's email and
// their downloads folder, so "can you send me my confirmation again" means
// searching both.
//
// The file goes to R2 and the row in D1 is the index. A listing then costs a
// database read rather than a bucket listing, and the object key is never the
// thing a browser is handed: a document is fetched by its id, checked against
// the advisor who owns it, and streamed. Guessing a key gets you nothing,
// because the key is not the address.

import { json, badRequest, notFound, clean, oneOf, uid, now } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

// Ten megabytes. A confirmation is a hundred kilobytes and a scanned passport
// a couple more; anything much larger is a video somebody meant to send
// elsewhere, and a Worker holding it in memory to write it is a Worker that
// falls over.
const MAX_BYTES = 10 * 1024 * 1024;

// 'other' leads because oneOf falls back to the first entry, and filing an
// unlabelled upload as an insurance policy is worse than filing it as nothing.
export const CATEGORIES = ['other', 'confirmation', 'invoice', 'insurance', 'air', 'visa', 'passport'];

const COLUMNS = `
  id, user_id, booking_id, object_key, filename, content_type, size_bytes,
  category, shared, created_at, updated_at
`;

/**
 * Whether the bucket is actually bound.
 *
 * The feature ships before the bucket exists, so every path says what is
 * missing rather than throwing "cannot read properties of undefined". The
 * alternative was putting the binding in wrangler.toml before the bucket was
 * created, which fails the deploy and takes new releases down with it.
 */
export function docsReady(env) {
  return Boolean(env && env.DOCS);
}

const notConfigured = () => badRequest(
  'File storage is not set up yet. Create an R2 bucket named cttagents-docs in the '
  + 'Cloudflare dashboard, then add its binding to wrangler.toml as DOCS.');

export async function listDocuments(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM documents
      WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY created_at DESC`
  ).bind(bookingId, ...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

/** Keeps a filename readable and harmless. */
function safeName(raw) {
  const name = clean(raw, 120) || 'document';
  const stripped = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return stripped || 'document';
}

export async function handleUploadDocument(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!docsReady(env)) return notConfigured();

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  let form;
  try { form = await request.formData(); } catch { form = null; }
  const file = form && form.get('file');
  if (!file || typeof file === 'string' || !file.arrayBuffer) {
    return badRequest('Choose a file to attach.');
  }

  if (file.size > MAX_BYTES) {
    return badRequest(`That file is ${Math.round(file.size / 1024 / 1024)}MB. The limit is 10MB.`);
  }
  if (!file.size) return badRequest('That file is empty.');

  const filename = safeName(file.name);
  const category = oneOf(form.get('category'), CATEGORIES);
  const id = uid();
  // The advisor and the trip are in the key as well as in the row. Nothing
  // reads the key to decide who may have the file, but a bucket somebody is
  // one day looking through by hand should say whose each object is.
  const key = `${user.id}/${bookingId}/${id}-${filename}`;

  await env.DOCS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  const ts = now();
  await env.DB.prepare(
    `INSERT INTO documents
       (id, user_id, booking_id, object_key, filename, content_type, size_bytes,
        category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, bookingId, key, filename, file.type || null, file.size,
         category, ts, ts).run();

  // The filename is deliberately absent from the log line. A passport scan
  // named after its owner should not end up in an activity feed.
  await db.logActivity(env, user.id, 'document.add',
    `Attached a ${category} to ${booking.client_name}'s trip`, { bookingId });

  return json({ ok: true, id, filename, category, sizeBytes: file.size }, 201);
}

/**
 * Streams a document back.
 *
 * Always as an attachment. A file the advisor uploaded is served from the same
 * origin as the portal, so an HTML or SVG document rendered inline would run
 * its own script against a signed in session. Downloading it cannot.
 */
export async function handleGetDocument(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!docsReady(env)) return notConfigured();

  // Read scope, so an owner can open an associate's paperwork the same way
  // they can read the reservation it hangs off.
  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'user_id');
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM documents WHERE id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).first();
  if (!row) return notFound('Document not found.');

  const object = await env.DOCS.get(row.object_key);
  if (!object) return notFound('That file is no longer in storage.');

  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${row.filename.replace(/"/g, '')}"`,
      // Belt and braces with the disposition above: no sniffing a type the
      // browser might decide to render instead.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function handleDeleteDocument(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!docsReady(env)) return notConfigured();

  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM documents WHERE id = ? AND user_id = ?`
  ).bind(id, user.id).first();
  if (!row) return notFound('Document not found.');

  // The object first. A row without its file is a broken download; a file
  // without its row is a few kilobytes nobody can reach, and of the two only
  // the first is visible to anybody.
  await env.DOCS.delete(row.object_key).catch(() => null);
  await env.DB.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();

  await db.logActivity(env, user.id, 'document.delete', 'Removed a document',
    { bookingId: row.booking_id });
  return json({ ok: true });
}
