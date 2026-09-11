// Calendars and appointments, read and written through to GoHighLevel.
//
// The events endpoint needs a calendar, user or group to scope by, so this
// fans out across the sub-account's active calendars and merges the results
// rather than asking the caller to pick one first.

import { json, badRequest, clean, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import * as db from './db.js';
const { logActivity } = db;

const DAY_MS = 86400000;

export async function handleListCalendar(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 180);
  const start = Date.now() - DAY_MS;           // include yesterday, so "today" is never empty by an hour
  const end = Date.now() + days * DAY_MS;

  const locationId = ghl.locationFor(env, user);

  // The travel itself, which is not in GoHighLevel and is the reason most of
  // those appointments exist. Read first and returned whatever GoHighLevel
  // does, so an unconfigured or failing CRM leaves the advisor with their
  // departures rather than an empty week.
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const scope = db.scopeFor(env, user, request);
  const travel = await db.travelDates(env, scope, { from: iso(start), to: iso(end) })
    .catch(() => []);

  // The advisor's own tasks, on the same run of days.
  //
  // Added here because you can now put a task on the calendar from this
  // screen, and a thing you add somewhere has to appear where you added it.
  // Read from this database, so they survive a CRM that is unreachable.
  const tasks = await db.openTasksBetween(env, scope, { from: iso(start), to: iso(end) })
    .catch(() => []);

  try {
    const calendars = await ghl.listCalendars(env, locationId);
    const active = calendars.filter((c) => c.isActive);

    if (!active.length) return json({ calendars, events: [], travel, tasks, days });

    // One request per calendar, and a calendar that errors is dropped rather
    // than failing the whole view.
    const perCalendar = await Promise.all(
      active.map((c) =>
        ghl.listAppointments(env, locationId, {
          calendarId: c.id,
          startTime: start,
          endTime: end,
        })
          .then((events) => events.map((e) => ({ ...e, calendarId: c.id, calendarName: c.name })))
          .catch(() => [])
      )
    );

    const events = perCalendar.flat().sort(
      (a, b) => Date.parse(a.startTime || 0) - Date.parse(b.startTime || 0)
    );

    return json({ calendars, events, travel, tasks, days });
  } catch (e) {
    // A CRM that is down should not hide the departures. The travel comes off
    // this portal's own database and is still worth showing on its own.
    if (travel.length || tasks.length) {
      return json({ calendars: [], events: [], travel, tasks, days, crmError: true });
    }
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateAppointment(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const calendarId = clean(body.calendarId, 64);
  const contactId = clean(body.contactId, 64);
  const startTime = clean(body.startTime, 40);

  if (!calendarId) return badRequest('Choose a calendar.');
  if (!contactId) return badRequest('Pick a contact.');
  if (!startTime) return badRequest('Choose a start time.');

  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs)) return badRequest('That start time is not a valid date.');

  const minutes = Math.min(Math.max(Number(body.durationMinutes) || 30, 5), 480);

  try {
    const appointment = await ghl.createAppointment(env, ghl.locationFor(env, user), {
      calendarId,
      contactId,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(startMs + minutes * 60000).toISOString(),
      title: clean(body.title, 160) || undefined,
      assignedUserId: user.ghl_user_id || undefined,
    });
    await logActivity(env, user.id, 'appointment.create',
      `Booked ${appointment.title || 'an appointment'}`, { contactId, calendarId });
    return json({ ok: true, appointment }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
