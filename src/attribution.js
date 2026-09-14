// Where clients come from, and what each channel is worth.
//
// The portal was good at recording and chasing what already existed and had no
// way to say what any of it earned. `clients.source` was free text, so Facebook
// and facebook and FB were three channels and no query could add them up, and
// `bookings.lead_source` is not this at all: it holds whether the agency handed
// the advisor the lead, and it exists to decide a commission split.
//
// So the question "what should I do more of" could not be asked. This answers
// it, from one rule:
//
//   A client has one origin. A reservation is attributed to the client's.
//
// Which is how a travel agency actually works. You do not re-acquire somebody
// who books a second cruise, and a channel that brought one client who has
// booked four trips is worth what all four are worth. First and repeat
// reservations are counted apart so the two readings are both available.
//
// Nothing is guessed. A client with no channel recorded is counted as exactly
// that and said out loud, because a blank is a fact about your bookkeeping and
// a wrong channel is a number somebody makes a decision on.

import { json } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { EARNED_SQL } from './split.js';

/**
 * The channels, in the words an advisor would use.
 *
 * Deliberately short. A list nobody can hold in their head is a list where the
 * same lead gets filed three ways, which is the free-text problem again with
 * extra steps. The detail goes in `source`, which is still there and still free.
 */
export const SOURCE_KINDS = [
  { id: 'referral', name: 'Referral', hint: 'A client or a friend sent them' },
  { id: 'website', name: 'Website', hint: 'The agency site, or one of your forms' },
  { id: 'social', name: 'Social', hint: 'Anywhere you post and do not pay to be seen' },
  { id: 'advertising', name: 'Advertising', hint: 'Anything you paid to be seen on' },
  { id: 'group', name: 'Group trip', hint: 'They came in through group space' },
  { id: 'event', name: 'Event', hint: 'A show, a party, a presentation' },
  { id: 'partner', name: 'Partner', hint: 'A vendor, a host agency, another business' },
  { id: 'company', name: 'The agency', hint: 'The agency handed you the lead' },
  { id: 'walk_in', name: 'Walk in', hint: 'They rang or came by unprompted' },
  { id: 'other', name: 'Something else', hint: 'Recorded, and none of the above' },
];

export const SOURCE_KIND_IDS = SOURCE_KINDS.map((s) => s.id);

/** The name for a channel, and something readable for one nobody recorded. */
export const sourceKindName = (id) =>
  (SOURCE_KINDS.find((s) => s.id === id) || {}).name || 'Not recorded';

// Counted as production everywhere else in the portal, so counted as production
// here. A quote is not a sale and a cancelled trip is not either.
const SOLD = "b.status IN ('booked','travelled')";

export async function handleAttribution(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const c = db.scopeWhere(scope, 'c.user_id');
  const earned = EARNED_SQL('b.commission_cents', 'b.commission_status');

  // First or repeat, decided by whether anything of theirs was taken earlier.
  // Created_at rather than departure: this is about the sale, and the sale
  // happened when it was written down.
  const isFirst = `NOT EXISTS (SELECT 1 FROM bookings e
    WHERE e.client_id = b.client_id AND e.status IN ('booked','travelled')
      AND (e.created_at < b.created_at OR (e.created_at = b.created_at AND e.id < b.id)))`;

  const [byKind, referrers, loose] = await Promise.all([
    env.DB.prepare(
      `SELECT c.source_kind AS kind,
              COUNT(DISTINCT c.id) AS clients,
              COUNT(DISTINCT CASE WHEN b.id IS NOT NULL THEN c.id END) AS booked_clients,
              COUNT(b.id) AS bookings,
              SUM(CASE WHEN b.id IS NOT NULL AND ${isFirst} THEN 1 ELSE 0 END) AS first_bookings,
              COALESCE(SUM(b.gross_cents), 0) AS gross_cents,
              COALESCE(SUM(${earned}), 0) AS commission_cents
         FROM clients c
         LEFT JOIN bookings b ON b.client_id = c.id AND ${SOLD}
        WHERE ${c.sql}
        GROUP BY c.source_kind`
    ).bind(...c.binds).all().catch(() => ({ results: [] })),

    // Who sends you people, worth the most first. The reason to record a
    // referral at all: a name here is somebody to ring or to thank.
    env.DB.prepare(
      `SELECT r.id, r.name,
              COUNT(DISTINCT c.id) AS sent,
              COUNT(DISTINCT CASE WHEN b.id IS NOT NULL THEN c.id END) AS booked,
              COALESCE(SUM(b.gross_cents), 0) AS gross_cents
         FROM clients c
         JOIN clients r ON r.id = c.referred_by_client_id
         LEFT JOIN bookings b ON b.client_id = c.id AND ${SOLD}
        WHERE ${c.sql}
        GROUP BY r.id, r.name
        ORDER BY gross_cents DESC, sent DESC
        LIMIT 12`
    ).bind(...c.binds).all().catch(() => ({ results: [] })),

    // Reservations attached to no client record at all. They are in no channel
    // and cannot be, and a report that quietly leaves them out is a report
    // whose total does not match the one on the next page.
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(b.gross_cents), 0) AS gross_cents
         FROM bookings b
        WHERE ${db.scopeWhere(scope, 'b.user_id').sql} AND ${SOLD}
          AND (b.client_id IS NULL OR b.client_id = '')`
    ).bind(...db.scopeWhere(scope, 'b.user_id').binds).first().catch(() => null),
  ]);

  const rows = (byKind.results || []).map((r) => ({
    kind: r.kind || null,
    name: sourceKindName(r.kind),
    clients: r.clients || 0,
    bookedClients: r.booked_clients || 0,
    bookings: r.bookings || 0,
    firstBookings: r.first_bookings || 0,
    repeatBookings: (r.bookings || 0) - (r.first_bookings || 0),
    grossCents: r.gross_cents || 0,
    commissionCents: r.commission_cents || 0,
    // What one client from this channel has been worth so far. The number that
    // decides where the next hour goes, and the one a total hides: a channel
    // with four clients and every one of them booking beats forty who did not.
    perClientCents: r.clients ? Math.round((r.gross_cents || 0) / r.clients) : 0,
  })).sort((a, b) => b.grossCents - a.grossCents || b.clients - a.clients);

  return json({
    kinds: SOURCE_KINDS,
    rows,
    referrers: (referrers.results || []).map((r) => ({
      id: r.id, name: r.name, sent: r.sent || 0,
      booked: r.booked || 0, grossCents: r.gross_cents || 0,
    })),
    // Said rather than dropped.
    unattributed: {
      bookings: (loose && loose.n) || 0,
      grossCents: (loose && loose.gross_cents) || 0,
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}
