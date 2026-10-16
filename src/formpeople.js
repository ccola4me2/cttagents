// What somebody told a form about themselves, filed on the person who filled it in.
//
// Submitting a form already makes the people travelling with them into clients, with their birthdays and one
// household. What it left on the lead was a name, an email and a phone: the address they typed, their own
// birthday where they were listed as a traveller, and what they asked about stayed in the submission. This
// fills those in. Only blanks, because a public form is a worse source of truth than somebody who typed it.
//
// Also reachable by hand from a submission, for the ones that arrived before this existed.

import { json, notFound, clean, cleanDate, now } from './util.js';
import { requireUser } from './auth.js';
import { tenantFor } from './tenant.js';
import * as db from './db.js';

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

  // The people travelling are already filed as clients, with their birthdays and one household, when the
  // form is submitted. What is left is the person who filled it in: a lead created from a first name alone
  // ("Brandi") is the same person as the traveller "Brandi Teigen", and has none of that traveller's details.
  // Matched by the lead's whole name, or the lead's name followed by a surname, and filling only a blank.
  const listed = fields.find((f) => f && f.type === 'travellers');
  const raw = listed && Array.isArray(data[listed.key]) ? data[listed.key] : [];
  const mine = String(lead.name).toLowerCase();
  const me = raw.find((p) => {
    const n = String((p && p.name) || '').trim().toLowerCase();
    return n && (n === mine || n.startsWith(`${mine} `));
  });
  const dob = me ? cleanDate(me.dob) : null;
  if (dob) {
    await env.DB.prepare(
      'UPDATE clients SET birthday = COALESCE(NULLIF(birthday, \'\'), ?), updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(dob, now(), clientId, owner).run();
  }
  return { filed: 1 };
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
