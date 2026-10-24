// A note from the Who to call page to somebody on the list for a reason: gone quiet, a birthday, an anniversary.
//
// The list says who to ring. For the ones with an email address this says it for you: the note is written in the
// agency's own words, filled in for this person, and the advisor reads it, changes it if they like, and presses send. It
// only ever goes out in the signed-in advisor's own name to the advisor's own clients, and a client who has asked not to
// get email is never written to.

import { json, badRequest, notFound, forbidden, clean, cleanText, now, readJson, PermanentError } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { isSuppressed } from './suppression.js';
import { fillWords, wordingFor, greeting, sendAdvisorNote, NOTE_QUIET, NOTE_BIRTHDAY, NOTE_ANNIVERSARY } from './tripemails.js';

const BY_LIST = { quiet: NOTE_QUIET, birthdays: NOTE_BIRTHDAY, anniversaries: NOTE_ANNIVERSARY };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Their last trip with you in a few words, or nothing when there has not been one. */
async function lastTrip(env, ownerId, clientId) {
  const b = await env.DB.prepare(
    `SELECT product_name, supplier, COALESCE(return_date, depart_date) AS ended FROM bookings
      WHERE client_id = ? AND user_id = ? AND status IN ('booked', 'travelled')
        AND COALESCE(return_date, depart_date) IS NOT NULL
      ORDER BY COALESCE(return_date, depart_date) DESC LIMIT 1`
  ).bind(clientId, ownerId).first().catch(() => null);
  if (!b) return '';
  const what = b.product_name || b.supplier || '';
  const month = MONTHS[Number(String(b.ended).slice(5, 7)) - 1] || '';
  return what ? `your ${what} trip${month ? ` in ${month} ${String(b.ended).slice(0, 4)}` : ''}` : '';
}

async function loadFor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return { response };
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return { response: notFound('That client is not here.') };
  // In the signed-in person's own name only. An owner looking across the agency can see who to ring, but a note in
  // somebody else's name is theirs to send.
  if (owner.id !== user.id) return { response: forbidden('That client is on another advisor\'s book, so the note is theirs to send.') };
  const client = await env.DB.prepare('SELECT id, name, email FROM clients WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!client) return { response: notFound('That client is not here.') };
  const advisor = await db.getUserById(env, user.id);
  return { user, advisor, client };
}

/** GET /api/clients/:id/note?list=quiet|birthdays|anniversaries : the note as it would go. */
export async function handleClientNoteDraft(request, env, id) {
  const got = await loadFor(request, env, id);
  if (got.response) return got.response;
  const { advisor, client } = got;
  const kind = BY_LIST[new URL(request.url).searchParams.get('list')];
  if (!kind) return badRequest('Which list is this from?');
  const stopped = client.email ? await isSuppressed(env, advisor.agency_id, client.email) : false;
  const vars = {
    first_name: greeting(client.name),
    last_trip: await lastTrip(env, advisor.id, client.id),
    advisor: [advisor.first_name, advisor.last_name].filter(Boolean).join(' ') || advisor.email || '',
    agency: advisor.agency_name || '', phone: advisor.phone || '',
  };
  const w = (await wordingFor(env, advisor.agency_id)).get(kind.kind);
  const filled = fillWords(w.subject, w.body, vars);
  return json({ to: client.email || '', canSend: Boolean(client.email) && !stopped, stopped,
    subject: filled.subject, body: filled.paragraphs.join('\n\n') });
}

/** POST /api/clients/:id/note { subject, body } : send it. */
export async function handleClientNoteSend(request, env, id) {
  const got = await loadFor(request, env, id);
  if (got.response) return got.response;
  const { user, advisor, client } = got;
  if (!client.email) return badRequest('There is no email address for them yet. Add one on their record, or ring them.');
  if (await isSuppressed(env, advisor.agency_id, client.email)) {
    return badRequest('They asked not to get email, so this was not sent. Ring them instead.');
  }
  const body = await readJson(request);
  const subject = clean(body.subject, 160);
  const text = cleanText(body.body, 4000);
  if (!subject || !text) return badRequest('A note needs a subject and some words.');
  try {
    await sendAdvisorNote(env, { advisor, to: client.email, subject, text });
  } catch (e) {
    return badRequest(e instanceof PermanentError ? String(e.message) : 'That did not send. Try again in a minute.');
  }
  await db.logActivity(env, user.id, 'client.note', `Sent a note to ${client.name}`, { id: client.id, at: now() });
  return json({ ok: true });
}
