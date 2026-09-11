// Pipeline and opportunities, read and written through to GoHighLevel.

import { json, badRequest, clean, oneOf, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import * as db from './db.js';
import { upsertOpportunity } from './sync.js';

const OPP_STATUSES = ['open', 'won', 'lost', 'abandoned'];

export async function handleListPipelines(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  try {
    return json({ pipelines: await db.localPipelines(env, ghl.locationFor(env, user)) });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

/**
 * Opportunities for one pipeline, already grouped by stage so the board can
 * render without a second pass. Falls back to the first pipeline when none is
 * named, which is what the board wants on first load.
 */
export async function handleListOpportunities(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const locationId = ghl.locationFor(env, user);
  const wanted = url.searchParams.get('pipelineId');

  // This portal's own reservations, as a pipeline.
  //
  // Listed first and used by default, because a reservation taken here is the
  // thing an advisor most wants to see the state of, and the CRM board could
  // not show it: opportunities live there and reservations live here. Derived
  // on read rather than copied across at creation, so a card cannot disagree
  // with the reservation under it.
  const RESERVATIONS = { id: 'reservations', name: 'Reservations' };

  let crm = [];
  let crmError = false;
  try {
    crm = await db.localPipelines(env, locationId);
  } catch {
    // A CRM that cannot be reached costs its own pipelines, not this screen.
    crmError = true;
  }

  const choices = [RESERVATIONS, ...crm.map(({ id, name }) => ({ id, name }))];

  if (!wanted || wanted === RESERVATIONS.id) {
    const scope = db.scopeFor(env, user, request);
    const today = new Date().toISOString().slice(0, 10);
    const query = clean(url.searchParams.get('q'), 80);
    let cards = await db.reservationPipeline(env, scope, today);
    if (query) {
      const needle = query.toLowerCase();
      cards = cards.filter((c) => c.name.toLowerCase().includes(needle));
    }

    const stages = db.RESERVATION_STAGES.map((st, i) => {
      const items = cards.filter((c) => c.stageId === st.id);
      return {
        ...st,
        position: i,
        count: items.length,
        valueTotal: items.reduce((sum, c) => sum + c.monetaryValue, 0),
        opportunities: items,
      };
    });

    return json({
      pipelines: choices,
      pipeline: RESERVATIONS,
      stages,
      total: cards.length,
      // The stage is worked out from the reservation, so dragging a card would
      // be a change the next load undoes. The board says so rather than
      // offering a control that silently does nothing.
      derived: true,
      crmError,
      scope: db.scopeLabel(db.scopeFor(env, user, request), user),
      advisors: await db.advisorOptions(env, user),
    });
  }

  try {
    const pipelines = crm;
    if (!pipelines.length) {
      return json({ pipelines: choices, pipeline: null, stages: [], opportunities: [] });
    }

    const pipeline = pipelines.find((p) => p.id === wanted) || pipelines[0];

    const opportunities = await db.localOpportunities(env, locationId, {
      pipelineId: pipeline.id,
      status: url.searchParams.get('status') || undefined,
      query: clean(url.searchParams.get('q'), 80) || undefined,
    });
    const total = opportunities.length;

    // Group into the pipeline's stage order, with anything unstaged last.
    const byStage = new Map(pipeline.stages.map((s) => [s.id, []]));
    const unstaged = [];
    for (const opp of opportunities) {
      const bucket = byStage.get(opp.stageId);
      if (bucket) bucket.push(opp); else unstaged.push(opp);
    }

    const stages = pipeline.stages.map((s) => {
      const items = byStage.get(s.id) || [];
      return {
        ...s,
        count: items.length,
        valueTotal: items.reduce((sum, o) => sum + o.monetaryValue, 0),
        opportunities: items,
      };
    });
    if (unstaged.length) {
      stages.push({
        id: null,
        name: 'Unstaged',
        position: 999,
        count: unstaged.length,
        valueTotal: unstaged.reduce((sum, o) => sum + o.monetaryValue, 0),
        opportunities: unstaged,
      });
    }

    return json({
      pipelines: choices,
      pipeline: { id: pipeline.id, name: pipeline.name },
      stages,
      total,
      derived: false,
    });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateOpportunity(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 160);
  if (!name) return badRequest('Give the opportunity a name.');
  if (!body.pipelineId) return badRequest('Choose a pipeline.');
  if (!body.contactId) return badRequest('Attach a contact.');

  try {
    const opportunity = await ghl.createOpportunity(env, ghl.locationFor(env, user), {
      name,
      pipelineId: body.pipelineId,
      stageId: body.stageId,
      contactId: body.contactId,
      status: oneOf(body.status, OPP_STATUSES),
      monetaryValue: body.monetaryValue,
      assignedTo: user.ghl_user_id || undefined,
    });
    if (opportunity && opportunity.id) await upsertOpportunity(env, ghl.locationFor(env, user), opportunity);
    await db.logActivity(env, user.id, 'opportunity.create', `Created ${name}`, { id: opportunity.id });
    return json({ ok: true, opportunity }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleUpdateOpportunity(request, env, opportunityId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const fields = {};
  if (body.name !== undefined) fields.name = clean(body.name, 160);
  if (body.stageId !== undefined) fields.stageId = body.stageId;
  if (body.monetaryValue !== undefined) fields.monetaryValue = body.monetaryValue;
  if (body.status !== undefined) fields.status = oneOf(body.status, OPP_STATUSES);
  if (!Object.keys(fields).length) return badRequest('Nothing to update.');

  try {
    const opportunity = await ghl.updateOpportunity(env, opportunityId, fields);
    if (opportunity && opportunity.id) await upsertOpportunity(env, ghl.locationFor(env, user), opportunity);
    await db.logActivity(env, user.id, 'opportunity.update', `Updated ${opportunity.name}`, {
      id: opportunityId, ...fields,
    });
    return json({ ok: true, opportunity });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
