// Time zones for agency events: what an owner typed, what an advisor's own zone is, and moving a time from one to the other.
//
// An event is entered once, in the zone its invitation states ("2:00 PM ET"). Each advisor reads it in their own: a
// training at 2:00 PM Eastern is 1:00 PM to somebody on Central time, and the date can change too for a late one. The stored
// event is never altered; only what each reader is shown.

import { zonedToEpoch } from './ics.js';

// The short labels an owner types. These are the zones that mean something to an advisor in this country.
export const ZONES = {
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
  MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  AKT: 'America/Anchorage', HT: 'Pacific/Honolulu', UTC: 'UTC', GMT: 'UTC',
};

// The generic name of each zone, so a label does not flip between EST and EDT as the clocks change.
const LABELS = {
  'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Phoenix': 'MST',
  'America/Los_Angeles': 'PT', 'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT', UTC: 'UTC',
};

/** Whether this is a zone the runtime knows. A made up one is refused rather than quietly treated as another. */
export function validZone(name) {
  const text = String(name || '').trim();
  if (!text) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: text }); return true; } catch { return false; }
}

/** The IANA name for what somebody typed, or null when it is not a zone this knows. A guessed zone moves a meeting by hours. */
export function zoneFor(tz) {
  const text = String(tz || '').trim();
  if (!text) return null;
  if (ZONES[text.toUpperCase()]) return ZONES[text.toUpperCase()];
  return text.includes('/') && validZone(text) ? text : null;
}

/** "ET" for New York, and the runtime's own short name for the rest. */
export function zoneLabel(zone, at = Date.now()) {
  if (LABELS[zone]) return LABELS[zone];
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName');
    return part ? part.value : zone;
  } catch { return zone; }
}

/** The clock in a zone at a moment, as plain numbers. */
function clockIn(ms, zone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const got = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') got[p.type] = Number(p.value);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${got.year}-${pad(got.month)}-${pad(got.day)}`,
    time: `${pad(got.hour % 24)}:${pad(got.minute)}`,
  };
}

/**
 * An event as somebody in another zone reads it. { onDate, startTime, endTime, tz }, all in the reader's zone.
 *
 * Left exactly as it was entered when either zone is not one this knows, or when they are the same: showing the wrong hour
 * is worse than showing the owner's hour with the owner's label next to it.
 */
export function inZone(ev, readerZone) {
  const same = { onDate: ev.on_date, startTime: ev.start_time, endTime: ev.end_time || '', tz: ev.tz || '' };
  const from = zoneFor(ev.tz);
  if (!from || !readerZone || !validZone(readerZone) || from === readerZone) return same;
  const [y, mo, d] = String(ev.on_date).split('-').map(Number);
  const [sh, sm] = String(ev.start_time).split(':').map(Number);
  if (![y, mo, d, sh, sm].every(Number.isFinite)) return same;
  const start = zonedToEpoch(y, mo, d, sh, sm, from);
  const a = clockIn(start, readerZone);
  let end = '';
  if (ev.end_time) {
    const [eh, em] = String(ev.end_time).split(':').map(Number);
    if (Number.isFinite(eh) && Number.isFinite(em)) end = clockIn(zonedToEpoch(y, mo, d, eh, em, from), readerZone).time;
  }
  return { onDate: a.date, startTime: a.time, endTime: end, tz: zoneLabel(readerZone, start) };
}

/** The zone an advisor's day is in: their own, else the portal's, else Eastern. */
export function zoneOfUser(env, user) {
  const own = user && user.timezone;
  return (own && validZone(own) ? own : null) || env.PORTAL_TZ || 'America/New_York';
}
