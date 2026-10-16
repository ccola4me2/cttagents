// The four lists a group actually gets asked for.
//
// Every group trip produces the same paperwork, and it is produced by hand:
// somebody reads the sign-up list and retypes it into a spreadsheet, four
// different ways, for four different people. The cruise line wants a manifest
// with passports on it. The restaurant wants a table plan and the allergies.
// The airline wants names exactly as they appear on the document. The hotel
// wants who is sharing with whom.
//
// None of that is new information. It is the same rows, cut four ways, which
// is exactly the kind of work a computer should be doing.
//
// CSV because the other end of this is always a spreadsheet, and because a
// cruise line's group desk will take a CSV from anybody and a JSON file from
// nobody.
//
// The manifest is the only list that carries a passport number in full, and
// taking one is a deliberate act that is written to the activity log with the
// group it was for. Nothing else here decrypts a passport: see
// docs/encryption.md for what that protects and what it does not.

import { badRequest, notFound, now } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { open } from './pii.js';

/**
 * One CSV field.
 *
 * Quoted whenever it holds a comma, a quote, a newline or a leading space,
 * which is the whole of RFC 4180 that matters here.
 *
 * The leading apostrophe on anything starting =, +, - or @ is not politeness.
 * A spreadsheet reads those as formulas, so a passenger whose note begins with
 * a minus sign becomes a calculation, and a malicious one becomes a command
 * the recipient's spreadsheet offers to run. These files are sent to other
 * companies, so the escape is not optional.
 */
function field(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(headers, rows) {
  const lines = [headers.map(field).join(',')];
  for (const row of rows) lines.push(row.map(field).join(','));
  // CRLF, because that is what RFC 4180 says and what Excel is happiest with.
  return `${lines.join('\r\n')}\r\n`;
}

/** What each list is, in the order a person would pick from a menu. */
export const LISTS = [
  { key: 'manifest', name: 'Supplier manifest', pii: true,
    hint: 'Everything the travel supplier asks for, passports included' },
  { key: 'rooming', name: 'Rooming list', pii: false,
    hint: 'Who is sharing with whom, by cabin grade' },
  { key: 'flight', name: 'Flight list', pii: false,
    hint: 'Names as they appear on the passport, with dates of birth' },
  { key: 'dining', name: 'Dining list', pii: false,
    hint: 'Party sizes, allergies and anything that needs a quieter table' },
];

export const LIST_KEYS = LISTS.map((l) => l.key);

function sayDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso : '';
}

/**
 * The roster, flattened to one row per traveller.
 *
 * `full` decides whether passports are opened. Everything else is the same
 * query, because a list that reads differently depending on who asked is a
 * list nobody can reconcile against another one.
 */
async function rows(env, groupId, scope, { full }) {
  const rScoped = db.scopeWhere(scope, 'r.user_id');
  const { results } = await env.DB.prepare(
    `SELECT r.id AS registration_id, r.name AS party_name, r.email AS party_email,
            r.phone AS party_phone, r.party_size, r.status, r.supplier_ref,
            rt.room_type, rt.occupancy,
            t.id AS traveller_id, t.name, t.email, t.passport_country,
            t.dietary, t.accessibility, t.emergency_name, t.emergency_phone,
            t.emergency_relation, t.is_lead,
            t.dob_enc, t.passport_number_enc, t.passport_expiry_enc
       FROM group_registrations r
       LEFT JOIN group_rates rt ON rt.id = r.rate_id
       LEFT JOIN group_travellers t ON t.registration_id = r.id
      WHERE r.group_id = ? AND ${rScoped.sql} AND r.status <> 'cancelled'
      ORDER BY rt.sort_order ASC, r.created_at ASC, t.is_lead DESC, t.created_at ASC`
  ).bind(groupId, ...rScoped.binds).all().catch(() => ({ results: [] }));

  const out = [];
  for (const row of results || []) {
    out.push({
      ...row,
      dob: await open(env, row.dob_enc),
      passport: full ? await open(env, row.passport_number_enc) : null,
      passportExpiry: await open(env, row.passport_expiry_enc),
    });
  }
  return out;
}

