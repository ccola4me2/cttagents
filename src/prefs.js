// Dashboard layout: which panels an advisor sees, and in what order.
//
// The catalogue lives here rather than on the page because the server has to
// validate what comes back. A layout is user supplied data that is later
// rendered, so an id that is not in this list is dropped rather than stored
// and echoed to a browser.
//
// Layouts are additive on read: a panel added in a later release appears for
// everyone, at the end, without anyone having to reset their dashboard. That
// matters more than it sounds. The alternative is shipping a feature that only
// new accounts ever see.

import { json, badRequest, clean, now, readJson } from './util.js';
import { requireUser } from './auth.js';

/**
 * Every panel the dashboard can show.
 *
 * `owner` marks the ones that only make sense to someone who sees the whole
 * agency, so an associate is never offered a panel that would be empty by
 * definition.
 */
export const PANELS = [
  { id: 'notices', title: 'Notices', hint: 'Things that need your attention' },
  { id: 'tasks', title: 'To do', hint: 'Your own working list' },
  { id: 'month', title: 'This month', hint: 'Departures, deadlines and tasks on a calendar' },
  { id: 'deadlines', title: 'Deadlines', hint: 'Reminders, vendor dates and anything past due' },
  { id: 'bookings', title: 'Latest bookings', hint: 'Newest and recently changed reservations' },
  { id: 'travelling', title: "Who's travelling", hint: 'Leaving soon, away now, just back' },
  { id: 'documents', title: 'Before they travel', hint: 'Passports that will be refused, and the ones nobody has recorded' },
  { id: 'groups', title: 'Group space', hint: 'Blocks of cabins and when they release' },
  { id: 'deals', title: 'Deals in play', hint: 'Open opportunities by stage' },
  { id: 'rebook', title: 'Worth a call', hint: 'Past clients with nothing booked, and credits about to lapse' },
  { id: 'pinned', title: 'Pinned clients', hint: 'The ones you are working on now' },
  { id: 'goal', title: 'Target', hint: 'This year against what you set out to do' },
  { id: 'commission', title: 'Commission owed', hint: 'Earned, not yet paid, by age' },
  { id: 'trend', title: 'Production trend', hint: 'Booked value by month' },
  { id: 'associates', title: 'Associate stats', hint: 'Clients, new business and departures, advisor by advisor' },
  { id: 'links', title: 'Quick links', hint: 'Your own shortcuts' },
  { id: 'activity', title: 'Activity', hint: 'What has happened recently' },
];

const PANEL_IDS = new Set(PANELS.map((p) => p.id));
const MAX_LINKS = 12;

/** The layout a new advisor gets. */
function defaultLayout() {
  return { widgets: PANELS.map((p) => ({ id: p.id, hidden: p.id === 'links' })), links: [] };
}

/**
 * A stored layout, repaired into something renderable.
 *
 * Unknown ids are dropped, duplicates collapsed, and panels added since the
 * layout was saved are appended. The result is always a complete list, so the
 * page never has to reason about a partial one.
 */
export function normalizeLayout(raw) {
  const base = defaultLayout();
  if (!raw || typeof raw !== 'object') return base;

  const seen = new Set();
  const widgets = [];
  for (const w of Array.isArray(raw.widgets) ? raw.widgets.slice(0, 40) : []) {
    const id = typeof w === 'string' ? w : (w && w.id);
    if (!PANEL_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    widgets.push({ id, hidden: Boolean(w && w.hidden) });
  }
  for (const p of PANELS) {
    if (!seen.has(p.id)) widgets.push({ id: p.id, hidden: p.id === 'links' });
  }

  const links = [];
  for (const l of Array.isArray(raw.links) ? raw.links.slice(0, MAX_LINKS) : []) {
    const label = clean(l && l.label, 40);
    const href = clean(l && l.href, 400);
    // http and https only. A saved javascript: or data: URL would be stored
    // once and clicked by the person who saved it on every later visit.
    if (!label || !/^https?:\/\//i.test(href)) continue;
    links.push({ label, href });
  }

  return { widgets, links };
}

export async function readLayout(env, userId) {
  const row = await env.DB.prepare('SELECT dashboard_json FROM user_prefs WHERE user_id = ?')
    .bind(userId).first();
  let parsed = null;
  try { parsed = row && row.dashboard_json ? JSON.parse(row.dashboard_json) : null; } catch { parsed = null; }
  return normalizeLayout(parsed);
}

export async function handleGetLayout(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  return json({ layout: await readLayout(env, user.id), panels: PANELS });
}

export async function handleSaveLayout(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const layout = normalizeLayout(body && body.layout);
  if (!layout.widgets.length) return badRequest('A dashboard needs at least one panel.');

  await env.DB.prepare(
    `INSERT INTO user_prefs (user_id, dashboard_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET dashboard_json = excluded.dashboard_json,
                                           updated_at = excluded.updated_at`
  ).bind(user.id, JSON.stringify(layout), now()).run();

  return json({ ok: true, layout });
}

/** Back to the default, for when someone has hidden everything. */
export async function handleResetLayout(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  await env.DB.prepare('DELETE FROM user_prefs WHERE user_id = ?').bind(user.id).run();
  return json({ ok: true, layout: defaultLayout() });
}
