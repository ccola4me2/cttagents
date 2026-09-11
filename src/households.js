// People who live at the same address, kept together.
//
// A client record is one person and stays one person: their own birthday,
// their own passport, their own trips. A household is the fact that two of
// those rows are married, which the portal had no way to know.
//
// The reason it earns its place is the reservation. Put one of them on a
// booking and the rest of the house is offered as travellers, with the name,
// the email, the phone and the date of birth already known. That is the second
// name on nearly every leisure booking, typed from memory today.
//
// A household groups people and owns nothing else. Trips, credits and tasks
// stay on the client, so somebody who moves out takes their history with them
// and dissolving a household leaves every client exactly where they were.

import {
  json, badRequest, notFound, clean, cleanText, uid, now, readJson,
} from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const COLUMNS = `h.id, h.user_id, h.name, h.address, h.phone, h.notes,
                 h.created_at, h.updated_at`;

/**
 * A name for a house full of people, from the surname they share.
 *
 * Two Gallos make "The Gallo household". A Gallo and a Nonnemacher make
 * "Gallo & Nonnemacher", because inventing a shared surname for people who do
 * not have one is how a household ends up addressed wrongly on a document.
 */
export function suggestName(names) {
  const surnames = [...new Set(names
    .map((n) => String(n || '').trim().split(/\s+/).pop())
    .filter((n) => n && n.length > 1))];
  if (!surnames.length) return 'Household';
  if (surnames.length === 1) return `The ${surnames[0]} household`;
  return surnames.slice(0, 3).join(' & ');
}

/** The clients in one household, in the order they read. */
export async function membersOf(env, householdId, scope) {
  if (!householdId) return [];
  const scoped = db.scopeWhere(scope, 'c.user_id');
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.phone, c.birthday, c.anniversary,
            c.legal_first, c.legal_middle, c.legal_last, c.gender, c.citizenship,
            c.passport_number, c.passport_country, c.passport_expiry,
            (SELECT COUNT(*) FROM bookings b WHERE b.client_id = c.id
              AND b.status IN ('booked','travelled')) AS trips,
            (SELECT COALESCE(SUM(b.gross_cents), 0) FROM bookings b WHERE b.client_id = c.id
              AND b.status IN ('booked','travelled')) AS lifetime_cents
       FROM clients c
      WHERE c.household_id = ? AND ${scoped.sql}
      ORDER BY c.name ASC LIMIT 40`
  ).bind(householdId, ...scoped.binds).all();
  return results || [];
}

/** The household a client is in, with everybody else in it. */
export async function householdFor(env, client, scope) {
  if (!client || !client.household_id) return null;
  const scoped = db.scopeWhere(scope, 'h.user_id');
  const house = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM households h WHERE h.id = ? AND ${scoped.sql}`
  ).bind(client.household_id, ...scoped.binds).first();
  if (!house) return null;
  const members = await membersOf(env, house.id, scope);
  return {
    ...house,
    members,
    // What the house is worth together, which is the figure that decides
    // whether it is worth a call. One of them booked the cruise and the other
    // has never booked anything, and separately neither looks like much.
    lifetimeCents: members.reduce((n, m) => n + (m.lifetime_cents || 0), 0),
    trips: members.reduce((n, m) => n + (m.trips || 0), 0),
  };
}

/** Every client id in this list that really belongs to the caller. */
async function ownClients(env, userId, ids) {
  const wanted = [...new Set((ids || [])
    .filter((x) => typeof x === 'string' && x).slice(0, 40))];
  if (!wanted.length) return [];
  const marks = wanted.map(() => '?').join(',');
  // Ordered, and not for tidiness. The suggested household name is built from
  // these names in the order they arrive, and a query with no ORDER BY is free
  // to return them in any order at all: the same two people made the "Vance &
  // Ridley household" one time and the "Ridley & Vance household" the next.
  const { results } = await env.DB.prepare(
    `SELECT id, name, household_id FROM clients
      WHERE user_id = ? AND id IN (${marks})
      ORDER BY name ASC`
  ).bind(userId, ...wanted).all();
  return results || [];
}

