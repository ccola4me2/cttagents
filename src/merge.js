// Two records, one person.
//
// clients is unique on (user_id, name), which stops the same spelling twice
// and nothing else. Robert Smith and Bob Smith are two people as far as the
// database is concerned, and so are "Jane Doe" and "jane doe " until the
// index folds them. Every route into the book makes more of them: a form
// filled in twice, a traveller block naming somebody already on the list, an
// import, a reservation typed before anybody checked.
//
// The traveller block shipped this week makes this worse rather than better,
// because it files whole families at once. So: find the pairs, and give the
// advisor one button that makes them one record.
//
// Merging rather than deleting. The loser's reservations, credits, tasks,
// forms and review requests all move across, and anything the keeper has no
// answer for is filled in from the loser. Nothing about a person is thrown
// away because their name was typed twice.

import { json, badRequest, notFound, clean, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

// What the keeper takes from the loser wherever the keeper has nothing. Not
// name, which is the thing being chosen between, and not household_id, which
// is handled on its own because it decides who somebody lives with.
const FILLABLE = [
  'email', 'phone', 'notes', 'birthday', 'anniversary', 'nickname',
  'legal_first', 'legal_middle', 'legal_last', 'gender', 'citizenship',
  'passport_number', 'passport_country', 'passport_issued', 'passport_expiry',
  'address1', 'address2', 'city', 'state', 'postcode', 'country',
  'known_traveler', 'redress', 'loyalty_json', 'source', 'source_kind',
  'referred_by_client_id', 'ghl_contact_id', 'hub_code', 'hub_at',
];

/**
 * Pairs that are probably one person.
 *
 * One signal only: the same name, folded to lower case, which catches the trailing space and the
 * capital letter that the unique index lets through. A shared email address or phone number is not
 * one, because a family or a group travelling together shares both on purpose, and offering every
 * member as a possible duplicate of every other buried the list in people who are all correct.
 *
 * Deliberately not fuzzy. Robert and Bob are the same person and no rule here will say so; offering a
 * guess that wrong would teach an advisor to stop reading the list.
 *
 * b.id > a.id so each pair appears once rather than twice with the sides swapped.
 */
export async function duplicateCandidates(env, scope, { limit = 40 } = {}) {
  const scoped = db.scopeWhere(scope, 'a.user_id');
  const { results } = await env.DB.prepare(
    `SELECT a.id AS a_id, a.name AS a_name, a.email AS a_email, a.phone AS a_phone,
            a.created_at AS a_created, a.user_id AS user_id, a.household_id AS a_household,
            b.id AS b_id, b.name AS b_name, b.email AS b_email, b.phone AS b_phone,
            b.created_at AS b_created, b.household_id AS b_household,
            (SELECT COUNT(*) FROM bookings k WHERE k.client_id = a.id
              OR EXISTS (SELECT 1 FROM travellers tv WHERE tv.booking_id = k.id AND tv.user_id = k.user_id AND LOWER(TRIM(tv.name)) = LOWER(TRIM(a.name)))) AS a_trips,
            (SELECT COUNT(*) FROM bookings k WHERE k.client_id = b.id
              OR EXISTS (SELECT 1 FROM travellers tv WHERE tv.booking_id = k.id AND tv.user_id = k.user_id AND LOWER(TRIM(tv.name)) = LOWER(TRIM(b.name)))) AS b_trips,
            'same name' AS why
       FROM clients a
       JOIN clients b ON b.user_id = a.user_id AND b.id > a.id
        AND LOWER(TRIM(a.name)) = LOWER(TRIM(b.name))
        -- Already explained: two people in one household are family, not a typo.
        AND NOT (a.household_id IS NOT NULL AND a.household_id = b.household_id)
        -- Already looked at, and decided to be two people.
        AND NOT EXISTS (SELECT 1 FROM client_not_duplicates n
                         WHERE n.user_id = a.user_id AND n.a_id = a.id AND n.b_id = b.id)
      WHERE ${scoped.sql}
      ORDER BY a.name ASC
      LIMIT ?`
  ).bind(...scoped.binds, Math.min(Math.max(limit, 1), 200)).all().catch(() => ({ results: [] }));
  return results || [];
}

/**
 * Pairs folded into groups of people who share an email, a number or a name.
 *
 * A couple on one email is a pair, but six people on one address is fifteen pairs, and a screen of
 * fifteen near identical rows is not something anybody reads. The same pairs, joined wherever they
 * share a person, make one card with the six names on it and the answer given once.
 */
export function groupDuplicates(pairs) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const people = new Map();
  for (const p of pairs) {
    for (const side of ['a', 'b']) {
      const id = p[`${side}_id`];
      if (!people.has(id)) {
        parent.set(id, id);
        people.set(id, { id, name: p[`${side}_name`], email: p[`${side}_email`], phone: p[`${side}_phone`],
          trips: p[`${side}_trips`], household: p[`${side}_household`] || null });
      }
    }
    parent.set(find(p.a_id), find(p.b_id));
  }
  const groups = new Map();
  for (const p of pairs) {
    const root = find(p.a_id);
    if (!groups.has(root)) groups.set(root, { ids: new Set(), reasons: new Map(), pairs: [] });
    const g = groups.get(root);
    g.ids.add(p.a_id); g.ids.add(p.b_id);
    g.reasons.set(p.why, (g.reasons.get(p.why) || 0) + 1);
    g.pairs.push({ a: p.a_id, b: p.b_id });
  }
  return [...groups.values()].map((g) => {
    const members = [...g.ids].map((id) => people.get(id)).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    const why = [...g.reasons.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const shared = why === 'same email' ? members.find((m) => m.email)?.email
      : why === 'same phone' ? members.find((m) => m.phone)?.phone : null;
    return { why, shared: shared || null, members, pairs: g.pairs };
  }).sort((x, y) => y.members.length - x.members.length);
}

export async function handleDuplicates(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const scope = db.scopeFor(env, user, request);
  // More pairs than the old list of forty: a few people on one email already make fifteen.
  const pairs = await duplicateCandidates(env, scope, { limit: 200 });
  return json({
    pairs,
    groups: groupDuplicates(pairs),
    scope: db.scopeLabel(scope, user),
  });
}

/**
 * Make two records one.
 *
 * `keep` survives and `drop` is absorbed. Which is which is the advisor's
 * call, not a rule: the older record is usually the one with the history on
 * it, and the newer one is usually the one with the passport, so guessing
 * would be wrong about half the time.
 *
 * Both must belong to the same advisor. Merging across advisors would move one
 * person's book into another's, which is a different operation with a
 * different meaning and is not this one.
 *
 * Not a transaction across every statement, because D1 batches are limited and
 * a half-merge is recoverable: the links move first and the record goes last,
 * so a failure part way leaves a client with nothing pointing at it rather
 * than rows pointing at a client that is gone.
 */
export async function handleMergeClients(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const keepId = clean(body.keep, 64);
  const dropId = clean(body.drop, 64);
  if (!keepId || !dropId) return badRequest('Say which record to keep and which to absorb.');
  if (keepId === dropId) return badRequest('Those are the same record.');

  // Whose records these are. Both, separately: an owner may merge an advisor's
  // two records, and nobody may merge one of theirs into somebody else's.
  const keepOwner = await db.writerFor(env, user, 'clients', keepId);
  const dropOwner = await db.writerFor(env, user, 'clients', dropId);
  if (!keepOwner || !dropOwner) return notFound('Client not found.');
  if (keepOwner.id !== dropOwner.id) {
    return badRequest('Those two belong to different advisors. Move one across first.');
  }
  const owner = keepOwner.id;

  const cols = ['id', 'name', 'household_id', ...FILLABLE].join(', ');
  const keep = await env.DB.prepare(
    `SELECT ${cols} FROM clients WHERE id = ? AND user_id = ?`
  ).bind(keepId, owner).first();
  const drop = await env.DB.prepare(
    `SELECT ${cols} FROM clients WHERE id = ? AND user_id = ?`
  ).bind(dropId, owner).first();
  if (!keep || !drop) return notFound('Client not found.');

  // Written out rather than looped over a list with the table name
  // interpolated. A built table name is a statement no checker can read, and
  // this is the operation where a missed table leaves live rows pointing at a
  // record that is about to be deleted. Eight statements somebody can audit
  // beats one clever one.
  //
  // contact_id on tasks and client_credits is NOT moved: it sits beside a
  // client_id and holds the old CRM's id, not ours, so pointing it at a client
  // would aim a live row at a contact in a system that no longer exists. Only
  // form_submissions uses contact_id for a real client, because that is what
  // publicform.js puts there.
  //
  // Every table but form_submissions is the advisor's own, so each names
  // user_id as well: the client id already implies the owner, and saying so
  // again is what makes that readable from the statement. form_submissions
  // belongs to the agency and has no user_id to name.
  const moved = [];
  const move = async (table, sql, binds) => {
    try {
      const res = await env.DB.prepare(sql).bind(...binds).run();
      const n = res && res.meta ? res.meta.changes : 0;
      if (n) moved.push({ table, rows: n });
    } catch (e) {
      // A table this deployment does not have is not a reason to abandon a
      // merge half way through.
      console.error('merge link', table, e);
    }
  };
  const mine = [keepId, dropId, owner];
  await move('bookings',
    'UPDATE bookings SET client_id = ? WHERE client_id = ? AND user_id = ?', mine);
  await move('client_credits',
    'UPDATE client_credits SET client_id = ? WHERE client_id = ? AND user_id = ?', mine);
  await move('tasks',
    'UPDATE tasks SET client_id = ? WHERE client_id = ? AND user_id = ?', mine);
  await move('appointments',
    'UPDATE appointments SET client_id = ? WHERE client_id = ? AND user_id = ?', mine);
  await move('reviews',
    'UPDATE reviews SET client_id = ? WHERE client_id = ? AND user_id = ?', mine);
  await move('form_invites',
    'UPDATE form_invites SET client_id = ? WHERE client_id = ? AND user_id = ?', mine);
  await move('broadcast_recipients',
    'UPDATE broadcast_recipients SET client_id = ? WHERE client_id = ? AND user_id = ?', mine);
  await move('clients',
    'UPDATE clients SET referred_by_client_id = ? WHERE referred_by_client_id = ? AND user_id = ?',
    mine);
  // Travelling on somebody else's reservation is recorded by name, so the absorbed spelling is carried to the
  // kept one or those trips stop counting as theirs.
  await move('travellers',
    'UPDATE travellers SET name = ? WHERE name = ? AND user_id = ?', [keep.name, drop.name, owner]);
  // The submission belongs to the agency, not to an advisor, so the client id
  // is the whole of the predicate it can have.
  await move('form_submissions',
    'UPDATE form_submissions SET contact_id = ? WHERE contact_id = ?', [keepId, dropId]);

  // Everything the keeper has no answer for, taken from the loser. Never the
  // other way round: the record the advisor chose to keep wins every field it
  // has an opinion about, and this only fills the silences.
  const filled = [];
  const sets = [];
  const binds = [];
  for (const f of FILLABLE) {
    const mine2 = keep[f];
    const theirs = drop[f];
    const blank = mine2 === null || mine2 === undefined || String(mine2).trim() === '';
    const has = theirs !== null && theirs !== undefined && String(theirs).trim() !== '';
    if (blank && has) { sets.push(`${f} = ?`); binds.push(theirs); filled.push(f); }
  }
  // Who they live with, if the keeper lives nowhere.
  if (!keep.household_id && drop.household_id) {
    sets.push('household_id = ?'); binds.push(drop.household_id); filled.push('household_id');
  }
  if (sets.length) {
    await env.DB.prepare(
      `UPDATE clients SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(...binds, now(), keepId, owner).run();
  }

  await env.DB.prepare(
    `UPDATE clients SET referred_by_client_id = NULL
      WHERE id = ? AND referred_by_client_id = ? AND user_id = ?`
  ).bind(keepId, keepId, owner).run().catch(() => {});

  await env.DB.prepare('DELETE FROM clients WHERE id = ? AND user_id = ?')
    .bind(dropId, owner).run();

  await db.logActivity(env, owner, 'client.merge',
    `Merged ${drop.name} into ${keep.name}`,
    { keep: keepId, drop: dropId, moved, filled });

  return json({
    ok: true,
    keep: { id: keepId, name: keep.name },
    absorbed: drop.name,
    moved,
    filled,
  });
}

/**
 * "These two are different people": remember it, so they are not offered again.
 *
 * POST says it, DELETE takes it back. Both records must be the caller's (or an
 * agency owner's for an advisor's), the same rule as merging, because what this
 * writes is a decision about somebody's book.
 */
export async function handleNotDuplicate(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const one = clean(body.a, 64);
  const two = clean(body.b, 64);
  if (!one || !two || one === two) return badRequest('Say which two records.');

  const first = await db.writerFor(env, user, 'clients', one);
  const second = await db.writerFor(env, user, 'clients', two);
  if (!first || !second) return notFound('Client not found.');
  if (first.id !== second.id) return badRequest('Those two belong to different advisors.');

  // The order the list uses, so one row answers for the pair whichever way round
  // it was reached.
  const [a, b] = one < two ? [one, two] : [two, one];

  if (request.method === 'DELETE') {
    await env.DB.prepare(
      'DELETE FROM client_not_duplicates WHERE user_id = ? AND a_id = ? AND b_id = ?'
    ).bind(first.id, a, b).run();
    return json({ ok: true, again: true });
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO client_not_duplicates (user_id, a_id, b_id, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(first.id, a, b, now()).run();
  return json({ ok: true });
}

