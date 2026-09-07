// Vendors, and the terms they trade on.
//
// Two jobs. The first is spelling: a vendor typed three ways is three vendors
// to every report that groups by the name, and merging them is the only way to
// make those reports true. The second is terms. Every vendor has a rule for
// when the balance falls due, and holding it here turns a reservation with no
// final payment date from a guess into an answer.

import { json, badRequest, notFound, clean, cleanText, uid, now, readJson } from './util.js';
import { requireUser, requireAdmin } from './auth.js';
import * as db from './db.js';

const COLUMNS = `
  v.id, v.user_id, v.name, v.final_days, v.deposit_days, v.commission_pct,
  v.phone, v.email, v.portal_url, v.notes, v.created_at, v.updated_at,
  v.category, v.favourite, v.bdm_name, v.bdm_email, v.bdm_phone,
  v.signup_url, v.website, v.account_number,
  v.phones_json, v.commission_structure, v.registration_instructions,
  v.partner_status, v.travel_types, v.budget_category, v.booking_instructions,
  v.bdm_info, v.vendor_login, v.categories_json
`;

// The shelves a directory of suppliers falls into. Fixed, because a free text
// category becomes "Cruise", "Cruises" and "Cruise Line" within a fortnight,
// which is the same mess vendors were created to end. Anything unrecognised
// lands in Other rather than being refused.
// High enough that no real book reaches it, low enough to stay one quick
// query. Reported rather than silently applied when it does bite.
const LIST_CAP = 2000;

// Named the way the Cruise Planners partner hub names them, so a list pasted
// out of that page lands on the right shelf instead of arriving as Other.
export const CATEGORIES = [
  'Cruise Lines',
  'River Cruises',
  'Expedition Experiences & Yacht',
  'Package Providers',
  'All-Inclusive Resorts',
  'All-Inclusive Brands',
  'Escorted Tours',
  'FIT',
  'Hotels & Resorts',
  'Rentals & Villas',
  'Air Consolidator',
  'Car & Transfer Services',
  'Rail Vacations',
  'Attractions',
  'Excursions',
  'Value Add & Other',
  'Tourism Boards',
  'Other',
];

// The heading a supplier list uses for the ones already starred, rather than
// for a kind of supplier. Treated as the star it is, not as a shelf.
const FAVOURITES_HEADING = 'favorite suppliers';

// Not suppliers anybody sells. The partner directory lists a hundred and ten
// of them, which would have been a third of the whole list and none of it
// useful, so they are dropped on the way in rather than imported and tidied
// up afterwards.
const SKIP_CATEGORIES = new Set(['tourism boards']);

/**
 * The vendor record for a name, made if it is new.
 *
 * Looks across the agency before making one. This is where duplicates were
 * born: an advisor booking "Carnival Cruise Line" got a second record because
 * the first belonged to somebody else, and the agency ended up with one row
 * per advisor per supplier, each with a different half of the details filled
 * in. Matched case-insensitively for the same reason.
 */
