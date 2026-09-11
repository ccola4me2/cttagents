// Clients as records: who they are, what they have bought, what they are owed.
//
// Built from this portal's own data rather than from the CRM mirror. The CRM
// knows who someone is; this knows what they have bought, what they are owed
// and when they last travelled, and it keeps working when the upstream API
// does not. A client who has never been synced but has three trips on file is
// still a client.
//
// A client record is created as a side effect of taking a reservation or
// recording a credit, so nobody has to maintain a list of people before they
// can do the work. Contact details are added afterwards, when there is a
// reason to.

import { json, badRequest, notFound, clean, cleanDate, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import * as ghl from './ghl.js';
import { householdFor } from './households.js';

export async function handleListClients(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const scope = db.scopeFor(env, user, request);
  const query = clean(url.searchParams.get('q'), 80);
  const clients = await db.listClients(env, scope, {
    limit: url.searchParams.get('limit'),
    query,
    pinnedOnly: url.searchParams.get('pinned') === '1',
  });
  // One row past the cap, so the page can say it was cut. Filtering a list
  // that is already short is how a search for somebody who exists comes back
  // with nothing.
  const { rows: shown, truncated } = db.capped(clients, url.searchParams.get('limit'), db.CLIENT_CAP);

  // People who are in the CRM but have never been booked here.
  //
  // A client record only exists once somebody has made a reservation, so the
  // first time an advisor books an existing contact they type a name the
  // portal already knows and creates a second version of a person the CRM has
  // held for a year. These are offered alongside the local ones, marked as
  // coming from the CRM, and become client records the moment one is used.
  //
  // Read from the synced copy rather than GoHighLevel itself: a typeahead
  // fires on every keystroke, and that is not a thing to do to an API.
  let fromCrm = [];
  if (query && query.length >= 2) {
    const known = new Set(clients.map((c) => c.name.trim().toLowerCase()));
    const { contacts } = await db.localContacts(env, ghl.locationFor(env, user), {
      query, limit: 8,
    });
    fromCrm = (contacts || [])
      .filter((c) => c.name && !known.has(c.name.trim().toLowerCase()))
      .slice(0, 8)
      .map((c) => ({
        id: null, contactId: c.id, name: c.name, email: c.email || '',
        phone: c.phone || '', source: 'crm', trips: 0,
      }));
  }

  return json({
    clients: shown,
    truncated,
    cap: db.CLIENT_CAP,
    fromCrm,
    stats: {
      total: shown.length,
      pinned: shown.filter((c) => c.pinned_at).length,
      // Somebody who has travelled and has nothing ahead of them. The same
      // question the dashboard asks, answerable from this list too.
      lapsed: shown.filter((c) => c.last_date && !c.next_date).length,
      lifetimeCents: shown.reduce((n, c) => n + (c.lifetime_cents || 0), 0),
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

export async function handleClientRecord(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const id = clean(url.searchParams.get('id'), 64);
  const name = clean(url.searchParams.get('name'), 120);
  if (!id && !name) return notFound('No client was named.');

  const scope = db.scopeFor(env, user, request);
  const client = await db.getClient(env, scope, { id, name });
  if (!client) return notFound('Client not found.');

  const bScope = db.scopeWhere(scope, 'b.user_id');
  const cScope = db.scopeWhere(scope, 'c.user_id');
  const tScope = db.scopeWhere(scope, 't.user_id');
  const today = new Date().toISOString().slice(0, 10);

  const [bookings, credits, tasks, household] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id, b.client_name, b.supplier, b.product_name, b.product_type, b.destination,
              b.confirmation_number, b.depart_date, b.return_date, b.status,
              b.gross_cents, b.commission_cents, b.commission_status, b.travellers,
              b.ghl_contact_id, b.user_id,
              COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                AS advisor_name
         FROM bookings b LEFT JOIN users u ON u.id = b.user_id
        WHERE ${bScope.sql} AND b.client_id = ?
        ORDER BY COALESCE(b.depart_date, '9999-12-31') DESC LIMIT 200`
    ).bind(...bScope.binds, client.id).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT c.id, c.vendor, c.kind, c.amount_cents, c.expires_on, c.used_on, c.reference
         FROM client_credits c WHERE ${cScope.sql} AND c.client_id = ?
        ORDER BY COALESCE(c.expires_on, '9999-12-31') ASC`
    ).bind(...cScope.binds, client.id).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.priority, t.done_at
         FROM tasks t JOIN bookings b ON b.id = t.booking_id
        WHERE ${tScope.sql} AND b.client_id = ?
        ORDER BY t.done_at IS NOT NULL ASC, COALESCE(t.due_date, '9999-12-31') ASC LIMIT 50`
    ).bind(...tScope.binds, client.id).all().catch(() => ({ results: [] })),

    // Who else lives there. Best effort: a client record that cannot load its
    // household is still a client record worth reading.
    householdFor(env, client, scope).catch(() => null),
  ]);

  const rows = bookings.results || [];
  const counted = rows.filter((b) => b.status === 'booked' || b.status === 'travelled');
  const past = counted.filter((b) => (b.return_date || b.depart_date) < today);
  const upcoming = counted.filter((b) => (b.return_date || b.depart_date) >= today);
  const liveCredits = (credits.results || []).filter((c) => !c.used_on);

  return json({
    client: {
      ...client,
      trips: counted.length,
      lifetimeCents: counted.reduce((n, b) => n + (b.gross_cents || 0), 0),
      commissionCents: counted.reduce((n, b) => n + (b.commission_cents || 0), 0),
      firstTravelled: past.length ? past[past.length - 1].depart_date : null,
      lastTravelled: past.length ? (past[0].return_date || past[0].depart_date) : null,
      // The one thing an advisor wants to know before they ring: is anything
      // already on the books.
      nextDeparture: upcoming.length ? upcoming[upcoming.length - 1].depart_date : null,
      vendors: [...new Set(counted.map((b) => b.supplier).filter(Boolean))],
      creditCents: liveCredits.reduce((n, c) => n + (c.amount_cents || 0), 0),
    },
    bookings: rows,
    credits: credits.results || [],
    tasks: tasks.results || [],
    editable: client.user_id === user.id,
    // Who else lives there, what the house is worth together, and the address
    // they share. Null when they live alone as far as the portal knows.
    household,
    today,
    scope: db.scopeLabel(scope, user),
  });
}

/**
 * A client the agency has met but not yet booked.
 *
 * Until now the only way a client record came into being was as a side effect
 * of taking a reservation, which is right for the common case and wrong for
 * the one that comes first: somebody rings, you take their details, and the
 * trip is a fortnight of conversation away. There was nowhere to put them.
 *
 * resolveClient does the insert, so a name that already exists comes back as
 * the person who has it rather than as a second copy of them.
 */
export async function handleCreateClient(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('A client needs a name.');

  // Asked before creating, rather than worked out afterwards from how recent
  // the row looks. resolveClient is happy either way; the caller wants to be
  // told which happened.
  const before = await db.getClient(env, db.selfScope(user), { name });
  const existed = Boolean(before);

  const existingId = await db.resolveClient(env, user.id, name);
  if (!existingId) return badRequest('A client needs a name.');

  // Everything else is optional and written over the top, so adding somebody
  // who turns out to be already known fills in what was missing rather than
  // refusing, and never blanks what was already there.
  const keep = (incoming, current) => (incoming === undefined || incoming === null
    || String(incoming).trim() === '' ? (current || null) : incoming);

  await env.DB.prepare(
    `UPDATE clients SET email = ?, phone = ?, notes = ?, birthday = ?, anniversary = ?,
       updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(
    keep(clean(body.email, 160), before?.email),
    keep(clean(body.phone, 40), before?.phone),
    keep(clean(body.notes, 4000), before?.notes),
    keep(cleanDate(body.birthday), before?.birthday),
    keep(cleanDate(body.anniversary), before?.anniversary),
    now(), existingId, user.id
  ).run();

  await db.logActivity(env, user.id, 'client.create', `Added ${name}`, { id: existingId });
  return json({
    ok: true,
    existing: existed,
    client: await db.getClient(env, db.selfScope(user), { id: existingId }),
  }, 201);
}

export async function handleUpdateClient(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);

  // Pinning is its own shape: it happens from a list, constantly, and should
  // not require sending a whole client back to say "this one matters today".
  if (Object.prototype.hasOwnProperty.call(body, 'pinned')) {
    const res = await env.DB.prepare(
      'UPDATE clients SET pinned_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(body.pinned ? now() : null, now(), id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Client not found.');
    return json({ ok: true });
  }

  const name = clean(body.name, 120);
  if (!name) return badRequest('A client needs a name.');

  // The name is the key reservations were matched on before this table
  // existed, so renaming has to carry them along or the trips would be
  // orphaned from the person who took them.
  const res = await env.DB.prepare(
    `UPDATE clients SET name = ?, email = ?, phone = ?, notes = ?,
       birthday = ?, anniversary = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(name, clean(body.email, 160) || null, clean(body.phone, 40) || null,
         clean(body.notes, 4000) || null,
         // Kept as written, year and all. A birthday with no year is still a
         // birthday, but the field is a date input and half of these arrive
         // from a passport, so there is no reason to throw the year away.
         cleanDate(body.birthday), cleanDate(body.anniversary),
         now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Client not found.');

  // A rename that reaches the client and not their reservations leaves the
  // same person under two names, so a failure here is the caller's problem.
  await env.DB.prepare('UPDATE bookings SET client_name = ? WHERE client_id = ? AND user_id = ?')
    .bind(name, id, user.id).run();
  await env.DB.prepare('UPDATE client_credits SET client_name = ? WHERE client_id = ? AND user_id = ?')
    .bind(name, id, user.id).run();

  return json({ ok: true, client: await db.getClient(env, db.selfScope(user), { id }) });
}
