// What the suppliers are running, searchable by everyone.
//
// The weekly list arrives as a Word document. The agency owner uploads it, the
// portal reads the tables out of it, shows what it found, and only adds
// anything once they have looked. Every advisor can then search the lot from
// Marketing while they are on the phone with somebody.
//
// These are the agency's, not an advisor's, so the fence is agency_id. Reading is
// open to everybody in the agency; every write goes through requireAdmin, because
// a list that anyone can edit stops being the list the suppliers sent.
//
// An offer that appears again next week is the same offer. Rows are matched on
// brand, programme and the offer's own words, and a match is updated in place, so
// a deal that runs for a month is one row with a fresh date and not four.

import { json, badRequest, notFound, clean, cleanDate, uid, now, readJson } from './util.js';
import { requireUser, requireAdmin, isAdmin } from './auth.js';
import * as db from './db.js';
import { readSpecialsDocx, readSpecialsJson, matchKey, norm, promoId } from './specialsdoc.js';

// Built from a list so it is not read as the table's whole column set: it leaves
// out agency_id, added_by and match_key on purpose, which the page never needs.
const COLUMNS = [
  'id', 'list_id', 'first_list_id', 'category', 'brand', 'program', 'offer', 'window_text',
  'starts_on', 'ends_on', 'code', 'notes', 'vendor_id', 'created_at', 'updated_at',
  'headline', 'travel_period', 'link', 'featured',
].join(', ');

const MAX_UPLOAD = 6 * 1024 * 1024;
const MAX_ROWS = 400;
const CHUNK = 40;

