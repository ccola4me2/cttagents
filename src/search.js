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
import { requireUser } from './auth.js';
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
  const locationId = tenantFor(env, user);
  // Same rule as every other screen: an associate finds their own records,
  // an owner finds the agency's.
  const scope = db.scopeFor(env, user, request);
  const bookingScope = db.scopeWhere(scope, 'b.user_id');
  const paymentScope = db.scopeWhere(scope, 'p.user_id');

  const [clients, reservations, payments] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, email, phone FROM crm_contacts
        WHERE location_id = ?
          AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')
        ORDER BY LENGTH(COALESCE(name, '')) ASC LIMIT ?`
    ).bind(locationId, term, term, term, PER_GROUP).all().catch(() => ({ results: [] })),

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

  // Clients as this portal knows them, from reservations. The CRM group above
  // needs a synced mirror; this one works on the day a trip is entered.
  const localClients = await env.DB.prepare(
    `SELECT b.client_name, COUNT(*) AS trips, MAX(b.supplier) AS vendor,
            MAX(COALESCE(b.return_date, b.depart_date)) AS last_date
       FROM bookings b
      WHERE ${bookingScope.sql} AND b.client_name LIKE ? ESCAPE '\\'
      GROUP BY b.client_name ORDER BY last_date DESC LIMIT ?`
  ).bind(...bookingScope.binds, term, PER_GROUP).all().catch(() => ({ results: [] }));

  const groups = [];

  const clientRows2 = localClients.results || [];
  if (clientRows2.length) {
    groups.push({
      type: 'people', label: 'Clients',
      items: clientRows2.map((c) => ({
        id: c.client_name,
        title: c.client_name,
        subtitle: [c.vendor, `${c.trips} trip${c.trips === 1 ? '' : 's'}`].filter(Boolean).join('  ·  '),
        href: `/app/client?name=${encodeURIComponent(c.client_name)}`,
      })),
    });
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

  return json({
    query: q,
    groups,
    total: groups.reduce((n, g) => n + g.items.length, 0),
  });
}
