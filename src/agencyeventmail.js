// Telling the advisors about an agency event: the announcement an owner sends when they add one, the note when it
// changes or is cancelled, and the reminder the day before for anybody who has not said they are going.
//
// The calendar and the dashboard were always the place an event lived. This is the part that reaches somebody who has not
// opened the portal today. It writes to the agency's own advisors and nobody else, so there is no client unsubscribe to
// carry, and it never sends the same reminder twice: reminded_at is set once the loop has been through.

import { escapeHtml, usDate, now, PermanentError } from './util.js';
import { sendHtml } from './email.js';
import { appUrl } from './share.js';
import { readableOnWhite } from './brand.js';
import { brandForUser } from './brand.js';
import { zonedToEpoch } from './ics.js';
import { zoneFor, inZone, zoneOfUser } from './eventzone.js';
import * as db from './db.js';

const KIND_WORDS = { training: 'training', webinar: 'vendor webinar', meeting: 'agency meeting', other: 'event' };

const FIRST_HOUR = 13;
const LAST_HOUR = 21;

const isoDay = (secs) => new Date(secs * 1000).toISOString().slice(0, 10);
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function clock12(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** "Thursday, November 12 at 2:00 PM to 3:00 PM ET". */
export function whenText(ev) {
  const day = new Date(`${ev.on_date}T12:00:00Z`).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const end = ev.end_time ? ` to ${clock12(ev.end_time)}` : '';
  return `${day} at ${clock12(ev.start_time)}${end}${ev.tz ? ` ${ev.tz}` : ''}`;
}

const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function icsText(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** A line folded at 73 characters, the way the format asks, so no client truncates a long summary. */
function fold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 73) { out.push(rest.slice(0, 73)); rest = ` ${rest.slice(73)}`; }
  out.push(rest);
  return out.join('\r\n');
}

/**
 * The invite file for an event, in universal time so it lands at the right hour in every advisor's calendar. Null when the
 * zone is not one this recognises: the email still goes, just without a file that could be an hour wrong.
 */
export function eventIcs(ev, { method = 'PUBLISH' } = {}) {
  const zone = zoneFor(ev.tz);
  if (!zone) return null;
  const [y, mo, d] = String(ev.on_date).split('-').map(Number);
  const [sh, sm] = String(ev.start_time).split(':').map(Number);
  const start = zonedToEpoch(y, mo, d, sh, sm, zone);
  let end = start + 3600000;
  if (ev.end_time) {
    const [eh, em] = String(ev.end_time).split(':').map(Number);
    const e = zonedToEpoch(y, mo, d, eh, em, zone);
    if (e > start) end = e;
  }
  const cancelled = method === 'CANCEL';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CTT Agent Portal//Agency events//EN', 'CALSCALE:GREGORIAN',
    `METHOD:${method}`, 'BEGIN:VEVENT',
    `UID:agency-event-${ev.id}@cttagents.com`,
    `DTSTAMP:${utcStamp(Date.now())}`,
    `SEQUENCE:${Math.floor((ev.updated_at || 0) % 100000000)}`,
    `DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`,
    `SUMMARY:${icsText(ev.title)}`,
    ...(ev.notes || ev.link ? [`DESCRIPTION:${icsText([ev.notes, ev.link].filter(Boolean).join('\n'))}`] : []),
    ...(ev.link ? [`URL:${ev.link}`] : []),
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const EYEBROW = { training: 'Training', webinar: 'Vendor webinar', meeting: 'Agency meeting', other: 'Agency event' };

/** What to call the join link: the tool, when the address says which one it is. */
function joinLabel(link) {
  const host = (() => { try { return new URL(link).hostname.toLowerCase(); } catch { return ''; } })();
  if (host.includes('zoom')) return 'Zoom link';
  if (host.includes('teams')) return 'Teams link';
  if (host.includes('webex')) return 'Webex link';
  if (host.includes('meet.google')) return 'Google Meet link';
  return 'Join link';
}

/**
 * The two "add to my calendar" buttons, as links that open the calendar already filled in. Null when the zone is not one
 * this recognises, for the same reason the attached file is: a wrong hour is worse than no button.
 */
export function calendarLinks(ev) {
  const zone = zoneFor(ev.tz);
  if (!zone) return null;
  const [y, mo, d] = String(ev.on_date).split('-').map(Number);
  const [sh, sm] = String(ev.start_time).split(':').map(Number);
  const start = zonedToEpoch(y, mo, d, sh, sm, zone);
  let end = start + 3600000;
  if (ev.end_time) {
    const [eh, em] = String(ev.end_time).split(':').map(Number);
    const e = zonedToEpoch(y, mo, d, eh, em, zone);
    if (e > start) end = e;
  }
  const details = [ev.notes, ev.link].filter(Boolean).join('\n\n');
  const g = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates: `${utcStamp(start)}/${utcStamp(end)}`, details });
  if (ev.link) g.set('location', ev.link);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const o = new URLSearchParams({
    path: '/calendar/action/compose', rru: 'addevent', subject: ev.title, startdt: iso(start), enddt: iso(end), body: details,
  });
  if (ev.link) o.set('location', ev.link);
  return {
    google: `https://calendar.google.com/calendar/render?${g.toString()}`,
    outlook: `https://outlook.office.com/calendar/0/deeplink/compose?${o.toString()}`,
  };
}

