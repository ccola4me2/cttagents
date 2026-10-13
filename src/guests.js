// Everyone named on a confirmation becomes a client, and the party becomes a household.
//
// Reading a confirmation used to file the lead guest under a bare name and stop there: the
// other travellers were not on the books at all, and nobody's birthday was kept. This is the
// step after the reservation exists. It makes a client record for each guest, fills in what
// the confirmation said, and puts the party in one household so the next booking offers them
// together.
//
// Two rules decide how much it does on its own. A person who is not on the books yet is simply
// added, with everything that was read, because there is nothing to overwrite. A person who is
// already on the books keeps what is on file until the advisor says otherwise: every blank that
// would be filled and every difference that would be replaced is listed first, and only the
// ones ticked are written. The page asks with preview: true, then sends the answers back.

import { json, badRequest, clean, cleanDate, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { createHousehold } from './households.js';

// A cabin holds at most a handful and a group booking a few dozen. More than this is not one
// confirmation's party, it is a paste that went wrong.
const MAX_GUESTS = 20;

const FIELDS = ['birthday', 'email', 'phone'];

const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const SAME = {
  birthday: (a, b) => String(a).slice(0, 10) === String(b).slice(0, 10),
  email: (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase(),
  phone: (a, b) => digits(a) !== '' && digits(a) === digits(b),
};

function readGuests(body) {
  const list = Array.isArray(body.guests) ? body.guests.slice(0, MAX_GUESTS) : [];
  const seen = new Set();
  const out = [];
  for (const g of list) {
    const name = clean(g && g.name, 120);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      birthday: cleanDate(g.birthday) || null,
      email: clean(g.email, 160) || null,
      phone: clean(g.phone, 40) || null,
    });
  }
  return out;
}

/** The client already on this advisor's books for a guest: by address first, then by name. */
async function findClient(env, user, guest) {
  let found = null;
  if (guest.email) {
    found = await env.DB.prepare(
      `SELECT ${db.CLIENT_COLUMNS} FROM clients c
        WHERE c.user_id = ? AND LOWER(TRIM(c.email)) = LOWER(TRIM(?)) LIMIT 1`
    ).bind(user.id, guest.email).first().catch(() => null);
  }
  if (!found) found = await db.getClient(env, db.selfScope(user), { name: guest.name });
  return found || null;
}

/** What would change on a client that already exists, one entry per field. */
function differences(client, guest) {
  const out = [];
  for (const field of FIELDS) {
    const incoming = guest[field];
    if (!incoming) continue;
    const current = client[field];
    if (!current) out.push({ field, kind: 'add', current: null, incoming });
    else if (!SAME[field](current, incoming)) out.push({ field, kind: 'change', current, incoming });
  }
  return out;
}

/** What to do about a household, from where the guests already live. */
function householdPlan(found) {
  if (found.length < 2) return { action: 'none' };
  const houses = [...new Set(found.filter((c) => c && c.household_id).map((c) => c.household_id))];
  if (houses.length > 1) return { action: 'conflict' };
  if (houses.length === 1 && found.every((c) => c && c.household_id === houses[0])) {
    return { action: 'already', id: houses[0] };
  }
  if (houses.length === 1) return { action: 'join', id: houses[0] };
  return { action: 'new' };
}

export async function handleFileGuests(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const guests = readGuests(body);
  if (!guests.length) return badRequest('There are no guests to file.');

  const found = [];
  for (const g of guests) found.push(await findClient(env, user, g));
  const plan = householdPlan(found);

  if (body.preview !== false) {
    return json({
      preview: true,
      people: guests.map((g, index) => ({
        index, name: g.name, existing: Boolean(found[index]),
        clientName: found[index] ? found[index].name : null,
        changes: found[index] ? differences(found[index], g) : [],
        // What a new client will be added with, so the page can say so.
        adding: found[index] ? [] : FIELDS.filter((f) => g[f]),
      })),
      household: plan,
    });
  }

  // Only what was ticked, and only a field that really is a difference: a request cannot name a
  // field the preview did not offer, so it cannot overwrite more than the advisor was shown.
  const accepted = new Set(Array.isArray(body.accept) ? body.accept.map(String) : []);
  const ids = [];
  const made = [];
  for (let i = 0; i < guests.length; i += 1) {
    const g = guests[i];
    let client = found[i];
    const sets = [];
    const binds = [];
    if (client) {
      for (const d of differences(client, g)) {
        if (!accepted.has(`${i}:${d.field}`)) continue;
        sets.push(`${d.field} = ?`); binds.push(g[d.field]);
      }
    } else {
      const id = await db.resolveClient(env, user.id, g.name);
      if (!id) continue;
      client = { id, name: g.name, household_id: null };
      made.push(g.name);
      for (const f of FIELDS) {
        if (g[f]) { sets.push(`${f} = ?`); binds.push(g[f]); }
      }
    }
    if (sets.length) {
      await env.DB.prepare(
        `UPDATE clients SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`
      ).bind(...binds, now(), client.id, user.id).run();
    }
    ids.push(client);
  }

  let household = null;
  if (body.household === true && ids.length >= 2) {
    const next = householdPlan(ids);
    if (next.action === 'new') {
      household = await createHousehold(env, user.id, ids.map((c) => ({ id: c.id, name: c.name })), {});
    } else if (next.action === 'join') {
      const marks = ids.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE clients SET household_id = ?, updated_at = ?
          WHERE user_id = ? AND id IN (${marks}) AND household_id IS NULL`
      ).bind(next.id, now(), user.id, ...ids.map((c) => c.id)).run();
      household = { id: next.id, joined: true };
    }
  }

  await db.logActivity(env, user.id, 'client.guests',
    `Filed ${ids.length} guest${ids.length === 1 ? '' : 's'} from a confirmation`,
    { added: made.length, household: household ? household.id : null });

  return json({ ok: true, clients: ids.map((c) => ({ id: c.id, name: c.name })), added: made, household });
}
