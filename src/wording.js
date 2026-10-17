// The words of a quote or an invoice, saved so they are not retyped on every one.
//
// Every quote opens with the same paragraph and ends with the same note, and advisors had to either
// live with the portal's words or change them on each send. An advisor can now save their own
// opening and closing for quotes and for invoices, and an owner can set the agency's. The order
// is the advisor's own, then the agency's, then the wording built into the portal; anything typed
// on one particular send still wins over all three.

import { json, badRequest, cleanText, now, readJson } from './util.js';
import { requireUser, isAdmin } from './auth.js';
import * as db from './db.js';

export const KINDS = ['quote', 'invoice'];

/**
 * The wording saved for this advisor and kind: their own if they have one, else the agency's.
 * intro is null when nothing is saved. note is null when nothing is saved, and an empty string when
 * somebody saved "no closing note" on purpose, which is a different thing.
 */
export async function savedWording(env, user, kind) {
  const { results } = await env.DB.prepare(
    `SELECT user_id, intro, note FROM statement_wording
      WHERE agency_id = ? AND kind = ? AND (user_id = ? OR user_id IS NULL)`
  ).bind(user.agency_id || '', kind, user.id).all().catch(() => ({ results: [] }));
  const mine = (results || []).find((r) => r.user_id);
  const agency = (results || []).find((r) => !r.user_id);
  const pick = mine || agency;
  return {
    intro: pick && pick.intro ? pick.intro : null,
    note: pick && pick.note !== null && pick.note !== undefined ? pick.note : null,
    source: mine ? 'advisor' : agency ? 'agency' : 'built-in',
  };
}

/**
 * PUT /api/statement-wording { kind, scope, intro, note }
 *
 * scope is "mine" or "agency". The agency's is an owner's to set, and it is what every advisor
 * without wording of their own sends from then on.
 */
export async function handleSaveWording(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return badRequest('Say whether this is for quotes or for invoices.');
  const agencyWide = body.scope === 'agency';
  if (agencyWide && !isAdmin(user)) return json({ error: 'Only an owner sets the agency\'s wording.' }, 403);

  const intro = cleanText(body.intro, 4000) || null;
  // Absent means not set; text, including none at all, is kept as the closing note.
  const note = body.note === undefined || body.note === null ? null : cleanText(body.note, 4000);
  if (!intro && note === null) return badRequest('There is no wording to save.');

  const agencyId = user.agency_id || '';
  const id = agencyWide ? `agency:${agencyId}:${kind}` : `user:${user.id}:${kind}`;
  await env.DB.prepare(
    `INSERT INTO statement_wording (id, agency_id, user_id, kind, intro, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET intro = excluded.intro, note = excluded.note, updated_at = excluded.updated_at`
  ).bind(id, agencyId, agencyWide ? null : user.id, kind, intro, note, now()).run();

  await db.logActivity(env, user.id, 'wording.save',
    `Saved ${agencyWide ? 'the agency\'s' : 'their own'} ${kind} wording`, { kind });
  return json({ ok: true, source: agencyWide ? 'agency' : 'advisor' });
}

/** DELETE /api/statement-wording?kind=&scope= : back to the next one down, the agency's or the portal's. */
export async function handleClearWording(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const params = new URL(request.url).searchParams;
  const kind = KINDS.includes(params.get('kind')) ? params.get('kind') : null;
  if (!kind) return badRequest('Say whether this is for quotes or for invoices.');
  const agencyWide = params.get('scope') === 'agency';
  if (agencyWide && !isAdmin(user)) return json({ error: 'Only an owner changes the agency\'s wording.' }, 403);

  const agencyId = user.agency_id || '';
  await env.DB.prepare('DELETE FROM statement_wording WHERE id = ? AND agency_id = ?')
    .bind(agencyWide ? `agency:${agencyId}:${kind}` : `user:${user.id}:${kind}`, agencyId).run();
  return json({ ok: true });
}
