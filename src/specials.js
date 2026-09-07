// Deals worth telling people about, and when each one dies.
//
// The advisor's own, not a feed. What they were sent by a BDM, what they
// negotiated, the group rate with three cabins left. A list of those in an
// inbox cannot do the two things that make them worth keeping: it does not
// know what expires on Friday, and it gives you nowhere to send anybody.
//
// So each one has a date it stops being true and an address of its own. The
// address is the part that pays: an enquiry that arrives through a deal's page
// arrives attached to that deal, which is the only way to find out which
// offers pull and which ones you have been posting for nothing.

import {
  json, badRequest, notFound, clean, cleanText, cleanDate, oneOf, toCents,
  uid, now, readJson,
} from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { PRODUCT_TYPES } from './producttypes.js';

// How the headline price is quoted. Per person leads because it is how a fare
// is advertised, and oneOf falls back to the first entry.
export const PRICE_BASIS = ['per person', 'per cabin', 'per room', 'total', 'per night'];

const COLUMNS = `
  s.id, s.user_id, s.code, s.headline, s.vendor, s.vendor_id, s.product_type,
  s.ship, s.destination, s.depart_date, s.return_date, s.nights,
  s.price_cents, s.price_basis, s.inclusions, s.terms, s.blurb,
  s.starts_on, s.ends_on, s.published, s.created_at, s.updated_at
`;

const ADVISOR = `COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                   AS advisor_name`;

const ENQUIRIES = `(SELECT COUNT(*) FROM special_leads l WHERE l.special_id = s.id) AS enquiries`;
const BOOKED = `(SELECT COUNT(*) FROM special_leads l
                  WHERE l.special_id = s.id AND l.booking_id IS NOT NULL) AS booked`;

/**
 * A public address from the headline.
 *
 * Readable, because it gets pasted into a post and a link that says what it is
 * gets clicked more than one that says nothing. The suffix is what makes it
 * unique: two advisors both running "7 night western caribbean" is the normal
 * case, not the odd one.
 */
function slugFrom(headline) {
  const base = String(headline).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'deal';
  const tail = Math.random().toString(36).slice(2, 8);
  return `${base}-${tail}`;
}

async function freeCode(env, headline) {
  for (let i = 0; i < 5; i += 1) {
    const code = slugFrom(headline);
    const clash = await env.DB.prepare('SELECT id FROM specials WHERE code = ?').bind(code).first();
    if (!clash) return code;
  }
  // Five collisions on a six character suffix is not going to happen, but a
  // loop with no way out is worse than a code nobody can read.
  return `deal-${uid()}`;
}

function parse(body) {
  const headline = clean(body.headline, 160);
  if (!headline) return { error: 'Give the deal a headline.' };

  const startsOn = cleanDate(body.startsOn);
  const endsOn = cleanDate(body.endsOn);
  if (startsOn && endsOn && endsOn < startsOn) {
    return { error: 'The offer ends before it starts.' };
  }

  const departDate = cleanDate(body.departDate);
  const returnDate = cleanDate(body.returnDate);
  if (departDate && returnDate && returnDate < departDate) {
    return { error: 'It comes back before it leaves.' };
  }

  return {
    fields: {
      headline,
      vendor: clean(body.vendor, 120),
      vendorId: clean(body.vendorId, 64) || null,
      productType: oneOf(body.productType, PRODUCT_TYPES),
      ship: clean(body.ship, 120),
      destination: clean(body.destination, 120),
      departDate,
      returnDate,
      nights: Math.max(0, Math.min(Number(body.nights) || 0, 999)) || null,
      priceCents: toCents(body.price) || null,
      priceBasis: oneOf(body.priceBasis, PRICE_BASIS),
      inclusions: cleanText(body.inclusions, 2000),
      terms: cleanText(body.terms, 2000),
      blurb: cleanText(body.blurb, 4000),
      startsOn,
      endsOn,
      published: body.published ? 1 : 0,
    },
  };
}