export async function resolveVendor(env, userId, name) {
  const value = String(name || '').trim().slice(0, 120);
  if (!value) return null;

  const mine = `(SELECT id FROM users WHERE agency_id =
                  (SELECT agency_id FROM users WHERE id = ?) AND agency_id IS NOT NULL)`;
  const find = async () => env.DB.prepare(
    `SELECT id FROM vendors
      WHERE LOWER(name) = LOWER(?) AND (user_id = ? OR user_id IN ${mine})
      ORDER BY created_at ASC LIMIT 1`
  ).bind(value, userId, userId).first();

  const existing = await find();
  if (existing) return existing.id;

  const ts = now();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO vendors (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(uid(), userId, value, ts, ts).run();

  const row = await find();
  return row ? row.id : null;
}

export async function handleListVendors(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // The agency's, not the reader's. An associate used to open this on an empty
  // screen while the rates and the desk contacts sat on the owner's copy.
  const scope = db.agencyScope(user);
  const scoped = db.scopeWhere(scope, 'v.user_id');

  // Narrowing the directory rather than paging it. The page filters what it
  // was given, which is right until the book outgrows the cap: past that the
  // supplier you are looking for can be missing from the answer entirely, and
  // filtering an incomplete list looks exactly like not having the vendor.
  const q = clean(new URL(request.url).searchParams.get('q'), 120);
  // Appended to the scope clause rather than folded into a list of conditions.
  // The scope checker reads this file as text and looks for the user predicate
  // in the query it can see; building the WHERE out of an array hid it, and a
  // check that cannot see the predicate is right to complain.
  const narrow = q ? ' AND v.name LIKE ?' : '';
  const binds = q ? [...scoped.binds, `%${q}%`] : [...scoped.binds];

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM bookings b WHERE b.vendor_id = v.id
              AND b.status IN ('booked','travelled')) AS trips,
            (SELECT COALESCE(SUM(b.gross_cents), 0) FROM bookings b WHERE b.vendor_id = v.id
              AND b.status IN ('booked','travelled')) AS gross_cents,
            (SELECT COALESCE(SUM(b.commission_cents), 0) FROM bookings b WHERE b.vendor_id = v.id
              AND b.status IN ('booked','travelled')) AS commission_cents,
            (SELECT COUNT(*) FROM bookings b WHERE b.vendor_id = v.id
              AND b.status IN ('quoted','booked') AND b.final_payment_due IS NULL) AS undated
       FROM vendors v
      WHERE ${scoped.sql}${narrow}
      ORDER BY gross_cents DESC, v.name ASC LIMIT ?`
    // One over the cap, so a truncated list can be reported as truncated. This
    // page is a directory: it is supposed to list everything, and a silent cut
    // meant a vendor could be added and simply not appear. Found by adding one.
  ).bind(...binds, LIST_CAP + 1).all();

  const all = results || [];
  const truncated = all.length > LIST_CAP;
  const vendors = truncated ? all.slice(0, LIST_CAP) : all;

  return json({
    vendors,
    categories: CATEGORIES,
    truncated,
    query: q || null,
    stats: {
      total: vendors.length,
      favourites: vendors.filter((v) => v.favourite).length,
      withTerms: vendors.filter((v) => v.final_days).length,
      unused: vendors.filter((v) => !v.trips).length,
      // Names that look like the same vendor written differently. Suggested
      // rather than merged: "Celebrity Cruises" and "Celebrity Cruises Ocean"
      // may be one vendor or two, and only the advisor knows.
      // Only the caller's own, and only within one advisor. An owner viewing
      // the agency sees two advisors' "Carnival" as two rows, which is right:
      // they are two records, and merging is scoped to the owner of them.
      // Across the agency, because that is where the duplicates are: the same
      // supplier entered by two people is the case worth catching.
      possibleDuplicates: findDuplicates(vendors),
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * Names that differ only by punctuation, case, or one being a prefix.
 *
 * Callers pass one advisor's vendors. Grouping across advisors would offer a
 * merge that cannot happen, since the merge is scoped to the owner of the
 * records and would quietly move nothing.
 */
function findDuplicates(vendors) {
  const key = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const groups = [];
  const used = new Set();

  for (let i = 0; i < vendors.length; i++) {
    if (used.has(vendors[i].id)) continue;
    const a = key(vendors[i].name);
    const group = [vendors[i]];
    for (let j = i + 1; j < vendors.length; j++) {
      if (used.has(vendors[j].id)) continue;
      const b = key(vendors[j].name);
      if (!a || !b) continue;
      if (a === b || a.startsWith(b) || b.startsWith(a)) {
        group.push(vendors[j]);
        used.add(vendors[j].id);
      }
    }
    if (group.length > 1) {
      used.add(vendors[i].id);
      groups.push(group.map((v) => ({ id: v.id, name: v.name, trips: v.trips })));
    }
  }
  return groups;
}

/**
 * The editable fields, read once so create and update cannot disagree.
 *
 * Two parsers for one form is how a field ends up saving on edit and silently
 * dropping on create, which is the same class of bug as two column lists.
 */
function parseVendor(body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'A vendor needs a name.' };

  const num = (v, max) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };

  // Only http and https, and only when it parses. A link in a directory is
  // clicked without being read, so a javascript: URL saved here would be a
  // script the advisor runs on themselves.
  const link = (v) => (/^https?:\/\//i.test(String(v || '')) ? clean(v, 300) : null);

  // Suppliers have several numbers: reservations, groups, after hours. Kept as
  // a list so each one stays dialable, capped so a runaway form cannot store a
  // thousand of them.
  const phones = (Array.isArray(body.phones) ? body.phones : [])
    .map((x) => ({ label: clean(x?.label, 40) || '', number: clean(x?.number, 40) || '' }))
    .filter((x) => x.number)
    .slice(0, 12);

  return {
    fields: {
      name,
      finalDays: num(body.finalDays, 730),
      depositDays: num(body.depositDays, 365),
      commissionPct: num(body.commissionPct, 100),
      phone: clean(body.phone, 40) || null,
      email: clean(body.email, 160) || null,
      portalUrl: link(body.portalUrl),
      website: link(body.website),
      signupUrl: link(body.signupUrl),
      notes: cleanText(body.notes, 2000) || null,
      category: CATEGORIES.includes(String(body.category)) ? String(body.category) : null,
      bdmName: clean(body.bdmName, 120) || null,
      bdmEmail: clean(body.bdmEmail, 160) || null,
      bdmPhone: clean(body.bdmPhone, 40) || null,
      accountNumber: clean(body.accountNumber, 60) || null,
      phonesJson: phones.length ? JSON.stringify(phones) : null,
      commissionStructure: cleanText(body.commissionStructure, 4000) || null,
      registrationInstructions: cleanText(body.registrationInstructions, 4000) || null,
      bookingInstructions: cleanText(body.bookingInstructions, 4000) || null,
    },
  };
}

/**
 * Read a supplier list pasted out of a partner directory.
 *
 * The shape those pages come in is a category heading followed by the names
 * under it, which is what you get by selecting the page and copying. So that
 * is the format this reads, rather than asking somebody to reformat 370 lines
 * into a spreadsheet first. A "Name, Category" line works too.
 *
 * Suppliers appear under several headings on those pages: Abercrombie & Kent
 * sells escorted tours and independent travel both. A vendor here has one
 * category, so the first heading wins and the repeat is reported rather than
 * silently dropped or made into a second row.
 */
export function parseVendorList(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const byLower = new Map(CATEGORIES.map((c) => [c.toLowerCase(), c]));

  // Only an exact category name is a heading. The first version of this
  // guessed, on the theory that a short line without punctuation was probably
  // a section title, and read "Azamara" and "Collette" as headings: most
  // supplier names look exactly like that. A supplier list whose headings we
  // do not recognise puts its names under the previous heading, which is
  // visible and fixable, where a guess is neither.
  const found = [];
  const seen = new Map();
  const alsoListed = [];
  const duplicates = [];
  const unknownHeadings = [];
  let category = null;
  let starring = false;
  let skipping = false;
  let skipped = 0;

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower === FAVOURITES_HEADING) { starring = true; category = null; skipping = false; continue; }
    if (SKIP_CATEGORIES.has(lower)) { skipping = true; category = null; starring = false; continue; }
    if (byLower.has(lower)) { category = byLower.get(lower); starring = false; skipping = false; continue; }
    if (skipping) { skipped += 1; continue; }

    // "Name, Category" for a hand-made list.
    let name = line;
    let rowCategory = category;
    const comma = line.lastIndexOf(',');
    if (comma > 0) {
      const tail = line.slice(comma + 1).trim().toLowerCase();
      if (byLower.has(tail)) {
        name = line.slice(0, comma).trim();
        rowCategory = byLower.get(tail);
      }
    }

    name = clean(name, 120);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) {
      const first = seen.get(key);
      // The favourites list comes first on these pages and carries no
      // category, so the real shelf arrives on the second sighting. Taking
      // only the first left every starred supplier uncategorised.
      if (starring) first.favourite = true;
      if (rowCategory && !first.categories.includes(rowCategory)) {
        // Listed under another heading as well. Both shelves are true, so it
        // gets both rather than the page's second mention being thrown away.
        first.categories.push(rowCategory);
        if (!first.category) first.category = rowCategory;
        alsoListed.push({ name, category: rowCategory });
      }
      continue;
    }

    const row = {
      name, category: rowCategory, favourite: starring,
      categories: rowCategory ? [rowCategory] : [],
    };
    seen.set(key, row);
    found.push(row);
  }

  return {
    vendors: found, duplicates, alsoListed, skipped,
    unknownHeadings: [...new Set(unknownHeadings)],
  };
}

/**
 * The handful of HTML entities a directory export leaves in its text.
 *
 * These fields were written in a rich text box and exported as they were
 * stored, so a booking instruction arrives reading "your number &amp; theirs"
 * and a paragraph of spacing arrives as a run of &nbsp;. Left alone they show
 * up literally on the vendor's page.
 */
function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, ', ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * A row out of a partner directory export, as opposed to a pasted page.
 *
 * The export carries what the web page does not: how to place a booking, the
 * agency's standing with the supplier, their login details, and the sales
 * desk numbers with the name of each desk against them.
 */
export function parseVendorRow(raw) {
  const name = clean(decodeEntities(raw.name), 120);
  if (!name) return null;

  const text = (v, max = 4000) => cleanText(decodeEntities(v), max) || null;

  // "CP Star Desk: 1-877-202-1530" a line at a time. A desk with a name
  // against it is worth more than a wall of numbers, which is what these
  // become when they are pasted into one field.
  const phones = [];
  for (const line of decodeEntities(raw.contacts).split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]{1,40}?)\s*:\s*(.+?)\s*$/);
    if (m && /\d/.test(m[2])) phones.push({ label: clean(m[1], 40), number: clean(m[2], 40) });
    else if (/^\s*[\d(+][\d\s()+.-]{6,}$/.test(line)) phones.push({ label: '', number: clean(line.trim(), 40) });
    if (phones.length >= 12) break;
  }

  // The manager's block is free text and sometimes a whole signature with a
  // postal address in it, so the parts are picked out and the original kept.
  const bdm = decodeEntities(raw.bdm);
  const email = bdm.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const phone = bdm.match(/(?:\+?\d[\d\s().-]{8,}\d)/);
  // These read "Andrea Loyola - BDM - Southeast Region", so the name is what
  // comes before the job title rather than the whole line.
  const bdmName = bdm.split(/\r?\n/)
    .map((l) => l.trim().split(/\s+[-\u2013,|]\s+/)[0].trim())
    .find((l) => l && !/[@\d]/.test(l) && l.split(/\s+/).length <= 4
      && !/^(bdm|business development|cell|phone|email|office)/i.test(l)
      // The supplier's own name appears in these blocks as the company line,
      // and it is not the name of a person to ring.
      && l.toLowerCase() !== name.toLowerCase());

  // Every category the supplier is listed under, not just the first. Keeping
  // one meant Celebrity Cruises appeared under Cruise Lines and nowhere near
  // Expedition Experiences, which is half of what it sells.
  const listed = decodeEntities(raw.category).split(',')
    .map((c) => c.trim())
    .filter((c) => CATEGORIES.includes(c));
  const category = listed[0] || '';

  return {
    name,
    category: category || null,
    categories: listed,
    // Skipped on the first listing, since that is the shelf the directory
    // considers it to be on.
    skip: SKIP_CATEGORIES.has(decodeEntities(raw.category).split(',')[0].trim().toLowerCase()),
    favourite: Boolean(raw.favourite),
    partnerStatus: text(raw.status, 60),
    travelTypes: text(raw.travelTypes, 200),
    budgetCategory: text(raw.budget, 100),
    commissionStructure: text(raw.commission),
    bookingInstructions: text(raw.bookingInstructions),
    registrationInstructions: text(raw.registrationInstructions),
    bdmInfo: text(raw.bdm),
    bdmName: bdmName ? clean(bdmName, 120) : null,
    bdmPhone: phone ? clean(phone[0].trim(), 40) : null,
    bdmEmail: email ? clean(email[0], 160) : null,
    vendorLogin: text(raw.login, 1000),
    notes: text(raw.notes, 2000),
    phonesJson: phones.length ? JSON.stringify(phones) : null,
  };
}

export async function handleImportVendors(request, env) {
  // Admin only. Bringing in a supplier directory writes several hundred rows
  // in one go, and the enforcement is here rather than only on the button:
  // hiding a control does not stop the request it would have sent.
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  const body = await readJson(request);

  // Two ways in. A pasted directory page gives names and headings; an export
  // gives a row per supplier with everything on it. Same endpoint, because
  // what happens afterwards is identical.
  const fromRows = Array.isArray(body.rows);
  let parsed;
  if (fromRows) {
    const rows = body.rows.slice(0, 2000).map(parseVendorRow).filter(Boolean);
    parsed = {
      vendors: rows.filter((r) => !r.skip),
      duplicates: [],
      skipped: rows.filter((r) => r.skip).length,
      unknownHeadings: [],
    };
  } else {
    parsed = parseVendorList(body.text);
  }
  if (!parsed.vendors.length) return badRequest('Nothing in that looks like a supplier list.');

  // What is already on the books, so a second paste tops up rather than
  // failing on every line.
  const { results: existing } = await env.DB.prepare(
    'SELECT id, name, category, favourite FROM vendors WHERE user_id = ?'
  ).bind(user.id).all();
  const have = new Map((existing || []).map((v) => [v.name.toLowerCase(), v]));

  const toAdd = parsed.vendors.filter((v) => !have.has(v.name.toLowerCase()));
  // A row import carries real detail, so it refreshes what it brought. A
  // pasted page carries only a name and a heading, so it fills gaps and
  // overrules nothing: a category or star set here was somebody's decision.
  const toUpdate = parsed.vendors.filter((v) => {
    const cur = have.get(v.name.toLowerCase());
    if (!cur) return false;
    if (fromRows) return true;
    if (v.categories?.length > 1) return true;
    return (v.category && !cur.category) || (v.favourite && !cur.favourite);
  });

  if (!body.commit) {
    return json({
      preview: true,
      add: toAdd.length,
      update: toUpdate.length,
      unchanged: parsed.vendors.length - toAdd.length - toUpdate.length,
      duplicates: parsed.duplicates.slice(0, 40),
      duplicateCount: parsed.duplicates.length,
      skipped: parsed.skipped || 0,
      unknownHeadings: parsed.unknownHeadings,
      byCategory: countByCategory(parsed.vendors),
      sample: toAdd.slice(0, 12),
    });
  }

  const ts = now();
  const writes = [];
  for (const v of toAdd) {
    writes.push(fromRows
      ? env.DB.prepare(
        `INSERT INTO vendors
           (id, user_id, name, category, categories_json, favourite, partner_status,
            travel_types, budget_category, commission_structure, booking_instructions,
            registration_instructions, bdm_info, bdm_name, bdm_phone, bdm_email,
            vendor_login, notes, phones_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uid(), user.id, v.name, v.category,
             v.categories?.length ? JSON.stringify(v.categories) : null,
             v.favourite ? 1 : 0,
             v.partnerStatus, v.travelTypes, v.budgetCategory, v.commissionStructure,
             v.bookingInstructions, v.registrationInstructions, v.bdmInfo,
             v.bdmName, v.bdmPhone, v.bdmEmail, v.vendorLogin, v.notes,
             v.phonesJson, ts, ts)
      : env.DB.prepare(
        `INSERT INTO vendors
           (id, user_id, name, category, categories_json, favourite, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uid(), user.id, v.name, v.category,
             v.categories?.length ? JSON.stringify(v.categories) : null,
             v.favourite ? 1 : 0, ts, ts));
  }
  for (const v of toUpdate) {
    const cur = have.get(v.name.toLowerCase());
    writes.push(fromRows
      ? env.DB.prepare(
        `UPDATE vendors SET
           category = COALESCE(?, category), categories_json = COALESCE(?, categories_json),
           partner_status = ?, travel_types = ?,
           budget_category = ?, commission_structure = ?, booking_instructions = ?,
           registration_instructions = ?, bdm_info = ?, bdm_name = ?, bdm_phone = ?,
           bdm_email = ?, vendor_login = ?, notes = ?, phones_json = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`
      ).bind(v.category, v.categories?.length ? JSON.stringify(v.categories) : null,
             v.partnerStatus, v.travelTypes, v.budgetCategory,
             v.commissionStructure, v.bookingInstructions, v.registrationInstructions,
             v.bdmInfo, v.bdmName, v.bdmPhone, v.bdmEmail, v.vendorLogin, v.notes,
             v.phonesJson, ts, cur.id, user.id)
      : env.DB.prepare(
        `UPDATE vendors SET category = ?, categories_json = COALESCE(?, categories_json),
           favourite = ?, updated_at = ? WHERE id = ? AND user_id = ?`
      ).bind(cur.category || v.category,
             v.categories?.length ? JSON.stringify(v.categories) : null,
             (cur.favourite || v.favourite) ? 1 : 0, ts, cur.id, user.id));
  }

  // In batches, because a partner directory is several hundred rows and one
  // statement per round trip would take longer than the request is allowed.
  for (let i = 0; i < writes.length; i += 50) {
    await env.DB.batch(writes.slice(i, i + 50));
  }

  await db.logActivity(env, user.id, 'vendor.import',
    `Imported ${toAdd.length} vendor${toAdd.length === 1 ? '' : 's'}`,
    { added: toAdd.length, updated: toUpdate.length });

  return json({ ok: true, added: toAdd.length, updated: toUpdate.length,
                skipped: parsed.skipped || 0 });
}

function countByCategory(rows) {
  const out = {};
  for (const r of rows) {
    const k = r.category || 'Other';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** One vendor, with the trips sold under it. */
export async function handleGetVendor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.agencyScope(user);
  const scoped = db.scopeWhere(scope, 'v.user_id');

  const vendor = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM vendors v WHERE ${scoped.sql} AND v.id = ?`
  ).bind(...scoped.binds, id).first();
  if (!vendor) return notFound('Vendor not found.');

  // The reservations are the reason the record is worth opening: what has
  // actually been sold through this supplier, and what is still to come.
  // Everything the agency has sold through this supplier, not only the trips
  // of whoever happened to type the record in. On a shared directory those are
  // rarely the same person, and "what have we done with Carnival" is the
  // question the page is open to answer.
  const bookingScope = db.scopeWhere(scope, 'b.user_id');
  const { results: bookings } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.product_name, b.depart_date, b.return_date,
            b.status, b.gross_cents, b.commission_cents, b.confirmation_number
       FROM bookings b
      WHERE ${bookingScope.sql} AND b.vendor_id = ?
      ORDER BY COALESCE(b.depart_date, '9999-12-31') DESC
      LIMIT 100`
  ).bind(...bookingScope.binds, id).all();

  const trips = bookings || [];
  const counted = trips.filter((b) => b.status === 'booked' || b.status === 'travelled');

  return json({
    vendor,
    categories: CATEGORIES,
    bookings: trips,
    // Anybody in the agency. The directory is shared, so the rate somebody
    // renegotiates is a correction for everyone rather than a note on a copy.
    canEdit: Boolean(user.agency_id) || vendor.user_id === user.id,
    totals: {
      trips: counted.length,
      grossCents: counted.reduce((n, b) => n + (b.gross_cents || 0), 0),
      commissionCents: counted.reduce((n, b) => n + (b.commission_cents || 0), 0),
    },
  });
}

/** Add a vendor by hand, rather than waiting to book one. */
export async function handleCreateVendor(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const { fields, error } = parseVendor(body);
  if (error) return badRequest(error);

  // A vendor typed twice is the duplicate this table exists to prevent, and
  // the second copy is usually somebody else's rather than your own. Answered
  // as a message rather than a constraint violation.
  const dupScope = db.scopeWhere(db.agencyScope(user), 'user_id');
  const clash = await env.DB.prepare(
    `SELECT id FROM vendors WHERE ${dupScope.sql} AND LOWER(name) = LOWER(?)`
  ).bind(...dupScope.binds, fields.name).first();
  if (clash) {
    return badRequest(`There is already a vendor called ${fields.name}. Open it and add to it.`);
  }

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO vendors
       (id, user_id, name, final_days, deposit_days, commission_pct, phone, email,
        portal_url, notes, category, bdm_name, bdm_email, bdm_phone, signup_url,
        website, account_number, phones_json, commission_structure,
        registration_instructions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.name, fields.finalDays, fields.depositDays,
         fields.commissionPct, fields.phone, fields.email, fields.portalUrl,
         fields.notes, fields.category, fields.bdmName, fields.bdmEmail,
         fields.bdmPhone, fields.signupUrl, fields.website, fields.accountNumber,
         fields.phonesJson, fields.commissionStructure,
         fields.registrationInstructions, ts, ts).run();

  return json({ ok: true, id });
}

/**
 * Remove a vendor, leaving its reservations alone.
 *
 * The trips keep the supplier name they were sold under, because that is what
 * the client's confirmation says and what every report groups by. Only the
 * link is cut. Deleting the reservations along with the directory entry would
 * destroy real bookings to tidy up a list.
 */
export async function handleDeleteVendor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Agency wide, both of them. A shared directory entry is pointed at by other
  // people's reservations, and cutting the record while leaving their vendor_id
  // dangling is worse than not deleting it at all.
  const scoped = db.scopeWhere(db.agencyScope(user), 'user_id');
  await env.DB.prepare(
    `UPDATE bookings SET vendor_id = NULL WHERE vendor_id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).run();

  const res = await env.DB.prepare(
    `DELETE FROM vendors WHERE id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).run();

  if (!res.meta || res.meta.changes === 0) return notFound('Vendor not found.');
  return json({ ok: true });
}

export async function handleUpdateVendor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const { fields, error } = parseVendor(body);
  if (error) return badRequest(error);
  const name = fields.name;

  // Anybody in the agency edits the agency's directory. A rate somebody
  // renegotiates is a correction for everyone, not a note on their own copy.
  const vScope = db.scopeWhere(db.agencyScope(user), 'user_id');

  const res = await env.DB.prepare(
    `UPDATE vendors SET name = ?, final_days = ?, deposit_days = ?, commission_pct = ?,
       phone = ?, email = ?, portal_url = ?, notes = ?, category = ?,
       bdm_name = ?, bdm_email = ?, bdm_phone = ?, signup_url = ?, website = ?,
       account_number = ?, phones_json = ?, commission_structure = ?,
       registration_instructions = ?, booking_instructions = ?, updated_at = ?
     WHERE id = ? AND ${vScope.sql}`
    // favourite is deliberately absent. It has its own endpoint, and writing
    // it here from a form that has no star field cleared the star every time
    // a vendor was edited.
  ).bind(name, fields.finalDays, fields.depositDays, fields.commissionPct,
         fields.phone, fields.email, fields.portalUrl, fields.notes,
         fields.category, fields.bdmName, fields.bdmEmail, fields.bdmPhone,
         fields.signupUrl, fields.website, fields.accountNumber,
         fields.phonesJson, fields.commissionStructure,
         fields.registrationInstructions, fields.bookingInstructions,
         now(), id, ...vScope.binds).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Vendor not found.');

  // The name is what every report groups by and what a vendor prints on a
  // confirmation, so renaming has to carry the reservations with it.
  // Not caught, because the line above says it has to happen: a rename that
  // reaches the vendor and not its reservations splits every report that
  // groups by the name, which is the thing vendors exist to prevent.
  const bScope = db.scopeWhere(db.agencyScope(user), 'user_id');
  await env.DB.prepare(`UPDATE bookings SET supplier = ? WHERE vendor_id = ? AND ${bScope.sql}`)
    .bind(name, id, ...bScope.binds).run();

  return json({ ok: true });
}

/**
 * Star or unstar a vendor.
 *
 * Its own endpoint rather than a field on the full save, because starring is
 * one click on a directory of two hundred suppliers and sending the whole
 * record back to toggle a flag would let a stale form overwrite the rest of it.
 */
export async function handleFavouriteVendor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const starScope = db.scopeWhere(db.agencyScope(user), 'user_id');
  const res = await env.DB.prepare(
    `UPDATE vendors SET favourite = ?, updated_at = ? WHERE id = ? AND ${starScope.sql}`
  ).bind(body.favourite ? 1 : 0, now(), id, ...starScope.binds).run();

  if (!res.meta || res.meta.changes === 0) return notFound('Vendor not found.');
  return json({ ok: true, favourite: Boolean(body.favourite) });
}

/**
 * Fold one vendor into another.
 *
 * Rewrites the name on every reservation as well as repointing them, because
 * the reports group by the string. Doing only one of the two leaves the totals
 * looking merged on one screen and split on another, which is worse than
 * leaving them alone.
 */
// Everything worth carrying from a record about to be deleted. The name is
// not here: the advisor chose which name to keep, and that choice is the whole
// point of the picker. Nor are the timestamps or the ids.
const MERGE_FIELDS = [
  'phone', 'email', 'website', 'portal_url', 'signup_url', 'account_number',
  'vendor_login', 'commission_pct', 'commission_structure', 'deposit_days',
  'final_days', 'booking_instructions', 'registration_instructions',
  'partner_status', 'budget_category', 'travel_types', 'phones_json',
  'bdm_name', 'bdm_email', 'bdm_phone', 'bdm_info', 'notes',
];

// What each is called when the advisor is told it came across.
const FIELD_WORD = {
  phone: 'phone', email: 'email', website: 'website', portal_url: 'booking portal',
  signup_url: 'sign-up link', account_number: 'account number',
  vendor_login: 'login', commission_pct: 'commission rate',
  commission_structure: 'commission terms', deposit_days: 'deposit terms',
  final_days: 'final payment terms', booking_instructions: 'how to book',
  registration_instructions: 'how to register', partner_status: 'partner status',
  budget_category: 'price bracket', travel_types: 'travel types',
  phones_json: 'sales desks', bdm_name: 'BDM', bdm_email: 'BDM email',
  bdm_phone: 'BDM phone', bdm_info: 'BDM notes', notes: 'notes',
  favourite: 'the star',
};

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/** The shelves one vendor sits on, from either column. */
function shelvesOf(v) {
  let list = [];
  try {
    const a = JSON.parse(v.categories_json || '[]');
    if (Array.isArray(a)) list = a.filter(Boolean);
  } catch { list = []; }
  if (v.category && !list.includes(v.category)) list.unshift(v.category);
  return list;
}

export async function handleMergeVendors(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const keepId = clean(body.keep, 64);
  const dropIds = Array.isArray(body.drop)
    ? body.drop.filter((x) => typeof x === 'string' && x !== keepId).slice(0, 50) : [];
  if (!keepId || !dropIds.length) return badRequest('Pick one vendor to keep and at least one to fold in.');

  // Across the agency, which is the whole point of the button now: a duplicate
  // is almost always two people's records for one supplier, and a merge that
  // could only fold in your own would leave exactly the pair worth folding.
  const vScope = db.scopeWhere(db.agencyScope(user), 'v.user_id');
  const flat = db.scopeWhere(db.agencyScope(user), 'user_id');

  // Aliased, because COLUMNS is written with the v. prefix the list query uses.
  const keep = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM vendors v WHERE v.id = ? AND ${vScope.sql}`
  ).bind(keepId, ...vScope.binds).first();
  if (!keep) return notFound('Vendor not found.');

  const marks = dropIds.map(() => '?').join(',');
  const { results: dropped } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM vendors v WHERE ${vScope.sql} AND v.id IN (${marks})
      ORDER BY v.updated_at DESC`
  ).bind(...vScope.binds, ...dropIds).all();

  // Everything the other records knew, moved across before they go.
  //
  // This used to delete them outright and keep only the reservations. The
  // duplicate is usually the one the import filled in: the phone number, the
  // booking instructions, the commission rate and the desk contact all sat on
  // the record being thrown away, and the advisor was left with a tidy list
  // and none of the detail they had been collecting.
  //
  // A blank on the kept record is filled from the first other record that has
  // it. Nothing already answered is overwritten: the one being kept is the one
  // the advisor chose.
  const filled = [];
  const sets = [];
  const binds = [];
  for (const field of MERGE_FIELDS) {
    if (!blank(keep[field])) continue;
    const source = (dropped || []).find((d) => !blank(d[field]));
    if (!source) continue;
    sets.push(`${field} = ?`);
    binds.push(source[field]);
    filled.push(field);
  }

  // The shelves are a set, not a choice: a supplier on Cruise Lines in one
  // record and Favorite Suppliers in the other belongs on both.
  const shelves = new Set(shelvesOf(keep));
  for (const d of dropped || []) for (const c of shelvesOf(d)) shelves.add(c);
  if (shelves.size) {
    sets.push('categories_json = ?', 'category = ?');
    binds.push(JSON.stringify([...shelves]), keep.category || [...shelves][0]);
  }

  // Starred on either record means starred: a star is a decision, and losing
  // it to a merge is losing the decision.
  if (!keep.favourite && (dropped || []).some((d) => d.favourite)) {
    sets.push('favourite = 1');
    filled.push('favourite');
  }

  if (sets.length) {
    await env.DB.prepare(
      `UPDATE vendors SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND ${flat.sql}`
    ).bind(...binds, now(), keepId, ...flat.binds).run();
  }

  const moved = await env.DB.prepare(
    `UPDATE bookings SET vendor_id = ?, supplier = ?, updated_at = ?
      WHERE ${flat.sql} AND vendor_id IN (${marks})`
  ).bind(keepId, keep.name, now(), ...flat.binds, ...dropIds).run();

  await env.DB.prepare(`DELETE FROM vendors WHERE ${flat.sql} AND id IN (${marks})`)
    .bind(...flat.binds, ...dropIds).run();

  const changed = moved.meta ? moved.meta.changes || 0 : 0;
  await db.logActivity(env, user.id, 'vendor.merge',
    `Folded ${dropIds.length} vendor${dropIds.length === 1 ? '' : 's'} into ${keep.name}`,
    { keep: keepId, moved: changed, filled });

  return json({
    ok: true,
    keptName: keep.name,
    mergedFrom: dropIds.length,
    reservationsMoved: changed,
    // Named, so the advisor can see what came across rather than trusting it.
    filled: filled.map((f) => FIELD_WORD[f] || f),
    categories: [...shelves],
  });
}

/**
 * Final payment dates the vendor's own terms imply.
 *
 * Suggested, never applied silently. A vendor's standard terms are a good
 * guess and not a fact: a group booking, a promotion or a late booking all
 * move the real date, and a date written into the record by software is
 * indistinguishable afterwards from one an advisor confirmed.
 */
export async function handleSuggestDates(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.selfScope(user);
  const scoped = db.scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.depart_date, b.final_payment_due,
            v.final_days, v.name AS vendor_name
       FROM bookings b JOIN vendors v ON v.id = b.vendor_id
      WHERE ${scoped.sql} AND b.status IN ('quoted','booked')
        AND b.final_payment_due IS NULL AND b.depart_date IS NOT NULL
        AND v.final_days IS NOT NULL
      ORDER BY b.depart_date ASC LIMIT 300`
  ).bind(...scoped.binds).all().catch(() => ({ results: [] }));

  const today = new Date().toISOString().slice(0, 10);
  const suggestions = (results || []).map((r) => {
    const due = new Date(Date.parse(`${r.depart_date}T00:00:00Z`) - r.final_days * 86400000)
      .toISOString().slice(0, 10);
    return {
      id: r.id,
      clientName: r.client_name,
      vendor: r.vendor_name,
      departDate: r.depart_date,
      finalDays: r.final_days,
      suggested: due,
      // A date already behind us is not a deadline, it is a warning that this
      // booking was taken inside the vendor's window.
      alreadyPassed: due < today,
    };
  });

  return json({ suggestions, today });
}
