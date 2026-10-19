// A proposal built and sent without being a quote.
//
// An advisor wants to put something in front of a client: a cover picture, a few words, the cruise, the
// hotel, an excursion each with a picture and a price, and a link or an email to send it. Nothing about
// that needs a client record or a reservation, and filling those in first is what stops it being quick. So
// this lives by itself: its own rows, its own pictures in the private bucket, a public page at /p/<code>
// that is only as long-lived as the advisor says, and nothing on the book until the advisor turns it into
// a quote, which is a separate and deliberate step.
//
// The advisor's own, always: every statement names user_id. What the public sees is in
// quickproposalpage.js, which is the only file that renders it.

import { json, badRequest, notFound, clean, cleanText, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import { appUrl } from './share.js';
import { docsReady } from './documents.js';
import { sniffPicture } from './grouppicture.js';
import { SECTION_KINDS } from './proposalkinds.js';
import { brandForUser } from './brand.js';
import { sendQuickProposalEmail } from './email.js';
import * as db from './db.js';

const MAX_SECTIONS = 15;
const MAX_IMAGES = 20;
const MAX_BYTES = 5 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const DAYS = [30, 60, 90, 180];

/** A short address for the public page: lower case letters and digits, nothing guessable in order. */
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

const KIND_KEYS = new Set(SECTION_KINDS.map(([k]) => k));
const MAX_FACTS = 10;
const MAX_OPTIONS = 10;

function sectionsOf(raw, ownImageIds) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw.slice(0, MAX_SECTIONS)) {
    // Details are short pairs, such as Ship and Islander, Sails and 10/30/2027. A pair with no label says
    // nothing and is dropped.
    const facts = (Array.isArray(s && s.facts) ? s.facts : []).slice(0, MAX_FACTS)
      .map((f) => ({ label: clean(f && f.label, 40), value: clean(f && f.value, 120) }))
      .filter((f) => f.label && f.value);
    // Options are the choices a client compares: the cabin categories, the hotel rooms, the flight times.
    // Each is a name, a few words and a price as typed, and one may be marked as the advisor's pick.
    const options = (Array.isArray(s && s.options) ? s.options : []).slice(0, MAX_OPTIONS)
      .map((o) => ({
        label: clean(o && o.label, 80), detail: clean(o && o.detail, 200),
        price: clean(o && o.price, 80), pick: Boolean(o && o.pick),
      }))
      .filter((o) => o.label || o.detail || o.price);
    const row = {
      kind: KIND_KEYS.has(s && s.kind) ? s.kind : '',
      heading: clean(s && s.heading, 100),
      body: cleanText(s && s.body, 2500),
      price: clean(s && s.price, 80),
      facts,
      options,
      // A picture is only ever one of this proposal's own: an id is not a permission.
      imageId: s && ownImageIds.has(s.imageId) ? s.imageId : '',
    };
    if (row.heading || row.body || row.price || row.imageId || row.facts.length || row.options.length) out.push(row);
  }
  return out;
}

function shape(r, images) {
  let sections = [];
  try { sections = JSON.parse(r.sections_json || '[]'); } catch { sections = []; }
  return {
    id: r.id, code: r.code, title: r.title, forName: r.for_name || '', note: r.note || '',
    coverImageId: r.cover_image_id || '', sections, totalText: r.total_text || '',
    expiresAt: r.expires_at || null, sentCount: r.sent_count || 0, lastSentAt: r.last_sent_at || null,
    viewCount: r.view_count || 0, firstViewedAt: r.first_viewed_at || null, bookingId: r.booking_id || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    images: images || [],
  };
}

const imageList = (env, rows) => (rows || []).map((i) => ({ id: i.id, url: `${appUrl(env)}/pi/${encodeURIComponent(i.id)}` }));

async function load(env, user, id) {
  return env.DB.prepare('SELECT * FROM quick_proposals WHERE id = ? AND user_id = ?').bind(id, user.id).first();
}