export async function handleListHouseholds(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'h.user_id');
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM clients c WHERE c.household_id = h.id) AS members,
            (SELECT COALESCE(SUM(b.gross_cents), 0) FROM bookings b
               JOIN clients c ON c.id = b.client_id
              WHERE c.household_id = h.id AND b.status IN ('booked','travelled'))
              AS lifetime_cents
       FROM households h
      WHERE ${scoped.sql}
      ORDER BY h.name ASC LIMIT 500`
  ).bind(...scoped.binds).all();

  return json({ households: results || [], scope: db.scopeLabel(scope, user) });
}

/**
 * Put people in one house.
 *
 * Takes the clients rather than making an empty household and filling it,
 * because a household of nobody is not a thing anybody wants and it is the
 * shape the clients list offers: tick two names, make them a household.
 */
/**
 * People who share an address and are in no household.
 *
 * A client list imported from a back office arrives one person at a time, so a
 * couple who have travelled together for twenty years land as two unrelated
 * rows. The address is already on both of them and says so; nobody was asked
 * to read it. Fifty of the first seventy nine clients imported here were
 * somebody's housemate.
 *
 * Matched on the street line and the postcode with the punctuation taken out,
 * because "1560 SW 4TH Cir" and "1560 SW 4th Cir." are the same house and a
 * plain comparison says they are not. The postcode is in the key so that two
 * different towns with a Main Street are not proposed as one family.
 *
 * Only ever the reader's own clients: a household is made from them by
 * user_id, so proposing a colleague's client would be proposing something the
 * next step refuses.
 */
export async function suggestHouseholds(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, email, phone, address1, city, state, postcode
       FROM clients
      WHERE user_id = ? AND household_id IS NULL
        AND address1 IS NOT NULL AND TRIM(address1) != ''
      LIMIT 2000`
  ).bind(user.id).all();

  const flat = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const groups = new Map();
  for (const c of results || []) {
    const key = `${flat(c.address1)}|${flat(c.postcode).slice(0, 5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  return [...groups.values()]
    .filter((people) => people.length > 1)
    // Never silently. A group of nine at one address is a block of flats with
    // no unit numbers, not a family, and an advisor should see the size before
    // agreeing to it.
    .map((people) => ({
      name: suggestName(people.map((p) => p.name)),
      address: [people[0].address1, people[0].city, people[0].state]
        .filter(Boolean).join(', '),
      members: people.map(({ id, name, email, phone }) => ({ id, name, email, phone })),
    }))
    .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
}

export async function handleSuggestHouseholds(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const suggestions = await suggestHouseholds(env, user);
  return json({ suggestions });
}

export async function handleCreateHousehold(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const found = await ownClients(env, user.id, body.clientIds);
  if (found.length < 2) {
    return badRequest('Pick at least two people who live together.');
  }

  // Somebody already in a house is moved into this one rather than refused: a
  // client can only be in one household, and being told no here would mean
  // finding and dissolving the old one first for no reason.
  const id = uid();
  const ts = now();
  const name = clean(body.name, 120) || suggestName(found.map((c) => c.name));

  await env.DB.prepare(
    `INSERT INTO households (id, user_id, name, address, phone, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, name, cleanText(body.address, 300) || null,
         clean(body.phone, 40) || null, cleanText(body.notes, 2000) || null, ts, ts).run();

  const marks = found.map(() => '?').join(',');
  await env.DB.prepare(
    `UPDATE clients SET household_id = ?, updated_at = ?
      WHERE user_id = ? AND id IN (${marks})`
  ).bind(id, ts, user.id, ...found.map((c) => c.id)).run();

  await db.logActivity(env, user.id, 'household.create',
    `Made a household of ${found.length}: ${name}`, { id });

  return json({ ok: true, id, name, members: found.length }, 201);
}

