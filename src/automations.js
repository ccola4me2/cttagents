// CTT's own automation engine.
//
// How it works, because the shape matters more than any individual function:
//
//   A run is a durable row, not an in-memory job. A Worker invocation lasts
//   seconds and an automation can wait days between steps, so progress lives
//   in the database. Each run records which step it is on and when it is next
//   due. A cron claims whatever is due and advances it.
//
//   Steps execute until one of three things happens: the list ends, a wait
//   step defers the run, or an action throws. A throw is retried a few times
//   with backoff and then the run is marked failed with the reason kept, so a
//   transient email hiccup does not silently drop somebody's follow-up.
//   A PermanentError skips the retries: an unset API key or an unverified
//   sending domain will not fix itself, and a run left waiting on one reads
//   as patience on the automation screen when it is really a broken step.
//
//   Triggers only enqueue. They never execute inline, because the request that
//   fired the trigger, a form submission say, must not be slowed down or made
//   to fail by an automation that is misconfigured.

import { uid, now, clean, oneOf, PermanentError } from './util.js';
import * as ghl from './ghl.js';
import { sendAutomationEmail } from './email.js';

export const TRIGGERS = [
  'form.submitted',
  'contact.created',
  'booking.created',
  'booking.final_payment_due',
  // The travel moments worth saying something at. The portal already finds
  // these for its own to-do lists; firing them as triggers lets a GoHighLevel
  // campaign do the talking instead of the advisor remembering to.
  'booking.returned',
];

export const ACTIONS = [
  'wait', 'send_email', 'send_sms', 'add_tag', 'add_note', 'create_task', 'notify_team',
  // Hand the contact to a drip campaign that already exists in GoHighLevel.
  //
  // The campaigns Brent has built there are not going to be rebuilt here, and
  // GoHighLevel's API does not offer a way to read a workflow's steps even if
  // they were. What it does offer is enrolling a contact, which is the half
  // that matters: this portal knows the travel moment (a reservation made, a
  // final payment looming, a client home from a trip) and GoHighLevel knows
  // what to say. Triggering the existing campaign beats reimplementing it
  // badly.
  'add_to_workflow',
];

const MAX_RUNS_PER_PASS = 25;
const MAX_STEPS_PER_PASS = 20;
const MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------
export function parseSteps(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const s of list.slice(0, 40)) {
    const action = oneOf(s.action, ACTIONS);
    const step = { action };
    if (action === 'wait') {
      step.minutes = Math.max(1, Math.min(Number(s.minutes) || 60, 60 * 24 * 90));
    } else if (action === 'send_email') {
      step.subject = clean(s.subject, 200);
      step.body = clean(s.body, 6000);
      if (!step.subject || !step.body) continue;
    } else if (action === 'send_sms') {
      step.body = clean(s.body, 800);
      if (!step.body) continue;
    } else if (action === 'add_tag') {
      step.tag = clean(s.tag, 80);
      if (!step.tag) continue;
    } else if (action === 'add_note') {
      step.body = clean(s.body, 2000);
      if (!step.body) continue;
    } else if (action === 'create_task') {
      step.title = clean(s.title, 160);
      step.dueInDays = Math.max(0, Math.min(Number(s.dueInDays) || 1, 365));
      if (!step.title) continue;
    } else if (action === 'add_to_workflow') {
      step.workflowId = clean(s.workflowId, 64);
      step.workflowName = clean(s.workflowName, 120);
    } else if (action === 'notify_team') {
      step.subject = clean(s.subject, 200) || 'Automation notification';
      step.body = clean(s.body, 4000);
      if (!step.body) continue;
    }
    out.push(step);
  }
  return out;
}

export function hydrateAutomation(row) {
  if (!row) return null;
  let steps = [];
  let cfg = {};
  try { steps = JSON.parse(row.steps_json); } catch { steps = []; }
  try { cfg = row.trigger_config_json ? JSON.parse(row.trigger_config_json) : {}; } catch { cfg = {}; }
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    triggerType: row.trigger_type,
    triggerConfig: cfg,
    steps,
    active: row.active === 1,
    runsStarted: row.runs_started || 0,
    runsDone: row.runs_done || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Templating
//
// Deliberately tiny: {{first_name}} style substitution against the run's
// context, with anything unknown replaced by empty string rather than left as
// a visible placeholder. A client should never receive "Hi {{first_name}}".
// ---------------------------------------------------------------------------
export function fill(template, context) {
  return String(template || '').replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_, key) => {
    const value = key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), context);
    return value == null ? '' : String(value);
  });
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------
/**
 * Starts every active automation matching a trigger. Never throws: a broken
 * automation must not break the thing that fired it.
 */
