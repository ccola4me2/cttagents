// What a client said when they got home, and who they sent you.
//
// A travel advisor's marketing is two things: people saying the trip was good,
// and people passing your name on. The portal already knew the moment for both
// and did neither. It has listed everybody who is back and has not been rung
// for a long time, under the heading "welcome home", and the list was the end
// of it.
//
// The ask goes to the page the client already has. No login, no new account, no
// third-party form: the trip page they have been opening for months grows a
// block at the bottom once the trip is over, and it asks two questions.
//
//   How was it, and may we quote you?
//   Who else would love this?
//
// The second is the one that pays. A named referral becomes a lead on the
// advisor's board, attributed to the person who sent them, which is exactly the
// shape src/attribution.js was built to count.
//
// Nothing is published anywhere by this file. consent_public records that
// somebody said it may be quoted; quoting it is a separate act by a person.

import { json, badRequest, notFound, uid, now, clean, cleanText,
         isValidEmail, normalizeEmail, sha256Hex, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { sendReviewRequest } from './email.js';

/** One to five, or nothing. A zero is not a rating, it is an empty box. */
function cleanRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 1 && r <= 5 ? r : null;
}

/**
 * Is this trip over?
 *
 * Asking somebody how their holiday was while they are on it is the kind of
 * thing that makes a portal look like it is not paying attention. The return
 * date if there is one, the departure if there is not.
 */
export function tripIsOver(booking, today) {
  if (!booking) return false;
  if (booking.status !== 'booked' && booking.status !== 'travelled') return false;
  const back = booking.return_date || booking.depart_date;
  return Boolean(back) && back < today;
}

/**
 * The review on a trip, or null. Public paths read it to fill the form back in.
 *
 * Names the owner as well as the booking. The booking id already decides which
 * review this is, so the owner is redundant in the sense that it cannot change
 * the answer, which is exactly why it belongs here: a statement that says whose
 * rows it wants can be read once and believed. The same reasoning loadTrip
 * gives a few files over.
 */
export async function reviewFor(env, bookingId, userId) {
  return env.DB.prepare('SELECT * FROM reviews WHERE booking_id = ? AND user_id = ?')
    .bind(bookingId, userId).first();
}

/**
 * The client answering, from their own trip page.
 *
 * Upserts, so somebody who writes a line and then thinks of something better
 * is not told they have already had their turn. The referral is separate: each
 * one names a different person, so each one is a new lead.
 */
export async function submitReview(env, request, booking, body) {
  // A bot fills every field it finds. Thanked rather than told, the same way
  // the note box on this page handles it.
  if (clean(body.company_website, 200)) return { ok: true, message: 'Thanks.' };

  const rating = cleanRating(body.rating);
  const text = cleanText(body.body, 4000);
  const referName = clean(body.referName, 120);
  const referEmail = normalizeEmail(clean(body.referEmail, 254) || '');
  const referPhone = clean(body.referPhone, 40);

  if (!rating && !text && !referName) {
    return { error: 'Tell them how it was, or give them a name. Either is welcome.' };
  }
  if (referEmail && !isValidEmail(referEmail)) {
    return { error: 'That email address does not look right.' };
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`review:${booking.id}:${ip}`)).slice(0, 32) : null;
  const ts = now();
  const out = { ok: true, reviewed: false, referred: null };

  if (rating || text) {
    const existing = await reviewFor(env, booking.id, booking.user_id);
    if (existing) {
      await env.DB.prepare(
        `UPDATE reviews SET rating = ?, body = ?, author_name = ?, consent_public = ?,
           submitted_at = ?, ip_hash = ?, updated_at = ? WHERE id = ? AND user_id = ?`
      ).bind(rating, text || null, clean(body.authorName, 120) || null,
             body.consentPublic ? 1 : 0, ts, ipHash, ts, existing.id, booking.user_id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO reviews (id, booking_id, user_id, client_id, rating, body,
           author_name, consent_public, submitted_at, ip_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uid(), booking.id, booking.user_id, booking.client_id || null,
             rating, text || null, clean(body.authorName, 120) || null,
             body.consentPublic ? 1 : 0, ts, ipHash, ts, ts).run();
    }
    out.reviewed = true;
  }

  if (referName) {
    // A lead on the advisor's board, carrying who sent them. resolveClient is
    // not used: this is somebody the advisor has never heard of, and matching
    // on a name typed by a third party would quietly merge two people.
    const existing = await env.DB.prepare(
      'SELECT id FROM clients WHERE user_id = ? AND name = ?'
    ).bind(booking.user_id, referName).first();

    if (existing) {
      // Already known. Fill in the blanks and record who sent them, and leave
      // everything that is already there alone.
      await env.DB.prepare(
        `UPDATE clients
            SET email = COALESCE(NULLIF(email, ''), ?),
                phone = COALESCE(NULLIF(phone, ''), ?),
                source_kind = COALESCE(source_kind, 'referral'),
                referred_by_client_id = COALESCE(referred_by_client_id, ?),
                source = COALESCE(NULLIF(source, ''), ?),
                updated_at = ?
          WHERE id = ? AND user_id = ?`
      ).bind(referEmail || null, referPhone || null, booking.client_id || null,
             `Referred by ${booking.client_name}`.slice(0, 120), ts,
             existing.id, booking.user_id).run();
      out.referred = { id: existing.id, name: referName, matched: true };
    } else {
      const id = uid();
      await env.DB.prepare(
        `INSERT INTO clients (id, user_id, name, email, phone, source, source_kind,
           referred_by_client_id, lead_stage, lead_at, lead_asked_about,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'referral', ?, 'new', ?, ?, ?, ?)`
      ).bind(id, booking.user_id, referName, referEmail || null, referPhone || null,
             `Referred by ${booking.client_name}`.slice(0, 120),
             booking.client_id || null, ts,
             `Sent by ${booking.client_name} after ${
               booking.product_name || 'their trip'}`.slice(0, 500),
             ts, ts).run();
      out.referred = { id, name: referName, matched: false };
    }
  }

  return out;
}