export async function handleUpdateHousehold(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('The household needs a name.');

  const res = await env.DB.prepare(
    `UPDATE households SET name = ?, address = ?, phone = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(name, cleanText(body.address, 300) || null, clean(body.phone, 40) || null,
         cleanText(body.notes, 2000) || null, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Household not found.');

  return json({ ok: true });
}

/**
 * One household and everybody in it.
 *
 * The list gives a count, which is enough to pick one out and not enough to do
 * anything with it. This is what the household screen reads.
 */
export async function handleHouseholdRecord(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'h.user_id');
  const house = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM households h WHERE h.id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).first();
  if (!house) return notFound('Household not found.');

  const members = await membersOf(env, house.id, scope);
  return json({
    household: house,
    members,
    lifetimeCents: members.reduce((n, m) => n + (m.lifetime_cents || 0), 0),
    editable: house.user_id === user.id,
  });
}

/** Move somebody in. */
export async function handleAddMember(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const house = await env.DB.prepare(
    'SELECT id FROM households WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!house) return notFound('Household not found.');

  const body = await readJson(request);
  const found = await ownClients(env, user.id, [body.clientId]);
  if (!found.length) return notFound('Client not found.');

  await env.DB.prepare(
    'UPDATE clients SET household_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(id, now(), found[0].id, user.id).run();

  return json({ ok: true });
}

/**
 * Move somebody out.
 *
 * Their trips, credits and tasks are theirs and stay with them. A household
 * left with one person is dissolved, because one person is not a household and
 * leaving the row behind would put an empty badge on their name for ever.
 */
export async function handleRemoveMember(request, env, id, clientId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const res = await env.DB.prepare(
    `UPDATE clients SET household_id = NULL, updated_at = ?
      WHERE id = ? AND user_id = ? AND household_id = ?`
  ).bind(now(), clientId, user.id, id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('They are not in that household.');

  const left = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM clients WHERE household_id = ? AND user_id = ?'
  ).bind(id, user.id).first();

  let dissolved = false;
  if ((left?.n || 0) < 2) {
    await env.DB.prepare('UPDATE clients SET household_id = NULL WHERE household_id = ? AND user_id = ?')
      .bind(id, user.id).run();
    await env.DB.prepare('DELETE FROM households WHERE id = ? AND user_id = ?')
      .bind(id, user.id).run();
    dissolved = true;
  }

  return json({ ok: true, dissolved });
}

/** Break the household up. Everybody in it keeps everything they had. */
export async function handleDeleteHousehold(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const res = await env.DB.prepare('DELETE FROM households WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Household not found.');

  // Said outright rather than left to a foreign key, which is a setting on the
  // database and not a fact about this code.
  await env.DB.prepare('UPDATE clients SET household_id = NULL WHERE household_id = ? AND user_id = ?')
    .bind(id, user.id).run();

  return json({ ok: true });
}

/**
 * Who else is in this client's house, for a reservation being written.
 *
 * Answers by client id, because that is what the reservation form has in its
 * hand. Returns the parts a traveller row wants filled in and nothing else:
 * this is read while typing, not a client record.
 */
export async function handleHouseholdTravellers(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const clientId = clean(url.searchParams.get('client'), 64);
  const name = clean(url.searchParams.get('name'), 120);
  if (!clientId && !name) return json({ household: null, travellers: [] });

  const scope = db.selfScope(user);
  const client = clientId
    ? await env.DB.prepare(
      'SELECT id, name, household_id FROM clients WHERE id = ? AND user_id = ?'
    ).bind(clientId, user.id).first()
    : await env.DB.prepare(
      'SELECT id, name, household_id FROM clients WHERE name = ? AND user_id = ?'
    ).bind(name, user.id).first();

  if (!client || !client.household_id) return json({ household: null, travellers: [] });

  const house = await householdFor(env, client, scope);
  if (!house) return json({ household: null, travellers: [] });

  return json({
    household: { id: house.id, name: house.name, address: house.address },
    // Everybody except the person already on the booking.
    travellers: house.members
      .filter((m) => m.id !== client.id)
      // Everything the traveller rows on a reservation ask for, so booking a
      // household is a matter of ticking people rather than fetching four
      // passports off a shelf.
      .map((m) => ({
        clientId: m.id,
        name: m.name,
        email: m.email,
        phone: m.phone,
        dob: m.birthday,
        legalName: [m.legal_first, m.legal_middle, m.legal_last]
          .filter(Boolean).join(' ') || null,
        gender: m.gender || null,
        citizenship: m.citizenship || null,
        passportNumber: m.passport_number || null,
        passportCountry: m.passport_country || null,
        passportExpiry: m.passport_expiry || null,
      })),
  });
}
