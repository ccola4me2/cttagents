// The marketing pipeline: people who have not booked yet.
//
// A card here is a person, not a deal. Somebody rang, or a form came in, or a
// client sent a friend, and the question the board answers is "who have I got
// and who have I not rung back". That is a different question from the
// reservation board next door, which is about trips that already exist, and
// keeping them apart is the point: one is people, the other is money.
//
// A lead is a `clients` row with a stage on it, not a row in a leads table.
// Same person, earlier. Two tables would mean whoever rang in March and booked
// in June exists twice, and this portal has already paid for that lesson once,
// with CRM contacts sitting beside clients and the same name typed in twice.
//
// They leave the board by booking, and that is derived from whether a
// reservation exists rather than from anybody remembering to move the card. A
// pipeline whose last column has to be maintained by hand is a pipeline whose
// last column is wrong.

import { json, badRequest, notFound, uid, now, clean, cleanText, cleanDate, oneOf, oneOfOrNull, readJson }
  from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { layout, sendHtml } from './email.js';
import { brandForUser } from './brand.js';
import { isSuppressed } from './suppression.js';
import { fillWords, wordingFor, greeting, LEAD_HELLO, LEAD_FOLLOWUP } from './tripemails.js';
import { escapeHtml, PermanentError } from './util.js';
import { SOURCE_KINDS, SOURCE_KIND_IDS } from './attribution.js';

// Where somebody is in the conversation, in the words an advisor would use.
// "Booked" is not here on purpose: it is a fact about reservations, so it is
// counted rather than staged.
export const LEAD_STAGES = [
  { id: 'new', name: 'New' },
  { id: 'contacted', name: 'Reached out' },
  { id: 'talking', name: 'In conversation' },
  { id: 'nurture', name: 'Keeping warm' },
  { id: 'lost', name: 'Gone cold' },
];
const STAGE_IDS = LEAD_STAGES.map((s) => s.id);

function shape(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email || '',
    phone: r.phone || '',
    source: r.source || '',
    // The channel and the note beside it. One is countable and one says which
    // form, whose party, which post.
    sourceKind: r.source_kind || '',
    referredBy: r.referred_by_client_id || '',
    referredByName: r.referred_by_name || '',
    stage: r.lead_stage,
    askedAbout: r.lead_asked_about || '',
    nextStep: r.lead_next_step || '',
    nextStepOn: r.lead_next_step_on || '',
    since: r.lead_at || r.created_at,
    trips: r.trips || 0,
    href: `/app/client?id=${r.id}`,
  };
}

