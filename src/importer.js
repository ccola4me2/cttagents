// Bringing an existing book of business across.
//
// A CRM with nothing in it is a demo. Most advisors arriving here have years
// of reservations somewhere else, and no back office worth the name offers a
// clean export, so the realistic path is to select the rows on screen and
// paste them. This accepts that paste.
//
// The parser runs on the server and the preview uses the same call as the
// import, so what you are shown is what will be created. Two parsers, one for
// preview and one for the write, is how a preview ends up lying.

import { json, badRequest, clean, cleanDate, toCents, oneOf, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { resolveVendor } from './vendors.js';
import { upsertClient } from './clients.js';

const MAX_ROWS = 500;

// The fields a row can carry. Order matters only for the unheaded case, where
// it is the order the columns are assumed to be in.
export const FIELDS = [
  'clientName', 'supplier', 'productName', 'departDate', 'returnDate',
  'confirmationNumber', 'gross', 'commission', 'status', 'destination',
];

// What a column heading has to contain to be recognised. Checked in order, so
// the more specific patterns come first.
const HEADINGS = [
  [/^(client|passenger|guest|name|last.*first)/i, 'clientName'],
  [/^(vendor|supplier|cruise line|carrier)/i, 'supplier'],
  [/^(ship|product|resort|property|itinerary)/i, 'productName'],
  [/^(depart|sail|travel date|start)/i, 'departDate'],
  [/^(return|end|back)/i, 'returnDate'],
  [/^(conf|booking (no|num|ref)|reservation (no|num))/i, 'confirmationNumber'],
  [/^(gross|total|fare|price|amount|value)/i, 'gross'],
  [/^(comm)/i, 'commission'],
  [/^(status)/i, 'status'],
  [/^(destination|region|area)/i, 'destination'],
];

/**
 * The byte order mark Excel puts at the front of a CSV.
 *
 * It is invisible everywhere except a string comparison, where it rides on the
 * first heading and stops it matching anything. A file whose first column is
 * Nickname arrives with a first column called "\uFEFFNickname", which is the
 * quiet way an import loses a column and, if enough of them go, stops
 * recognising the header row at all.
 */
function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

/** Splits a line on tabs, or on commas when there are no tabs. */
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * "Montoro, Manuel" becomes "Manuel Montoro".
 *
 * Back offices list people surname first for sorting. Storing it that way
 * means every screen, email and vendor confirmation reads backwards, so it is
 * turned around on the way in rather than lived with forever.
 */
export function personName(raw) {
  const value = clean(raw, 120);
  if (!value) return '';
  const parts = value.split(',');
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return `${parts[1].trim()} ${parts[0].trim()}`.slice(0, 120);
  }
  return value;
}

/**
 * "Margaritaville at Sea (Islander)" becomes vendor and ship separately.
 *
 * Kept apart because the vendor is who you chase for commission and the ship
 * is what the client thinks they bought, and a report grouped by the pair is
 * a report grouped by nothing.
 */
export function splitVendor(raw) {
  const value = clean(raw, 200);
  const match = value.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { supplier: value.slice(0, 120), productName: '' };
  let ship = match[2].trim();
  const vendor = match[1].trim();
  // "Margaritaville at Sea (Margaritaville at Sea Islander)" says the vendor
  // twice. Keep the part that is actually the ship.
  if (ship.toLowerCase().startsWith(vendor.toLowerCase())) {
    ship = ship.slice(vendor.length).trim() || ship;
  }
  return { supplier: vendor.slice(0, 120), productName: ship.slice(0, 160) };
}

