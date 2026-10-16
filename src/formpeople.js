// What somebody told a form about themselves and the people travelling with them, filed as clients.
//
// A form enquiry used to make one client record from a name, an email and a phone, and leave everything
// else sitting in the submission. The address they typed, the birthdays, and above all the people
// travelling with them were visible only by opening the form and reading its submissions, and on that
// screen the travellers read as "[object Object]". The advisor then retyped them.
//
// This files them. The person who filled the form in keeps what the advisor already knows about them:
// only blanks are filled, because a public form is a worse source of truth than somebody who typed it.
// Everyone named as travelling becomes a client with their birthday, and the party is put in one
// household so the next booking offers them together. Nobody here is put on the lead board: the person
// who got in touch is the lead, and the people with them are the people they are bringing.

import { json, notFound, clean, cleanDate, now } from './util.js';
import { requireUser } from './auth.js';
import { tenantFor } from './tenant.js';
import * as db from './db.js';
import { createHousehold } from './households.js';

// The same limit the group registration uses: more than this is a form filled in wrongly.
const MAX_PEOPLE = 8;

const ADDRESS_FIELD = /address|where you live|home/i;
const ASKED_FIELD = /thinking about|travel type|roughly when|travel date|when|cabin|destination|interested/i;

/** "126 Garrett Way Canyon Lake, TX 78133" as a street, a state and a postcode, as far as it can be told. */
export function readAddress(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const m = text.match(/^(.*?)[,\s]+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  return m ? { address1: m[1].replace(/,\s*$/, ''), state: m[2], postcode: m[3] } : { address1: text, state: '', postcode: '' };
}

/** One line for the lead's "asked about", from the answers about what they want. */
export function askedAbout(form, data) {
  const bits = [];
  for (const f of form.fields || []) {
    if (!f || !f.key || f.type === 'heading' || f.type === 'travellers') continue;
    if (!ASKED_FIELD.test(`${f.label || ''} ${f.key}`)) continue;
    const v = data[f.key];
    if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
    bits.push(String(v).slice(0, 80));
  }
  return bits.join(', ');
}

/**
 * File a submission's people. Best effort by design: the submission is already saved, and a lead lost to
 * a failed write here would be worse than a record missing a birthday.
 */
export async function fileFormPeople(env, owner, clientId, form, data) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const lead = await env.DB.prepare('SELECT id, name, household_id FROM clients WHERE id = ? AND user_id = ?')
    .bind(clientId, owner).first();
  if (!lead) return { filed: 0 };

  // Where they live, into the blanks of the address.
  const addrField = fields.find((f) => f && f.key && !['heading', 'email', 'tel', 'travellers'].includes(f.type)
    && ADDRESS_FIELD.test(`${f.label || ''} ${f.key}`));
  const addr = addrField ? readAddress(clean(data[addrField.key], 300)) : null;
  if (addr) {
    await env.DB.prepare(
      `UPDATE clients SET address1 = COALESCE(NULLIF(address1, ''), ?), state = COALESCE(NULLIF(state, ''), ?),
              postcode = COALESCE(NULLIF(postcode, ''), ?), updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(addr.address1, addr.state || null, addr.postcode || null, now(), clientId, owner).run();
  }

  // What they asked about, in place of the bare "From the form" line, where nobody has written anything better.
  const asked = askedAbout({ fields }, data);
  if (asked) {
    await env.DB.prepare(
      `UPDATE clients SET lead_asked_about = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND lead_stage IS NOT NULL
          AND (lead_asked_about IS NULL OR lead_asked_about = '' OR lead_asked_about LIKE 'From the % form')`
    ).bind(`From the ${clean(form.name, 80)} form: ${asked}`.slice(0, 500), now(), clientId, owner).run();
  }

  // The people travelling.
  const listed = fields.find((f) => f && f.type === 'travellers');
  const raw = listed && Array.isArray(data[listed.key]) ? data[listed.key] : [];
  const people = raw.slice(0, MAX_PEOPLE)
    .map((p) => ({ name: clean(p && p.name, 120), dob: cleanDate(p && p.dob) || null }))
    .filter((p) => p.name);
  if (!people.length) return { filed: 0 };

  const members = [{ id: lead.id, name: lead.name, household_id: lead.household_id || null }];
  for (const p of people) {
    let row;
    if (p.name.toLowerCase() === String(lead.name).toLowerCase()) {
      row = members[0];
    } else {
      const found = await env.DB.prepare('SELECT id, name, household_id FROM clients WHERE user_id = ? AND name = ?')
        .bind(owner, p.name).first();
      const id = found ? found.id : await db.resolveClient(env, owner, p.name);
      if (!id) continue;
      row = { id, name: p.name, household_id: found ? found.household_id || null : null };
      if (!members.some((m) => m.id === id)) members.push(row);
    }
    if (p.dob) {
      await env.DB.prepare(
        `UPDATE clients SET birthday = COALESCE(NULLIF(birthday, ''), ?), updated_at = ? WHERE id = ? AND user_id = ?`
      ).bind(p.dob, now(), row.id, owner).run();
    }
  }

  // One household for the party, where nobody is in a different one already.
  if (members.length >= 2) {
    const houses = [...new Set(members.map((m) => m.household_id).filter(Boolean))];
    if (houses.length === 0) {
      await createHousehold(env, owner, members.map((m) => ({ id: m.id, name: m.name })), {});
    } else if (houses.length === 1) {
      const marks = members.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE clients SET household_id = ?, updated_at = ?
          WHERE user_id = ? AND id IN (${marks}) AND household_id IS NULL`
      ).bind(houses[0], now(), owner, ...members.map((m) => m.id)).run();
    }
  }
  return { filed: members.length };
}

/**
 * POST /api/myforms/submissions/:id/file
 *
 * For a submission that came in before the people in it were filed: the same filing, started by hand
 * from the submission, on the client that submission was matched to.
 */
export async function handleFileSubmission(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const sub = await env.DB.prepare(
    `SELECT s.id, s.form_id, s.contact_id, s.data_json, f.name AS form_name, f.fields_json
       FROM form_submissions s JOIN forms f ON f.id = s.form_id
      WHERE s.id = ? AND s.agency_id = ?`
  ).bind(id, tenantFor(env, user)).first();
  if (!sub || !sub.contact_id) return notFound('That submission has no client to file them under.');

  const owner = await db.writerFor(env, user, 'clients', sub.contact_id);
  if (!owner) return notFound('That client is not yours to change.');

  let fields = [];
  let data = {};
  try { fields = JSON.parse(sub.fields_json || '[]') || []; } catch { fields = []; }
  try { data = JSON.parse(sub.data_json || '{}') || {}; } catch { data = {}; }

  const out = await fileFormPeople(env, owner.id, sub.contact_id, { name: sub.form_name, fields }, data);
  await db.logActivity(env, user.id, 'form.people', `Filed the people on a ${sub.form_name} submission`, { id });
  return json({ ok: true, filed: out.filed, clientId: sub.contact_id });
}
