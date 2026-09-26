// What is out with a client and still unanswered.
//
// A proposal is a reservation in the quoted state with options on it. It has
// never had a screen of its own: the reservation list shows them among
// everything else, and the dashboard shows the ones nobody has answered in a
// week. Neither says which of them is waiting on the client and which is
// waiting on the advisor, and that is the only distinction that matters here.
//
// Every fact below was already being written down. quote_sent_at and
// quote_sent_count since quotes were emailable, viewed_first_at and view_count
// since the trip page counted a visit, chosen and chosen_by since a client
// could pick an option. Nothing new is recorded; this is the first time any of
// it is read together.

import { json, clean, badRequest, notFound, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

/**
 * Where a proposal has got to, worked out rather than stored.
 *
 * Ordered by who is holding it up. The first three are the advisor's own
 * doing and the last two are the client's, and an advisor who only ever
 * clears the first three has still done the part nobody else can.
 */
export const PROPOSAL_STATES = [
  { id: 'empty', name: 'Nothing to choose from',
    hint: 'Quoted, with no options on it. There is nothing for the client to answer.' },
  { id: 'unsent', name: 'Not sent',
    hint: 'Written and never sent. This is the one that costs the most and is the easiest to fix.' },
  { id: 'chosen', name: 'They chose, not booked yet',
    hint: 'The client answered. Turning it into a booking is the last thing between you and the commission.' },
  { id: 'declined', name: 'They said no',
    hint: 'Answered, and the answer was no. Worth reading why: half of these are a date or a '
      + 'budget rather than a no to you.' },
  { id: 'unopened', name: 'Sent, not opened',
    hint: 'Out and never looked at. Worth a second send before a chase: mail goes missing.' },
  { id: 'waiting', name: 'Opened, no answer',
    hint: 'They read it and said nothing. This is the follow-up list.' },
];

function stateOf(b) {
  // Before every other answer. A client who chose and then thought better of
  // it has declined, and a quote sitting in "they chose" on the strength of an
  // option they have since said no to is the worst row on this page.
  if (b.declined_at) return 'declined';
  if (b.chosen_count > 0) return 'chosen';
  if (!b.option_count) return 'empty';
  // Out either way: an emailed quote and a shared trip page are the same act
  // from the client's side, and an advisor who only ever sends the link should
  // not be told they have never sent anything.
  if (!b.quote_sent_at && !b.shared_at) return 'unsent';
  if (!b.view_count) return 'unopened';
  return 'waiting';
}

const days = (from, nowSec) => (from ? Math.floor((nowSec - from) / 86400) : null);

/**
 * They said yes.
 *
 * The whole of turning a proposal into a reservation is this one field, and
 * that is the argument for never building a second kind of record. The trip
 * page link the client already holds keeps working. The options they turned
 * down stay where they are, and what somebody declined is the most useful
 * thing you can know the next time you quote them. The view count, the
 * payment schedule, the client and the agreed commission split are all still
 * attached to the same row, rather than copied across at the exact moment the
 * money became real.
 *
 * Only from quoted, and the condition is in the UPDATE rather than in a read
 * followed by a write. This is a button on a list of rows that were fetched a
 * minute ago: the trip may have been booked from another tab, or cancelled,
 * and a list button that can move a cancelled trip to booked is one misclick
 * from a reservation nobody can account for.
 *
 * It does not touch the price. handleChooseOption already made the trip total
 * follow the option the client picked, so by the time anybody presses this the
 * figure is right, and a second opinion about it here would be a way for the
 * two to disagree.
 */
export async function handleMarkBooked(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerForBooking(env, user, id);
  if (!owner) return notFound('Reservation not found.');

  const res = await env.DB.prepare(
    `UPDATE bookings SET status = 'booked', updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'quoted'`
  ).bind(now(), id, owner.id).run();

  if (!res.meta || res.meta.changes === 0) {
    return badRequest('That is not a quote any more. Open it and see where it got to.');
  }

  const booking = await db.getBooking(env, id, owner.id);
  await db.logActivity(env, owner.id, 'booking.booked',
    `Booked ${booking?.client_name || 'a trip'} from the proposals list`, { booking: id });

  return json({ ok: true, id, status: 'booked' });
}

/**
 * Record a no, or take one back.
 *
 * The client can say no from their own page, and an advisor needs the same
 * switch for the half of the noes that arrive by phone. Symmetrical with
 * "Client chose this" on the same card and for the same reason: what the
 * portal knows should not depend on which way the client happened to answer.
 *
 * Only a quote. A booked trip that falls over is a cancellation, which keeps
 * the deposit, the penalty and the commission owed; this keeps none of those
 * because there was never any money. Letting one button do both would put
 * trips that cost somebody something in the same bucket as trips that never
 * existed.
 */
export async function handleSetDeclined(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerForBooking(env, user, id);
  if (!owner) return notFound('Reservation not found.');

  const body = await readJson(request);
  const on = body.on !== false && body.on !== 'false';
  const reason = clean(body.reason, 500);
  const ts = now();

  const res = on
    ? await env.DB.prepare(
      `UPDATE bookings SET declined_at = ?, declined_reason = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'quoted'`
    ).bind(ts, reason || null, ts, id, owner.id).run()
    : await env.DB.prepare(
      `UPDATE bookings SET declined_at = NULL, declined_reason = NULL, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(ts, id, owner.id).run();

  if (!res.meta || res.meta.changes === 0) {
    return badRequest(on
      ? 'Only a quote can be declined. Open it and see where it got to.'
      : 'Nothing to undo.');
  }

  await db.logActivity(env, owner.id, 'quote.declined',
    on ? 'Recorded that the client said no' : 'Took back a no', { booking: id });

  return json({ ok: true, declined: on });
}

export async function handleProposals(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const scope = db.scopeFor(env, user, request);
  const query = clean(url.searchParams.get('q'), 80);
  const nowSec = Math.floor(Date.now() / 1000);

  let rows = await db.proposals(env, scope);
  if (query) {
    const needle = query.toLowerCase();
    rows = rows.filter((b) => [b.client_name, b.supplier, b.product_name, b.itinerary]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)));
  }

  const items = rows.map((b) => {
    const out = b.quote_sent_at || b.shared_at || null;
    return {
      id: b.id,
      clientName: b.client_name || '',
      supplier: b.supplier || '',
      productName: b.product_name || '',
      itinerary: b.itinerary || '',
      departDate: b.depart_date || '',
      grossCents: b.gross_cents || 0,
      shareCode: b.share_code || null,
      optionsOpen: Boolean(b.options_open),
      optionCount: b.option_count || 0,
      declinedAt: b.declined_at || null,
      declinedReason: b.declined_reason || '',
      chosenLabel: b.chosen_label || '',
      chosenAt: b.chosen_at || null,
      chosenBy: b.chosen_by || null,
      sentAt: b.quote_sent_at || null,
      sentCount: b.quote_sent_count || 0,
      sharedAt: b.shared_at || null,
      viewCount: b.view_count || 0,
      viewedFirstAt: b.viewed_first_at || null,
      viewedLastAt: b.viewed_last_at || null,
      advisorName: b.advisor_name || '',
      state: stateOf(b),
      // How long it has been sitting. Measured from when it went out, or from
      // when it was written if it never did, because an unsent quote is still
      // ageing and pretending otherwise is how one sits for a month.
      age: days(out || b.created_at, nowSec),
      sinceSeen: days(b.viewed_last_at, nowSec),
    };
  });

  const groups = PROPOSAL_STATES.map((st) => ({
    ...st,
    items: items.filter((i) => i.state === st.id),
  }));

  return json({
    groups,
    total: items.length,
    // The money sitting in unanswered proposals. Not a forecast and not
    // weighted by anything: it is what these trips are quoted at, which is the
    // number an advisor is carrying whether or not they have added it up.
    openValue: items.reduce((n, i) => n + i.grossCents, 0),
    // The three the advisor can act on today without anybody replying.
    // A no is not waiting on the advisor. There is nothing to do about it
    // today, and counting it here would turn the one number on this page that
    // means "get on with it" into a number that never goes down.
    yours: items.filter((i) => i.state === 'unsent' || i.state === 'chosen'
      || i.state === 'empty').length,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}