/** m/d/yy, m/d/yyyy, yyyy-mm-dd and d Mon yyyy, or nothing. */
export function anyDate(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  const iso = cleanDate(value);
  if (iso) return iso;

  const slash = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    // A two digit year is this century. A travel agency's records do not run
    // back to the 1900s, and guessing 1927 for a 2027 sailing is worse than
    // refusing the row.
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const out = `${year}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
    return cleanDate(out);
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

/** Turns pasted text into rows, with the problems named rather than dropped. */
export function parsePaste(text, mapping) {
  const lines = stripBom(text).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return { columns: [], rows: [], skippedHeader: false };

  let columns = Array.isArray(mapping) && mapping.length ? mapping.slice(0, 20) : null;
  let start = 0;

  if (!columns) {
    const first = splitLine(lines[0]);
    const guessed = first.map((cell) => {
      const hit = HEADINGS.find(([re]) => re.test(cell.trim()));
      return hit ? hit[1] : '';
    });
    // Treated as a heading row only if most cells name something. A row of
    // real data occasionally matches one pattern by accident.
    if (guessed.filter(Boolean).length >= Math.max(2, Math.ceil(first.length / 2))) {
      columns = guessed;
      start = 1;
    } else {
      columns = FIELDS.slice(0, first.length);
    }
  }

  const rows = [];
  for (let i = start; i < lines.length && rows.length < MAX_ROWS; i++) {
    const cells = splitLine(lines[i]);
    const raw = {};
    columns.forEach((field, n) => { if (field) raw[field] = cells[n] ?? ''; });

    const vendorParts = splitVendor(raw.supplier || '');
    const row = {
      line: i + 1,
      clientName: personName(raw.clientName),
      supplier: vendorParts.supplier,
      productName: clean(raw.productName, 160) || vendorParts.productName,
      destination: clean(raw.destination, 160),
      confirmationNumber: clean(raw.confirmationNumber, 80),
      departDate: anyDate(raw.departDate),
      returnDate: anyDate(raw.returnDate),
      gross: raw.gross ? String(raw.gross).replace(/[^0-9.]/g, '') : '',
      commission: raw.commission ? String(raw.commission).replace(/[^0-9.]/g, '') : '',
      status: oneOf(raw.status, ['quoted', 'booked', 'travelled', 'cancelled']),
      problems: [],
    };

    if (!row.clientName) row.problems.push('no client name');
    if (raw.departDate && !row.departDate) row.problems.push(`could not read the date "${raw.departDate}"`);
    rows.push(row);
  }

  return { columns, rows, skippedHeader: start === 1 };
}

export async function handlePreviewImport(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const parsed = parsePaste(body.text, body.mapping);

  // Which of these are already here, so the preview can say "12 new, 8 you
  // already have" rather than importing duplicates and leaving you to find
  // them afterwards.
  const existing = new Set();
  const refs = parsed.rows.map((r) => r.confirmationNumber).filter(Boolean);
  if (refs.length) {
    const marks = refs.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT confirmation_number FROM bookings
        WHERE user_id = ? AND confirmation_number IN (${marks})`
    ).bind(user.id, ...refs).all().catch(() => ({ results: [] }));
    for (const r of results || []) existing.add(r.confirmation_number);
  }

  const rows = parsed.rows.map((r) => ({
    ...r,
    duplicate: Boolean(r.confirmationNumber && existing.has(r.confirmationNumber)),
  }));

  return json({
    columns: parsed.columns,
    fields: FIELDS,
    skippedHeader: parsed.skippedHeader,
    rows,
    summary: {
      total: rows.length,
      ready: rows.filter((r) => !r.problems.length && !r.duplicate).length,
      duplicates: rows.filter((r) => r.duplicate).length,
      problems: rows.filter((r) => r.problems.length).length,
    },
  });
}

