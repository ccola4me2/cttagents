// The sheet behind a group: one row per cabin booking, who booked it, and where it stands.
//
// A group's cabins are booked by several people, each on the cruise line's own system and each under their own
// reservation number, so the portal's reservations cannot be the record of who has what. This is the group's
// own sheet, typed or pasted in or filled from a sign-up, and it is where the numbers that matter are worked
// out: how many cabins are in, how many guests, who booked which, and how many tour conductor credits the
// guests have earned.
//
// The rule is the cruise line's: one tour conductor credit for every twelve guests, counted across everybody's
// bookings in the group and credited to the group's owner, whoever made the booking. A cancelled cabin stops
// counting. A group is live from six staterooms.
//
// The group's owner is the fence, as for every other part of a group: the rows carry the owner's user_id, and
// whoever may change the group may change its sheet.

import { json, badRequest, notFound, clean, cleanText, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

export const CABIN_STATUSES = ['held', 'deposit', 'paid', 'cancelled'];
const GUESTS_PER_TC = 12;
const MINIMUM_CABINS = 6;
const MAX_ROWS = 400;

/** The totals for a sheet. Pure, so the same sums are on the page, in the export and in the desk's overview. */
export function summarise(rows) {
  const live = rows.filter((r) => r.status !== 'cancelled');
  const guests = live.reduce((n, r) => n + (Number(r.guests) || 0), 0);
  const byBooker = {};
  for (const r of live) {
    const who = (r.booked_by || '').trim() || 'Nobody yet';
    byBooker[who] = byBooker[who] || { cabins: 0, guests: 0 };
    byBooker[who].cabins += 1;
    byBooker[who].guests += Number(r.guests) || 0;
  }
  return {
    cabins: live.length,
    guests,
    paidCabins: live.filter((r) => r.status === 'paid').length,
    paidGuests: live.filter((r) => r.status === 'paid').reduce((n, r) => n + (Number(r.guests) || 0), 0),
    cancelled: rows.length - live.length,
    tcEarned: Math.floor(guests / GUESTS_PER_TC),
    // Guests still needed for the next credit. Twelve exactly when the last one has just been earned.
    toNextTc: GUESTS_PER_TC - (guests % GUESTS_PER_TC),
    perTc: GUESTS_PER_TC,
    minimum: MINIMUM_CABINS,
    minimumMet: live.length >= MINIMUM_CABINS,
    byBooker,
  };
}

/** One row as the page and the export read it. */
function shape(r) {
  return {
    id: r.id, cabinNo: r.cabin_no || '', category: r.category || '', guests: Number(r.guests) || 0,
    guestNames: r.guest_names || '', bookedBy: r.booked_by || '', bookingNo: r.booking_no || '',
    status: r.status || 'held', tc: Number(r.tc) === 1, notes: r.notes || '',
    registrationId: r.registration_id || null, updatedAt: r.updated_at,
  };
}

// The fields a row has, how each is cleaned, and the column each is kept in.
const FIELDS = {
  cabinNo: ['cabin_no', (v) => clean(v, 20)],
  category: ['category', (v) => clean(v, 60)],
  guests: ['guests', (v) => Math.max(0, Math.min(Math.floor(Number(v) || 0), 12))],
  guestNames: ['guest_names', (v) => cleanText(v, 600)],
  bookedBy: ['booked_by', (v) => clean(v, 80)],
  bookingNo: ['booking_no', (v) => clean(v, 40)],
  status: ['status', (v) => oneOf(v, CABIN_STATUSES)],
  tc: ['tc', (v) => (v === true || v === 1 || v === '1' || /^(y|yes|true|tc)$/i.test(String(v || '').trim()) ? 1 : 0)],
  notes: ['notes', (v) => cleanText(v, 1000)],
};

/** The group this sheet belongs to, for somebody who may change it, with its owner. */
async function groupFor(env, user, groupId) {
  const owner = await db.writerFor(env, user, 'travel_groups', groupId);
  if (!owner) return null;
  const group = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.vendor, g.product_name, g.group_code, g.group_number, g.depart_date,
            g.return_date, g.option_date, g.final_payment_due, g.cabins_held, u.first_name, u.last_name
       FROM travel_groups g JOIN users u ON u.id = g.user_id
      WHERE g.id = ? AND g.user_id = ?`
  ).bind(groupId, owner.id).first();
  return group ? { group, owner } : null;
}

async function loadRows(env, groupId, ownerId) {
  const { results } = await env.DB.prepare(
    `SELECT id, cabin_no, category, guests, guest_names, booked_by, booking_no, status, tc, notes,
            registration_id, updated_at
       FROM group_cabins WHERE group_id = ? AND user_id = ? ORDER BY sort_order ASC, created_at ASC`
  ).bind(groupId, ownerId).all();
  return results || [];
}

/** Sign-ups that have not been put on the sheet yet, newest first. */
async function waitingSignups(env, groupId, ownerId) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.name, r.party_size, r.created_at, rt.room_type AS rate_name
       FROM group_registrations r
       LEFT JOIN group_rates rt ON rt.id = r.rate_id
      WHERE r.group_id = ? AND r.user_id = ? AND r.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM group_cabins c WHERE c.registration_id = r.id AND c.user_id = ?)
      ORDER BY r.created_at DESC LIMIT 100`
  ).bind(groupId, ownerId, ownerId).all().catch(() => ({ results: [] }));
  return (results || []).map((r) => ({
    id: r.id, name: r.name, party: Number(r.party_size) || 1, category: r.rate_name || '', createdAt: r.created_at,
  }));
}

