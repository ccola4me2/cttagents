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
import { requireUser } from './auth.js';
import * as db from './db.js';

const COLUMNS = `
  id, booking_id, user_id, label, detail, amount_cents, chosen, sort_order,
  image_url, inclusions, chosen_at, chosen_by, created_at, updated_at
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
    },
  };
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
       (id, booking_id, user_id, label, detail, amount_cents, chosen, sort_order,
        image_url, inclusions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, user.id, fields.label, fields.detail, fields.amountCents,
         fields.sortOrder, fields.imageUrl, fields.inclusions, ts, ts).run();

  await db.logActivity(env, user.id, 'option.add',
    `Added "${fields.label}" to ${booking.client_name}'s quote`, { bookingId });
  return json({ ok: true, id }, 201);
}

export async function handleUpdateOption(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const res = await env.DB.prepare(
    `UPDATE quote_options SET label = ?, detail = ?, amount_cents = ?, sort_order = ?,
            image_url = ?, inclusions = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(fields.label, fields.detail, fields.amountCents, fields.sortOrder,
         fields.imageUrl, fields.inclusions, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Option not found.');
  return json({ ok: true });
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

  // One at a time. Two chosen options is not a client who wants both, it is a
  // record nobody can read.
  await env.DB.prepare(
    `UPDATE quote_options SET chosen = 0, chosen_at = NULL, chosen_by = NULL,
       updated_at = ? WHERE booking_id = ? AND user_id = ?`
  ).bind(now(), option.booking_id, user.id).run();

  if (chosen) {
    await env.DB.prepare(
      `UPDATE quote_options SET chosen = 1, chosen_at = ?, chosen_by = 'advisor',
         updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(now(), now(), id, user.id).run();

    await env.DB.prepare(
      'UPDATE bookings SET gross_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(option.amount_cents, now(), option.booking_id, user.id).run();
  }

  await db.logActivity(env, user.id, 'option.choose',
    chosen
      ? `${booking.client_name} chose "${option.label}"`
      : `Cleared the chosen option for ${booking.client_name}`,
    { bookingId: option.booking_id });
  return json({ ok: true, chosen: Boolean(chosen) });
}