export async function handleLeadBoard(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'c.user_id');
  const query = clean(url.searchParams.get('q'), 80);

  const binds = [...scoped.binds];
  let search = '';
  if (query) {
    search = 'AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)';
    const like = `%${query}%`;
    binds.push(like, like, like);
  }

  // The scope predicate sits in the statement rather than being joined in from
  // an array, so a reader and check-scope can both see which fence this read is
  // behind without following a variable.
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.user_id, c.name, c.email, c.phone, c.source, c.created_at,
            c.source_kind, c.referred_by_client_id,
            -- The referrer's name, so the dialog can show who sent them rather
            -- than an id nobody can read.
            (SELECT r.name FROM clients r WHERE r.id = c.referred_by_client_id
               AND r.user_id = c.user_id) AS referred_by_name,
            c.lead_stage, c.lead_at, c.lead_asked_about, c.lead_next_step, c.lead_next_step_on,
            (SELECT COUNT(*) FROM bookings b
              WHERE b.client_id = c.id AND b.status IN ('booked','travelled')) AS trips
       FROM clients c
      WHERE ${scoped.sql} AND c.lead_stage IS NOT NULL ${search}
      ORDER BY c.lead_next_step_on IS NULL ASC, c.lead_next_step_on ASC, c.lead_at DESC
      LIMIT 500`
  ).bind(...binds).all();

  const everyone = (results || []).map(shape);
  // Booked is derived, so it cannot disagree with the reservations. Somebody
  // who books leaves the board on their own.
  const open = everyone.filter((l) => !l.trips);
  const converted = everyone.filter((l) => l.trips);
  const today = new Date().toISOString().slice(0, 10);

  const stages = LEAD_STAGES.map((st, i) => {
    const items = open.filter((l) => l.stage === st.id);
    return { ...st, position: i, count: items.length, leads: items };
  });

  return json({
    stages,
    // The channels, from the one place they are written down. The dialog builds
    // its dropdown from this for the same reason it builds the stage dropdown
    // from `stages`: a second copy is a second thing to keep in step.
    kinds: SOURCE_KINDS,
    total: open.length,
    // The ones who have not been answered. A pipeline exists to produce this
    // number and most of them make it hard to find.
    nudge: open.filter((l) => l.stage !== 'lost'
      && l.nextStepOn && l.nextStepOn <= today).length,
    // Nobody has rung them and nothing is scheduled. Worse than overdue,
    // because overdue at least means somebody made a plan.
    untouched: open.filter((l) => l.stage === 'new' && !l.nextStepOn).length,
    converted: converted.length,
    // Everyone who became a client, not a sample, because the tile that counts them opens the list.
    convertedRecent: converted,
    today,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

function parse(body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'Who called?' };
  const on = clean(body.nextStepOn, 10);
  if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    return { error: 'A follow-up date has to be a real date.' };
  }
  return {
    fields: {
      name,
      email: clean(body.email, 254) || null,
      phone: clean(body.phone, 40) || null,
      source: clean(body.source, 120) || null,
      // Null rather than a default. Nobody has said where this person came
      // from, and "other" would be the portal saying it for them.
      sourceKind: oneOfOrNull(body.sourceKind, SOURCE_KIND_IDS),
      sourceKindGiven: Object.prototype.hasOwnProperty.call(body, 'sourceKind'),
      referredBy: clean(body.referredBy, 64) || null,
      stage: oneOf(body.stage, STAGE_IDS) || 'new',
      askedAbout: cleanText(body.askedAbout, 500) || null,
      nextStep: clean(body.nextStep, 160) || null,
      nextStepOn: on || null,
    },
  };
}

/**
 * Somebody rang.
 *
 * Resolves against the advisor's own book first, so a client ringing about a
 * second trip lands on the person who is already there rather than making a
 * duplicate of them. That is the whole reason leads live on `clients`.
 */
export async function handleAddLead(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const existing = await env.DB.prepare(
    'SELECT id FROM clients WHERE user_id = ? AND name = ?'
  ).bind(user.id, fields.name).first();

  const ts = now();
  if (existing) {
    await env.DB.prepare(
      `UPDATE clients
          SET email = COALESCE(NULLIF(email, ''), ?),
              phone = COALESCE(NULLIF(phone, ''), ?),
              source = COALESCE(NULLIF(source, ''), ?),
              -- Where somebody came from is a fact about the first time, so an
              -- existing one is never written over by a later form or call.
              source_kind = COALESCE(source_kind, ?),
              referred_by_client_id = COALESCE(referred_by_client_id, ?),
              lead_stage = ?, lead_at = COALESCE(lead_at, ?), lead_asked_about = ?,
              lead_next_step = ?, lead_next_step_on = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(fields.email, fields.phone, fields.source,
           fields.sourceKind, fields.referredBy, fields.stage, ts,
           fields.askedAbout, fields.nextStep, fields.nextStepOn, ts,
           existing.id, user.id).run();
    return json({ ok: true, id: existing.id, matched: true });
  }

  const id = uid();
  await env.DB.prepare(
    `INSERT INTO clients
       (id, user_id, name, email, phone, source, source_kind, referred_by_client_id,
        lead_stage, lead_at,
        lead_asked_about, lead_next_step, lead_next_step_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.name, fields.email, fields.phone, fields.source,
         fields.sourceKind, fields.referredBy,
         fields.stage, ts, fields.askedAbout, fields.nextStep, fields.nextStepOn,
         ts, ts).run();

  await db.logActivity(env, user.id, 'lead.add', `${fields.name} got in touch`);
  return json({ ok: true, id }, 201);
}

export async function handleUpdateLead(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('That lead is not here.');

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  // A save that does not mention the channel leaves it alone.
  if (!fields.sourceKindGiven) {
    const cur = await env.DB.prepare('SELECT source_kind FROM clients WHERE id = ? AND user_id = ?')
      .bind(id, owner.id).first();
    fields.sourceKind = (cur && cur.source_kind) || null;
  }

  const res = await env.DB.prepare(
    `UPDATE clients
        SET name = ?, email = ?, phone = ?, source = ?,
            source_kind = ?, referred_by_client_id = ?, lead_stage = ?,
            lead_asked_about = ?, lead_next_step = ?, lead_next_step_on = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(fields.name, fields.email, fields.phone, fields.source,
         fields.sourceKind, fields.referredBy, fields.stage,
         fields.askedAbout, fields.nextStep, fields.nextStepOn, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That lead is not here.');
  return json({ ok: true });
}

/**
 * The follow-up is done.
 *
 * Its own endpoint rather than the full save, for the same reason a drag has
 * one: this knows one field, and posting back the rest from whatever the To do
 * drawer was rendered with is how a stale row overwrites an edit made
 * somewhere else.
 *
 * Only the date goes. The stage stays, so they stay on the board, and the note
 * about what you were going to do stays with them, because "I rang her" is not
 * the same as "she is no longer a lead". Closing a lead has its own button on
 * the board, where you can see what you are closing.
 *
 * Send a date and it goes back on instead, which is what unticking does.
 */
export async function handleFollowedUp(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('That lead is not here.');

  // A date to put back, for a tick somebody did not mean. Clearing a date is
  // the one thing in this drawer that cannot be worked out again afterwards,
  // so undoing it has to carry the date rather than guess at one.
  const on = cleanDate((await readJson(request)).on);

  const res = await env.DB.prepare(
    `UPDATE clients SET lead_next_step_on = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND lead_stage IS NOT NULL`
  ).bind(on || null, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That lead is not here.');
  return json({ ok: true });
}

/**
 * Drag a card.
 *
 * Its own endpoint rather than the full save, because a drag knows one field,
 * and posting back the rest from whatever the card was rendered with is how a
 * stale card overwrites an edit made in another tab.
 */
export async function handleMoveLead(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('That lead is not here.');

  const body = await readJson(request);
  const stage = oneOf(body.stage, STAGE_IDS);
  if (!stage) return badRequest('That is not one of the columns.');

  const res = await env.DB.prepare(
    'UPDATE clients SET lead_stage = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(stage, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That lead is not here.');
  return json({ ok: true, stage });
}

/**
 * Take somebody off the pipeline without deleting the person.
 *
 * The record stays and keeps its name, address and history, because a lead who
 * went nowhere is still somebody who rang once and may ring again. Only the
 * stage goes, which is what taking them off a board should mean.
 */
export async function handleCloseLead(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('That lead is not here.');
  const res = await env.DB.prepare(
    `UPDATE clients SET lead_stage = NULL, lead_next_step = NULL,
            lead_next_step_on = NULL, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That lead is not here.');
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Saying hello
// ---------------------------------------------------------------------------

const FOLLOW_UP_DAYS = 3;
const dayPlus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/** The lead as the hello is written for them: only this advisor's, and only somebody on the board. */
async function leadFor(env, owner, id) {
  return env.DB.prepare(
    `SELECT id, name, email, phone, lead_stage, lead_asked_about FROM clients
      WHERE id = ? AND user_id = ? AND lead_stage IS NOT NULL`
  ).bind(id, owner.id).first();
}

/** The agency's first note, filled in for this person and this advisor, for the advisor to change before it goes. */
async function helloDraft(env, advisor, lead, kind) {
  const form = (String(lead.lead_asked_about || '').match(/^From the (.+) form$/) || [])[1] || '';
  const name = [advisor.first_name, advisor.last_name].filter(Boolean).join(' ') || advisor.email || '';
  const vars = {
    first_name: greeting(lead.name),
    thanks: form ? `Thank you for filling in our ${form} form.` : 'Thank you for getting in touch.',
    advisor: name, agency: advisor.agency_name || '', phone: advisor.phone || '',
  };
  const w = (await wordingFor(env, advisor.agency_id)).get(kind);
  const filled = fillWords(w.subject, w.body, vars);
  return { subject: filled.subject, body: filled.paragraphs.join('\n\n') };
}

/** GET /api/leads/:id/hello : the note that would go, and whether it can. */
export async function handleLeadHelloDraft(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('That lead is not here.');
  const lead = await leadFor(env, owner, id);
  if (!lead) return notFound('That lead is not here.');
  const advisor = await db.getUserById(env, owner.id);
  const stopped = lead.email ? await isSuppressed(env, advisor.agency_id, lead.email) : false;
  return json({ to: lead.email || '', canSend: Boolean(lead.email) && !stopped, stopped,
    // The first note for somebody new, the second for somebody already written to who has not replied.
    kind: lead.lead_stage === 'new' ? 'hello' : 'followup',
    ...(await helloDraft(env, advisor, lead, lead.lead_stage === 'new' ? LEAD_HELLO.kind : LEAD_FOLLOWUP.kind)) });
}

/** The next step after reaching somebody: a nudge to follow up, so nobody is dropped after one note. */
async function afterReaching(env, owner, id, step, days = FOLLOW_UP_DAYS) {
  await env.DB.prepare(
    `UPDATE clients SET lead_stage = CASE WHEN lead_stage = 'new' THEN 'contacted' ELSE lead_stage END,
            lead_next_step = ?, lead_next_step_on = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND lead_stage IS NOT NULL`
  ).bind(step, dayPlus(days), now(), id, owner.id).run();
}

/** POST /api/leads/:id/hello { subject, body } : send it, move them to Reached out, and plan the follow-up. */
export async function handleLeadHello(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('That lead is not here.');
  const lead = await leadFor(env, owner, id);
  if (!lead) return notFound('That lead is not here.');
  if (!lead.email) return badRequest('There is no email address for them yet. Add one on their record, or ring them.');

  const advisor = await db.getUserById(env, owner.id);
  if (await isSuppressed(env, advisor.agency_id, lead.email)) {
    return badRequest('They asked not to get email, so this was not sent. Ring them instead.');
  }
  const body = await readJson(request);
  const subject = clean(body.subject, 160);
  const text = cleanText(body.body, 4000);
  if (!subject || !text) return badRequest('A note needs a subject and some words.');

  const html = layout(env, {
    brand: await brandForUser(env, owner.id),
    heading: subject,
    body: text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''),
  });
  try {
    await sendHtml(env, {
      to: lead.email, replyTo: advisor.notify_email || advisor.email, subject, html,
      unsubscribe: { agencyId: advisor.agency_id || null, agencyName: advisor.agency_name || '' },
    });
  } catch (e) {
    return badRequest(e instanceof PermanentError ? String(e.message) : 'That did not send. Try again in a minute.');
  }
  // A second note is the last prompt: the next one is a week out, and a lead who still has not answered then is a call.
  await afterReaching(env, owner, id, lead.lead_stage === 'new' ? 'Follow up if they have not replied' : 'Ring them, or let them go quiet', lead.lead_stage === 'new' ? FOLLOW_UP_DAYS : 7);
  await db.logActivity(env, owner.id, 'lead.hello', `Sent a first note to ${lead.name}`, { id });
  return json({ ok: true });
}

/** POST /api/leads/:id/reached : they were rung, so they move to Reached out and the follow-up is planned. */
export async function handleLeadReached(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('That lead is not here.');
  const lead = await leadFor(env, owner, id);
  if (!lead) return notFound('That lead is not here.');
  await afterReaching(env, owner, id, 'Follow up after your call');
  await db.logActivity(env, owner.id, 'lead.reached', `Rang ${lead.name}`, { id });
  return json({ ok: true });
}
