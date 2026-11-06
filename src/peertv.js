// Asking Trip Vara what its advisors have booked on Margaritaville at Sea.
//
// The desk's members are not all on this portal. Lori and Dawn work in Trip
// Vara, which is a different Worker with a different database, so the join
// that brings a cabin onto a sheet here cannot reach them: until this, a
// reservation either of them took had to be typed onto the sheet by hand.
//
// Trip Vara answers one question and only that one. It hands back cabins
// already described, not rows from its schema, so nothing here knows how it
// stores a reservation, and it never sends commission.
//
// Matched on the sign in address. Somebody on the desk and an advisor over
// there are the same person when they are the same address, which is what an
// email already means in both portals, and it means nothing has to be linked
// by hand.

const CACHE_MS = 30000;
// The desk overview refreshes every group it lists, four calls on one page
// load today. The answer is the same for all of them, so it is fetched once.
let cache = { at: 0, people: null };

/** The addresses of everybody on the desk. */
async function deskEmails(env) {
  const { results } = await env.DB.prepare(
    `SELECT email, first_name, last_name FROM users
      WHERE agency_id IN (SELECT id FROM agencies WHERE is_desk = 1)
        AND status = 'active' AND email IS NOT NULL`
  ).all().catch(() => ({ results: [] }));
  return results || [];
}

/**
 * Everybody on the desk who also works in Trip Vara, and what they have booked.
 *
 * Quiet on every failure. A sheet that will not open because the other portal
 * is slow, or is mid deploy, or has no shared secret set yet, is worse than a
 * sheet missing a row somebody can still type in. Every caller gets an empty
 * list and carries on.
 */
export async function tripVaraPeople(env) {
  if (!env.PEER || !env.PEER_SECRET) return [];
  if (cache.people && Date.now() - cache.at < CACHE_MS) return cache.people;

  const members = await deskEmails(env);
  if (!members.length) return [];

  const base = String(env.PEER_APP_URL || 'https://tripvaratravel.com').replace(/\/+$/, '');
  try {
    const res = await Promise.race([
      env.PEER.fetch(new Request(`${base}/api/peer/mas-bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Peer-Secret': env.PEER_SECRET },
        body: JSON.stringify({ emails: members.map((m) => m.email) }),
      })),
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    if (!res || !res.ok) return [];
    const data = await res.json();
    const people = (data && Array.isArray(data.people) ? data.people : []).map((p) => {
      // The name the desk already knows wins over the one the other portal
      // sent, so a sheet does not call the same person two different things.
      const mine = members.find((m) => String(m.email).toLowerCase() === String(p.email).toLowerCase());
      const named = mine ? `${mine.first_name || ''} ${mine.last_name || ''}`.trim() : '';
      return { ...p, name: named || p.name || '' };
    });
    cache = { at: Date.now(), people };
    return people;
  } catch (e) {
    console.error('trip vara bridge', e);
    return [];
  }
}

/** Forget what was fetched. For the tests, and for a sheet that has just been written to. */
export function forgetTripVara() {
  cache = { at: 0, people: null };
}
