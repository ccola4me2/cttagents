// Global search across the things an advisor looks up by name.
//
// A CRM is mostly lookup. Without this you have to know which screen a person
// or a trip lives on before you can find them, which is backwards: you know
// the client's name, and the screen is what you are trying to get to.
//
// Everything here reads the local mirror and the local reservations, so it
// answers at database speed and keeps working when the upstream API does not.

import { json } from './util.js';
import { tenantFor } from './tenant.js';
import { requireUser, isAdmin } from './auth.js';
import * as db from './db.js';

const PER_GROUP = 6;

/** SQL LIKE with the wildcards escaped, so a search for 100% finds 100%. */
function like(term) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function handleSearch(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  // Two characters matches half the database and helps nobody.
  if (q.length < 2) return json({ query: q, groups: [], total: 0 });

  const term = like(q);
  const agencyId = tenantFor(env, user);
  // Same rule as every other screen: an associate finds their own records,
  // an owner finds the agency's.
  const scope = db.scopeFor(env, user, request);
  const bookingScope = db.scopeWhere(scope, 'b.user_id');
  const paymentScope = db.scopeWhere(scope, 'p.user_id');

  // Owners only, and while not sitting in somebody's seat.
  //
  // crm_contacts is the mirror of the old CRM: nothing has written to it since
  // that was dropped, and its rows belong to no advisor, only to the agency.
  // Searched by agency alone it handed every advisor every contact's name,
  // email and phone, including people who were never theirs. The advisor's own
  // clients are found by the group below, which is fenced to their
  // reservations; this one is left for whoever runs the agency.
  const readsMirror = isAdmin(user) && !user.acting_as;

  const [clients, reservations, payments] = await Promise.all([
    readsMirror
      ? env.DB.prepare(
        `SELECT id, name, email, phone FROM crm_contacts
          WHERE agency_id = ?
            AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')
          ORDER BY LENGTH(COALESCE(name, '')) ASC LIMIT ?`
      ).bind(agencyId, term, term, term, PER_GROUP).all().catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),

    env.DB.prepare(
      `SELECT b.id, b.client_name, b.supplier, b.product_name, b.destination,
              b.confirmation_number, b.depart_date, b.status
         FROM bookings b
        WHERE ${bookingScope.sql}
          AND (b.client_name LIKE ? ESCAPE '\\' OR b.supplier LIKE ? ESCAPE '\\'
               OR b.product_name LIKE ? ESCAPE '\\' OR b.confirmation_number LIKE ? ESCAPE '\\'
               OR b.destination LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC LIMIT ?`
    ).bind(...bookingScope.binds, term, term, term, term, term, PER_GROUP)
     .all().catch(() => ({ results: [] })),

    // Worth its own group: chasing a payment usually starts from the client's
    // name, and the answer wanted is the date, not the reservation record.
    env.DB.prepare(
      `SELECT p.id, p.kind, p.payment_class, p.amount_cents, p.due_date, p.paid_date,
              b.client_name, b.supplier
         FROM booking_payments p JOIN bookings b ON b.id = p.booking_id
        WHERE ${paymentScope.sql} AND p.paid_date IS NULL
          AND (b.client_name LIKE ? ESCAPE '\\' OR b.supplier LIKE ? ESCAPE '\\'
               OR b.confirmation_number LIKE ? ESCAPE '\\')
        ORDER BY p.due_date ASC LIMIT ?`
    ).bind(...paymentScope.binds, term, term, term, PER_GROUP)
     .all().catch(() => ({ results: [] })),
  ]);

  // Clients as this portal knows them. Two sources, because a client is not
  // always on a reservation: somebody added to a household, imported from a
  // confirmation or kept as a prospect is a client with no trip yet, and a
  // search that only read reservations answered "Nothing matches" for a
  // person who was right there on the client list.
  const clientScope = db.scopeWhere(scope, 'c.user_id');
  const [listedClients, localClients] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.name, c.email, c.phone,
              (SELECT COUNT(*) FROM bookings b WHERE b.client_id = c.id) AS trips
         FROM clients c
        WHERE ${clientScope.sql}
          AND (c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')
        ORDER BY LENGTH(c.name) ASC LIMIT ?`
    ).bind(...clientScope.binds, term, term, term, PER_GROUP).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT b.client_name, COUNT(*) AS trips, MAX(b.supplier) AS vendor,
              MAX(COALESCE(b.return_date, b.depart_date)) AS last_date
         FROM bookings b
        WHERE ${bookingScope.sql} AND b.client_name LIKE ? ESCAPE '\\'
        GROUP BY b.client_name ORDER BY last_date DESC LIMIT ?`
    ).bind(...bookingScope.binds, term, PER_GROUP).all().catch(() => ({ results: [] })),
  ]);

  // Everything else somebody looks up by name. The scope is the same one as above, so an
  // owner reaches across the agency and an advisor reaches their own book; the last three
  // are the agency's own business and are read for an owner only.
  const ownerView = readsMirror;
  const ask = (sql, binds) => env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] }));
  const likeAny = (cols) => `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  const terms = (n) => Array(n).fill(term);
  const groupScope = db.scopeWhere(scope, 'g.user_id');
  const guestScope = db.scopeWhere(scope, 'r.user_id');
  const travellerScope = db.scopeWhere(scope, 't.user_id');
  const tripScope = db.scopeWhere(scope, 't.user_id');
  const houseScope = db.scopeWhere(scope, 'h.user_id');
  const taskScope = db.scopeWhere(scope, 'k.user_id');
  const vendorScope = db.scopeWhere(db.agencyScope(user), 'v.user_id');

  const [groupRows, guestRows, travellerRows, tripRows, houseRows, vendorRows, taskRows,
    specialRows, advisorRows, eventRows, checkRows] = await Promise.all([
    ask(`SELECT g.id, g.name, g.vendor, g.destination, g.depart_date, g.status
           FROM travel_groups g
          WHERE ${groupScope.sql}
            AND ${likeAny(['g.name', 'g.vendor', 'g.product_name', 'g.destination', 'g.group_code', 'g.group_number'])}
          ORDER BY COALESCE(g.depart_date, '9999-12-31') ASC LIMIT ?`,
    [...groupScope.binds, ...terms(6), PER_GROUP]),

    ask(`SELECT r.id, r.group_id, r.name, r.email, r.phone, g.name AS groupName
           FROM group_registrations r JOIN travel_groups g ON g.id = r.group_id
          WHERE ${guestScope.sql} AND ${likeAny(['r.name', 'r.email', 'r.phone'])}
          ORDER BY r.created_at DESC LIMIT ?`,
    [...guestScope.binds, ...terms(3), PER_GROUP]),

    // Never searched by passport: that number is encrypted for a reason.
    ask(`SELECT t.id, t.booking_id, t.name, t.email, t.phone, b.client_name
           FROM travellers t JOIN bookings b ON b.id = t.booking_id
          WHERE ${travellerScope.sql} AND ${likeAny(['t.name', 't.email', 't.phone'])}
          ORDER BY t.created_at DESC LIMIT ?`,
    [...travellerScope.binds, ...terms(3), PER_GROUP]),

    ask(`SELECT t.id, t.name FROM trips t
          WHERE ${tripScope.sql} AND ${likeAny(['t.name'])}
          ORDER BY t.updated_at DESC LIMIT ?`,
    [...tripScope.binds, ...terms(1), PER_GROUP]),

    ask(`SELECT h.id, h.name, h.address, h.phone FROM households h
          WHERE ${houseScope.sql} AND ${likeAny(['h.name', 'h.address', 'h.phone'])}
          ORDER BY h.name ASC LIMIT ?`,
    [...houseScope.binds, ...terms(3), PER_GROUP]),

    // The directory is the agency's, and each advisor may have entered the same
    // supplier, so more is read than shown and the repeats are dropped below.
    ask(`SELECT v.id, v.name, v.category FROM vendors v
          WHERE ${vendorScope.sql} AND ${likeAny(['v.name', 'v.bdm_name', 'v.account_number'])}
          ORDER BY v.name ASC LIMIT ?`,
    [...vendorScope.binds, ...terms(3), PER_GROUP * 4]),

    ask(`SELECT k.id, k.title, k.due_date, k.done_at FROM tasks k
          WHERE ${taskScope.sql} AND ${likeAny(['k.title', 'k.notes'])}
          ORDER BY (k.done_at IS NOT NULL) ASC, COALESCE(k.due_date, '9999-12-31') ASC LIMIT ?`,
    [...taskScope.binds, ...terms(2), PER_GROUP]),

    // The agency's weekly supplier offers: read by anyone in the agency.
    agencyId
      ? ask(`SELECT id, brand, headline, program, offer FROM supplier_specials
              WHERE agency_id = ? AND ${likeAny(['brand', 'headline', 'program', 'offer', 'code'])}
              ORDER BY brand ASC LIMIT ?`,
        [agencyId, ...terms(5), PER_GROUP])
      : Promise.resolve({ results: [] }),

    ownerView && agencyId
      ? ask(`SELECT id, first_name, last_name, email, phone, role FROM users
              WHERE agency_id = ? AND ${likeAny(["COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')", 'email', 'phone'])}
              ORDER BY first_name ASC LIMIT ?`,
        [agencyId, ...terms(3), PER_GROUP])
      : Promise.resolve({ results: [] }),

    ownerView && agencyId
      ? ask(`SELECT id, title, vendor, on_date FROM agency_events
              WHERE agency_id = ? AND cancelled_at IS NULL AND ${likeAny(['title', 'vendor', 'notes'])}
              ORDER BY on_date DESC LIMIT ?`,
        [agencyId, ...terms(3), PER_GROUP])
      : Promise.resolve({ results: [] }),

    ownerView && agencyId
      ? ask(`SELECT id, vendor_name, reference, received_on FROM commission_checks
              WHERE agency_id = ? AND ${likeAny(['vendor_name', 'reference', 'trace_number'])}
              ORDER BY received_on DESC LIMIT ?`,
        [agencyId, ...terms(3), PER_GROUP])
      : Promise.resolve({ results: [] }),
  ]);

  const groups = [];

  // The client list first, then any name that only appears on a reservation.
  const people = (listedClients.results || []).map((c) => ({
    id: c.id,
    title: c.name,
    subtitle: [c.email || c.phone, `${c.trips} trip${c.trips === 1 ? '' : 's'}`]
      .filter(Boolean).join('  ·  '),
    href: `/app/client?id=${encodeURIComponent(c.id)}`,
  }));
  const seen = new Set(people.map((p) => p.title.trim().toLowerCase()));
  for (const c of localClients.results || []) {
    if (seen.has(String(c.client_name).trim().toLowerCase())) continue;
    people.push({
      id: c.client_name,
      title: c.client_name,
      subtitle: [c.vendor, `${c.trips} trip${c.trips === 1 ? '' : 's'}`].filter(Boolean).join('  ·  '),
      href: `/app/client?name=${encodeURIComponent(c.client_name)}`,
    });
  }
  if (people.length) {
    groups.push({ type: 'people', label: 'Clients', items: people.slice(0, PER_GROUP) });
  }

  const clientRows = clients.results || [];
  if (clientRows.length) {
    groups.push({
      type: 'contacts', label: 'CRM contacts',
      items: clientRows.map((c) => ({
        id: c.id,
        title: c.name || c.email || c.phone || 'Unnamed contact',
        subtitle: [c.email, c.phone].filter(Boolean).join('  ·  '),
        href: `/app/contact?id=${encodeURIComponent(c.id)}`,
      })),
    });
  }

  const resRows = reservations.results || [];
  if (resRows.length) {
    groups.push({
      type: 'reservations', label: 'Reservations',
      items: resRows.map((b) => ({
        id: b.id,
        title: b.client_name,
        subtitle: [b.supplier, b.product_name || b.destination,
                   b.confirmation_number ? `Conf ${b.confirmation_number}` : '']
          .filter(Boolean).join('  ·  '),
        badge: b.status,
        href: `/app/reservation?id=${encodeURIComponent(b.id)}`,
      })),
    });
  }

  const payRows = payments.results || [];
  if (payRows.length) {
    groups.push({
      type: 'payments', label: 'Payments due',
      items: payRows.map((p) => ({
        id: p.id,
        title: p.client_name,
        subtitle: [p.supplier, `${p.kind} due ${p.due_date || 'no date'}`].filter(Boolean).join('  ·  '),
        badge: p.payment_class,
        amountCents: p.amount_cents,
        href: '/app/payments',
      })),
    });
  }


  const group = (type, label, rows, make) => {
    const items = (rows.results || []).map(make);
    if (items.length) groups.push({ type, label, items });
  };
  const enc = encodeURIComponent;
  const people_ = (r) => [r.email || r.phone, r.groupName || r.client_name].filter(Boolean).join('  ·  ');

  group('groups', 'Groups', groupRows, (g) => ({
    id: g.id, title: g.name,
    subtitle: [g.vendor, g.destination, g.depart_date].filter(Boolean).join('  ·  '),
    badge: g.status, href: `/app/group?id=${enc(g.id)}`,
  }));
  group('guests', 'Group guests', guestRows, (r) => ({
    id: r.id, title: r.name, subtitle: people_(r), href: `/app/group?id=${enc(r.group_id)}`,
  }));
  group('travellers', 'Travellers', travellerRows, (r) => ({
    id: r.id, title: r.name, subtitle: people_(r), href: `/app/reservation?id=${enc(r.booking_id)}`,
  }));
  group('trips', 'Trips', tripRows, (t) => ({
    id: t.id, title: t.name, subtitle: '', href: `/app/trip?id=${enc(t.id)}`,
  }));
  group('households', 'Households', houseRows, (h) => ({
    id: h.id, title: h.name, subtitle: [h.address, h.phone].filter(Boolean).join('  ·  '),
    href: '/app/households',
  }));
  const seenVendor = new Set();
  group('vendors', 'Vendors', {
    results: (vendorRows.results || []).filter((v) => {
      const key = String(v.name).trim().toLowerCase();
      if (seenVendor.has(key)) return false;
      seenVendor.add(key);
      return true;
    }).slice(0, PER_GROUP),
  }, (v) => ({
    id: v.id, title: v.name, subtitle: v.category || '', href: `/app/vendor?id=${enc(v.id)}`,
  }));
  group('tasks', 'To-dos', taskRows, (k) => ({
    id: k.id, title: k.title, subtitle: k.due_date ? `due ${k.due_date}` : '',
    badge: k.done_at ? 'done' : '', href: '/app/tasks',
  }));
  group('specials', 'Supplier specials', specialRows, (s) => ({
    id: s.id, title: [s.brand, s.headline || s.program].filter(Boolean).join(': '),
    subtitle: s.offer || '', href: `/app/supplier-specials?q=${enc(s.brand || q)}`,
  }));
  group('advisors', 'Advisors', advisorRows, (u) => ({
    id: u.id, title: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
    subtitle: [u.email, u.phone].filter(Boolean).join('  ·  '), badge: u.role, href: '/admin/',
  }));
  group('events', 'Trainings and events', eventRows, (e) => ({
    id: e.id, title: e.title, subtitle: [e.vendor, e.on_date].filter(Boolean).join('  ·  '),
    href: '/admin/events',
  }));
  group('checks', 'Commission checks', checkRows, (c) => ({
    id: c.id, title: c.vendor_name, subtitle: [c.reference, c.received_on].filter(Boolean).join('  ·  '),
    href: '/admin/commissions',
  }));

  return json({
    query: q,
    groups,
    total: groups.reduce((n, g) => n + g.items.length, 0),
  });
}
