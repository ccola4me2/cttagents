// How a group's page is doing: who looked, who asked, who signed up, who booked.
//
// The page counts a visit without keeping anything about the visitor. A visitor is a hash of their
// address and browser for that one group on that one day, so the same person tomorrow is counted
// again and nobody can be looked up. Browsers that announce themselves as robots, link previews and
// monitors are not counted, since a message that shows a preview of the link is not a person
// reading the page.
//
// What is read back is an owner's. An owner sees every group in their agency and nothing outside it.

import { json, now, sha256Hex } from './util.js';
import { requireAdmin } from './auth.js';
import * as db from './db.js';

const NOT_A_PERSON = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|monitor|uptime|headless|lighthouse/i;

/** Count one view of a group's page, never failing the page it is counting. */
export async function recordVisit(env, request, group, kind) {
  try {
    if (!group || !group.id || !group.user_id) return;
    if (request.method !== 'GET') return;
    const agent = request.headers.get('User-Agent') || '';
    if (NOT_A_PERSON.test(agent)) return;
    const purpose = `${request.headers.get('Purpose') || ''}${request.headers.get('Sec-Purpose') || ''}`;
    if (/prefetch|prerender/i.test(purpose)) return;
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const day = new Date().toISOString().slice(0, 10);
    const visitor = (await sha256Hex(`visit:${group.id}:${day}:${ip}:${agent}`)).slice(0, 32);
    await env.DB.prepare(
      `INSERT INTO group_visits (group_id, user_id, day, visitor, kind, views, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(group_id, day, visitor, kind) DO UPDATE SET views = views + 1`
    ).bind(group.id, group.user_id, day, visitor, kind === 'register' ? 'register' : 'page', now()).run();
  } catch (e) {
    console.error('group visit', e);
  }
}

const RANGES = { '7': 7, '30': 30, '90': 90, all: 0 };

/** GET /api/admin/group-stats?range=7|30|90|all : every group in the agency, with its funnel. */
export async function handleGroupStats(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  const asked = new URL(request.url).searchParams.get('range') || '30';
  const range = Object.prototype.hasOwnProperty.call(RANGES, asked) ? asked : '30';
  const days = RANGES[range];
  const sinceDay = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : '0000-00-00';
  const sinceTs = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;

  const scope = db.agencyScope(user);
  const scoped = db.scopeWhere(scope, 'g.user_id');
  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.page_slug, g.group_code, g.status, g.registration_open,
            g.depart_date, g.cabins_held, g.selling, g.selling_changed_at,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS advisor
       FROM travel_groups g JOIN users u ON u.id = g.user_id
      WHERE ${scoped.sql} AND g.status <> 'cancelled'
      ORDER BY g.depart_date DESC, g.name ASC LIMIT 500`
  ).bind(...scoped.binds).all().catch(() => ({ results: [] }));

  const visitScope = db.scopeWhere(scope, 'v.user_id');
  const { results: visits } = await env.DB.prepare(
    `SELECT v.group_id, v.kind, COUNT(DISTINCT v.day || v.visitor) AS visitors, SUM(v.views) AS views
       FROM group_visits v
      WHERE ${visitScope.sql} AND v.day >= ?
      GROUP BY v.group_id, v.kind`
  ).bind(...visitScope.binds, sinceDay).all().catch(() => ({ results: [] }));

  // A short enquiry is a name and an email; a registration names who is travelling. Booked is
  // when the advisor turned either into a reservation.
  const regScope = db.scopeWhere(scope, 'r.user_id');
  const { results: regs } = await env.DB.prepare(
    `SELECT r.group_id,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM group_travellers t WHERE t.registration_id = r.id) THEN 0 ELSE 1 END) AS enquiries,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM group_travellers t WHERE t.registration_id = r.id) THEN 1 ELSE 0 END) AS registrations,
            SUM(CASE WHEN r.booking_id IS NOT NULL THEN 1 ELSE 0 END) AS booked
       FROM group_registrations r
      WHERE ${regScope.sql} AND r.created_at >= ?
      GROUP BY r.group_id`
  ).bind(...regScope.binds, sinceTs).all().catch(() => ({ results: [] }));

  const byGroup = new Map();
  for (const v of visits || []) {
    const row = byGroup.get(v.group_id) || {};
    if (v.kind === 'register') { row.signupVisitors = v.visitors; row.signupViews = v.views; }
    else { row.visitors = v.visitors; row.views = v.views; }
    byGroup.set(v.group_id, row);
  }
  const regBy = new Map((regs || []).map((r) => [r.group_id, r]));

  const rows = (groups || []).map((g) => {
    const v = byGroup.get(g.id) || {};
    const r = regBy.get(g.id) || {};
    const visitors = v.visitors || 0;
    const registrations = r.registrations || 0;
    const enquiries = r.enquiries || 0;
    return {
      id: g.id, name: g.name, slug: g.page_slug || '', code: g.group_code || '', advisor: g.advisor,
      status: g.status, pageOn: Boolean(g.registration_open), departs: g.depart_date || '',
      selling: g.selling || 'private', sellingChangedAt: g.selling_changed_at || null,
      cabins: g.cabins_held || 0,
      visitors, views: v.views || 0,
      signupVisitors: v.signupVisitors || 0,
      enquiries, registrations, booked: r.booked || 0,
      // Of the people who looked, how many asked or signed up. Not shown until somebody has looked,
      // since a rate of nothing over nothing is not a rate.
      conversion: visitors ? Math.round(((registrations + enquiries) / visitors) * 1000) / 10 : null,
    };
  });

  const total = rows.reduce((t, r) => ({
    visitors: t.visitors + r.visitors, views: t.views + r.views, signupVisitors: t.signupVisitors + r.signupVisitors,
    enquiries: t.enquiries + r.enquiries, registrations: t.registrations + r.registrations, booked: t.booked + r.booked,
  }), { visitors: 0, views: 0, signupVisitors: 0, enquiries: 0, registrations: 0, booked: 0 });
  total.conversion = total.visitors
    ? Math.round(((total.registrations + total.enquiries) / total.visitors) * 1000) / 10 : null;

  return json({ range, groups: rows, total });
}
