// Trip Vara's own form builder.
//
// The upstream builder has no create or edit API, so forms made there can only
// ever be read. These are the portal's own: defined here, hosted here at
// /f/<slug>, and submitted into this database.
//
// A submission also creates the contact upstream, so messaging and automations
// keep working, but that push is best effort. Losing a lead because the CRM
// API was rate limiting would be much worse than a contact arriving late.

import {
  json, badRequest, notFound, forbidden, uid, now, clean, cleanText, cleanDate, oneOf,
  isValidEmail, normalizeEmail, readJson,
} from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import * as db from './db.js';
import { upsertContact } from './sync.js';

const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'date', 'number', 'checkbox'];

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'form';
}

function parseFields(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const f of list.slice(0, 40)) {
    const label = clean(f.label, 120);
    if (!label) continue;
    let key = clean(f.key, 60) || slugify(label).replace(/-/g, '_');
    // Keys end up as form input names and submission keys, so they have to be
    // unique within a form or answers overwrite each other.
    let n = 2;
    while (seen.has(key)) key = `${key}_${n++}`;
    seen.add(key);
    out.push({
      key,
      label,
      type: oneOf(f.type, FIELD_TYPES),
      required: Boolean(f.required),
      placeholder: clean(f.placeholder, 120),
      options: Array.isArray(f.options)
        ? f.options.map((o) => clean(o, 80)).filter(Boolean).slice(0, 40)
        : [],
    });
  }
  return out;
}

