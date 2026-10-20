// The words of the travel insurance waiver, kept per agency.
//
// An owner can replace the explanation a client reads, the line they tick, and the closing warning. Each is
// its own field and a blank one is the portal's built-in text, so changing one sentence does not mean
// retyping three paragraphs. {agency} and {advisor} are filled in when a client opens the page.
//
// Waivers already signed keep the words their client saw: the text is copied onto the waiver when it is
// signed (see waiver.js), so editing these never changes a record.

import { json, badRequest, cleanText, now, readJson } from './util.js';
import { requireAdmin } from './auth.js';
import { DEFAULT_WORDS, WORD_FIELDS, waiverWords, waiverView } from './waiverdata.js';
import { brandForUser } from './brand.js';
import * as db from './db.js';

const LIMITS = { intro: 4000, decline: 800, finePrint: 800 };

async function shape(env, user) {
  const { words, custom } = await waiverWords(env, user.agency_id);
  const name = user.agency_name || (await brandForUser(env, user.id)).name || 'Your agency';
  const advisor = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Your advisor';
  return {
    words, custom, defaults: DEFAULT_WORDS, names: { agency: name, advisor },
    preview: waiverView(words, { agency: name, advisor }),
  };
}

/** GET /api/waiver-wording : an owner's, for their own agency. */
export async function handleGetWaiverWording(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('This account is not part of an agency.');
  return json(await shape(env, user));
}

/** PUT /api/waiver-wording { intro, decline, finePrint } : blank, or the built-in text, means the built-in text. */
export async function handleSaveWaiverWording(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('This account is not part of an agency.');

  const body = await readJson(request);
  const saved = {};
  for (const f of WORD_FIELDS) {
    const text = cleanText(body[f], LIMITS[f]);
    saved[f] = text && text !== DEFAULT_WORDS[f] ? text : null;
  }
  const typedDecline = cleanText(body.decline, LIMITS.decline);
  if (typedDecline && typedDecline !== DEFAULT_WORDS.decline && typedDecline.length < 20) {
    return badRequest('The line the client ticks is too short to be a decline. Leave it blank for the built-in one.');
  }

  await env.DB.prepare(
    `INSERT INTO waiver_wording (agency_id, intro, decline, fine_print, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (agency_id) DO UPDATE SET intro = excluded.intro, decline = excluded.decline,
       fine_print = excluded.fine_print, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(user.agency_id, saved.intro, saved.decline, saved.finePrint, user.id, now()).run();
  await db.logActivity(env, user.id, 'waiver.wording', 'Changed the travel insurance waiver wording');
  return json({ ok: true, ...(await shape(env, user)) });
}

/** DELETE /api/waiver-wording : back to the built-in wording, in all three. */
export async function handleResetWaiverWording(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return badRequest('This account is not part of an agency.');
  await env.DB.prepare('DELETE FROM waiver_wording WHERE agency_id = ?').bind(user.agency_id).run();
  await db.logActivity(env, user.id, 'waiver.wording', 'Put the travel insurance waiver wording back to the built-in text');
  return json({ ok: true, ...(await shape(env, user)) });
}
