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

// The words built into the portal, which an agency may replace field by field. {agency} and {advisor} are
// filled in when the page is shown, so one text serves every advisor.
export const DEFAULT_WORDS = {
  intro: 'Travel protection insurance is strongly recommended to protect the money you are putting into this '
    + 'trip. Cruise lines, tour companies, resorts and most other suppliers charge a penalty to cancel, '
    + 'which can run from the deposit up to the whole price, and in some cases there is no refund at '
    + 'all. Unforeseen events happen, and they tend to happen close to departure.\n\n'
    + 'Travel protection can also cover emergency medical and dental care, medical evacuation, delayed '
    + 'baggage and more. Your own health insurance may not cover you while you are travelling, and an '
    + 'emergency medical transport can cost many thousands of dollars, which would be yours to pay if '
    + 'you are not covered.\n\n'
    + '{agency} has offered you the chance to buy travel protection for this trip. If you choose not to, '
    + 'please sign this acknowledgement below.',
  decline: 'I DECLINE the travel protection insurance that has been offered to me. '
    + 'I am aware of the advantages and benefits of travel insurance and I choose to decline the purchase '
    + 'of a protection plan.',
  finePrint: 'By submitting this form you are declining travel protection for this trip. If you would like a '
    + 'quote for insurance, which is highly recommended, please contact {advisor}.',
};

export const WORD_FIELDS = ['intro', 'decline', 'finePrint'];
const COLUMN = { intro: 'intro', decline: 'decline', finePrint: 'fine_print' };

/** {agency} and {advisor} filled in, with a plain fallback so a missing name never prints a brace. */
export function fillWords(text, { agency, advisor }) {
  return String(text || '')
    .replace(/\{agency\}/gi, agency || 'Your travel advisor')
    .replace(/\{advisor\}/gi, advisor || 'your travel advisor');
}

/**
 * What an agency has saved, field by field. A field it left blank is the built-in text, so an owner can
 * change only the closing line and keep the rest. Raw, with the placeholders still in.
 */
export async function waiverWords(env, agencyId) {
  const row = agencyId
    ? await env.DB.prepare('SELECT intro, decline, fine_print, updated_at FROM waiver_wording WHERE agency_id = ?')
      .bind(agencyId).first().catch(() => null)
    : null;
  const words = {};
  const custom = {};
  for (const f of WORD_FIELDS) {
    const saved = row && String(row[COLUMN[f]] || '').trim();
    words[f] = saved || DEFAULT_WORDS[f];
    custom[f] = Boolean(saved);
  }
  const anyCustom = Object.values(custom).some(Boolean);
  return { words, custom, version: anyCustom ? `agency-${row.updated_at}` : WAIVER_VERSION };
}

/** The words as a client reads them, split for the page. */
export function waiverView(words, names) {
  return {
    paragraphs: fillWords(words.intro, names).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
    decline: fillWords(words.decline, names),
    finePrint: fillWords(words.finePrint, names),
  };
}

/** Everything the client agreed to, as one block of text for the record. */
export function waiverRecord(view) {
  return [...view.paragraphs, view.decline, view.finePrint].join('\n\n');
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