function hydrate(row) {
  if (!row) return null;
  let fields = [];
  try { fields = JSON.parse(row.fields_json); } catch { fields = []; }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    headline: row.headline || '',
    description: row.description || '',
    fields,
    submitLabel: row.submit_label || 'Send',
    successMessage: row.success_message || '',
    redirectUrl: row.redirect_url || '',
    startsOn: row.starts_on || '',
    endsOn: row.ends_on || '',
    notifyEmail: row.notify_email || '',
    source: row.source || '',
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Portal side
// ---------------------------------------------------------------------------
/**
 * The fields a travel client record actually holds, to tick rather than type.
 *
 * Typing a label for every question is fine for one form and tiresome by the
 * third, and it produces "Mobile" on one form and "Cell phone" on another,
 * which then arrive as two different answers to the same question. A fixed
 * catalogue keeps the keys stable, so a phone number is always `mobile_phone`
 * whichever form collected it.
 *
 * Custom fields still exist for anything not here. This is a starting set, not
 * a fence.
 */
export const FIELD_CATALOGUE = [
  {
    group: 'Who they are',
    fields: [
      { key: 'full_name', label: 'Your name', type: 'text' },
      { key: 'first_name', label: 'First name', type: 'text' },
      { key: 'last_name', label: 'Last name', type: 'text' },
      { key: 'nickname', label: 'Goes by', type: 'text' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'secondary_email', label: 'Second email', type: 'email' },
      { key: 'date_of_birth', label: 'Date of birth', type: 'date' },
      { key: 'business_name', label: 'Company', type: 'text' },
      { key: 'preferred_contact', label: 'Best way to reach you', type: 'select',
        options: ['Email', 'Phone', 'Text message'] },
    ],
  },
  {
    group: 'Phone and address',
    fields: [
      { key: 'mobile_phone', label: 'Mobile', type: 'tel' },
      { key: 'home_phone', label: 'Home phone', type: 'tel' },
      { key: 'work_phone', label: 'Work phone', type: 'tel' },
      { key: 'address', label: 'Address', type: 'textarea' },
    ],
  },
  {
    group: 'The trip',
    fields: [
      { key: 'destination', label: 'Where you want to go', type: 'text' },
      { key: 'travel_date', label: 'Roughly when', type: 'date' },
      { key: 'party_size', label: 'How many travelling', type: 'number' },
      // Cabins, not people. A group is held in cabins and a block is sized in
      // them, so eight travelling is four rooms or eight, and the difference
      // is the whole booking.
      { key: 'cabins_wanted', label: 'How many rooms or cabins', type: 'number' },
      { key: 'nights', label: 'How long', type: 'select',
        options: ['A long weekend', 'About a week', 'Ten days or so', 'Two weeks or more'] },
      { key: 'budget', label: 'Budget you are working to', type: 'select',
        options: ['Under 5,000', '5,000 to 10,000', '10,000 to 20,000', 'Over 20,000', 'Not sure yet'] },
      { key: 'travel_type', label: 'What kind of trip', type: 'select',
        options: ['Cruise', 'All-inclusive resort', 'Escorted tour', 'Independent travel',
                  'River cruise', 'Expedition', 'Not sure yet'] },
      { key: 'occasion', label: 'Special occasion', type: 'text' },
      { key: 'flying_from', label: 'Flying from', type: 'text' },
      { key: 'follow_up_date', label: 'When to follow up', type: 'date' },
    ],
  },
  {
    group: 'Preferences',
    fields: [
      { key: 'dining_preference', label: 'Dining preference', type: 'select',
        options: ['Early', 'Late', 'Anytime', 'No preference'] },
      { key: 'bed_preference', label: 'Bed preference', type: 'select',
        options: ['One bed', 'Two beds', 'No preference'] },
      { key: 'seating_preference', label: 'Airline seat', type: 'select',
        options: ['Window', 'Aisle', 'No preference'] },
      { key: 'loyalty_program', label: 'Loyalty programme', type: 'text' },
      { key: 'loyalty_number', label: 'Loyalty number', type: 'text' },
      { key: 'smoker', label: 'Smoker', type: 'checkbox' },
      { key: 'special_needs', label: 'Access needs or dietary requirements', type: 'textarea' },
    ],
  },
  {
    group: 'Travel documents',
    // Held back from the ready-made forms on purpose. These belong on a form
    // sent to somebody who has already booked, not on one handed out at a
    // stand, and a passport number in particular is worth asking for only when
    // a vendor actually needs it.
    sensitive: true,
    fields: [
      { key: 'passport_name', label: 'Name exactly as printed in the passport', type: 'text' },
      { key: 'citizenship', label: 'Citizenship', type: 'text' },
      { key: 'place_of_birth', label: 'Place of birth', type: 'text' },
      { key: 'passport_number', label: 'Passport number', type: 'text' },
      { key: 'passport_issued', label: 'Passport issued', type: 'date' },
      { key: 'passport_expiry', label: 'Passport expires', type: 'date' },
      { key: 'known_traveler_number', label: 'Known traveller number', type: 'text' },
      { key: 'global_entry', label: 'Global Entry number', type: 'text' },
    ],
  },
  {
    group: 'Emergency contact',
    fields: [
      { key: 'emergency_name', label: 'Emergency contact', type: 'text' },
      { key: 'emergency_phone', label: 'Their phone', type: 'tel' },
      { key: 'emergency_relationship', label: 'Relationship to you', type: 'text' },
      { key: 'emergency_email', label: 'Their email', type: 'email' },
    ],
  },
  {
    group: 'Consent and notes',
    fields: [
      { key: 'email_opt_in', label: 'Yes, send me travel offers by email', type: 'checkbox' },
      { key: 'sms_opt_in', label: 'Yes, send me trip updates by text', type: 'checkbox' },
      // Declined is a different fact from never asked, and the difference is
      // the advisor's position if something goes wrong on the trip. Worth
      // having on any form, not only the one built for it.
      { key: 'insurance_choice', label: 'Travel insurance', type: 'select',
        options: ['I would like a quote for travel insurance',
                  'I decline travel insurance for this trip',
                  'I already have my own cover'] },
      { key: 'insurance_provider', label: 'If you have your own cover, who is it with',
        type: 'text' },
      { key: 'notes', label: 'Anything else we should know', type: 'textarea' },
    ],
  },
  {
    // The half of the arc nothing else asks about. A trip that went well is
    // worth a quote and a referral, and one that did not is worth hearing
    // about from the client rather than reading in a review.
    group: 'After the trip',
    fields: [
      { key: 'trip_rating', label: 'How was it overall', type: 'select',
        options: ['Better than we hoped', 'Very good', 'Fine', 'Some problems', 'Poor'] },
      { key: 'trip_highlight', label: 'What was the best part', type: 'textarea' },
      { key: 'trip_problem', label: 'Anything that did not go to plan', type: 'textarea' },
      // Asked outright rather than assumed. Quoting somebody without checking
      // is how a nice note becomes a complaint.
      { key: 'testimonial_ok', label: 'May we quote you on our website', type: 'checkbox' },
      { key: 'next_trip', label: 'Where would you like to go next', type: 'text' },
    ],
  },
  {
    group: 'Referral',
    fields: [
      { key: 'referral_name', label: 'Their name', type: 'text' },
      { key: 'referral_email', label: 'Their email', type: 'email' },
      { key: 'referral_phone', label: 'Their phone', type: 'tel' },
      { key: 'referral_warm', label: 'Have you told them to expect us', type: 'checkbox' },
    ],
  },
];

/** Every catalogue field by key, for validating what a form asks for. */
export const CATALOGUE_BY_KEY = new Map(
  FIELD_CATALOGUE.flatMap((g) => g.fields.map((f) => [f.key, { ...f, group: g.group }]))
);

/**
 * Ready-made lead forms, for the places advisors actually meet people.
 *
 * A blank form builder is a blank page: the useful part is not the field
 * types, it is knowing that a bridal show wants the wedding date and a party
 * size, and that a cruise night wants to know which sailing they came to hear
 * about. These are starting points, editable once created, not fixed shapes.
 *
 * Every one of them opens with name, email and phone, because a lead without
 * a way to reach them is not a lead.
 */
const REACH = [
  { label: 'Your name', key: 'full_name', type: 'text', required: true },
  { label: 'Email', key: 'email', type: 'email', required: true },
  { label: 'Mobile', key: 'mobile_phone', type: 'tel', required: false },
];

export const FORM_TEMPLATES = [
  {
    key: 'bridal',
    label: 'Bridal show',
    blurb: 'Honeymoons and destination weddings, captured at the stand.',
    headline: 'Tell us about the honeymoon',
    description: 'Leave your details and we will come back with real options, not brochures.',
    fields: [
      ...REACH,
      { label: 'Wedding date', key: 'wedding_date', type: 'date', required: false },
      { label: 'Where you have in mind', key: 'destination', type: 'text', required: false },
      { label: 'Roughly how long', key: 'nights', type: 'select', required: false,
        options: ['A long weekend', 'About a week', 'Ten days or so', 'Two weeks or more'] },
      { label: 'Budget you are working to', key: 'budget', type: 'select', required: false,
        options: ['Under 5,000', '5,000 to 10,000', '10,000 to 20,000', 'Over 20,000', 'Not sure yet'] },
      { label: 'Anything else', key: 'notes', type: 'textarea', required: false },
    ],
  },
  {
    key: 'consumer_show',
    label: 'Travel show',
    blurb: 'A short form for a busy stand, where nobody fills in ten boxes.',
    headline: 'What are you thinking about?',
    description: 'Four questions and we will be in touch.',
    fields: [
      ...REACH,
      { label: 'Where do you want to go', key: 'destination', type: 'text', required: false },
      { label: 'Roughly when', key: 'travel_date', type: 'date', required: false },
      { label: 'How should we reach you', key: 'preferred_contact', type: 'select',
        required: false, options: ['Email', 'Phone', 'Either'] },
    ],
  },
  {
    key: 'cruise_night',
    label: 'Cruise or tour evening',
    blurb: 'For a hosted event, where the sailing on offer is the reason they came.',
    headline: 'Thanks for coming',
    description: 'Leave your details and we will follow up on what you saw tonight.',
    fields: [
      ...REACH,
      { label: 'Which sailing interests you', key: 'sailing', type: 'text', required: false },
      { label: 'How many travelling', key: 'party_size', type: 'number', required: false },
      { label: 'Sailed with this line before', key: 'sailed_before', type: 'checkbox',
        required: false },
      { label: 'Best time to call', key: 'best_time', type: 'text', required: false },
      { label: 'Anything else', key: 'notes', type: 'textarea', required: false },
    ],
  },
  {
    key: 'quick',
    label: 'Quick enquiry',
    blurb: 'The four things you need before you can quote anything.',
    headline: 'Tell us about the trip',
    description: 'The essentials, and we will come back with options.',
    fields: [
      ...REACH,
      { label: 'Where to', key: 'destination', type: 'text', required: true },
      { label: 'When', key: 'travel_date', type: 'date', required: false },
      { label: 'How many travelling', key: 'party_size', type: 'number', required: false },
      { label: 'Budget you are working to', key: 'budget', type: 'text', required: false },
    ],
  },
  {
    key: 'group_interest',
    label: 'Group trip interest',
    blurb: 'Collect names for a group before there is a sailing to point them at.',
    headline: 'Put your name down',
    description: 'No deposit and no commitment. We will send the details as soon as they are set.',
    fields: [
      ...REACH,
      { label: 'How many in your party', key: 'party_size', type: 'number', required: false },
      // Cabins, not people. A group is held in cabins and the block is sized
      // in them, so "eight travelling" is four rooms or eight, and the
      // difference is the whole booking.
      { label: 'How many rooms or cabins', key: 'cabins_wanted', type: 'number', required: false },
      { label: 'Which dates work', key: 'travel_date', type: 'date', required: false },
      { label: 'Flying from', key: 'flying_from', type: 'text', required: false },
      { label: 'Anything else we should know', key: 'notes', type: 'textarea', required: false },
    ],
  },
  {
    key: 'cruise_enquiry',
    label: 'Cruise enquiry',
    blurb: 'The things a cruise needs that a general enquiry does not ask for.',
    headline: 'Tell us about the cruise',
    description: 'A few details and we will come back with what is actually available.',
    fields: [
      ...REACH,
      { label: 'Where you would like to sail', key: 'destination', type: 'text', required: false },
      { label: 'Roughly when', key: 'travel_date', type: 'date', required: false },
      { label: 'How many nights', key: 'nights', type: 'select', required: false,
        options: ['3 to 5', '6 to 8', '9 to 12', 'Two weeks or more', 'Not sure yet'] },
      { label: 'How many travelling', key: 'party_size', type: 'number', required: false },
      { label: 'Kind of cabin', key: 'bed_preference', type: 'select', required: false,
        options: ['Interior', 'Ocean view', 'Balcony', 'Suite', 'Whatever is best value'] },
      // Past guest status is money: it is the difference between the fare on
      // the website and the one the advisor can actually book.
      { label: 'Past guest number, if you have one', key: 'loyalty_number', type: 'text',
        required: false },
      { label: 'Dining you prefer', key: 'dining_preference', type: 'select', required: false,
        options: ['Early seating', 'Late seating', 'Anytime', 'No preference'] },
      { label: 'Anything else', key: 'notes', type: 'textarea', required: false },
    ],
  },
  {
    key: 'insurance_choice',
    label: 'Travel insurance, in writing',
    blurb: 'Their answer recorded, whichever way it goes. This is the one you want on file.',
    headline: 'Travel insurance',
    description: 'We offer insurance on every trip. Whether you take it or not, we record what you '
      + 'chose, so there is never a question later about what was offered.',
    fields: [
      ...REACH,
      { label: 'Which trip is this about', key: 'destination', type: 'text', required: true },
      { label: 'Departure date', key: 'travel_date', type: 'date', required: false },
      // Both answers are recorded and neither is the default. Declined is a
      // different fact from never asked, and the difference is the advisor's
      // position if something goes wrong on the trip.
      { label: 'Your decision', key: 'insurance_choice', type: 'select', required: true,
        options: ['I would like a quote for travel insurance',
          'I decline travel insurance for this trip',
          'I already have my own cover'] },
      { label: 'If you have your own, who is it with', key: 'insurance_provider', type: 'text',
        required: false },
      { label: 'Anything you want noted', key: 'notes', type: 'textarea', required: false },
    ],
  },
  {
    key: 'welcome_home',
    label: 'How was the trip',
    blurb: 'Sent after they land. The one moment they are most willing to say something nice.',
    headline: 'Welcome home',
    description: 'Two minutes on how it went. It tells us who to send where next time, and if '
      + 'anything went wrong we would rather hear it from you than read it.',
    fields: [
      ...REACH,
      { label: 'Where you have just been', key: 'destination', type: 'text', required: false },
      { label: 'How was it overall', key: 'trip_rating', type: 'select', required: false,
        options: ['Better than we hoped', 'Very good', 'Fine', 'Some problems', 'Poor'] },
      { label: 'What was the best part', key: 'trip_highlight', type: 'textarea', required: false },
      { label: 'Anything that did not go to plan', key: 'trip_problem', type: 'textarea',
        required: false },
      // Asked outright rather than assumed. Quoting somebody without checking
      // is how a nice note becomes a complaint.
      { label: 'May we quote you on our website', key: 'testimonial_ok', type: 'checkbox',
        required: false },
      { label: 'Where would you like to go next', key: 'next_trip', type: 'text', required: false },
    ],
  },
  {
    key: 'referral',
    label: 'Refer a friend',
    blurb: 'The cheapest lead there is, and the one nobody has a form for.',
    headline: 'Who should we look after next',
    description: 'Tell us who to speak to and we will take it from there. We will mention you '
      + 'sent us, and we will not pester them.',
    fields: [
      { label: 'Your name', key: 'full_name', type: 'text', required: true },
      { label: 'Your email', key: 'email', type: 'email', required: true },
      { label: 'Their name', key: 'referral_name', type: 'text', required: true },
      { label: 'Their email', key: 'referral_email', type: 'email', required: false },
      { label: 'Their phone', key: 'referral_phone', type: 'tel', required: false },
      // One of the two, or there is nobody to contact. Said on the form rather
      // than enforced, because a required pair is not something a form builder
      // this simple can express and a half-filled referral is still a name.
      { label: 'What are they thinking about', key: 'notes', type: 'textarea', required: false },
      { label: 'Have you told them to expect us', key: 'referral_warm', type: 'checkbox',
        required: false },
    ],
  },
  {
    key: 'documents',
    label: 'Traveller details',
    blurb: 'What a vendor needs on the booking, asked once rather than by email.',
    headline: 'Traveller details',
    description: 'These have to match the passport exactly, or the vendor will reject the booking.',
    fields: [
      ...REACH,
      { label: 'Full name as printed in the passport', key: 'passport_name', type: 'text',
        required: true },
      { label: 'Date of birth', key: 'date_of_birth', type: 'date', required: true },
      { label: 'Citizenship', key: 'citizenship', type: 'text', required: false },
      { label: 'Passport expires', key: 'passport_expiry', type: 'date', required: false },
      // Deliberately not the passport number. A public form is not the place
      // to collect one, and an advisor does not need it to hold a booking.
      { label: 'Any access needs or dietary requirements', key: 'special_needs', type: 'textarea',
        required: false },
    ],
  },
];

// ---------------------------------------------------------------------------
// An advisor's own templates
// ---------------------------------------------------------------------------
//
// The built-in ten cover situations everybody meets. What they cannot cover is
// the form one advisor sends every week, in their wording and their order.
// Build it once, keep it, start the next one from it.

const MY_TEMPLATE_COLUMNS = `id, user_id, name, blurb, headline, description,
  submit_label, success_message, fields_json, created_at, updated_at`;

/** Shaped exactly like a built-in, so the picker does not care which it has. */
function hydrateTemplate(row) {
  let fields = [];
  try { fields = JSON.parse(row.fields_json); } catch { fields = []; }
  return {
    // Namespaced, because a built-in key and a row id share one dropdown and
    // "quick" must never collide with somebody's own template.
    key: `mine:${row.id}`,
    id: row.id,
    mine: true,
    label: row.name,
    blurb: row.blurb || '',
    headline: row.headline || '',
    description: row.description || '',
    submitLabel: row.submit_label || '',
    successMessage: row.success_message || '',
    fields,
    updatedAt: row.updated_at,
  };
}

export async function listMyTemplates(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT ${MY_TEMPLATE_COLUMNS} FROM form_templates
      WHERE user_id = ? ORDER BY name ASC LIMIT 100`
  ).bind(userId).all().catch(() => ({ results: [] }));
  return (results || []).map(hydrateTemplate);
}

export async function handleListMyTemplates(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  return json({ templates: await listMyTemplates(env, user.id) });
}

/**
 * Keep a form as a starting point.
 *
 * Takes a form id and copies it, or takes the fields directly for a builder
 * that has not been saved yet. Copied rather than referenced: editing the form
 * afterwards must not quietly rewrite the template it came from, and deleting
 * the form must not take the template with it.
 */
export async function handleSaveMyTemplate(request, env, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  let source = body;

  if (body.fromForm) {
    const row = await env.DB.prepare('SELECT * FROM forms WHERE id = ? AND location_id = ?')
      .bind(clean(body.fromForm, 64), ghl.locationFor(env, user)).first();
    if (!row) return notFound('Form not found.');
    const form = hydrate(row);
    source = {
      name: body.name || form.name,
      blurb: body.blurb,
      headline: form.headline,
      description: form.description,
      submitLabel: form.submitLabel,
      successMessage: form.successMessage,
      fields: form.fields,
    };
  }

  const name = clean(source.name, 120);
  if (!name) return badRequest('Give the template a name.');

  const fields = parseFields(source.fields);
  if (!fields.length) return badRequest('A template with no questions is not a template.');

  const ts = now();
  if (id) {
    const res = await env.DB.prepare(
      `UPDATE form_templates SET name = ?, blurb = ?, headline = ?, description = ?,
         submit_label = ?, success_message = ?, fields_json = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(name, cleanText(source.blurb, 200) || null, clean(source.headline, 160) || null,
           cleanText(source.description, 1000) || null, clean(source.submitLabel, 40) || null,
           cleanText(source.successMessage, 500) || null, JSON.stringify(fields), ts,
           id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Template not found.');
    return json({ ok: true, templates: await listMyTemplates(env, user.id) });
  }

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM form_templates WHERE user_id = ?'
  ).bind(user.id).first();
  if ((count?.n || 0) >= 40) {
    return badRequest('Forty templates is plenty. Remove one rather than adding another.');
  }

  const newId = uid();
  await env.DB.prepare(
    `INSERT INTO form_templates (id, user_id, name, blurb, headline, description,
       submit_label, success_message, fields_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(newId, user.id, name, cleanText(source.blurb, 200) || null,
         clean(source.headline, 160) || null, cleanText(source.description, 1000) || null,
         clean(source.submitLabel, 40) || null, cleanText(source.successMessage, 500) || null,
         JSON.stringify(fields), ts, ts).run();

  await db.logActivity(env, user.id, 'formTemplate.create', `Saved the template ${name}`,
    { id: newId });
  return json({ ok: true, id: newId, templates: await listMyTemplates(env, user.id) }, 201);
}

export async function handleDeleteMyTemplate(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM form_templates WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Template not found.');
  // The forms already built from it are untouched: a template is a starting
  // point, not a parent.
  return json({ ok: true, templates: await listMyTemplates(env, user.id) });
}

export async function handleListForms(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const locationId = ghl.locationFor(env, user);

  const { results } = await env.DB.prepare(
    `SELECT f.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS submissions
       FROM forms f WHERE f.location_id = ? ORDER BY f.updated_at DESC`
  ).bind(locationId).all();

  return json({
    forms: (results || []).map((r) => ({ ...hydrate(r), submissions: r.submissions || 0 })),
    // Sent with the list so the builder can offer a starting point without a
    // second round trip before anybody has typed anything.
    templates: FORM_TEMPLATES,
    // The advisor's own, in the same payload and the same shape, so the
    // picker offers both without a second round trip.
    myTemplates: await listMyTemplates(env, user.id),
    catalogue: FIELD_CATALOGUE,
  });
}

export async function handleGetForm(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Scoped by location, not just id. This returns every submission on the
  // form, which is client names, emails and phone numbers, and an id is not a
  // permission.
  const row = await env.DB.prepare('SELECT * FROM forms WHERE id = ? AND location_id = ?')
    .bind(id, ghl.locationFor(env, user)).first();
  if (!row) return notFound('Form not found.');

  const { results } = await env.DB.prepare(
    'SELECT * FROM form_submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT 200'
  ).bind(id).all();

  return json({
    form: hydrate(row),
    catalogue: FIELD_CATALOGUE,
    templates: FORM_TEMPLATES,
    submissions: (results || []).map((s) => {
      let data = {};
      try { data = JSON.parse(s.data_json); } catch { data = {}; }
      return {
        id: s.id, name: s.name, email: s.email, phone: s.phone,
        contactId: s.contact_id, createdAt: s.created_at, data,
      };
    }),
  });
}

/**
 * Every lead the forms have brought in, across all of them.
 *
 * The per-form view answers "who filled this one in". This answers the
 * questions an owner actually asks: is any of this working, which form is
 * pulling its weight, and did the leads reach the CRM or stop here.
 */
export async function handleFormsReport(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const locationId = ghl.locationFor(env, user);
  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 90, 1), 730);
  // Seconds. now() is seconds in this codebase and mixing the two has been the
  // most repeated bug in it.
  const since = now() - days * 86400;

  const { results: rows } = await env.DB.prepare(
    `SELECT s.id, s.form_id, s.name, s.email, s.phone, s.contact_id, s.created_at,
            s.source, s.data_json, f.name AS form_name, f.slug
       FROM form_submissions s
       JOIN forms f ON f.id = s.form_id
      WHERE s.location_id = ? AND s.created_at >= ?
      ORDER BY s.created_at DESC
      LIMIT 500`
  ).bind(locationId, since).all();

  const submissions = (rows || []).map((r) => {
    let data = {};
    try { data = JSON.parse(r.data_json); } catch { data = {}; }
    return {
      id: r.id, formId: r.form_id, formName: r.form_name, slug: r.slug,
      name: r.name, email: r.email, phone: r.phone,
      contactId: r.contact_id, createdAt: r.created_at, source: r.source, data,
    };
  });

  const { results: forms } = await env.DB.prepare(
    `SELECT f.id, f.name, f.slug, f.active,
            (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS total,
            (SELECT MAX(created_at) FROM form_submissions s WHERE s.form_id = f.id) AS last_at
       FROM forms f WHERE f.location_id = ?
      ORDER BY total DESC, f.name ASC`
  ).bind(locationId).all();

  const byMonth = {};
  for (const s of submissions) {
    const key = new Date(s.createdAt * 1000).toISOString().slice(0, 7);
    byMonth[key] = (byMonth[key] || 0) + 1;
  }

  // A lead that never reached the CRM is one nobody is following up, which is
  // worth its own number rather than being buried in a total.
  const reachedCrm = submissions.filter((s) => s.contactId).length;

  return json({
    days,
    submissions,
    forms: forms || [],
    byMonth: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b))
      .map(([month, count]) => ({ month, count })),
    totals: {
      submissions: submissions.length,
      forms: (forms || []).length,
      activeForms: (forms || []).filter((f) => f.active).length,
      reachedCrm,
      strandedHere: submissions.length - reachedCrm,
      allTime: (forms || []).reduce((n, f) => n + (f.total || 0), 0),
    },
  });
}

/**
 * What the lead already told you, as a reservation.
 *
 * A form lead landed in the report and in the CRM and then stopped: turning it
 * into something quotable meant retyping their name, their dates and where
 * they want to go, off a screen two clicks away. Everything the form asked is
 * already here, so the reservation starts filled in.
 *
 * Quoted, never booked. Nobody has agreed to anything yet, and a reservation
 * that arrives booked would land in production totals and commission owed on
 * the strength of somebody filling in a form at a stand.
 */
export async function handleReservationFromLead(request, env, submissionId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const locationId = ghl.locationFor(env, user);
  // Scoped by location: a submission id is not a permission, and this reads a
  // client's name, email and phone number.
  const row = await env.DB.prepare(
    `SELECT s.*, f.name AS form_name, f.source AS form_source
       FROM form_submissions s JOIN forms f ON f.id = s.form_id
      WHERE s.id = ? AND s.location_id = ?`
  ).bind(submissionId, locationId).first();
  if (!row) return notFound('That lead was not found.');

  let data = {};
  try { data = JSON.parse(row.data_json); } catch { data = {}; }

  const clientName = clean(row.name, 120)
    || clean(data.full_name, 120)
    || [clean(data.first_name, 60), clean(data.last_name, 60)].filter(Boolean).join(' ')
    || clean(row.email, 120);
  if (!clientName) return badRequest('That lead has no name to file a reservation under.');

  // The catalogue keys earn their keep here: the same question always arrives
  // under the same name, so this mapping is a list rather than a guess.
  const productType = ({
    Cruise: 'cruise', 'All-inclusive resort': 'resort', 'Escorted tour': 'tour',
    'Independent travel': 'package', 'River cruise': 'cruise', Expedition: 'cruise',
  })[data.travel_type] || 'cruise';

  // resolveClient answers with an id, not a row. Reading it as an object left
  // client_id null on the reservation, so the trip was not attached to the
  // client it was for.
  const clientId = await db.resolveClient(env, user.id, clientName, {
    ghlContactId: row.contact_id || null,
  });

  // The lead gave an email and a phone number, and a client record without
  // them is a name. Only fills blanks: a record somebody has edited should not
  // be overwritten by whatever an old form said.
  if (clientId && (row.email || row.phone)) {
    await env.DB.prepare(
      `UPDATE clients SET email = COALESCE(NULLIF(email, ''), ?),
         phone = COALESCE(NULLIF(phone, ''), ?), updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(row.email || null, row.phone || null, now(), clientId, user.id).run();
  }

  // What they said, kept as prose on the reservation. A budget of "10,000 to
  // 20,000" is not a price and must not become one, so it goes in the notes
  // rather than the gross.
  const said = [
    data.budget ? `Budget: ${data.budget}` : '',
    data.nights ? `Length: ${data.nights}` : '',
    data.occasion ? `Occasion: ${data.occasion}` : '',
    data.travel_type ? `Interested in: ${data.travel_type}` : '',
    data.special_needs ? `Needs: ${data.special_needs}` : '',
    data.notes ? `They said: ${data.notes}` : '',
    `From ${row.form_name}${row.form_source ? ` (${row.form_source})` : ''}`,
  ].filter(Boolean).join('\n');

  const booking = await db.createBooking(env, user.id, {
    ghlContactId: row.contact_id || null,
    clientName,
    clientId: clientId || null,
    productType,
    destination: clean(data.destination, 120) || null,
    departDate: cleanDate(data.travel_date),
    returnDate: null,
    depositDue: null,
    finalPaymentDue: null,
    travellers: Math.max(1, Math.min(Number(data.party_size) || 1, 99)),
    grossCents: 0,
    commissionCents: 0,
    commissionStatus: 'pending',
    status: 'quoted',
    notes: said,
    insuranceStatus: 'unknown',
  });

  // The person who filled the form in is the first traveller, and the lead
  // holds their email and phone, so the reservation does not have to ask again.
  await env.DB.prepare(
    `INSERT INTO travellers (id, booking_id, user_id, name, email, phone, is_lead,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(uid(), booking.id, user.id, clientName, row.email || null, row.phone || null,
         now(), now()).run();

  await db.logActivity(env, user.id, 'lead.reservation',
    `Started a reservation for ${clientName}`, { submissionId, bookingId: booking.id });

  return json({ ok: true, bookingId: booking.id, clientName });
}

async function uniqueSlug(env, base, excludeId = null) {
  let slug = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    const row = await env.DB.prepare('SELECT id FROM forms WHERE slug = ?').bind(candidate).first();
    if (!row || row.id === excludeId) return candidate;
  }
  return `${slug}-${uid().slice(0, 6)}`;
}

export async function handleSaveForm(request, env, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('Give the form a name.');

  // Remembered before the insert below assigns one, so the status code can
  // still tell a create from an update.
  const isNew = !id;

  const fields = parseFields(body.fields);
  if (!fields.length) return badRequest('Add at least one field.');

  const locationId = ghl.locationFor(env, user);
  const ts = now();
  const slug = await uniqueSlug(env, clean(body.slug, 60) || name, id);

  const startsOn = cleanDate(body.startsOn);
  const endsOn = cleanDate(body.endsOn);
  if (startsOn && endsOn && endsOn < startsOn) {
    return badRequest('The form closes before it opens.');
  }

  const notifyEmail = clean(body.notifyEmail, 254);
  if (notifyEmail && !isValidEmail(notifyEmail)) {
    return badRequest('That notification address does not look right.');
  }

  const shared = [
    slug, name, clean(body.headline, 160), clean(body.description, 600),
    JSON.stringify(fields), clean(body.submitLabel, 40) || 'Send',
    clean(body.successMessage, 400), clean(body.redirectUrl, 300),
    body.active === false ? 0 : 1,
    startsOn, endsOn, notifyEmail || null, clean(body.source, 80) || null, ts,
  ];

  if (id) {
    const res = await env.DB.prepare(
      `UPDATE forms SET slug=?, name=?, headline=?, description=?, fields_json=?,
         submit_label=?, success_message=?, redirect_url=?, active=?,
         starts_on=?, ends_on=?, notify_email=?, source=?, updated_at=?
       WHERE id = ? AND location_id = ?`
    ).bind(...shared, id, locationId).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Form not found.');
    await db.logActivity(env, user.id, 'form.update', `Updated form ${name}`, { id });
  } else {
    id = uid();
    await env.DB.prepare(
      `INSERT INTO forms (id, location_id, slug, name, headline, description, fields_json,
         submit_label, success_message, redirect_url, active,
         starts_on, ends_on, notify_email, source, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, locationId, ...shared.slice(0, 13), user.id, ts, ts).run();
    await db.logActivity(env, user.id, 'form.create', `Created form ${name}`, { id });
  }

  const row = await env.DB.prepare('SELECT * FROM forms WHERE id = ? AND location_id = ?')
    .bind(id, locationId).first();
  return json({ ok: true, form: hydrate(row) }, isNew ? 201 : 200);
}

export async function handleDeleteForm(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM forms WHERE id = ? AND location_id = ?')
    .bind(id, ghl.locationFor(env, user)).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Form not found.');
  await db.logActivity(env, user.id, 'form.delete', 'Deleted a form', { id });
  return json({ ok: true });
}

export { hydrate as hydrateForm, FIELD_TYPES };