/**
 * The whole message. One plain card in the agency's colour: what it is, what it is called, when, how to join, what it
 * covers, and a button for each calendar people use. A banner above the title says when this is a change, a cancellation
 * or a reminder; a brand new event has none.
 */
function eventEmail(brand, ev, { banner = '', goingHref = '', links = null } = {}) {
  const head = readableOnWhite(brand.color) ? brand.color : '#12315e';
  const day = new Date(`${ev.on_date}T12:00:00Z`).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const time = `${clock12(ev.start_time)}${ev.end_time ? ` to ${clock12(ev.end_time)}` : ''}${ev.tz ? ` ${ev.tz}` : ''}`;
  const button = (href, label) => `<a href="${escapeHtml(href)}" style="display:inline-block;background:#46829a;color:#ffffff;
    text-decoration:none;font-size:14px;padding:11px 20px;border-radius:4px;margin:0 10px 10px 0;">${label}</a>`;
  const site = String(brand.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;font-family:Helvetica,Arial,sans-serif;color:#2b3a4a;">
      <tr><td style="background:${head};padding:24px 30px;font-size:19px;color:#ffffff;">${escapeHtml(brand.name)}</td></tr>
      <tr><td style="padding:30px 30px 10px;">
        ${banner ? `<p style="margin:0 0 18px;padding:10px 14px;background:#f3efe2;border-radius:4px;font-size:14px;">${escapeHtml(banner)}</p>` : ''}
        <p style="margin:0 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b7b8b;">${escapeHtml(EYEBROW[ev.kind] || 'Agency event')}</p>
        <h1 style="margin:0 0 22px;font-size:24px;line-height:1.4;color:#12243d;">${escapeHtml(ev.title)}</h1>
        <p style="margin:0 0 8px;font-size:17px;font-weight:bold;color:#2b3a4a;">${escapeHtml(day)}</p>
        <p style="margin:0 0 8px;font-size:17px;">${escapeHtml(time)}</p>
        ${ev.vendor ? `<p style="margin:0 0 8px;font-size:15px;color:#5c7286;">Given by ${escapeHtml(ev.vendor)}</p>` : ''}
        ${ev.link ? `<p style="margin:0 0 8px;font-size:17px;"><a href="${escapeHtml(ev.link)}" style="color:#2b3a4a;">${joinLabel(ev.link)}</a></p>` : ''}
        ${ev.notes ? `<p style="margin:22px 0 0;font-size:16px;line-height:1.5;">${escapeHtml(ev.notes).replace(/\n/g, '<br>')}</p>` : ''}
      </td></tr>
      ${links ? `<tr><td style="padding:22px 30px 0;">${button(links.google, 'Add to Google Calendar')}${button(links.outlook, 'Add to Outlook')}</td></tr>
      <tr><td style="padding:6px 30px 0;font-size:13px;color:#6b7b8b;">Or open the attached file to add it to Apple Calendar or any other calendar app.</td></tr>` : ''}
      ${goingHref ? `<tr><td style="padding:18px 30px 0;font-size:14px;"><a href="${escapeHtml(goingHref)}" style="color:#46829a;">Say you are going in the portal</a></td></tr>` : ''}
      <tr><td style="padding:26px 0 0;"></td></tr>
      <tr><td style="background:#ece6d6;padding:16px 30px;font-size:13px;color:#4a5a6a;">${escapeHtml(brand.name)}${site ? ` &middot; ${escapeHtml(site)}` : ''}</td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

/** The advisors an event is for: everybody in the agency, or only the ones the owner picked. */
async function agencyAdvisors(env, agencyId, ev = null) {
  const people = (await db.listUsers(env, { status: 'active', agencyId: agencyId || undefined })).filter((u) => u.email);
  if (!ev || ev.audience !== 'some') return people;
  const { results } = await env.DB.prepare(
    'SELECT user_id FROM agency_event_invites WHERE event_id = ? AND agency_id = ?'
  ).bind(ev.id, agencyId).all();
  const invited = new Set((results || []).map((r) => r.user_id));
  return people.filter((u) => invited.has(u.id));
}

async function deliver(env, { owner, ev, people, subject, banner, goingHref, mode }) {
  const brand = await brandForUser(env, owner.id);
  const ics = eventIcs(ev, { method: mode === 'cancel' ? 'CANCEL' : 'PUBLISH' });
  // The buttons and the attached file are in universal time, so they are right for everybody. Only the words differ: each
  // advisor reads the day and the hour in their own zone, built once per zone.
  const links = mode === 'cancel' ? null : calendarLinks(ev);
  const byZone = new Map();
  const htmlFor = (user) => {
    const zone = zoneOfUser(env, user);
    if (!byZone.has(zone)) {
      const shown = inZone(ev, zone);
      byZone.set(zone, eventEmail(brand, { ...ev, on_date: shown.onDate, start_time: shown.startTime, end_time: shown.endTime, tz: shown.tz },
        { banner, goingHref, links }));
    }
    return byZone.get(zone);
  };
  let sent = 0;
  const failed = [];
  for (const u of people) {
    try {
      await sendHtml(env, {
        to: u.notify_email || u.email,
        replyTo: owner.notify_email || owner.email,
        subject, html: htmlFor(u),
        attachments: ics ? [{ filename: 'event.ics', content: base64Utf8(ics) }] : [],
      });
      sent += 1;
    } catch (e) {
      // No key, no point trying the rest: say so once and stop.
      if (e instanceof PermanentError && /not configured/i.test(String(e.message))) throw e;
      failed.push([u.first_name, u.last_name].filter(Boolean).join(' ') || u.email);
    }
  }
  return { sent, failed, total: people.length };
}

/** Tell every advisor in the owner's agency about an event: new, changed, or cancelled. */
export async function announceEvent(env, owner, ev, mode = 'new') {
  const people = await agencyAdvisors(env, ev.agency_id, ev);
  const kind = KIND_WORDS[ev.kind] || 'event';
  const goingHref = `${appUrl(env)}/app/`;
  const text = {
    new: { subject: `New ${kind}: ${ev.title}, ${usDate(ev.on_date)}`, banner: '', goingHref },
    update: { subject: `Changed: ${ev.title}, ${usDate(ev.on_date)}`, banner: `This ${kind} has changed. Your portal calendar is already up to date.`, goingHref },
    cancel: { subject: `Cancelled: ${ev.title}, ${usDate(ev.on_date)}`, banner: `This ${kind} has been cancelled.`, goingHref: '' },
  }[mode] || null;
  if (!text) throw new PermanentError('Which message: new, changed or cancelled?');
  const result = await deliver(env, { owner, ev, people, ...text, mode });
  if (mode !== 'cancel' && result.sent) {
    await env.DB.prepare('UPDATE agency_events SET announced_at = ? WHERE id = ? AND agency_id = ?')
      .bind(now(), ev.id, ev.agency_id).run();
  }
  return result;
}

/**
 * The day-before reminder, for advisors who have not said they are going. Runs on the ordinary tick and does nothing but
 * one query until there is an event tomorrow. Daytime only, so nobody is woken, and an event announced in the last
 * twenty hours is not nagged about on top of its announcement.
 */
export async function sendEventReminders(env, { at = now() } = {}) {
  const hour = new Date(at * 1000).getUTCHours();
  if (hour < FIRST_HOUR || hour > LAST_HOUR) return { skipped: 'outside the sending hours' };
  const tomorrow = addDays(isoDay(at), 1);
  const { results } = await env.DB.prepare(
    `SELECT id, agency_id, kind, title, vendor, on_date, start_time, end_time, tz, link, notes, created_by,
            updated_at, announced_at, audience
       FROM agency_events
      WHERE agency_id IS NOT NULL AND on_date = ? AND cancelled_at IS NULL AND remind = 1 AND reminded_at IS NULL
      LIMIT 20`
  ).bind(tomorrow).all();

  const out = { events: 0, sent: 0, failed: 0 };
  for (const ev of results || []) {
    if (ev.announced_at && at - ev.announced_at < 20 * 3600) continue;
    const owner = ev.created_by ? await db.getUserById(env, ev.created_by).catch(() => null) : null;
    if (!owner) continue;
    const going = await env.DB.prepare(
      'SELECT user_id FROM agency_event_going WHERE event_id = ? AND agency_id = ?'
    ).bind(ev.id, ev.agency_id).all();
    const yes = new Set((going.results || []).map((r) => r.user_id));
    const people = (await agencyAdvisors(env, ev.agency_id, ev)).filter((u) => !yes.has(u.id));
    // Marked first, so a slow loop that overruns the tick is not run twice.
    await env.DB.prepare('UPDATE agency_events SET reminded_at = ? WHERE id = ? AND agency_id = ?')
      .bind(at, ev.id, ev.agency_id).run();
    out.events += 1;
    if (!people.length) continue;
    const kind = KIND_WORDS[ev.kind] || 'event';
    const result = await deliver(env, {
      owner, ev, people, mode: 'new',
      subject: `Tomorrow: ${ev.title}, ${clock12(ev.start_time)}${ev.tz ? ` ${ev.tz}` : ''}`,
      banner: `Reminder: this ${kind} is tomorrow, and you have not said you are going yet.`,
      goingHref: `${appUrl(env)}/app/`,
    });
    out.sent += result.sent;
    out.failed += result.failed.length;
  }
  return out;
}