async function loadImages(env, user, id) {
  const { results } = await env.DB.prepare(
    'SELECT id FROM quick_proposal_images WHERE proposal_id = ? AND user_id = ? ORDER BY created_at ASC'
  ).bind(id, user.id).all().catch(() => ({ results: [] }));
  return results || [];
}

/** GET /api/quick-proposals : the advisor's own, newest first. */
export async function handleListQuickProposals(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const { results } = await env.DB.prepare(
    `SELECT id, code, title, for_name, expires_at, sent_count, last_sent_at, view_count, first_viewed_at,
            booking_id, created_at, updated_at
       FROM quick_proposals WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`
  ).bind(user.id).all().catch(() => ({ results: [] }));
  const today = now();
  return json({
    proposals: (results || []).map((r) => ({
      id: r.id, title: r.title, forName: r.for_name || '', link: `${appUrl(env)}/p/${r.code}`,
      expired: Boolean(r.expires_at && r.expires_at < today), expiresAt: r.expires_at || null,
      sentCount: r.sent_count || 0, lastSentAt: r.last_sent_at || null,
      viewCount: r.view_count || 0, firstViewedAt: r.first_viewed_at || null,
      bookingId: r.booking_id || null, updatedAt: r.updated_at,
    })),
  });
}

/** POST /api/quick-proposals : a new, empty one, with its address, ready to be filled in. */
export async function handleCreateQuickProposal(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request).catch(() => ({}));
  const ts = now();
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO quick_proposals (id, user_id, code, title, for_name, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, newCode(), clean(body.title, 140) || 'New proposal', clean(body.forName, 120) || null,
    ts + 60 * 86400, ts, ts).run();
  return json({ ok: true, id }, 201);
}

/** GET /api/quick-proposals/:id */
export async function handleGetQuickProposal(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await load(env, user, id);
  if (!row) return notFound('That proposal is not here.');
  return json({
    proposal: shape(row, imageList(env, await loadImages(env, user, id))),
    link: `${appUrl(env)}/p/${row.code}`,
    storage: docsReady(env),
    kinds: SECTION_KINDS,
  });
}

