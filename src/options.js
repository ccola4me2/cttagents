// The two or three choices a real quote offers.
//
// A quote here was one trip at one price, which is not how anybody sells
// travel. An advisor pricing Alaska sends an inside, an oceanview and a
// balcony and lets the client pick; the systems they are given hold one
// number, so they build the comparison in Word and the portal never learns
// what was offered or what was taken.
//
// The choice matters after the sale too. "They took the balcony over the
// oceanview for eight hundred more" is the most useful thing you can know
// about a client the next time you quote them, and it is exactly what gets
// lost when the losing options are deleted.

import { json, badRequest, notFound, clean, cleanText, toCents, uid, now, readJson } from './util.js';
import { tenantFor } from './tenant.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { fireTrigger } from './automations.js';

const COLUMNS = `
  id, booking_id, user_id, label, detail, amount_cents, chosen, recommended, sort_order,
  image_url, inclusions, chosen_at, chosen_by, component_id, created_at, updated_at
`;

export async function listOptions(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM quote_options
      WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY sort_order ASC, amount_cents ASC`
  ).bind(bookingId, ...scoped.binds).all();
  return results || [];
}

function parse(body) {
  const label = clean(body.label, 120);
  if (!label) return { error: 'What is this option called?' };

  const imageUrl = clean(body.imageUrl, 500);
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
    // It loads on a page the client opens over https, and a plain http image
    // on one of those is a browser warning beside your proposal.
    return { error: 'A picture address has to start with https://.' };
  }
  return {
    fields: {
      label,
      detail: clean(body.detail, 200),
      amountCents: toCents(body.amount),
      sortOrder: Math.max(0, Math.min(Number(body.sortOrder) || 0, 999)),
      imageUrl: imageUrl || null,
      // What the client gets for the money. Its own field rather than more
      // prose in detail, because this is the part they compare across three
      // options and comparing needs it in the same place on each.
      inclusions: cleanText(body.inclusions, 1500) || null,
      // Which part of the trip this is an alternative for. Blank means the
      // trip itself, which is what every option was before components could
      // carry their own.
      componentId: clean(body.componentId, 64) || null,
    },
  };
}

/**
 * The component an option belongs to, if it belongs to one and it is ours.
 *
 * Checked rather than trusted: the id arrives in the request, and an option
 * pinned to somebody else's component would group with theirs and be cleared
 * by their client's choice.
 */
async function ownComponent(env, userId, bookingId, componentId) {
  if (!componentId) return null;
  const row = await env.DB.prepare(
    'SELECT id FROM components WHERE id = ? AND booking_id = ? AND user_id = ?'
  ).bind(componentId, bookingId, userId).first();
  return row ? row.id : null;
}

export async function handleAddOption(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO quote_options
       (id, booking_id, user_id, label, detail, amount_cents, chosen, recommended, sort_order,
        image_url, inclusions, component_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, user.id, fields.label, fields.detail, fields.amountCents,
         fields.sortOrder, fields.imageUrl, fields.inclusions,
         await ownComponent(env, user.id, bookingId, fields.componentId), ts, ts).run();

  await db.logActivity(env, user.id, 'option.add',
    `Added "${fields.label}" to ${booking.client_name}'s quote`, { bookingId });
  return json({ ok: true, id }, 201);
}

