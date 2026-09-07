// The Monday email that makes Who to call worth having.
//
// The page answers a real question and it still has to be remembered.
// Everything else that earns money here has a deadline pushing it: a payment
// falls due, a document is missing, a client is waiting on a quote. Ringing
// somebody who has gone quiet has nothing pushing it at all, which is exactly
// why it never happens and exactly why it is the best lead on the books.
//
// Once a week, not once a day. A call list does not change much between
// Tuesday and Wednesday, and a daily version would be the same eight names
// five times, which is how an email becomes something people filter. Monday
// morning is when the week gets planned.
//
// Nothing is stamped on the rows themselves, the way the task digest stamps a
// task. A name is not "told about": it stays on the list until it is rung or
// put away, and the page is where that happens. All this records is that the
// advisor was written to, so they get one message a week rather than one every
// five minutes.

import { now } from './util.js';
import { sendCallListEmail } from './email.js';
import { buildHotLists, LISTS } from './hotlists.js';
import { selfScope } from './db.js';

// Monday. Date.getUTCDay is 0 for Sunday.
const SEND_ON = 1;

// The hour, UTC, after which it goes out. Noon UTC is eight in the morning on
// the east coast in summer, seven in winter: the same hour the task digest
// uses, so an advisor gets both at once rather than being pinged twice.
const DEFAULT_HOUR_UTC = 12;

// How long before another one is due. Six rather than seven so a run that
// misses its window, because the Worker was busy or a send failed, still goes
// out on the next Monday rather than skipping a fortnight.
const AGAIN_AFTER = 6 * 86400;

// How many names of each list go in the message. The email is a prompt to open
// the page, not a copy of it, and a message with sixty names in it is one
// nobody reads to the end of.
const PER_LIST = 5;

/**
 * One pass. Safe to call every five minutes: it does nothing on six days out
 * of seven, nothing before the hour, and nothing for an advisor already
 * written to this week.
 */
export async function sendCallLists(env, { at = now(), force = false, only = null } = {}) {
  const when = new Date(at * 1000);
  const hour = Number(env.REMINDER_HOUR_UTC ?? DEFAULT_HOUR_UTC);
  if (!force && (when.getUTCDay() !== SEND_ON || when.getUTCHours() < hour)) {
    return { sent: 0, skipped: 'not the morning for it' };
  }

  const where = ["u.status = 'active'", 'u.weekly_call_list = 1'];
  const binds = [];
  if (!force) {
    where.push('(u.call_list_sent_at IS NULL OR u.call_list_sent_at < ?)');
    binds.push(at - AGAIN_AFTER);
  }
  if (only) { where.push('u.id = ?'); binds.push(only); }

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.first_name, u.notify_email
       FROM users u WHERE ${where.join(' AND ')} LIMIT 200`
  ).bind(...binds).all();

  const out = { sent: 0, failed: 0, nothingToSay: 0, noEmail: 0, considered: (results || []).length };

  for (const u of results || []) {
    let built;
    try {
      // Their own book, never the agency's. An owner who can see everybody on
      // the page should still be rung about their own clients: a Monday email
      // listing another advisor's leads is not a list of calls to make.
      built = await buildHotLists(env, selfScope({ id: u.id }), u.id);
    } catch (e) {
      console.error('call list', u.id, e);
      out.failed += 1;
      continue;
    }

    const lists = LISTS
      .map((l) => ({
        key: l.key,
        label: l.label,
        rows: built.lists[l.key].rows,
        shown: built.lists[l.key].rows.slice(0, PER_LIST),
        truncated: built.lists[l.key].truncated,
      }))
      .filter((l) => l.rows.length);

    // Nobody to ring is a fine week and not worth an email. An empty digest
    // every Monday is the fastest way to teach somebody to filter this one.
    if (!lists.length) { out.nothingToSay += 1; continue; }

    const to = u.notify_email || u.email;
    if (!to) { out.noEmail += 1; continue; }

    // Stamped before the send rather than after, so an address that bounces
    // every Monday does not get retried every five minutes for a day.
    await env.DB.prepare('UPDATE users SET call_list_sent_at = ? WHERE id = ?')
      .bind(at, u.id).run();

    try {
      await sendCallListEmail(env, { to, firstName: u.first_name, lists });
      out.sent += 1;
    } catch (e) {
      console.error('call list send', u.id, e);
      out.failed += 1;
    }
  }

  return out;
}
