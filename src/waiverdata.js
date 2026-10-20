// The travel insurance waiver: what it says and where its row lives.
//
// Kept apart from the pages so the trip page can ask whether a reservation has one without importing the
// module that imports the trip page.
//
// A waiver is the client's own written acknowledgement that travel protection was offered and they chose
// to decline it. It is one row per reservation, found by a code in a link: the link is the credential, the
// same as a proposal or a trip page. What the client signed is copied onto the row as it was worded that
// day, so changing the words later never changes what somebody agreed to.

import { now, uid } from './util.js';

export const WAIVER_VERSION = '1';

/** The address, which is not the reservation's id and cannot be counted up to. */
export function waiverCode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** The reading text, a paragraph each. Written for any agency, so it names the one it is for. */
export function waiverParagraphs(agency) {
  const who = agency || 'Your travel advisor';
  return [
    'Travel protection insurance is strongly recommended to protect the money you are putting into this '
      + 'trip. Cruise lines, tour companies, resorts and most other suppliers charge a penalty to cancel, '
      + 'which can run from the deposit up to the whole price, and in some cases there is no refund at '
      + 'all. Unforeseen events happen, and they tend to happen close to departure.',
    'Travel protection can also cover emergency medical and dental care, medical evacuation, delayed '
      + 'baggage and more. Your own health insurance may not cover you while you are travelling, and an '
      + 'emergency medical transport can cost many thousands of dollars, which would be yours to pay if '
      + 'you are not covered.',
    `${who} has offered you the chance to buy travel protection for this trip. If you choose not to, `
      + 'please sign this acknowledgement below.',
  ];
}

/** The line the client ticks, and the warning under it. Both go onto the signed row. */
export const DECLINE_STATEMENT = 'I DECLINE the travel protection insurance that has been offered to me. '
  + 'I am aware of the advantages and benefits of travel insurance and I choose to decline the purchase '
  + 'of a protection plan.';

export function waiverFinePrint(advisor) {
  return 'By submitting this form you are declining travel protection for this trip. If you would like a '
    + `quote for insurance, which is highly recommended, please contact ${advisor || 'your travel advisor'}.`;
}

/** Everything the client agreed to, as one block of text for the record. */
export function waiverRecord(agency, advisor) {
  return [...waiverParagraphs(agency), DECLINE_STATEMENT, waiverFinePrint(advisor)].join('\n\n');
}

/**
 * The waiver for a reservation, made if it is not there yet.
 *
 * Both columns named, because the id alone already implies the owner and saying so again is what makes the
 * fence readable from the statement. A second request that lands between the read and the insert hits the
 * unique index and reads the row the first one made.
 */
export async function ensureWaiver(env, booking) {
  const read = () => env.DB.prepare(
    `SELECT id, code, created_at, sent_at, sent_count, view_count, first_viewed_at, signed_at, signer_name,
            signer_email
       FROM insurance_waivers WHERE booking_id = ? AND user_id = ?`
  ).bind(booking.id, booking.user_id).first();

  const have = await read();
  if (have) return have;
  try {
    await env.DB.prepare(
      `INSERT INTO insurance_waivers (id, booking_id, user_id, code, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(uid(), booking.id, booking.user_id, waiverCode(), now()).run();
  } catch (e) {
    console.error('waiver insert', e);
  }
  return read();
}