// How suppliers are known in the directory against how a weekly list says them.
// Short, on purpose: it only has to bridge the abbreviations that lists use.
const ALIASES = {
  ncl: 'norwegian cruise line',
  'royal caribbean': 'royal caribbean international',
  celebrity: 'celebrity cruises',
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** The directory supplier a brand is, when exactly one of them is. */
function vendorFor(brand, vendors) {
  const want = norm(brand);
  if (!want) return null;
  const wanted = [want];
  if (ALIASES[want]) wanted.push(ALIASES[want]);

  const exact = vendors.filter((v) => wanted.includes(norm(v.name)));
  if (exact.length === 1) return exact[0].id;

  // "Royal Caribbean" against "Royal Caribbean International". Only a whole
  // leading word run, and only when it is unambiguous: a wrong link is worse
  // than none, and the supplier can always be set by hand.
  if (want.length >= 4) {
    const near = vendors.filter((v) => {
      const have = norm(v.name);
      return wanted.some((w) => have === w || have.startsWith(`${w} `) || w.startsWith(`${have} `));
    });
    if (near.length === 1) return near[0].id;
  }
  return null;
}

async function agencyVendors(env, user) {
  const scoped = db.scopeWhere(db.agencyScope(user), 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM vendors WHERE ${scoped.sql} LIMIT 2000`
  ).bind(...scoped.binds).all();
  return results || [];
}

async function existingRows(env, agencyId) {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM supplier_specials WHERE agency_id = ? LIMIT 6000`
  ).bind(agencyId).all();
  return results || [];
}

const FIELDS = [
  ['offer', 'offer'], ['window_text', 'windowText'], ['starts_on', 'startsOn'],
  ['ends_on', 'endsOn'], ['code', 'code'], ['notes', 'notes'],
  ['category', 'category'], ['program', 'program'],
  ['headline', 'headline'], ['travel_period', 'travelPeriod'], ['link', 'link'],
  ['featured', 'featured'],
];

/**
 * What makes a row the same offer next week.
 *
 * A promotion from the Travel Leaders Network has a number of its own, in its link,
 * and that is the one thing about it that does not change when somebody rewords the
 * headline. Anything else is known by its brand, programme and the offer's words.
 */
function keyFor(row) {
  const id = promoId(row.link);
  return id ? `tln:${id}` : matchKey(row.brand, row.program, row.offer);
}

/** The same offer as one already held: its words, or failing that its code. */
function findExisting(index, row) {
  const key = keyFor(row);
  if (index.byKey.has(key)) return index.byKey.get(key);
  // A weekly code is the offer's name. NCL's FLATOFF is worded a little
  // differently each week and is still one offer.
  if (row.code) return index.byCode.get(`${norm(row.brand)}|${row.code.toLowerCase()}`) || null;
  return null;
}

function indexOf(rows) {
  const byKey = new Map();
  const byCode = new Map();
  for (const r of rows) {
    // From the row's own fields, so a promotion known by the number in its link is found by it.
    byKey.set(keyFor(r), r);
    if (r.code) byCode.set(`${norm(r.brand)}|${r.code.toLowerCase()}`, r);
  }
  return { byKey, byCode };
}

function changesBetween(was, row) {
  return FIELDS.filter(([col, key]) => (was[col] || '') !== (row[key] || '')).map(([, key]) => key);
}

/** One uploaded or typed row, cleaned. */
function tidy(body) {
  const brand = clean(body.brand, 120);
  const offer = clean(body.offer, 800);
  // Kept exactly as given: the agent id in a TLN link is what credits the lead, and a
  // link that has been tidied is a link that may no longer carry it.
  const rawLink = String(body.link || '').trim();
  if (rawLink && !/^https?:\/\/\S+$/i.test(rawLink)) return { error: 'The link needs to be a web address starting with https://.' };
  if (!brand) return { error: 'Name the brand.' };
  if (!offer) return { error: 'Say what the offer is.' };

  const startsOn = cleanDate(body.startsOn);
  const endsOn = cleanDate(body.endsOn);
  if (startsOn && endsOn && endsOn < startsOn) return { error: 'The offer ends before it starts.' };

  return {
    row: {
      category: clean(body.category, 60) || 'Other',
      brand,
      program: clean(body.program, 120),
      offer,
      windowText: clean(body.windowText, 240),
      startsOn,
      endsOn,
      code: clean(body.code, 60) || null,
      notes: clean(body.notes, 800),
      headline: clean(body.headline, 160),
      travelPeriod: clean(body.travelPeriod, 160),
      link: rawLink ? rawLink.slice(0, 600) : null,
      featured: body.featured ? 1 : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function handleListSupplierSpecials(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const canEdit = isAdmin(user) && !user.acting_as;
  if (!user.agency_id) {
    return json({ specials: [], lists: [], today: today(), canEdit: false, latestListId: null });
  }

  const [rows, vendors, listed] = await Promise.all([
    existingRows(env, user.agency_id),
    agencyVendors(env, user),
    env.DB.prepare(
      `SELECT id, title, issued_on, intro, filename, added_count, updated_count, created_at
         FROM supplier_special_lists WHERE agency_id = ? ORDER BY created_at DESC LIMIT 12`
    ).bind(user.agency_id).all(),
  ]);

  // The link is only offered while the supplier still exists.
  const known = new Set(vendors.map((v) => v.id));
  const specials = rows.map((r) => ({ ...r, vendor_id: known.has(r.vendor_id) ? r.vendor_id : null }));
  const all = (listed.results || []);

  // The history of uploads, with the file names and how many each one added, is the
  // owner's, and not sent to anybody else. What everybody is told is when the list was
  // last updated: the newest date printed on anything uploaded, or the day it was
  // uploaded where it printed none.
  const lists = canEdit ? all : [];
  const dated = all.map((l) => l.issued_on || (l.created_at ? new Date(l.created_at * 1000).toISOString().slice(0, 10) : null))
    .filter(Boolean).sort();

  return json({
    specials,
    lists,
    listCount: all.length,
    updatedOn: dated.length ? dated[dated.length - 1] : null,
    latestListId: all.length ? all[0].id : null,
    today: today(),
    canEdit,
  });
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

/** Read the document and say what adding it would do. Nothing is saved. */
export async function handleReadSpecialsFile(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('Your account is not part of an agency yet.');

  const buf = await request.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength) return badRequest('No file arrived.');
  if (buf.byteLength > MAX_UPLOAD) return badRequest('That file is larger than 6MB, which is far more than a weekly list.');

  const name = clean(request.headers.get('X-Filename') || '', 160);
  const head = new TextDecoder().decode(new Uint8Array(buf).subarray(0, 40)).trimStart();
  const isJson = /\.json$/i.test(name) || (!name && /^[{[]/.test(head));
  if (name && !isJson && !/\.docx$/i.test(name)) {
    return badRequest('I can read the weekly Word document (.docx) and the Travel Leaders Network specials file (.json). Open a Word file in Word or Google Docs and save it as .docx, then upload that.');
  }

  let doc = null;
  try {
    doc = isJson ? readSpecialsJson(new TextDecoder().decode(buf)) : await readSpecialsDocx(buf);
  } catch (e) {
    console.error('readSpecials', e);
  }
  if (!doc) {
    return badRequest(isJson
      ? 'That does not look like the specials file I read. It should be a .json file with a list of specials.'
      : 'That does not look like a Word document I can open. Save it as .docx and try again.');
  }
  if (!doc.rows.length) {
    return badRequest(isJson
      ? 'There are no specials in that file.'
      : 'I could not find a table of offers in that document. It needs a table with a Brand column and an Offer column.');
  }
  if (doc.rows.length > MAX_ROWS) return badRequest(`That list has ${doc.rows.length} offers, which is more than one upload takes (${MAX_ROWS}).`);

  const [have, vendors] = await Promise.all([existingRows(env, user.agency_id), agencyVendors(env, user)]);
  const index = indexOf(have);

  const rows = doc.rows.map((r) => {
    const was = findExisting(index, r);
    const changes = was ? changesBetween(was, r) : [];
    return {
      ...r,
      status: !was ? 'new' : (changes.length ? 'changed' : 'same'),
      changes,
      vendorId: vendorFor(r.brand, vendors),
    };
  });

  const count = (s) => rows.filter((r) => r.status === s).length;
  return json({
    file: { name, title: doc.title, issuedOn: doc.issuedOn, intro: doc.intro },
    rows,
    skipped: doc.skipped,
    warnings: doc.warnings || [],
    counts: { total: rows.length, new: count('new'), changed: count('changed'), same: count('same') },
  });
}

/** Add what the preview showed. */
export async function handleImportSpecials(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('Your account is not part of an agency yet.');

  const body = await readJson(request);
  const incoming = Array.isArray(body.rows) ? body.rows : [];
  if (!incoming.length) return badRequest('There is nothing to add.');
  if (incoming.length > MAX_ROWS) return badRequest(`That is more than one upload takes (${MAX_ROWS}).`);

  const rows = [];
  for (const raw of incoming) {
    const { row, error } = tidy(raw || {});
    if (error) return badRequest(`${error} (${clean(raw && raw.brand, 60) || 'a row with no brand'})`);
    rows.push(row);
  }

  const agencyId = user.agency_id;
  const [have, vendors] = await Promise.all([existingRows(env, agencyId), agencyVendors(env, user)]);
  const index = indexOf(have);

  const listId = uid();
  const ts = now();
  const statements = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of rows) {
    const was = findExisting(index, row);
    const vendorId = vendorFor(row.brand, vendors);
    if (was) {
      const changes = changesBetween(was, row);
      if (changes.length) updated += 1; else unchanged += 1;
      statements.push(env.DB.prepare(
        `UPDATE supplier_specials SET category = ?, program = ?, offer = ?, window_text = ?,
                starts_on = ?, ends_on = ?, code = ?, notes = ?, vendor_id = COALESCE(?, vendor_id),
                headline = ?, travel_period = ?, link = ?, featured = ?,
                list_id = ?, updated_at = ?
          WHERE id = ? AND agency_id = ?`
      ).bind(row.category, row.program || null, row.offer, row.windowText || null,
             row.startsOn, row.endsOn, row.code, row.notes || null, vendorId,
             row.headline || null, row.travelPeriod || null, row.link, row.featured,
             listId, ts, was.id, agencyId));
      continue;
    }

    const id = uid();
    const key = keyFor(row);
    added += 1;
    statements.push(env.DB.prepare(
      `INSERT INTO supplier_specials (id, agency_id, added_by, list_id, first_list_id, category,
         brand, program, offer, window_text, starts_on, ends_on, code, notes, vendor_id,
         match_key, headline, travel_period, link, featured, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, agencyId, user.id, listId, listId, row.category, row.brand, row.program || null,
           row.offer, row.windowText || null, row.startsOn, row.endsOn, row.code,
           row.notes || null, vendorId, key, row.headline || null, row.travelPeriod || null,
           row.link, row.featured, ts, ts));
    // So the same offer twice in one document is added once.
    index.byKey.set(key, { id, ...row, window_text: row.windowText, starts_on: row.startsOn, ends_on: row.endsOn });
  }

  await env.DB.prepare(
    `INSERT INTO supplier_special_lists (id, agency_id, added_by, title, issued_on, intro, filename,
       added_count, updated_count, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(listId, agencyId, user.id, clean(body.title, 160) || null, cleanDate(body.issuedOn),
         clean(body.intro, 1200) || null, clean(body.filename, 160) || null, added, updated, ts).run();

  for (let i = 0; i < statements.length; i += CHUNK) {
    await env.DB.batch(statements.slice(i, i + CHUNK));
  }

  await db.logActivity(env, user.id, 'supplier_specials.import',
    `Uploaded the supplier specials list: ${added} new, ${updated} updated`, { listId });
  return json({ ok: true, listId, added, updated, unchanged }, 201);
}

/** Take a whole upload back out: the offers it added, and the record of it. */
export async function handleUndoSpecialsList(request, env, listId) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('Your account is not part of an agency yet.');

  const list = await env.DB.prepare(
    'SELECT id FROM supplier_special_lists WHERE id = ? AND agency_id = ?'
  ).bind(listId, user.agency_id).first();
  if (!list) return notFound('That upload was not found.');

  const gone = await env.DB.prepare(
    'DELETE FROM supplier_specials WHERE first_list_id = ? AND agency_id = ?'
  ).bind(listId, user.agency_id).run();
  await env.DB.prepare('DELETE FROM supplier_special_lists WHERE id = ? AND agency_id = ?')
    .bind(listId, user.agency_id).run();

  await db.logActivity(env, user.id, 'supplier_specials.undo',
    'Took back a supplier specials upload', { listId });
  return json({ ok: true, removed: (gone.meta && gone.meta.changes) || 0 });
}

// ---------------------------------------------------------------------------
// One offer
// ---------------------------------------------------------------------------

export async function handleSaveSupplierSpecial(request, env, id) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('Your account is not part of an agency yet.');

  const { row, error } = tidy(await readJson(request));
  if (error) return badRequest(error);

  const vendors = await agencyVendors(env, user);
  const vendorId = vendorFor(row.brand, vendors);
  const key = keyFor(row);
  const ts = now();

  if (!id) {
    const made = uid();
    await env.DB.prepare(
      `INSERT INTO supplier_specials (id, agency_id, added_by, category, brand, program, offer,
         window_text, starts_on, ends_on, code, notes, vendor_id, match_key, headline,
         travel_period, link, featured, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(made, user.agency_id, user.id, row.category, row.brand, row.program || null, row.offer,
           row.windowText || null, row.startsOn, row.endsOn, row.code, row.notes || null,
           vendorId, key, row.headline || null, row.travelPeriod || null, row.link, row.featured,
           ts, ts).run();
    return json({ ok: true, id: made }, 201);
  }

  const res = await env.DB.prepare(
    `UPDATE supplier_specials SET category = ?, brand = ?, program = ?, offer = ?, window_text = ?,
            starts_on = ?, ends_on = ?, code = ?, notes = ?, vendor_id = ?, match_key = ?,
            headline = ?, travel_period = ?, link = ?, featured = ?, updated_at = ?
      WHERE id = ? AND agency_id = ?`
  ).bind(row.category, row.brand, row.program || null, row.offer, row.windowText || null,
         row.startsOn, row.endsOn, row.code, row.notes || null, vendorId, key,
         row.headline || null, row.travelPeriod || null, row.link, row.featured, ts,
         id, user.agency_id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That offer was not found.');
  return json({ ok: true, id });
}

export async function handleDeleteSupplierSpecial(request, env, id) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('Your account is not part of an agency yet.');

  const res = await env.DB.prepare('DELETE FROM supplier_specials WHERE id = ? AND agency_id = ?')
    .bind(id, user.agency_id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That offer was not found.');
  return json({ ok: true });
}
