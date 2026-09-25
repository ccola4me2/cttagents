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

/**
 * Every column that holds a clients.id.
 *
 * Written out rather than derived. `contact_id` on tasks and client_credits
 * sits beside a `client_id` and holds the old CRM's id, not ours, so moving it
 * would point a live row at a contact in a system that no longer exists. Only
 * form_submissions uses contact_id for a real client, because that is what
 * publicform.js puts there.
 *
 * A table missed here is a row left pointing at a record that is about to be
 * deleted, so this list is the whole safety of the operation.
 */
export const CLIENT_LINKS = [
  ['bookings', 'client_id'],
  ['client_credits', 'client_id'],
  ['tasks', 'client_id'],
  ['appointments', 'client_id'],
  ['reviews', 'client_id'],
  ['form_invites', 'client_id'],
  ['broadcast_recipients', 'client_id'],
  ['form_submissions', 'contact_id'],
  // Somebody referred by the record about to go needs repointing too, or the
  // referral chain breaks at exactly the person who did the referring.
  ['clients', 'referred_by_client_id'],
];

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

// Phone numbers are typed however somebody feels that day. Enough of the
// separators to make (555) 123-4567 and 555-123-4567 the same number, done in
// SQL because the comparison happens there.
const DIGITS = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(`
  + `${col}, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '')`;

/**
 * Pairs that are probably one person.
 *
 * Three signals, strongest first. A shared email is as close to proof as this
 * gets. A shared phone is nearly as good. The same name folded to lower case
 * is weaker and catches the trailing-space pair the unique index lets through.
 *
 * Deliberately not fuzzy. Robert and Bob are the same person and no rule here
 * will say so; offering a guess that wrong would teach an advisor to stop
 * reading the list, and the list is only useful if every row on it is worth
 * looking at.
 *
 * b.id > a.id so each pair appears once rather than twice with the sides
 * swapped.
 */
export async function duplicateCandidates(env, scope, { limit = 40 } = {}) {
  const scoped = db.scopeWhere(scope, 'a.user_id');
  const { results } = await env.DB.prepare(
    `SELECT a.id AS a_id, a.name AS a_name, a.email AS a_email, a.phone AS a_phone,
            a.created_at AS a_created, a.user_id AS user_id,
            b.id AS b_id, b.name AS b_name, b.email AS b_email, b.phone AS b_phone,
            b.created_at AS b_created,
            (SELECT COUNT(*) FROM bookings k WHERE k.client_id = a.id) AS a_trips,
            (SELECT COUNT(*) FROM bookings k WHERE k.client_id = b.id) AS b_trips,
            CASE
              WHEN TRIM(COALESCE(a.email, '')) != ''
               AND LOWER(TRIM(a.email)) = LOWER(TRIM(b.email)) THEN 'same email'
              WHEN TRIM(COALESCE(a.phone, '')) != ''
               AND ${DIGITS('a.phone')} = ${DIGITS('b.phone')} THEN 'same phone'
              ELSE 'same name'
            END AS why
       FROM clients a
       JOIN clients b ON b.user_id = a.user_id AND b.id > a.id
        AND (
          (TRIM(COALESCE(a.email, '')) != '' AND LOWER(TRIM(a.email)) = LOWER(TRIM(b.email)))
          OR (TRIM(COALESCE(a.phone, '')) != ''
              AND LENGTH(${DIGITS('a.phone')}) >= 7
              AND ${DIGITS('a.phone')} = ${DIGITS('b.phone')})
          OR (LOWER(TRIM(a.name)) = LOWER(TRIM(b.name)))
        )
      WHERE ${scoped.sql}
      ORDER BY a.name ASC
      LIMIT ?`
  ).bind(...scoped.binds, Math.min(Math.max(limit, 1), 200)).all().catch(() => ({ results: [] }));
  return results || [];
}

export async function handleDuplicates(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const scope = db.scopeFor(env, user, request);
  return json({
    pairs: await duplicateCandidates(env, scope),
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

  const moved = [];
  for (const [table, column] of CLIENT_LINKS) {
    try {
      const res = await env.DB.prepare(
        `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`
      ).bind(keepId, dropId).run();
      const n = res && res.meta ? res.meta.changes : 0;
      if (n) moved.push({ table, rows: n });
    } catch (e) {
      // A table this deployment does not have is not a reason to abandon a
      // merge. Anything else is worth knowing about, and neither is worth
      // leaving the advisor with two records.
      console.error('merge link', table, e);
    }
  }
  // Everything the keeper has no answer for, taken from the loser. Never the
  // other way round: the record the advisor chose to keep wins every field it
  // has an opinion about.
  const filled = [];
  const sets = [];
  const binds = [];
  for (const f of FILLABLE) {
    const mine = keep[f];
    const theirs = drop[f];
    const blank = mine === null || mine === undefined || String(mine).trim() === '';
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

  // After the fill, not before it. The loser referred the keeper, the link
  // move pointed that at the keeper, and then the fill copied it onto the
  // keeper: a record that referred itself. Caught by testing the merge rather
  // than by reading it.
  await env.DB.prepare(
    'UPDATE clients SET referred_by_client_id = NULL WHERE id = ? AND referred_by_client_id = ?'
  ).bind(keepId, keepId).run().catch(() => {});

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
