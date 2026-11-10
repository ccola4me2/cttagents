// A group brought onto the Group Desk from CTT stays in step with the group it came from.
//
// Bringing a group copies it, and a copy that is left alone goes stale the first time somebody changes the
// original: its sailing date, the cabins held, the option date, the rates, the wording of its page. The desk is
// where the cabins are counted against what the cruise line is holding, so a held count that is a week behind
// is a wrong answer. These bring the copy back to the original whenever the desk looks at it.
//
// One way only: the original is the record, and a change made to the copy on the desk is put back the next time
// the original differs. What belongs to the desk is left alone: its cabin sheet, its owner, the sign-up page
// switch (a copy never takes names, the original's page does) and its own notes.

import { now, uid } from './util.js';
import { releaseAllFor } from './groupslug.js';
import { removeGroupFiles } from './groupfiles.js';

// Every column that describes the group itself, as the original has it.
const FIELDS = [
  'name', 'vendor', 'product_name', 'destination', 'depart_date', 'return_date', 'option_date', 'cabins_held',
  'status', 'group_type', 'registration_blurb', 'vendor_contact', 'departure_port', 'passengers', 'proposal_id',
  'sailing_id', 'proposal_expires', 'deposit_due', 'deposit_per_guest_cents', 'suite_deposit_per_guest_cents', 'final_payment_due', 'passport_due',
  'faq_json', 'terms', 'agency_fee_cents', 'fee_terms', 'trip_terms', 'headline', 'hero_image_url', 'perks_json',
  'itinerary_json', 'amenities_json', 'drinks_json', 'enhancements_json', 'excursions_url',
];

const RATE_FIELDS = ['room_type', 'occupancy', 'cabins', 'guests', 'per_guest_cents', 'extra_adult_cents',
  'extra_child_cents', 'taxes_cents', 'total_cents'];

async function ratesOf(env, groupId, userId) {
  const { results } = await env.DB.prepare(
    `SELECT room_type, occupancy, cabins, guests, per_guest_cents, extra_adult_cents, extra_child_cents,
            taxes_cents, total_cents FROM group_rates WHERE group_id = ? AND user_id = ? ORDER BY sort_order ASC`
  ).bind(groupId, userId).all().catch(() => ({ results: [] }));
  return results || [];
}

/**
 * Brings one desk group up to its original, if it has one. Returns true when something changed.
 * The group is found within the agency asked for, so a caller can only reach groups it may already see.
 */
export async function syncFromCtt(env, groupId, agencyId) {
  const copy = await env.DB.prepare(
    `SELECT id, user_id, ctt_group_id, ctt_owner_id, group_number, ${FIELDS.join(', ')} FROM travel_groups
      WHERE id = ? AND user_id IN (SELECT id FROM users WHERE agency_id = ?)`
  ).bind(groupId, agencyId).first();
  if (!copy || !copy.ctt_group_id || !copy.ctt_owner_id) return false;

  const src = await env.DB.prepare(
    `SELECT group_code, group_number, ${FIELDS.join(', ')} FROM travel_groups WHERE id = ? AND user_id = ?`
  ).bind(copy.ctt_group_id, copy.ctt_owner_id).first();
  // The original is gone: the copy is left as it was rather than emptied.
  if (!src) return false;

  const number = src.group_number || src.group_code || '';
  const sets = [];
  const binds = [];
  for (const f of FIELDS) {
    if ((copy[f] ?? null) !== (src[f] ?? null)) { sets.push(`${f} = ?`); binds.push(src[f] ?? null); }
  }
  if ((copy.group_number || '') !== number) { sets.push('group_number = ?'); binds.push(number || null); }

  let changed = false;
  if (sets.length) {
    await env.DB.prepare(`UPDATE travel_groups SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(...binds, now(), copy.id, copy.user_id).run();
    changed = true;
  }

  const want = await ratesOf(env, copy.ctt_group_id, copy.ctt_owner_id);
  const have = await ratesOf(env, copy.id, copy.user_id);
  const same = (a, b) => a.length === b.length
    && a.every((r, i) => RATE_FIELDS.every((k) => (r[k] ?? null) === (b[i][k] ?? null)));
  if (!same(want, have)) {
    await env.DB.prepare('DELETE FROM group_rates WHERE group_id = ? AND user_id = ?').bind(copy.id, copy.user_id).run();
    const ts = now();
    let i = 0;
    for (const r of want) {
      await env.DB.prepare(
        `INSERT INTO group_rates (id, group_id, user_id, room_type, occupancy, cabins, guests, per_guest_cents,
           extra_adult_cents, extra_child_cents, taxes_cents, total_cents, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uid(), copy.id, copy.user_id, r.room_type, r.occupancy, r.cabins, r.guests, r.per_guest_cents,
        r.extra_adult_cents, r.extra_child_cents, r.taxes_cents, r.total_cents, i, ts, ts).run();
      i += 1;
    }
    changed = true;
  }
  return changed;
}

/**
 * Copies whose original has been deleted in CTT.
 *
 * Deleting the original is how somebody says the group is not happening, so its copy goes too, rather than sitting on
 * the desk for ever as a group nobody can sell. Only when nothing is on it: a copy with cabins on its sheet or people
 * registered holds work done on the desk, so that one is closed instead, which takes it off the open list and keeps
 * everything on it.
 */
async function dropGone(env, agencyId) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.user_id, c.status FROM travel_groups c
      WHERE c.ctt_group_id IS NOT NULL AND c.user_id IN (SELECT id FROM users WHERE agency_id = ?)
        AND NOT EXISTS (SELECT 1 FROM travel_groups o WHERE o.id = c.ctt_group_id AND o.user_id = c.ctt_owner_id)`
  ).bind(agencyId).all();
  for (const g of results || []) {
    const cabins = await env.DB.prepare('SELECT COUNT(*) AS n FROM group_cabins WHERE group_id = ? AND user_id = ?')
      .bind(g.id, g.user_id).first();
    const people = await env.DB.prepare('SELECT COUNT(*) AS n FROM group_registrations WHERE group_id = ? AND user_id = ?')
      .bind(g.id, g.user_id).first();
    if ((cabins && cabins.n) || (people && people.n)) {
      if (g.status === 'open') {
        await env.DB.prepare(`UPDATE travel_groups SET status = 'closed', updated_at = ? WHERE id = ? AND user_id = ?`)
          .bind(now(), g.id, g.user_id).run();
      }
      continue;
    }
    await env.DB.prepare('UPDATE bookings SET group_id = NULL WHERE group_id = ? AND user_id = ?').bind(g.id, g.user_id).run();
    await releaseAllFor(env, g.id, g.user_id);
    await removeGroupFiles(env, g.id, g.user_id);
    await env.DB.prepare('DELETE FROM group_rates WHERE group_id = ? AND user_id = ?').bind(g.id, g.user_id).run();
    await env.DB.prepare('DELETE FROM travel_groups WHERE id = ? AND user_id = ?').bind(g.id, g.user_id).run();
  }
}

/** Every copied group in an agency, brought up to date. Best effort: a failure is a copy as it was. */
export async function syncAllFor(env, agencyId) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id FROM travel_groups
        WHERE ctt_group_id IS NOT NULL AND user_id IN (SELECT id FROM users WHERE agency_id = ?)`
    ).bind(agencyId).all();
    for (const g of results || []) await syncFromCtt(env, g.id, agencyId);
    await dropGone(env, agencyId);
  } catch (e) {
    console.error('desk copies', e);
  }
}
