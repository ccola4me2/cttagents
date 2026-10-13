// A quote that nobody has answered gets a follow-up on the advisor's list.
//
// A quote goes out and then there is nothing to say it exists. It is not a task, so it is never on the
// to do list; it is not booked, so it is in no total; and the reservation looks the same the day it was
// sent and a month later. The follow-up that wins the booking is the one that happens three days after,
// and it is the one that gets forgotten.
//
// So the portal makes the task. Three days after a quote was sent, with no answer and no deposit, the
// advisor whose quote it is gets a to do, dated today, on that reservation. It then does everything a
// task already does: it is on the To do page, it is in the morning email, and it is in the bell. Nothing
// here emails a client. The nudge is to the advisor, who decides what to say.
//
// Bounded, because a nudge that never stops is one people learn to ignore. At most three for any one
// quote, never while one is still open, and four days apart, so a quote that is still unanswered after
// ten days has had three reminders and then is left to the advisor's judgement.

import { uid, now } from './util.js';

// Days after the quote went out before the first nudge, and between one nudge and the next.
export const FIRST_AFTER_DAYS = 3;
export const AGAIN_AFTER_DAYS = 4;
export const MOST_NUDGES = 3;
// A quote older than this has gone cold, and nudging it the day this ships would flood the list with every
// old quote at once. It is left to the advisor, who can still send it again.
export const TOO_OLD_DAYS = 21;

// What every nudge's title starts with, so they can be told from tasks somebody wrote by hand.
export const NUDGE_TITLE = 'Follow up on the quote for';

const money = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const say = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
};

/** What the task says, from what is known about the quote. */
export function nudgeText(b, days) {
  const opened = Number(b.view_count) || 0;
  const bits = [
    `The quote for ${b.product_name || b.supplier || 'this trip'} went out ${days} day${days === 1 ? '' : 's'} ago and has not been answered.`,
    opened
      ? `They have opened their page ${opened} time${opened === 1 ? '' : 's'}, so they are looking at it: a call or a message will help.`
      : 'They have not opened it yet. Mail goes missing, so a second send before a call is worth it.',
  ];
  if (b.deposit_cents) {
    bits.push(`The deposit is ${money(b.deposit_cents)}${b.deposit_due ? `, due ${say(b.deposit_due)}` : ''}.`);
  }
  bits.push('Open the reservation to send it again, or to post the deposit once it arrives, which books it.');
  return bits.join(' ');
}

/**
 * One pass. Safe to run on every tick: a quote that already has an open nudge, or had one made
 * recently, is passed over, so it does nothing most of the time.
 */
export async function nudgeQuotes(env, { at = now(), limit = 200 } = {}) {
  const today = new Date(at * 1000).toISOString().slice(0, 10);
  const first = at - FIRST_AFTER_DAYS * 86400;
  const again = at - AGAIN_AFTER_DAYS * 86400;
  const cold = at - TOO_OLD_DAYS * 86400;

  // Every advisor, on purpose: this runs as nobody. Each row carries its own user_id and the task made
  // from it belongs to that advisor and no one else.
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.user_id, b.client_id, b.client_name, b.product_name, b.supplier,
            b.quote_sent_at, b.deposit_cents, b.deposit_due, b.view_count
       FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE u.status = 'active' AND b.status = 'quoted' AND b.personal = 0
        AND b.quote_sent_at IS NOT NULL AND b.quote_sent_at <= ? AND b.quote_sent_at >= ?
        AND b.accepted_at IS NULL AND b.declined_at IS NULL
        AND (b.depart_date IS NULL OR b.depart_date = '' OR b.depart_date >= ?)
        AND NOT EXISTS (SELECT 1 FROM quote_options o WHERE o.booking_id = b.id AND o.chosen = 1)
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.booking_id = b.id AND t.user_id = b.user_id
                         AND t.title LIKE ? AND t.done_at IS NULL)
        AND (SELECT COUNT(*) FROM tasks t WHERE t.booking_id = b.id AND t.user_id = b.user_id
                AND t.title LIKE ?) < ?
        AND COALESCE((SELECT MAX(t.created_at) FROM tasks t WHERE t.booking_id = b.id AND t.user_id = b.user_id
                AND t.title LIKE ?), 0) <= ?
      ORDER BY b.quote_sent_at ASC
      LIMIT ?`
  ).bind(first, cold, today, `${NUDGE_TITLE}%`, `${NUDGE_TITLE}%`, MOST_NUDGES, `${NUDGE_TITLE}%`, again, limit).all();

  const rows = results || [];
  if (!rows.length) return { made: 0 };

  const stmt = env.DB.prepare(
    `INSERT INTO tasks (id, user_id, title, notes, due_date, priority, kind, booking_id, client_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'normal', 'call', ?, ?, ?, ?)`
  );
  const ts = now();
  await env.DB.batch(rows.map((b) => {
    const days = Math.max(1, Math.floor((at - b.quote_sent_at) / 86400));
    return stmt.bind(
      uid(), b.user_id, `${NUDGE_TITLE} ${b.client_name}`.slice(0, 200), nudgeText(b, days), today,
      b.id, b.client_id || null, ts, ts
    );
  }));
  return { made: rows.length };
}