export async function handleUpdateOption(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  // Read first, because moving an option between groups has to be checked
  // against the booking it is already on rather than one named in the request.
  const before = await env.DB.prepare(
    'SELECT booking_id, chosen FROM quote_options WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!before) return notFound('Option not found.');

  const componentId = await ownComponent(env, user.id, before.booking_id, fields.componentId);

  const res = await env.DB.prepare(
    `UPDATE quote_options SET label = ?, detail = ?, amount_cents = ?, sort_order = ?,
            image_url = ?, inclusions = ?, component_id = ?,
            updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(fields.label, fields.detail, fields.amountCents, fields.sortOrder,
         fields.imageUrl, fields.inclusions, componentId, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Option not found.');
  return json({ ok: true });
}

/**
 * The one the advisor would pick.
 *
 * Its own endpoint rather than a field on the edit form, because it is a
 * one-of-many state and the form saves one card at a time: saving a card with
 * a "recommended" tickbox would need the form to know about the other cards,
 * and the day it got that wrong there would be two.
 *
 * Grouped exactly as choosing is. An option belongs either to a component or
 * to the trip itself, and a suggestion about cabins says nothing about
 * insurance. The predicate is written out here rather than borrowed from a
 * helper for the reason the comment in handleChooseOption gives: check-scope
 * refuses a write that names user_id and interpolates something.sql, and it is
 * right to, because a grouping predicate and a viewing scope look identical at
 * a glance and only one of them is a data fence.
 */
export async function handleRecommendOption(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const option = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM quote_options WHERE id = ? AND user_id = ?`
  ).bind(id, user.id).first();
  if (!option) return notFound('Option not found.');

  const booking = await db.getBooking(env, option.booking_id, user.id);
  if (!booking) return notFound('Reservation not found.');

  const body = await readJson(request);
  // Sent as false to take a suggestion back, which is the same button again.
  const on = body.recommended === false ? 0 : 1;

  const sameGroup = option.component_id ? 'component_id = ?' : 'component_id IS NULL';
  const groupBinds = option.component_id ? [option.component_id] : [];

  await env.DB.prepare(
    `UPDATE quote_options SET recommended = 0, updated_at = ?
      WHERE booking_id = ? AND user_id = ? AND ${sameGroup}`
  ).bind(now(), option.booking_id, user.id, ...groupBinds).run();

  if (on) {
    await env.DB.prepare(
      'UPDATE quote_options SET recommended = 1, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(now(), id, user.id).run();
  }

  await db.logActivity(env, user.id, 'option.recommend',
    on ? `Suggested "${option.label}" on ${booking.client_name}'s quote`
      : `Took back the suggestion on ${booking.client_name}'s quote`,
    { bookingId: booking.id });

  return json({ ok: true, recommended: on === 1 });
}

export async function handleDeleteOption(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare(
    'DELETE FROM quote_options WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Option not found.');
  return json({ ok: true });
}

/**
 * The client answered.
 *
 * Marks one option taken and makes the reservation's price follow it, because
 * a quote whose chosen option says $3,400 and whose trip total still says
 * $2,900 is a reservation that will be wrong on every report it appears in.
 * The losing options are kept: what somebody turned down is the most useful
 * thing you can know the next time you quote them.
 *
 * Deliberately does not book the trip. A client saying "the balcony, then" is
 * not a deposit, and moving the reservation to booked on their behalf would
 * put money into production that nobody has taken.
 */
/**
 * Let the client answer, or stop them.
 *
 * Its own switch rather than "there are options, so they may pick one": a
 * quote still being written should not be answerable, and one already settled
 * on the phone should not be contradicted by the page a week later.
 */
export async function handleOpenOptions(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const open = body.open === true || body.open === 'on';
  const res = await env.DB.prepare(
    'UPDATE bookings SET options_open = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(open ? 1 : 0, now(), bookingId, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Reservation not found.');

  return json({ ok: true, open });
}

export async function handleChooseOption(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const option = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM quote_options WHERE id = ? AND user_id = ?`
  ).bind(id, user.id).first();
  if (!option) return notFound('Option not found.');

  const booking = await db.getBooking(env, option.booking_id, user.id);
  if (!booking) return notFound('Reservation not found.');

  const body = await readJson(request);
  // Sent as false to undo a choice made by mistake, which happens more often
  // than a client changing their mind.
  const chosen = body.chosen === false ? 0 : 1;

  // One at a time within a group, not across the whole reservation.
  //
  // A group is the component the option belongs to, or the trip itself for the
  // whole-trip alternatives. Clearing everything was right when every option
  // was a whole alternative and is wrong now: choosing a cabin would unchoose
  // the insurance, and the client would watch their last answer disappear.
  // Named so it cannot be mistaken for a scope helper. check-scope refuses a
  // write that names user_id and also interpolates ${something.sql}, because a
  // write must never borrow a viewing scope, and a grouping predicate called
  // group.sql is indistinguishable from one at a glance. It was right to ask.
  const sameGroup = option.component_id ? 'component_id = ?' : 'component_id IS NULL';
  const groupBinds = option.component_id ? [option.component_id] : [];

  await env.DB.prepare(
    `UPDATE quote_options SET chosen = 0, chosen_at = NULL, chosen_by = NULL,
       updated_at = ? WHERE booking_id = ? AND user_id = ? AND ${sameGroup}`
  ).bind(now(), option.booking_id, user.id, ...groupBinds).run();

  if (chosen) {
    await env.DB.prepare(
      `UPDATE quote_options SET chosen = 1, chosen_at = ?, chosen_by = 'advisor',
         updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(now(), now(), id, user.id).run();

    // Only a whole-trip option is the trip's price. A cabin grade or an
    // insurance choice is part of the total, not the total, and writing it
    // over gross_cents would report a $6,000 cruise as a $90 policy.
    if (!option.component_id) {
      await env.DB.prepare(
        'UPDATE bookings SET gross_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?'
      ).bind(option.amount_cents, now(), option.booking_id, user.id).run();
    }
  }

  if (chosen) {
    await fireTrigger(env, tenantFor(env, user), 'option.chosen', {
      bookingId: booking.id,
      contactId: booking.ghl_contact_id || null,
      name: booking.client_name,
      option: option.label,
      amount: option.amount_cents || 0,
      part: option.component_id ? 'part of the trip' : 'the whole trip',
      chosen_by: 'advisor',
      // Once per option. Unchoosing and rechoosing is a correction, not a
      // second yes, and it should not send the client a second welcome.
    }, { key: `option.chosen:${option.id}` });
  }

  await db.logActivity(env, user.id, 'option.choose',
    chosen
      ? `${booking.client_name} chose "${option.label}"`
      : `Cleared the chosen option for ${booking.client_name}`,
    { bookingId: option.booking_id });
  return json({ ok: true, chosen: Boolean(chosen) });
}