/** PUT /api/quick-proposals/:id { title, forName, note, coverImageId, sections, totalText, expiresInDays } */
export async function handleSaveQuickProposal(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await load(env, user, id);
  if (!row) return notFound('That proposal is not here.');

  const body = await readJson(request);
  const title = clean(body.title, 140);
  if (!title) return badRequest('Give the proposal a title.');
  const own = new Set((await loadImages(env, user, id)).map((i) => i.id));
  const sections = sectionsOf(body.sections, own);
  const cover = own.has(body.coverImageId) ? body.coverImageId : null;

  let expiresAt = row.expires_at;
  if (body.expiresInDays !== undefined) {
    const days = Number(body.expiresInDays);
    if (!DAYS.includes(days)) return badRequest('Choose 30, 60, 90 or 180 days.');
    expiresAt = now() + days * 86400;
  }

  await env.DB.prepare(
    `UPDATE quick_proposals SET title = ?, for_name = ?, note = ?, cover_image_id = ?, sections_json = ?,
            total_text = ?, expires_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(title, clean(body.forName, 120) || null, cleanText(body.note, 3000) || null, cover,
    JSON.stringify(sections), clean(body.totalText, 120) || null, expiresAt, now(), id, user.id).run();
  return json({ ok: true, proposal: shape(await load(env, user, id), imageList(env, await loadImages(env, user, id))) });
}

async function removeImages(env, user, ids) {
  if (!ids.length || !docsReady(env)) return;
  for (const img of ids) {
    await env.DOCS.delete(img.r2_key).catch(() => {});
  }
}

/** DELETE /api/quick-proposals/:id : the proposal, its link and its pictures. */
export async function handleDeleteQuickProposal(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await load(env, user, id);
  if (!row) return notFound('That proposal is not here.');
  const { results } = await env.DB.prepare(
    'SELECT r2_key FROM quick_proposal_images WHERE proposal_id = ? AND user_id = ?'
  ).bind(id, user.id).all().catch(() => ({ results: [] }));
  await removeImages(env, user, results || []);
  await env.DB.prepare('DELETE FROM quick_proposal_images WHERE proposal_id = ? AND user_id = ?').bind(id, user.id).run();
  await env.DB.prepare('DELETE FROM quick_proposals WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return json({ ok: true });
}

/** POST /api/quick-proposals/:id/image : a multipart upload with the picture as "file". */
export async function handleUploadProposalImage(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await load(env, user, id);
  if (!row) return notFound('That proposal is not here.');
  if (!docsReady(env)) return badRequest('File storage is not set up yet, so a picture cannot be uploaded.');

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

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM quick_proposal_images WHERE proposal_id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if ((count && count.n) >= MAX_IMAGES) return badRequest(`A proposal holds ${MAX_IMAGES} pictures at most.`);

  const imageId = uid();
  const key = `${user.id}/proposals/${id}/${imageId}.${EXT[type]}`;
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare(
    `INSERT INTO quick_proposal_images (id, proposal_id, user_id, r2_key, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(imageId, id, user.id, key, bytes.length, now()).run();
  return json({ ok: true, id: imageId, url: `${appUrl(env)}/pi/${encodeURIComponent(imageId)}` }, 201);
}

/** DELETE /api/quick-proposals/:id/image/:imageId */
export async function handleRemoveProposalImage(request, env, id, imageId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const img = await env.DB.prepare(
    'SELECT r2_key FROM quick_proposal_images WHERE id = ? AND proposal_id = ? AND user_id = ?'
  ).bind(imageId, id, user.id).first();
  if (!img) return notFound('That picture is not here.');
  await removeImages(env, user, [img]);
  await env.DB.prepare('DELETE FROM quick_proposal_images WHERE id = ? AND proposal_id = ? AND user_id = ?')
    .bind(imageId, id, user.id).run();
  // Neither the cover nor a section may keep pointing at a picture that has gone.
  const row = await load(env, user, id);
  if (row) {
    let sections = [];
    try { sections = JSON.parse(row.sections_json || '[]'); } catch { sections = []; }
    sections = sections.map((s) => (s.imageId === imageId ? { ...s, imageId: '' } : s));
    await env.DB.prepare(
      'UPDATE quick_proposals SET sections_json = ?, cover_image_id = CASE WHEN cover_image_id = ? THEN NULL ELSE cover_image_id END WHERE id = ? AND user_id = ?'
    ).bind(JSON.stringify(sections), imageId, id, user.id).run();
  }
  return json({ ok: true });
}

/**
 * POST /api/quick-proposals/:id/send { to, name, message, copyToMe }
 *
 * The link, in an email from the portal that answers to the advisor. Nothing here saves anything to a
 * client record: the address is typed, used, and the count of times it was sent is all that is kept.
 */
export async function handleSendQuickProposal(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await load(env, user, id);
  if (!row) return notFound('That proposal is not here.');
  if (row.expires_at && row.expires_at < now()) return badRequest('This proposal has expired. Set a new expiry and save it first.');

  const body = await readJson(request);
  const to = clean(body.to, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return badRequest('Type the email address to send it to.');

  const brand = await brandForUser(env, user.id);
  const advisor = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
  const link = `${appUrl(env)}/p/${row.code}`;
  const args = {
    replyTo: user.notify_email || user.email, firstName: clean(body.name, 80) || (row.for_name || '').split(/\s+/)[0] || '',
    advisorName: advisor, title: row.title, message: cleanText(body.message, 2000), url: link, brand,
  };
  const out = await sendQuickProposalEmail(env, { to, ...args });
  if (!out || out.skipped) return badRequest('Email is not set up on this portal yet, so the link was not sent. You can copy the link and send it yourself.');
  if (out.ok === false) return badRequest('The email could not be sent. Check the address and try again.');
  if (body.copyToMe) await sendQuickProposalEmail(env, { to: user.notify_email || user.email, ...args, message: `Your copy.\n\n${args.message || ''}` });

  await env.DB.prepare('UPDATE quick_proposals SET sent_count = sent_count + 1, last_sent_at = ? WHERE id = ? AND user_id = ?')
    .bind(now(), id, user.id).run();
  await db.logActivity(env, user.id, 'proposal.sent', `Sent the proposal "${row.title}"`, { id });
  return json({ ok: true });
}

/**
 * POST /api/quick-proposals/:id/quote { clientName }
 *
 * The step where it touches the book: a quoted reservation in the client's name, with the proposal's words
 * kept in its notes so nothing typed is lost. The proposal stays, and says which reservation it became.
 */
export async function handleProposalToQuote(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await load(env, user, id);
  if (!row) return notFound('That proposal is not here.');
  if (row.booking_id) return json({ ok: true, bookingId: row.booking_id, already: true });

  const body = await readJson(request);
  const clientName = clean(body.clientName, 120) || clean(row.for_name, 120);
  if (!clientName) return badRequest('Who is the quote for? Type the client\'s name.');

  let sections = [];
  try { sections = JSON.parse(row.sections_json || '[]'); } catch { sections = []; }
  const notes = [
    `From the proposal "${row.title}"${row.total_text ? `, ${row.total_text}` : ''}.`,
    ...sections.flatMap((s) => [
      [s.heading, s.price ? `(${s.price})` : '', s.body].filter(Boolean).join(' '),
      ...(s.facts || []).map((f) => `  ${f.label}: ${f.value}`),
      ...(s.options || []).map((o) => `  ${o.pick ? 'Our pick: ' : ''}${[o.label, o.detail, o.price].filter(Boolean).join(', ')}`),
    ]),
  ].filter(Boolean).join('\n').slice(0, 3800);

  const clientId = await db.resolveClient(env, user.id, clientName, {});
  const booking = await db.createBooking(env, user.id, {
    clientName, clientId: clientId || null, productType: 'cruise', productName: row.title,
    departDate: null, returnDate: null, depositDue: null, finalPaymentDue: null, travellers: 1,
    grossCents: 0, commissionCents: 0, commissionStatus: 'pending', status: 'quoted',
    notes, insuranceStatus: 'unknown',
  });
  await env.DB.prepare('UPDATE quick_proposals SET booking_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(booking.id, now(), id, user.id).run();
  await db.logActivity(env, user.id, 'proposal.quote', `Turned the proposal "${row.title}" into a quote for ${clientName}`,
    { id, bookingId: booking.id });
  return json({ ok: true, bookingId: booking.id }, 201);
}

/** The housekeeping pass: a proposal goes a week after it expires, with its pictures. */
export async function purgeExpiredProposals(env) {
  const cutoff = now() - 7 * 86400;
  const { results } = await env.DB.prepare(
    `SELECT id, user_id FROM quick_proposals WHERE booking_id IS NULL AND expires_at IS NOT NULL AND expires_at < ? LIMIT 50`
  ).bind(cutoff).all().catch(() => ({ results: [] }));
  for (const p of results || []) {
    const { results: imgs } = await env.DB.prepare(
      'SELECT r2_key FROM quick_proposal_images WHERE proposal_id = ? AND user_id = ?'
    ).bind(p.id, p.user_id).all().catch(() => ({ results: [] }));
    if (docsReady(env)) for (const i of imgs || []) await env.DOCS.delete(i.r2_key).catch(() => {});
    await env.DB.prepare('DELETE FROM quick_proposal_images WHERE proposal_id = ? AND user_id = ?').bind(p.id, p.user_id).run();
    await env.DB.prepare('DELETE FROM quick_proposals WHERE id = ? AND user_id = ?').bind(p.id, p.user_id).run();
  }
  return { removed: (results || []).length };
}