export async function listSpecials(env, scope, { state = 'live', limit = 300 } = {}) {
  const scoped = db.scopeWhere(scope, 's.user_id');
  const where = [scoped.sql];
  const today = new Date().toISOString().slice(0, 10);
  // Expired means the offer has an end date and it has gone. A deal with no
  // end date never expires, which is a real thing an advisor means: an evergreen
  // group rate is not a promotion with a deadline.
  if (state === 'live') where.push('(s.ends_on IS NULL OR s.ends_on >= ?)');
  if (state === 'expired') where.push('(s.ends_on IS NOT NULL AND s.ends_on < ?)');

  const binds = [...scoped.binds];
  if (state === 'live' || state === 'expired') binds.push(today);

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS}, ${ADVISOR}, ${ENQUIRIES}, ${BOOKED}
       FROM specials s LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where.join(' AND ')}
      -- Soonest to die first. A promotions list ordered by when it was written
      -- buries the one with two days left under six that run all year.
      ORDER BY s.ends_on IS NULL ASC, s.ends_on ASC, s.created_at DESC
      LIMIT ?`
  ).bind(...binds, Math.min(Number(limit) || 300, 500)).all();
  return results || [];
}

async function getSpecial(env, id, userId) {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM specials s WHERE s.id = ? AND s.user_id = ?`)
    .bind(id, userId).first();
}