export async function fireTrigger(env, locationId, triggerType, context = {}, { key = null } = {}) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM automations
        WHERE location_id = ? AND trigger_type = ? AND active = 1`
    ).bind(locationId, triggerType).all();

    for (const row of results || []) {
      const a = hydrateAutomation(row);
      if (!a.steps.length) continue;

      // trigger_config narrows which events match, e.g. one specific form.
      if (a.triggerConfig.formId && a.triggerConfig.formId !== context.formId) continue;

      const ts = now();
      try {
        // A repeat insert for the same key hits the partial unique index and
        // throws, which is exactly what should happen: the event already
        // started a run and must not start another.
        await env.DB.prepare(
          `INSERT INTO automation_runs
             (id, automation_id, location_id, contact_id, contact_email, contact_name,
              context_json, step_index, status, next_run_at, trigger_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?)`
        ).bind(uid(), a.id, locationId, context.contactId || null,
               context.email || null, context.name || null,
               JSON.stringify(context), ts, key, ts, ts).run();
      } catch (e) {
        if (key && /UNIQUE|constraint/i.test(String(e.message || e))) continue;
        throw e;
      }

      await env.DB.prepare('UPDATE automations SET runs_started = runs_started + 1 WHERE id = ?')
        .bind(a.id).run();
    }
  } catch (e) {
    console.error('fireTrigger', triggerType, e);
  }
}

async function log(env, run, stepIndex, action, status, detail) {
  try {
    await env.DB.prepare(
      `INSERT INTO automation_logs (id, run_id, automation_id, step_index, action, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uid(), run.id, run.automation_id, stepIndex, action, status,
           detail ? String(detail).slice(0, 500) : null, now()).run();
  } catch (e) {
    console.error('automation log', e);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function runStep(env, run, step, context) {
  switch (step.action) {
    case 'send_email': {
      const to = context.email;
      if (!to) return { status: 'skipped', detail: 'no email address on the contact' };
      await sendAutomationEmail(env, to, fill(step.subject, context), fill(step.body, context));
      return { status: 'ok', detail: `emailed ${to}` };
    }
    case 'send_sms': {
      if (!context.contactId) return { status: 'skipped', detail: 'no contact to message' };
      await ghl.sendMessage(env, {
        contactId: context.contactId,
        type: 'SMS',
        message: fill(step.body, context),
      });
      return { status: 'ok', detail: 'sms sent' };
    }
    case 'add_tag': {
      if (!context.contactId) return { status: 'skipped', detail: 'no contact' };
      const current = await ghl.getContact(env, context.contactId).catch(() => null);
      const tags = new Set([...(current?.tags || []), fill(step.tag, context)]);
      await ghl.updateContact(env, context.contactId, { tags: [...tags] });
      return { status: 'ok', detail: `tagged ${step.tag}` };
    }
    case 'add_note': {
      if (!context.contactId) return { status: 'skipped', detail: 'no contact' };
      await ghl.createContactNote(env, context.contactId, fill(step.body, context));
      return { status: 'ok', detail: 'note added' };
    }
    case 'create_task': {
      if (!context.contactId) return { status: 'skipped', detail: 'no contact' };
      const due = new Date(Date.now() + (step.dueInDays || 0) * 86400000).toISOString();
      await ghl.createContactTask(env, context.contactId, {
        title: fill(step.title, context), dueDate: due,
      });
      return { status: 'ok', detail: 'task created' };
    }
    case 'add_to_workflow': {
      if (!context.contactId) return { status: 'skipped', detail: 'no contact to enrol' };
      if (!step.workflowId) return { status: 'skipped', detail: 'no workflow chosen' };
      await ghl.addContactToWorkflow(env, context.contactId, step.workflowId);
      return { status: 'ok', detail: `enrolled in ${step.workflowName || step.workflowId}` };
    }
    case 'notify_team': {
      const to = env.NOTIFY_EMAIL;
      if (!to) return { status: 'skipped', detail: 'NOTIFY_EMAIL is not set' };
      await sendAutomationEmail(env, to, fill(step.subject, context), fill(step.body, context));
      return { status: 'ok', detail: `notified ${to}` };
    }
    default:
      return { status: 'skipped', detail: `unknown action ${step.action}` };
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
/** Advances one run as far as it can go. Returns its final status. */
async function advanceRun(env, run) {
  // Unscoped on purpose: the id comes from the run being advanced, not from a
  // request, and the run already carries the location it belongs to.
  const autoRow = await env.DB.prepare('SELECT * FROM automations WHERE id = ?')
    .bind(run.automation_id).first();
  const automation = hydrateAutomation(autoRow);

  if (!automation || !automation.active) {
    await env.DB.prepare("UPDATE automation_runs SET status='cancelled', updated_at=? WHERE id=?")
      .bind(now(), run.id).run();
    return 'cancelled';
  }

  let context = {};
  try { context = run.context_json ? JSON.parse(run.context_json) : {}; } catch { context = {}; }
  context.email = context.email || run.contact_email || '';
  context.name = context.name || run.contact_name || '';
  context.contactId = context.contactId || run.contact_id || null;
  const parts = String(context.name || '').split(/\s+/);
  context.first_name = context.first_name || parts[0] || '';
  context.last_name = context.last_name || parts.slice(1).join(' ') || '';

  let index = run.step_index;

  for (let n = 0; n < MAX_STEPS_PER_PASS; n++) {
    if (index >= automation.steps.length) {
      await env.DB.prepare("UPDATE automation_runs SET status='done', step_index=?, updated_at=? WHERE id=?")
        .bind(index, now(), run.id).run();
      await env.DB.prepare('UPDATE automations SET runs_done = runs_done + 1 WHERE id = ?')
        .bind(automation.id).run();
      return 'done';
    }

    const step = automation.steps[index];

    if (step.action === 'wait') {
      const due = now() + step.minutes * 60;
      await env.DB.prepare(
        "UPDATE automation_runs SET status='waiting', step_index=?, next_run_at=?, attempts=0, updated_at=? WHERE id=?"
      ).bind(index + 1, due, now(), run.id).run();
      await log(env, run, index, 'wait', 'ok', `waiting ${step.minutes} minutes`);
      return 'waiting';
    }

    try {
      const res = await runStep(env, run, step, context);
      await log(env, run, index, step.action, res.status, res.detail);
      index += 1;
      await env.DB.prepare('UPDATE automation_runs SET step_index=?, attempts=0, updated_at=? WHERE id=?')
        .bind(index, now(), run.id).run();
    } catch (e) {
      const attempts = (run.attempts || 0) + 1;
      const message = String(e && e.message ? e.message : e).slice(0, 400);
      const permanent = e instanceof PermanentError || e?.permanent === true ||
        (e instanceof ghl.GhlError && e.detail && e.detail.code === 'not_configured');
      await log(env, run, index, step.action, 'error', message);

      if (permanent || attempts >= MAX_ATTEMPTS) {
        // next_run_at is zeroed with it. Nothing claims a failed run, but a
        // failed row still carrying a future retry time reads as though one is
        // coming. Zero rather than NULL because the column is NOT NULL.
        await env.DB.prepare(
          "UPDATE automation_runs SET status='failed', attempts=?, last_error=?, next_run_at=0, updated_at=? WHERE id=?"
        ).bind(attempts, message, now(), run.id).run();
        return 'failed';
      }
      // Back off and try this same step again on a later pass.
      await env.DB.prepare(
        "UPDATE automation_runs SET status='waiting', attempts=?, last_error=?, next_run_at=?, updated_at=? WHERE id=?"
      ).bind(attempts, message, now() + attempts * 300, now(), run.id).run();
      return 'retrying';
    }
  }

  // Hit the per-pass ceiling. Leave it due immediately so the next pass
  // continues rather than stalling a long automation.
  await env.DB.prepare(
    "UPDATE automation_runs SET status='pending', step_index=?, next_run_at=?, updated_at=? WHERE id=?"
  ).bind(index, now(), now(), run.id).run();
  return 'continuing';
}

/**
 * Time based triggers.
 *
 * Everything else fires from a user action. This is the one that has to be
 * looked for, so the cron sweeps unpaid payments falling due inside the
 * window and fires one run per payment, keyed on the payment id so a week of
 * passes produces exactly one reminder.
 */
export async function scanTimeTriggers(env, locationId, { withinDays = 7 } = {}) {
  const through = new Date(Date.now() + withinDays * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // Only the payments belonging to advisors on this sub-account.
  //
  // This swept every advisor's payments in the database and fired the calling
  // location's automations against all of them. On the cron that was merely
  // wrong; from the "run automations" button it was one advisor's client data
  // flowing into another advisor's automation, which can send an email or an
  // SMS from their CRM account. An advisor's own location wins, falling back
  // to the agency default, which is exactly how locationFor resolves it for
  // every other call.
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.kind, p.amount_cents, p.due_date,
            b.client_name, b.supplier, b.product_name, b.depart_date, b.ghl_contact_id
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN users u ON u.id = p.user_id
      WHERE COALESCE(NULLIF(u.ghl_location_id, ''), ?) = ?
        AND p.paid_date IS NULL
        AND p.due_date IS NOT NULL
        AND p.due_date >= ? AND p.due_date <= ?
        AND b.status IN ('quoted','booked')
      LIMIT 200`
  ).bind(env.GHL_DEFAULT_LOCATION_ID || '', locationId, today, through).all();

  let fired = 0;

  // Clients home from a trip and not yet welcomed back. Same location filter as
  // the payments above, and for the same reason: one advisor's clients must
  // never reach another advisor's campaigns.
  const { results: home } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.return_date,
            b.ghl_contact_id
       FROM bookings b
       JOIN users u ON u.id = b.user_id
      WHERE COALESCE(NULLIF(u.ghl_location_id, ''), ?) = ?
        AND b.status = 'travelled'
        AND b.personal = 0
        AND b.welcomed_at IS NULL
        AND b.return_date IS NOT NULL
        AND b.return_date <= ?
      LIMIT 100`
  ).bind(env.GHL_DEFAULT_LOCATION_ID || '', locationId, today).all();

  for (const row of home || []) {
    await fireTrigger(env, locationId, 'booking.returned', {
      bookingId: row.id,
      contactId: row.ghl_contact_id || null,
      name: row.client_name,
      supplier: row.supplier || '',
      product: row.product_name || '',
      return_date: row.return_date || '',
    }, { key: `home:${row.id}` });
    fired += 1;
  }

  for (const row of results || []) {
    await fireTrigger(env, locationId, 'booking.final_payment_due', {
      paymentId: row.id,
      kind: row.kind,
      amount: (row.amount_cents / 100).toFixed(2),
      due_date: row.due_date,
      contactId: row.ghl_contact_id || null,
      name: row.client_name,
      supplier: row.supplier || '',
      product: row.product_name || '',
      depart_date: row.depart_date || '',
    }, { key: row.id });
    fired += 1;
  }
  return { candidates: (results || []).length, fired };
}

/**
 * Housekeeping. Finished runs and their logs accumulate forever otherwise, and
 * a busy automation firing on every form submission fills the table with rows
 * nobody will read again. Keeps recent history for the activity view and drops
 * anything older; failed runs are kept longer because they are the ones
 * someone may still want to look at.
 */
export async function purgeOldRuns(env, { doneAfterDays = 30, failedAfterDays = 90 } = {}) {
  const doneBefore = now() - doneAfterDays * 86400;
  const failedBefore = now() - failedAfterDays * 86400;

  await env.DB.prepare(
    `DELETE FROM automation_logs WHERE run_id IN (
       SELECT id FROM automation_runs
        WHERE (status IN ('done','cancelled') AND updated_at < ?)
           OR (status = 'failed' AND updated_at < ?))`
  ).bind(doneBefore, failedBefore).run();

  const res = await env.DB.prepare(
    `DELETE FROM automation_runs
      WHERE (status IN ('done','cancelled') AND updated_at < ?)
         OR (status = 'failed' AND updated_at < ?)`
  ).bind(doneBefore, failedBefore).run();

  return { removed: res.meta?.changes || 0 };
}

/** One scheduled pass over everything that is due. */
export async function processDueRuns(env, { automationId = null } = {}) {
  // Oldest first, because a queue that serves the newest arrival first is not
  // a queue. The ceiling is what keeps a pass inside a Worker's budget, and it
  // is also why this can be asked for one automation: a run triggered a second
  // ago sits behind everything already due, so "did my automation fire" is a
  // question a full pass cannot answer while anything is queued ahead of it.
  const { results } = await env.DB.prepare(
    `SELECT * FROM automation_runs
      WHERE status IN ('pending','waiting') AND next_run_at <= ?
        AND (? IS NULL OR automation_id = ?)
      ORDER BY next_run_at ASC LIMIT ?`
  ).bind(now(), automationId, automationId, MAX_RUNS_PER_PASS).all();

  const out = { processed: 0, done: 0, waiting: 0, failed: 0 };
  for (const run of results || []) {
    try {
      const status = await advanceRun(env, run);
      out.processed += 1;
      if (status === 'done') out.done += 1;
      if (status === 'waiting') out.waiting += 1;
      if (status === 'failed') out.failed += 1;
    } catch (e) {
      console.error('advanceRun', run.id, e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Portal API
// ---------------------------------------------------------------------------
import { json, badRequest, notFound, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

export async function handleListAutomations(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const locationId = ghl.locationFor(env, user);

  const { results } = await env.DB.prepare(
    `SELECT a.*,
       (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status IN ('pending','waiting')) AS active_runs,
       (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'failed') AS failed_runs
     FROM automations a WHERE a.location_id = ? ORDER BY a.updated_at DESC`
  ).bind(locationId).all();

  return json({
    automations: (results || []).map((r) => ({
      ...hydrateAutomation(r),
      activeRuns: r.active_runs || 0,
      failedRuns: r.failed_runs || 0,
    })),
    triggers: TRIGGERS,
    actions: ACTIONS,
  });
}

export async function handleGetAutomation(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Scoped by location. The runs below carry contact names and email
  // addresses, and knowing an id is not the same as being allowed to see it.
  const row = await env.DB.prepare('SELECT * FROM automations WHERE id = ? AND location_id = ?')
    .bind(id, ghl.locationFor(env, user)).first();
  if (!row) return notFound('Automation not found.');

  const { results: runs } = await env.DB.prepare(
    `SELECT id, contact_name, contact_email, status, step_index, next_run_at, last_error, created_at
       FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(id).all();

  const { results: logs } = await env.DB.prepare(
    `SELECT step_index, action, status, detail, created_at
       FROM automation_logs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(id).all();

  return json({ automation: hydrateAutomation(row), runs: runs || [], logs: logs || [] });
}

export async function handleSaveAutomation(request, env, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('Give the automation a name.');

  const triggerType = oneOf(body.triggerType, TRIGGERS);
  const steps = parseSteps(body.steps);
  if (!steps.length) return badRequest('Add at least one step.');

  // A run that opens with a wait and never acts is almost always a mistake,
  // and it is invisible until someone wonders why nothing happened.
  if (steps.every((s) => s.action === 'wait')) {
    return badRequest('This automation only waits. Add a step that does something.');
  }

  const locationId = ghl.locationFor(env, user);
  const cfg = {};
  if (clean(body.formId, 64)) cfg.formId = clean(body.formId, 64);
  const ts = now();

  if (id) {
    const res = await env.DB.prepare(
      `UPDATE automations SET name=?, description=?, trigger_type=?, trigger_config_json=?,
         steps_json=?, active=?, updated_at=? WHERE id=? AND location_id=?`
    ).bind(name, clean(body.description, 400), triggerType, JSON.stringify(cfg),
           JSON.stringify(steps), body.active === false ? 0 : 1, ts, id, locationId).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Automation not found.');
    await db.logActivity(env, user.id, 'automation.update', `Updated ${name}`, { id });
  } else {
    id = uid();
    await env.DB.prepare(
      `INSERT INTO automations (id, location_id, name, description, trigger_type,
         trigger_config_json, steps_json, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, locationId, name, clean(body.description, 400), triggerType,
           JSON.stringify(cfg), JSON.stringify(steps),
           body.active === false ? 0 : 1, user.id, ts, ts).run();
    await db.logActivity(env, user.id, 'automation.create', `Created ${name}`, { id });
  }

  const row = await env.DB.prepare('SELECT * FROM automations WHERE id = ? AND location_id = ?')
    .bind(id, locationId).first();
  return json({ ok: true, automation: hydrateAutomation(row) });
}

export async function handleDeleteAutomation(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM automations WHERE id = ? AND location_id = ?')
    .bind(id, ghl.locationFor(env, user)).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Automation not found.');
  await db.logActivity(env, user.id, 'automation.delete', 'Deleted an automation', { id });
  return json({ ok: true });
}

/** Runs a pass now rather than waiting for the cron. Useful while testing one. */
export async function handleRunAutomations(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request).catch(() => ({}));
  const only = clean(body.automationId, 80) || null;

  // Asked about one automation, check it belongs to this location first: an
  // id is not permission to run somebody else's rules.
  if (only) {
    const owned = await env.DB.prepare(
      'SELECT id FROM automations WHERE id = ? AND location_id = ?'
    ).bind(only, ghl.locationFor(env, user)).first();
    if (!owned) return notFound('Automation not found.');
  }

  await scanTimeTriggers(env, ghl.locationFor(env, user)).catch(() => null);
  const result = await processDueRuns(env, { automationId: only });
  await db.logActivity(env, user.id, 'automation.run',
    only ? 'Ran one automation' : 'Ran a pass', result);
  return json({ ok: true, result });
}
