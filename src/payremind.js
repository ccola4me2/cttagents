// Telling the client the money is due, before it is.
//
// The reminder was already written and already worked; it was a button. An
// advisor with forty live bookings presses it when they remember to, which is
// the failure the portal exists to fix. This is the same email on a schedule.
//
// Four decisions worth stating, because each is the kind that gets reversed by
// accident later:
//
//   - Hard payments only. The scheduler creates a soft row a week before every
//     vendor deadline as the advisor's own buffer, for the same money. Sending
//     both would tell the client twice about one payment.
//   - Three weeks, one week, one day, then once when it is late. Different
//     messages about the same payment, so the column tracks how close the last
//     one was rather than whether any went at all.
//   - Nothing is sent for a payment the advisor has already reminded about by
//     hand today. Two notices an hour apart reads as a system with nobody
//     driving it.
//   - Off until turned on, per advisor. This sends email to their clients over
//     their name, which nobody should inherit by default.

import { now } from './util.js';
import { sendPaymentReminder } from './email.js';

// How far ahead each notice goes out. Descending, because the pass takes the
// first one the payment has reached and the closest is the most urgent.
const LEADS = [21, 7, 1];

// The one after the date has passed. Kept out of LEADS because it is not a
// lead time, and giving it a negative number that sorts correctly by accident
// is how this sort of list quietly stops working.
const OVERDUE = -1;

const isoDay = (ts, offset = 0) =>
  new Date(ts * 1000 + offset * 86400000).toISOString().slice(0, 10);

/**
 * Which notice this payment is due, or null.
 *
 * `sent` is the closest lead already used. A payment three weeks out that has
 * had its three week notice waits until one week out for the next one.
 */
export function leadFor(dueDate, today, sent) {
  if (!dueDate) return null;
  const days = Math.round(
    (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

  if (days < 0) return sent === OVERDUE ? null : OVERDUE;

  // The closest lead the payment has reached, and only if it is closer than
  // whatever went last time.
  for (const lead of [...LEADS].sort((a, b) => a - b)) {
    if (days <= lead) return (sent === null || sent === undefined || lead < sent) ? lead : null;
  }
  return null;
}

export async function remindDuePayments(env, { at = now(), limit = 200 } = {}) {
  const today = isoDay(at);
  const horizon = isoDay(at, LEADS[0]);

  // Only advisors who asked for this, and only real vendor deadlines. The
  // client's email comes from the client record, so a booking with no client
  // attached simply has nobody to write to.
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.booking_id, p.user_id, p.amount_cents, p.due_date, p.payment_class,
            p.auto_lead_sent, p.reminded_at,
            b.client_name, b.product_name, b.supplier, b.confirmation_number, b.client_id,
            c.email AS client_email, c.name AS client_record_name,
            u.first_name, u.last_name, u.email AS advisor_email, u.notify_email,
            u.agency_name
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN users u ON u.id = p.user_id
       LEFT JOIN clients c ON c.id = b.client_id
      WHERE p.paid_date IS NULL
        AND p.payment_class = 'hard'
        AND p.due_date IS NOT NULL
        AND p.due_date <= ?
        AND u.auto_remind_clients = 1
        AND b.status IN ('quoted', 'booked')
      ORDER BY p.due_date ASC
      LIMIT ?`
  ).bind(horizon, limit).all();

  const out = { sent: 0, failed: 0, skipped: 0, noEmail: 0, considered: (results || []).length };

  for (const p of results || []) {
    const lead = leadFor(p.due_date, today, p.auto_lead_sent);
    if (lead === null) { out.skipped += 1; continue; }

    // Reminded by hand today already. The advisor doing it themselves is the
    // reminder; following it an hour later reads as nobody being in charge.
    if (p.reminded_at && isoDay(p.reminded_at) === today) { out.skipped += 1; continue; }

    if (!p.client_email) { out.noEmail += 1; continue; }

    const advisorName = [p.first_name, p.last_name].filter(Boolean).join(' ')
      || p.advisor_email;

    try {
      await sendPaymentReminder(env, {
        to: p.client_email,
        // So the client's reply reaches the advisor rather than a noreply box.
        replyTo: p.notify_email || p.advisor_email,
        clientName: p.client_record_name || p.client_name,
        advisorName,
        agencyName: p.agency_name || '',
        amountCents: p.amount_cents,
        dueDate: p.due_date,
        hard: true,
        tripName: p.product_name || '',
        vendor: p.supplier || '',
        confirmation: p.confirmation_number || '',
      });
      out.sent += 1;
    } catch (e) {
      // One client's bounced address must not stop the other thirty. Stamped
      // either way, so a permanently bad address is not retried every hour.
      // Counted, though: a pass that considered thirty and sent none while
      // every counter reads zero is a pass that looks like it did nothing.
      out.failed += 1;
      console.error('payment reminder', p.id, e);
    }

    await env.DB.prepare(
      `UPDATE booking_payments SET auto_lead_sent = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(lead, now(), p.id, p.user_id).run();
  }

  return out;
}