export async function handleRunImport(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const parsed = parsePaste(body.text, body.mapping);
  if (!parsed.rows.length) return badRequest('There was nothing to import.');

  const refs = parsed.rows.map((r) => r.confirmationNumber).filter(Boolean);
  const existing = new Set();
  if (refs.length) {
    const marks = refs.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT confirmation_number FROM bookings
        WHERE user_id = ? AND confirmation_number IN (${marks})`
    ).bind(user.id, ...refs).all().catch(() => ({ results: [] }));
    for (const r of results || []) existing.add(r.confirmation_number);
  }

  let created = 0;
  let skipped = 0;
  const failures = [];

  for (const row of parsed.rows) {
    if (row.problems.length) { skipped += 1; continue; }
    if (row.confirmationNumber && existing.has(row.confirmationNumber)) { skipped += 1; continue; }

    try {
      const clientId = await db.resolveClient(env, user.id, row.clientName);
      const vendorId = await resolveVendor(env, user.id, row.supplier);
      await db.createBooking(env, user.id, {
        clientName: row.clientName,
        supplier: row.supplier,
        productType: 'cruise',
        productName: row.productName,
        destination: row.destination,
        confirmationNumber: row.confirmationNumber,
        departDate: row.departDate,
        returnDate: row.returnDate,
        depositDue: null,
        finalPaymentDue: null,
        travellers: 1,
        grossCents: toCents(row.gross),
        depositCents: 0,
        commissionCents: toCents(row.commission),
        commissionStatus: 'pending',
        status: row.status,
        notes: 'Imported',
        clientId,
        vendorId,
      });
      created += 1;
      // Within one paste as well as against the database, so a list pasted
      // twice in the same box does not import twice.
      if (row.confirmationNumber) existing.add(row.confirmationNumber);
    } catch (e) {
      failures.push({ line: row.line, client: row.clientName, error: String(e && e.message || e).slice(0, 200) });
    }
  }

  await db.logActivity(env, user.id, 'import.reservations',
    `Imported ${created} reservation${created === 1 ? '' : 's'}`, { created, skipped });

  return json({ ok: true, created, skipped, failures });
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
//
// The same machinery pointed at people rather than reservations.
//
// An advisor arriving with a book of business has two lists, not one: the
// trips, and everyone they have ever sold to. The second is the longer of the
// two and the one that a reservation import cannot produce, because a client
// who has not travelled with you yet appears on no reservation anywhere.
//
// Writes through upsertClient, the same call the Add a client dialog uses, so
// an imported client and a typed one are the same record cleaned the same way.

export const CLIENT_FIELDS = [
  'name', 'nickname', 'email', 'phone', 'homePhone', 'birthday', 'anniversary',
  'address1', 'address2', 'city', 'state', 'postcode', 'country',
  'legalFirst', 'legalMiddle', 'legalLast', 'gender', 'citizenship',
  'passportNumber', 'passportCountry', 'passportExpiry', 'knownTraveler',
  'source', 'notes',
];

// Checked in order, so the specific patterns come before the general ones.
//
// Two shapes have to work. A sheet somebody typed has bare headings: Name,
// Email, City. A back office export qualifies everything: the Cruise Planners
// one writes Home Address City and Home Phone, which none of the bare patterns
// matched, so more than half its columns went unrecognised and the header row
// was not even detected as a header. Hence the optional prefixes and the
// anchors: "Home Address City" is a city and "Home Address 1" is a street, and
// telling those apart is the whole job.
const CLIENT_HEADINGS = [
  // Whose book this is, not who the client is. Dropped before anything else,
  // or "Agent First Name" is read as the client's first name.
  [/^agent\b/i, ''],

  [/^(nick|preferred)/i, 'nickname'],
  // Before the plain name patterns, or "first name" is read as the whole name.
  [/^(legal.*first|first.*(name|legal)|given)/i, 'legalFirst'],
  [/^(middle)/i, 'legalMiddle'],
  [/^(legal.*last|last.*(name|legal)|surname|family)/i, 'legalLast'],
  [/^(e.?mail)/i, 'email'],
  // Mobile wins the phone field; a home number is kept as a fallback for the
  // sheets that carry only one and call it something else.
  [/^(mobile|cell)/i, 'phone'],
  [/^(home\s*phone|phone|tel)/i, 'homePhone'],
  [/^(birth|dob|d\.o\.b)/i, 'birthday'],
  [/^(anniv)/i, 'anniversary'],
  [/^(gender|sex)$/i, 'gender'],
  // The qualified address parts first, so none of them is read as the street.
  [/^(home\s*)?(address\s*)?(city|town)$/i, 'city'],
  [/^(home\s*)?(address\s*)?(state|province|county|region)$/i, 'state'],
  [/^(home\s*)?(address\s*)?(zip|post.?code|postal.*)$/i, 'postcode'],
  [/^(home\s*)?(address\s*)?country$/i, 'country'],
  [/^(home\s*)?(address|street)\s*(2|line\s*2)$|^(apt|suite|unit)/i, 'address2'],
  [/^(home\s*)?(address|street)(\s*(1|line\s*1))?$|^addr/i, 'address1'],
  [/^(citizen|nationality)/i, 'citizenship'],
  [/^(passport.*(country|issu.*(country|place)))/i, 'passportCountry'],
  [/^(passport.*exp|exp.*passport)/i, 'passportExpiry'],
  [/^(passport)/i, 'passportNumber'],
  [/^(known.?travell?er|ktn|redress|trusted)/i, 'knownTraveler'],
  [/^(source|referr|lead source|how.*hear)/i, 'source'],
  [/^(note|comment|remark)/i, 'notes'],
  [/^(client|passenger|guest|full.?name|name|contact)/i, 'name'],
];

/** The client half of parsePaste. Same splitting, different columns. */
export function parseClientPaste(text, mapping) {
  const lines = stripBom(text).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return { columns: [], rows: [], skippedHeader: false };

  let columns = Array.isArray(mapping) && mapping.length ? mapping.slice(0, 24) : null;
  let start = 0;

  if (!columns) {
    const first = splitLine(lines[0]);
    const guessed = first.map((cell) => {
      const hit = CLIENT_HEADINGS.find(([re]) => re.test(cell.trim()));
      return hit ? hit[1] : '';
    });
    if (guessed.filter(Boolean).length >= Math.max(2, Math.ceil(first.length / 2))) {
      columns = guessed;
      start = 1;
    } else {
      columns = CLIENT_FIELDS.slice(0, first.length);
    }
  }

  const rows = [];
  for (let i = start; i < lines.length && rows.length < MAX_ROWS; i++) {
    const cells = splitLine(lines[i]);
    const raw = {};
    columns.forEach((field, n) => { if (field) raw[field] = cells[n] ?? ''; });

    // A sheet with first and last in separate columns and no full name column
    // still describes a person. Built rather than refused.
    const legalFirst = clean(raw.legalFirst, 80);
    const legalLast = clean(raw.legalLast, 80);
    const name = personName(raw.name)
      || [legalFirst, legalLast].filter(Boolean).join(' ').slice(0, 120);

    const row = {
      line: i + 1,
      name,
      nickname: clean(raw.nickname, 80),
      email: clean(raw.email, 160),
      // A mobile if there is one, otherwise whatever other number the sheet
      // carries. Both columns are common and only one field holds a number.
      phone: clean(raw.phone, 40) || clean(raw.homePhone, 40),
      birthday: anyDate(raw.birthday),
      anniversary: anyDate(raw.anniversary),
      address1: clean(raw.address1, 160),
      address2: clean(raw.address2, 160),
      city: clean(raw.city, 80),
      state: clean(raw.state, 80),
      postcode: clean(raw.postcode, 24),
      country: clean(raw.country, 80),
      legalFirst,
      legalMiddle: clean(raw.legalMiddle, 80),
      legalLast,
      citizenship: clean(raw.citizenship, 80),
      passportNumber: clean(raw.passportNumber, 40),
      passportCountry: clean(raw.passportCountry, 80),
      passportExpiry: anyDate(raw.passportExpiry),
      knownTraveler: clean(raw.knownTraveler, 40),
      gender: clean(raw.gender, 40),
      source: clean(raw.source, 80),
      notes: clean(raw.notes, 4000),
      problems: [],
    };

    if (!row.name) row.problems.push('no name');
    // Said rather than silently dropped, because a column mapped to the wrong
    // field is the usual cause and it is invisible otherwise.
    if (raw.email && !row.email.includes('@')) {
      row.problems.push(`"${String(raw.email).slice(0, 40)}" is not an email address`);
    }
    if (raw.birthday && !row.birthday) {
      row.problems.push(`could not read the birthday "${String(raw.birthday).slice(0, 20)}"`);
    }
    if (raw.passportExpiry && !row.passportExpiry) {
      row.problems.push(`could not read the passport expiry "${String(raw.passportExpiry).slice(0, 20)}"`);
    }
    rows.push(row);
  }

  return { columns, rows, skippedHeader: start === 1 };
}

/** The names already on this advisor's list, for the duplicate count. */
async function knownClientNames(env, userId, names) {
  const wanted = names.filter(Boolean);
  if (!wanted.length) return new Set();
  const marks = wanted.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT name FROM clients WHERE user_id = ? AND name IN (${marks})`
  ).bind(userId, ...wanted).all().catch(() => ({ results: [] }));
  return new Set((results || []).map((r) => r.name));
}

