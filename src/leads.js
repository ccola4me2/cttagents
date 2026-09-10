// Leads and contacts. Read and written straight through to GoHighLevel.

import { json, badRequest, clean, isValidEmail, normalizeEmail, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import * as db from './db.js';
import { upsertContact } from './sync.js';
import { fireTrigger } from './automations.js';

export async function handleListLeads(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Read from the local mirror: fast, and unaffected by upstream rate limits.
  const url = new URL(request.url);
  const locationId = ghl.locationFor(env, user);
  const result = await db.localContacts(env, locationId, {
    query: clean(url.searchParams.get('q'), 80) || undefined,
    limit: url.searchParams.get('limit') || 50,
    offset: url.searchParams.get('offset') || 0,
  });

  // An empty mirror on a configured account means the first sync has not run
  // yet, which is a different thing from having no contacts.
  const state = await env.DB.prepare('SELECT status FROM sync_state WHERE id = ?')
    .bind(`contacts:${locationId}`).first();
  return json({ ...result, syncing: !state || state.status !== 'complete' });
}

/**
 * One contact, and nothing else. This used to answer with `notes: []`, which
 * read as "this contact has no notes" when in truth it had never looked. The
 * key is gone rather than empty: see /detail for a contact with its notes.
 */
export async function handleGetLead(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const local = await db.localContact(env, contactId);
  if (local) return json({ contact: local });
  try {
    const contact = await ghl.getContact(env, contactId);
    if (!contact) return json({ error: 'Contact not found.' }, 404);
    return json({ contact });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateLead(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  const email = normalizeEmail(body.email);
  const phone = clean(body.phone, 40);

  if (!firstName && !lastName) return badRequest('A first or last name is required.');
  if (!email && !phone) return badRequest('An email address or phone number is required.');
  if (email && !isValidEmail(email)) return badRequest('Enter a valid email address.');

  try {
    const locationId = ghl.locationFor(env, user);
    const contact = await ghl.createContact(env, locationId, {
      firstName, lastName, email, phone,
      source: clean(body.source, 80) || 'CTT Agent Portal',
    });
    // Mirror straight away rather than waiting for the next sync, so the new
    // contact is in the list the moment the dialog closes.
    if (contact && contact.id) await upsertContact(env, locationId, contact);
    await db.logActivity(env, user.id, 'lead.create', `Added lead ${contact.name}`, { contactId: contact.id });
    await fireTrigger(env, locationId, 'contact.created', {
      contactId: contact.id, name: contact.name, email: contact.email, phone: contact.phone,
    });
    return json({ ok: true, contact }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleUpdateLead(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const email = body.email === undefined ? undefined : normalizeEmail(body.email);
  if (email && !isValidEmail(email)) return badRequest('Enter a valid email address.');

  try {
    const contact = await ghl.updateContact(env, contactId, {
      firstName: body.firstName === undefined ? undefined : clean(body.firstName, 80),
      lastName: body.lastName === undefined ? undefined : clean(body.lastName, 80),
      email,
      phone: body.phone === undefined ? undefined : clean(body.phone, 40),
    });
    if (contact && contact.id) await upsertContact(env, ghl.locationFor(env, user), contact);
    await db.logActivity(env, user.id, 'lead.update', `Updated ${contact.name}`, { contactId });
    return json({ ok: true, contact });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateLeadNote(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const note = clean(body.body, 4000);
  if (!note) return badRequest('The note is empty.');

  try {
    await ghl.createContactNote(env, contactId, note, user.ghl_user_id || undefined);
    await db.logActivity(env, user.id, 'lead.note', 'Added a note', { contactId });
    const notes = await ghl.listContactNotes(env, contactId).catch(() => []);
    return json({ ok: true, notes }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

/**
 * Everything about one contact on a single page: details, notes, tasks,
 * appointments and their opportunities.
 *
 * Each extra is fetched independently and allowed to fail. Custom fields,
 * tags and appointments sit behind scopes the token may not carry, and a
 * missing scope should cost you that one panel, not the whole page.
 */
export async function handleContactDetail(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const locationId = ghl.locationFor(env, user);

  const [contact, notes, tasks, opportunities] = await Promise.all([
    db.localContact(env, contactId).then((c) => c || ghl.getContact(env, contactId)),
    ghl.listContactNotes(env, contactId).catch(() => null),
    ghl.listContactTasks(env, contactId).catch(() => null),
    db.localOpportunitiesForContact(env, contactId).catch(() => null),
  ]).catch((e) => { throw e; });

  if (!contact) return json({ error: 'Contact not found.' }, 404);

  return json({
    contact,
    notes: notes || [],
    tasks: tasks || [],
    opportunities: opportunities || [],
    // Tells the UI to say "unavailable" rather than "none", which are
    // different things and matter when a scope is missing.
    unavailable: {
      notes: notes === null,
      tasks: tasks === null,
      opportunities: opportunities === null,
    },
  });
}

export async function handleCreateTask(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const title = clean(body.title, 160);
  if (!title) return badRequest('Give the task a title.');

  try {
    const task = await ghl.createContactTask(env, contactId, {
      title,
      body: clean(body.body, 2000),
      dueDate: body.dueDate || undefined,
      assignedTo: user.ghl_user_id || undefined,
    });
    await db.logActivity(env, user.id, 'task.create', `Added task "${title}"`, { contactId });
    return json({ ok: true, task }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleToggleTask(request, env, contactId, taskId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  try {
    const task = await ghl.setTaskCompleted(env, contactId, taskId, Boolean(body.completed));
    await db.logActivity(env, user.id, 'task.update',
      body.completed ? 'Completed a task' : 'Reopened a task', { contactId, taskId });
    return json({ ok: true, task });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