function buildManifest(all) {
  return csv(
    ['Cabin grade', 'Party', 'Supplier ref', 'Name as on passport', 'Lead',
      'Date of birth', 'Passport number', 'Passport expires', 'Country of issue',
      'Email', 'Emergency contact', 'Emergency phone', 'Relationship'],
    all.filter((r) => r.traveller_id).map((r) => [
      r.room_type, r.party_name, r.supplier_ref, r.name, r.is_lead ? 'Yes' : '',
      sayDate(r.dob), r.passport, sayDate(r.passportExpiry), r.passport_country,
      r.email || r.party_email, r.emergency_name, r.emergency_phone, r.emergency_relation,
    ])
  );
}

function buildRooming(all) {
  // One row per cabin, with the people in it on the same line. A rooming list
  // read by a hotel is "who is in room 412", not a list of guests.
  const byParty = new Map();
  for (const r of all) {
    if (!byParty.has(r.registration_id)) {
      byParty.set(r.registration_id, {
        grade: r.room_type, occupancy: r.occupancy, party: r.party_name,
        ref: r.supplier_ref, size: r.party_size, names: [],
      });
    }
    if (r.traveller_id) byParty.get(r.registration_id).names.push(r.name);
  }
  return csv(
    ['Cabin grade', 'Occupancy', 'Party', 'Supplier ref', 'People', 'Names'],
    [...byParty.values()].map((p) => [
      p.grade, p.occupancy, p.party, p.ref,
      p.names.length || p.size || '', p.names.join('; '),
    ])
  );
}

function buildFlight(all) {
  return csv(
    ['Name as on passport', 'Date of birth', 'Party', 'Email', 'Phone'],
    all.filter((r) => r.traveller_id).map((r) => [
      r.name, sayDate(r.dob), r.party_name, r.email || r.party_email, r.party_phone,
    ])
  );
}

function buildDining(all) {
  // Only the people with something to say. A dining list where every row reads
  // "no requirements" is a list the restaurant will not read.
  const wanted = all.filter((r) => r.traveller_id && (r.dietary || r.accessibility));
  const parties = new Map();
  for (const r of all) {
    if (!parties.has(r.registration_id)) parties.set(r.registration_id, 0);
    if (r.traveller_id) parties.set(r.registration_id, parties.get(r.registration_id) + 1);
  }
  return csv(
    ['Party', 'People in party', 'Name', 'Cannot eat', 'Anything else'],
    wanted.map((r) => [
      r.party_name, parties.get(r.registration_id) || r.party_size || '',
      r.name, r.dietary, r.accessibility,
    ])
  );
}

const BUILDERS = {
  manifest: buildManifest,
  rooming: buildRooming,
  flight: buildFlight,
  dining: buildDining,
};

/** A filename somebody can find again in a downloads folder six weeks later. */
function fileName(groupName, list) {
  const slug = String(groupName || 'group').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'group';
  return `${slug}-${list}-${new Date().toISOString().slice(0, 10)}.csv`;
}

export async function handleGroupList(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const list = url.searchParams.get('list') || 'manifest';
  if (!LIST_KEYS.includes(list)) return badRequest('There is no list by that name.');

  const scope = db.scopeFor(env, user, request);
  const gScoped = db.scopeWhere(scope, 'g.user_id');
  const group = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name FROM travel_groups g
      WHERE g.id = ? AND ${gScoped.sql}`
  ).bind(groupId, ...gScoped.binds).first();
  if (!group) return notFound('Group not found.');

  const spec = LISTS.find((l) => l.key === list);
  const all = await rows(env, groupId, scope, { full: spec.pii });

  // Written down because it happened, not for the sake of a log line. A
  // passport leaving this portal is the one event here worth being able to
  // point at afterwards, and the row says which group and how many people.
  if (spec.pii) {
    await db.logActivity(env, user.id, 'group.manifest',
      `Took a supplier manifest for ${group.name}`,
      { groupId, people: all.filter((r) => r.traveller_id).length, at: now() });
  }

  return new Response(BUILDERS[list](all), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName(group.name, list)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