/**
 * Ask a client how it was.
 *
 * The advisor presses this. Nothing in the portal sends it on its own: the
 * portal knows when somebody is home, it does not know whether the flight was
 * cancelled or the hotel was wrong, and an automatic "how was it?" landing on
 * the wrong week is worse than none at all. The count is kept so the screen can
 * say it has been asked before rather than asking again on a whim.
 */
export async function handleAskReview(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerForBooking(env, user, bookingId);
  if (!owner) return notFound('Booking not found.');

  const booking = await db.getBooking(env, bookingId, owner.id);
  if (!booking) return notFound('Booking not found.');

  const today = new Date().toISOString().slice(0, 10);
  if (!tripIsOver(booking, today)) {
    return badRequest('They are not home yet. This asks how a trip was, so it waits '
      + 'until the trip is over.');
  }
  if (!booking.share_code) {
    return badRequest('This trip has no page to send them to. Share the trip page from the '
      + 'reservation first, and the same link is the one this asks them to open.');
  }

  const client = booking.client_id
    ? await env.DB.prepare('SELECT name, email FROM clients WHERE id = ? AND user_id = ?')
        .bind(booking.client_id, owner.id).first()
    : null;
  const to = client && client.email;
  if (!to) return badRequest('That client has no email address on file.');

  const ts = now();
  const existing = await reviewFor(env, booking.id, owner.id);
  const appUrl = (env.APP_URL || 'https://cttagents.com').replace(/\/$/, '');

  try {
    await sendReviewRequest(env, {
      to,
      replyTo: owner.notify_email || owner.email,
      clientName: (client && client.name) || booking.client_name,
      advisorName: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || owner.email,
      agencyName: owner.agency_name || '',
      advisorPhone: owner.phone || '',
      tripName: booking.itinerary || booking.product_name || '',
      href: `${appUrl}/t/${encodeURIComponent(booking.share_code)}`,
    });
  } catch (e) {
    return badRequest(String((e && e.message) || e).slice(0, 300));
  }

  // Stamped after the send, so a bounced address does not read as asked.
  if (existing) {
    await env.DB.prepare(
      `UPDATE reviews SET asked_at = ?, asked_count = asked_count + 1, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(ts, ts, existing.id, owner.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO reviews (id, booking_id, user_id, client_id, asked_at, asked_count,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(uid(), booking.id, owner.id, booking.client_id || null, ts, ts, ts).run();
  }

  await db.logActivity(env, owner.id, 'review.ask',
    db.byHand(`Asked ${booking.client_name} how the trip was`,
      user, owner), { bookingId: booking.id });
  return json({ ok: true, to });
}

/**
 * Every review this reader may see, newest answer first.
 *
 * The ones nobody has answered come too, at the bottom, because "asked and
 * heard nothing" is the half of this that tells you to pick up the phone.
 */
export async function handleListReviews(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'r.user_id');
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.booking_id, r.rating, r.body, r.author_name, r.consent_public,
            r.asked_at, r.asked_count, r.submitted_at, r.created_at,
            b.client_name, b.product_name, b.supplier, b.depart_date, b.return_date,
            b.share_code, b.client_id,
            (SELECT COUNT(*) FROM clients c
              WHERE c.referred_by_client_id = b.client_id
                AND c.user_id = b.user_id) AS referrals
       FROM reviews r JOIN bookings b ON b.id = r.booking_id
      WHERE ${scoped.sql}
      ORDER BY r.submitted_at IS NULL ASC, r.submitted_at DESC, r.created_at DESC
      LIMIT 200`
  ).bind(...scoped.binds).all();

  const rows = results || [];
  const answered = rows.filter((r) => r.submitted_at);
  const rated = answered.filter((r) => r.rating);

  return json({
    reviews: rows,
    stats: {
      asked: rows.length,
      answered: answered.length,
      quotable: answered.filter((r) => r.consent_public && r.body).length,
      // Null rather than nought when nobody has rated anything. An average of
      // no ratings is not zero stars.
      average: rated.length
        ? Math.round((rated.reduce((n, r) => n + r.rating, 0) / rated.length) * 10) / 10
        : null,
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}