export async function handlePreviewClientImport(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const parsed = parseClientPaste(body.text, body.mapping);
  const known = await knownClientNames(env, user.id, parsed.rows.map((r) => r.name));

  // A duplicate is not a refusal here, the way it is for a reservation.
  // Importing somebody already on the list fills in what was blank and leaves
  // what was there, so the count says "updated" rather than "skipped".
  const rows = parsed.rows.map((r) => ({ ...r, duplicate: Boolean(r.name && known.has(r.name)) }));

  return json({
    columns: parsed.columns,
    fields: CLIENT_FIELDS,
    skippedHeader: parsed.skippedHeader,
    rows,
    summary: {
      total: rows.length,
      ready: rows.filter((r) => !r.problems.length && !r.duplicate).length,
      duplicates: rows.filter((r) => r.duplicate && !r.problems.length).length,
      problems: rows.filter((r) => r.problems.length).length,
    },
  });
}

export async function handleRunClientImport(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const parsed = parseClientPaste(body.text, body.mapping);
  if (!parsed.rows.length) return badRequest('There was nothing to import.');

  const known = await knownClientNames(env, user.id, parsed.rows.map((r) => r.name));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failures = [];

  for (const row of parsed.rows) {
    if (row.problems.length) { skipped += 1; continue; }
    try {
      const out = await upsertClient(env, user, row);
      if (out.error) {
        failures.push({ line: row.line, client: row.name, error: out.error });
        continue;
      }
      if (out.existed || known.has(row.name)) updated += 1; else created += 1;
      // Within the paste as well as against the database, so the same person
      // twice in one sheet counts once as new and once as filled in.
      known.add(row.name);
    } catch (e) {
      failures.push({
        line: row.line,
        client: row.name,
        error: String((e && e.message) || e).slice(0, 200),
      });
    }
  }

  await db.logActivity(env, user.id, 'client.import',
    `Imported ${created} client${created === 1 ? '' : 's'}`, { created, updated, skipped });

  return json({ ok: true, created, updated, skipped, failures });
}