/** The names a "booked by" box offers: the people on the desk, and anybody already written on the sheet. */
async function bookerNames(env, user, rows) {
  const names = new Set(rows.map((r) => (r.booked_by || '').trim()).filter(Boolean));
  if (user.agency_id) {
    const { results } = await env.DB.prepare(
      "SELECT first_name, last_name FROM users WHERE agency_id = ? AND status = 'active'"
    ).bind(user.agency_id).all().catch(() => ({ results: [] }));
    for (const u of results || []) {
      const n = `${u.first_name || ''} ${u.last_name || ''}`.trim();
      if (n) names.add(n);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** GET /api/groups/:id/cabins */
export async function handleListCabins(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const found = await groupFor(env, user, groupId);
  if (!found) return notFound('Group not found.');
  const { group, owner } = found;

  const rows = await loadRows(env, group.id, owner.id);
  return json({
    group: {
      id: group.id, name: group.name, vendor: group.vendor || '', ship: group.product_name || '',
      groupCode: group.group_number || group.group_code || '',
      departDate: group.depart_date || '', returnDate: group.return_date || '', cabinsHeld: group.cabins_held || 0,
      optionDate: group.option_date || '', finalPaymentDue: group.final_payment_due || '',
      owner: `${group.first_name || ''} ${group.last_name || ''}`.trim(),
    },
    cabins: rows.map(shape),
    summary: summarise(rows),
    signups: await waitingSignups(env, group.id, owner.id),
    bookers: await bookerNames(env, user, rows),
    statuses: CABIN_STATUSES,
  });
}

async function nextOrder(env, groupId, ownerId) {
  const row = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS n FROM group_cabins WHERE group_id = ? AND user_id = ?'
  ).bind(groupId, ownerId).first();
  return ((row && row.n) || 0) + 1;
}

async function insertRow(env, group, owner, user, values, extra = {}) {
  const id = uid();
  const ts = now();
  const get = (key, fallback) => (values[key] === undefined ? fallback : FIELDS[key][1](values[key]));
  await env.DB.prepare(
    `INSERT INTO group_cabins (id, group_id, user_id, cabin_no, category, guests, guest_names, booked_by,
       booking_no, status, tc, notes, registration_id, sort_order, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, group.id, owner.id, get('cabinNo', ''), get('category', ''), get('guests', 0), get('guestNames', ''),
    get('bookedBy', ''), get('bookingNo', ''), get('status', 'held'), get('tc', 0), get('notes', ''),
    extra.registrationId || null, extra.order || await nextOrder(env, group.id, owner.id), user.id, ts, ts).run();
  return id;
}

/** POST /api/groups/:id/cabins : a new row, empty or with values. */
export async function handleAddCabin(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const found = await groupFor(env, user, groupId);
  if (!found) return notFound('Group not found.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM group_cabins WHERE group_id = ? AND user_id = ?')
    .bind(found.group.id, found.owner.id).first();
  if ((count && count.n) >= MAX_ROWS) return badRequest(`A sheet holds at most ${MAX_ROWS} cabins.`);

  const body = await readJson(request);
  const id = await insertRow(env, found.group, found.owner, user, body);
  return json({ ok: true, id }, 201);
}

/** PUT /api/groups/:id/cabins/:cabinId : only the fields the request names. */
export async function handleUpdateCabin(request, env, groupId, cabinId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const found = await groupFor(env, user, groupId);
  if (!found) return notFound('Group not found.');

  const body = await readJson(request);
  const sets = [];
  const binds = [];
  for (const [key, [column, tidy]] of Object.entries(FIELDS)) {
    if (body[key] === undefined) continue;
    sets.push(`${column} = ?`);
    binds.push(tidy(body[key]));
  }
  if (!sets.length) return badRequest('Nothing to change.');
  const res = await env.DB.prepare(
    `UPDATE group_cabins SET ${sets.join(', ')}, updated_by = ?, updated_at = ?
      WHERE id = ? AND group_id = ? AND user_id = ?`
  ).bind(...binds, user.id, now(), cabinId, found.group.id, found.owner.id).run();
  if (!res.meta || !res.meta.changes) return notFound('That cabin is not on the sheet.');
  return json({ ok: true });
}

/** DELETE /api/groups/:id/cabins/:cabinId */
export async function handleDeleteCabin(request, env, groupId, cabinId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const found = await groupFor(env, user, groupId);
  if (!found) return notFound('Group not found.');
  const res = await env.DB.prepare('DELETE FROM group_cabins WHERE id = ? AND group_id = ? AND user_id = ?')
    .bind(cabinId, found.group.id, found.owner.id).run();
  if (!res.meta || !res.meta.changes) return notFound('That cabin is not on the sheet.');
  return json({ ok: true });
}

/** The column each heading a pasted sheet may have means. */
const HEADINGS = [
  [/^cabin|^stateroom|^room( no| number)?$/, 'cabinNo'],
  [/categor|grade|type/, 'category'],
  [/^guests?$|^pax|^people|^number of/, 'guests'],
  [/names?|passenger|traveller|traveler/, 'guestNames'],
  [/booked|agent|agency|advisor/, 'bookedBy'],
  [/booking|reservation|res ?#|confirmation/, 'bookingNo'],
  [/status/, 'status'],
  [/^tc$|tour conductor/, 'tc'],
  [/note|comment/, 'notes'],
];
const DEFAULT_ORDER = ['cabinNo', 'category', 'guests', 'guestNames', 'bookedBy', 'bookingNo', 'status', 'tc', 'notes'];

function splitLine(line) {
  const sep = line.includes('\t') ? '\t' : (line.includes('|') ? '|' : ',');
  if (sep !== ',') return line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  // Commas inside quotes belong to the cell, which is how a list of guest names arrives from a spreadsheet saved
  // as CSV.
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = !quoted; }
    } else if (ch === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Turns pasted text into rows. A first line of headings is read for what each column is; without one the
 * columns are taken in the order of the sheet. Status words are forgiven (paid in full, deposited).
 */
export function readPasted(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let order = DEFAULT_ORDER;
  const first = splitLine(lines[0]).map((c) => c.toLowerCase());
  const mapped = first.map((h) => (HEADINGS.find(([re]) => re.test(h)) || [])[1] || null);
  if (mapped.filter(Boolean).length >= 2) { order = mapped; lines.shift(); }
  return lines.map((line) => {
    const cells = splitLine(line);
    const out = {};
    order.forEach((key, i) => { if (key && cells[i] !== undefined && cells[i] !== '') out[key] = cells[i]; });
    if (out.status) {
      const s = String(out.status).toLowerCase();
      out.status = /cancel/.test(s) ? 'cancelled' : /paid|final/.test(s) ? 'paid' : /dep/.test(s) ? 'deposit' : 'held';
    }
    return out;
  }).filter((r) => Object.keys(r).length);
}

/** POST /api/groups/:id/cabins/import { text } : many rows at once, from a pasted sheet. */
export async function handleImportCabins(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const found = await groupFor(env, user, groupId);
  if (!found) return notFound('Group not found.');

  const body = await readJson(request);
  const rows = readPasted(body.text);
  if (!rows.length) return badRequest('Nothing to read there. Paste the rows, one cabin a line.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM group_cabins WHERE group_id = ? AND user_id = ?')
    .bind(found.group.id, found.owner.id).first();
  if (((count && count.n) || 0) + rows.length > MAX_ROWS) return badRequest(`A sheet holds at most ${MAX_ROWS} cabins.`);

  let order = await nextOrder(env, found.group.id, found.owner.id);
  for (const r of rows) {
    await insertRow(env, found.group, found.owner, user, r, { order });
    order += 1;
  }
  await db.logActivity(env, user.id, 'group.cabins.import', `Pasted ${rows.length} cabins onto a group's sheet`,
    { id: found.group.id });
  return json({ ok: true, added: rows.length }, 201);
}

/** POST /api/groups/:id/cabins/from-signup { registrationId } : a sign-up becomes a row. */
export async function handleCabinFromSignup(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const found = await groupFor(env, user, groupId);
  if (!found) return notFound('Group not found.');

  const body = await readJson(request);
  const reg = await env.DB.prepare(
    `SELECT r.id, r.name, r.party_size, rt.room_type AS rate_name
       FROM group_registrations r LEFT JOIN group_rates rt ON rt.id = r.rate_id
      WHERE r.id = ? AND r.group_id = ? AND r.user_id = ?`
  ).bind(clean(body.registrationId, 64), found.group.id, found.owner.id).first();
  if (!reg) return notFound('That sign-up was not found.');
  const already = await env.DB.prepare(
    'SELECT id FROM group_cabins WHERE registration_id = ? AND user_id = ?'
  ).bind(reg.id, found.owner.id).first();
  if (already) return badRequest('That sign-up is already on the sheet.');

  const { results: people } = await env.DB.prepare(
    'SELECT name FROM group_travellers WHERE registration_id = ? AND user_id = ? ORDER BY is_lead DESC, created_at ASC'
  ).bind(reg.id, found.owner.id).all().catch(() => ({ results: [] }));
  const names = (people || []).map((p) => p.name).filter(Boolean);
  const guestNames = names.length ? names.join(', ') : reg.name;
  const guests = Math.min(Math.max(names.length || Number(reg.party_size) || 1, 1), 12);

  const id = await insertRow(env, found.group, found.owner, user, {
    category: reg.rate_name || '', guests, guestNames, notes: 'From the sign-up page.',
  }, { registrationId: reg.id });
  return json({ ok: true, id }, 201);
}

function csvField(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n]|^\s/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/groups/:id/cabins.csv */
export async function handleCabinsCsv(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const found = await groupFor(env, user, groupId);
  if (!found) return notFound('Group not found.');
  const rows = await loadRows(env, found.group.id, found.owner.id);
  const lines = [['Cabin', 'Category', 'Guests', 'Guest names', 'Booked by', 'Booking number', 'Status', 'TC cabin', 'Notes']
    .join(',')];
  for (const r of rows) {
    lines.push([r.cabin_no, r.category, r.guests, r.guest_names, r.booked_by, r.booking_no, r.status,
      Number(r.tc) === 1 ? 'yes' : '', r.notes].map(csvField).join(','));
  }
  const safe = String(found.group.name || 'group').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return new Response(`${lines.join('\r\n')}\r\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe || 'group'}-cabins.csv"`,
    },
  });
}