export async function handleListSpecials(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const state = oneOf(url.searchParams.get('state'), ['live', 'expired', 'all']);
  const scope = db.scopeFor(env, user, request);
  const specials = await listSpecials(env, scope, { state });

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const live = specials.filter((s) => !s.ends_on || s.ends_on >= today);

  return json({
    specials,
    today,
    stats: {
      live: live.length,
      published: live.filter((s) => s.published).length,
      endingSoon: live.filter((s) => s.ends_on && s.ends_on <= soon).length,
      enquiries: specials.reduce((n, s) => n + (s.enquiries || 0), 0),
    },
    productTypes: PRODUCT_TYPES,
    priceBasis: PRICE_BASIS,
    appUrl: (env.APP_URL || 'https://tripvaratravel.com').replace(/\/$/, ''),
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

export async function handleGetSpecial(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 's.user_id');
  const special = await env.DB.prepare(
    `SELECT ${COLUMNS}, ${ADVISOR} FROM specials s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).first();
  if (!special) return notFound('Special not found.');

  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.email, l.phone, l.party_size, l.notes, l.booking_id,
            l.created_at, b.client_name AS booking_client
       FROM special_leads l
       LEFT JOIN bookings b ON b.id = l.booking_id
      WHERE l.special_id = ? ORDER BY l.created_at DESC LIMIT 500`
  ).bind(id).all();

  return json({
    special,
    leads: results || [],
    editable: special.user_id === user.id,
    productTypes: PRODUCT_TYPES,
    priceBasis: PRICE_BASIS,
    appUrl: (env.APP_URL || 'https://tripvaratravel.com').replace(/\/$/, ''),
  });
}

export async function handleCreateSpecial(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const id = uid();
  const code = await freeCode(env, fields.headline);
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO specials (id, user_id, code, headline, vendor, vendor_id, product_type,
       ship, destination, depart_date, return_date, nights, price_cents, price_basis,
       inclusions, terms, blurb, starts_on, ends_on, published, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, user.id, code, fields.headline, fields.vendor, fields.vendorId, fields.productType,
         fields.ship, fields.destination, fields.departDate, fields.returnDate, fields.nights,
         fields.priceCents, fields.priceBasis, fields.inclusions, fields.terms, fields.blurb,
         fields.startsOn, fields.endsOn, fields.published, ts, ts).run();

  await db.logActivity(env, user.id, 'special.create', `Added a special: ${fields.headline}`, { id });
  return json({ ok: true, special: await getSpecial(env, id, user.id) }, 201);
}

export async function handleUpdateSpecial(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const res = await env.DB.prepare(
    `UPDATE specials SET headline = ?, vendor = ?, vendor_id = ?, product_type = ?,
       ship = ?, destination = ?, depart_date = ?, return_date = ?, nights = ?,
       price_cents = ?, price_basis = ?, inclusions = ?, terms = ?, blurb = ?,
       starts_on = ?, ends_on = ?, published = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.headline, fields.vendor, fields.vendorId, fields.productType,
         fields.ship, fields.destination, fields.departDate, fields.returnDate, fields.nights,
         fields.priceCents, fields.priceBasis, fields.inclusions, fields.terms, fields.blurb,
         fields.startsOn, fields.endsOn, fields.published, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Special not found.');

  return json({ ok: true, special: await getSpecial(env, id, user.id) });
}

export async function handleDeleteSpecial(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Counted first, because "deleted" reporting one row when it took four names
  // with it is the kind of number that stops people trusting the rest.
  const { results } = await env.DB.prepare(
    'SELECT id FROM special_leads WHERE special_id = ? AND user_id = ?'
  ).bind(id, user.id).all();

  const res = await env.DB.prepare('DELETE FROM specials WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Special not found.');

  // Said outright rather than left to ON DELETE CASCADE. The constraint is
  // declared and SQLite will honour it where foreign keys are on, but that is
  // a setting on the database rather than a fact about this code, and a table
  // created without the clause, by a hand-run migration or a console that
  // baulked at it, would silently leave every enquiry behind pointing at a
  // deal that no longer exists.
  await env.DB.prepare('DELETE FROM special_leads WHERE special_id = ? AND user_id = ?')
    .bind(id, user.id).run();

  return json({ ok: true, enquiriesRemoved: (results || []).length });
}

/** Turn an enquiry into a reservation, the way a group registration does. */
export async function handleBookEnquiry(request, env, leadId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const lead = await env.DB.prepare(
    `SELECT l.id, l.name, l.email, l.phone, l.party_size, l.special_id, l.booking_id,
            s.vendor, s.vendor_id, s.product_type, s.ship, s.destination,
            s.depart_date, s.return_date, s.headline
       FROM special_leads l JOIN specials s ON s.id = l.special_id
      WHERE l.id = ? AND l.user_id = ?`
  ).bind(leadId, user.id).first();
  if (!lead) return notFound('Enquiry not found.');
  if (lead.booking_id) return badRequest('That enquiry is already on a reservation.');

  const clientId = await db.resolveClient(env, user.id, lead.name);
  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO bookings (id, user_id, client_name, client_id, supplier, vendor_id,
       product_type, product_name, destination, depart_date, return_date, travellers,
       status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'quoted',?,?)`
  ).bind(id, user.id, lead.name, clientId, lead.vendor, lead.vendor_id,
         lead.product_type, lead.headline, lead.destination,
         lead.depart_date, lead.return_date, lead.party_size || null, ts, ts).run();

  await env.DB.prepare('UPDATE special_leads SET booking_id = ? WHERE id = ? AND user_id = ?')
    .bind(id, leadId, user.id).run();

  // The client's contact details came in on the enquiry and would otherwise
  // stop at the deal's page, leaving a reservation for somebody with no way
  // to reach them.
  if (clientId && (lead.email || lead.phone)) {
    await env.DB.prepare(
      `UPDATE clients SET email = COALESCE(NULLIF(email,''), ?),
                          phone = COALESCE(NULLIF(phone,''), ?), updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(lead.email || null, lead.phone || null, ts, clientId, user.id).run();
  }

  await db.logActivity(env, user.id, 'special.book',
    `Turned an enquiry into a reservation for ${lead.name}`, { id, leadId });
  return json({ ok: true, bookingId: id }, 201);
}

export async function handleDeleteEnquiry(request, env, leadId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM special_leads WHERE id = ? AND user_id = ?')
    .bind(leadId, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Enquiry not found.');
  return json({ ok: true });
}
