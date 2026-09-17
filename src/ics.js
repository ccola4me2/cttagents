// Reading a meeting invite.
//
// An invite is an iCalendar file, which is a format with thirty years of
// accumulated opinions in it. This reads the small part that answers "what,
// when, where, who", and ignores the rest on purpose: recurrence rules,
// alarms, free/busy and attachments are all real and none of them change what
// goes in a diary entry.
//
// The hard part is not parsing, it is time. An invite says its times in one of
// three ways and this portal stores a fourth: a plain day and a plain clock
// time, the way somebody says them out loud. Converting needs to know whose
// day it is, which is why an advisor has a zone and why getting it wrong moves
// every meeting by hours without saying anything.

/**
 * Undo the folding, which is the first thing that surprises everybody.
 *
 * A line longer than 75 octets is broken and continued with a leading space or
 * tab. A parser that reads line by line without joining them back gets a
 * summary cut in half and a UID that does not match the one it matched last
 * time.
 */
function unfold(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');
}

/**
 * One line, split into its name, its parameters and its value.
 *
 * The colon that ends the name is the first one not inside quotes: a
 * parameter may legitimately contain one, and CN="Smith: Jane" is not two
 * fields.
 */
function readLine(line) {
  let inQuotes = false;
  let at = -1;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) { at = i; break; }
  }
  if (at === -1) return null;

  const head = line.slice(0, at);
  const value = line.slice(at + 1);
  const parts = head.split(';');
  const name = parts[0].trim().toUpperCase();

  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).trim().toUpperCase()] =
      p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** The escaping iCalendar uses inside a text value. */
function unescapeText(v) {
  return String(v || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * A wall-clock time in a named zone, as a moment.
 *
 * There is no way to ask JavaScript "what instant is 2pm in New York", so this
 * asks the opposite question twice: guess an instant, see what clock time it
 * shows there, and correct by the difference. Twice, because the first
 * correction can cross a daylight-saving boundary and land an hour out.
 */
function zonedToEpoch(y, mo, d, h, mi, zone) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 2; i += 1) {
    const shown = partsInZone(guess, zone);
    if (!shown) return guess;
    const drift = Date.UTC(shown.y, shown.mo - 1, shown.d, shown.h, shown.mi, 0)
      - Date.UTC(y, mo - 1, d, h, mi, 0);
    if (!drift) break;
    guess -= drift;
  }
  return guess;
}

/** What the clock says in a zone at a given moment. */
function partsInZone(ms, zone) {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const got = {};
    for (const p of f.formatToParts(new Date(ms))) {
      if (p.type !== 'literal') got[p.type] = Number(p.value);
    }
    // Midnight comes back as 24 in some engines rather than 0.
    return { y: got.year, mo: got.month, d: got.day, h: got.hour % 24, mi: got.minute };
  } catch {
    // An unknown zone. Better to say so than to silently use another one.
    return null;
  }
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * A DTSTART or DTEND, as the plain day and clock time this portal stores.
 *
 * Three shapes arrive, and all three end in the advisor's own day:
 *
 *   VALUE=DATE:20260917        an all day thing, no clock time at all
 *   TZID=America/New_York:...  a wall time in a named zone
 *   20260917T140000Z           an instant, in UTC
 *
 * A form with no Z and no TZID is "floating": it means the same clock time
 * wherever you are, which is exactly what this portal stores, so it is taken
 * as written.
 */
export function readWhen(line, zone) {
  if (!line) return null;
  const v = String(line.value || '').trim();

  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly || line.params.VALUE === 'DATE') {
    const m = dateOnly || v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null, allDay: true };
  }

  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, Y, M, D, h, mi, , isUtc] = m;

  const named = line.params.TZID;
  if (!isUtc && !named) {
    // Floating: the same clock time wherever it is read, which is what this
    // portal stores anyway.
    return { date: `${Y}-${M}-${D}`, time: `${h}:${mi}`, allDay: false };
  }

  const at = isUtc
    ? Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(h), Number(mi), 0)
    : zonedToEpoch(Number(Y), Number(M), Number(D), Number(h), Number(mi), named);

  const local = partsInZone(at, zone);
  if (!local) {
    // The advisor's zone is unusable. Rather than put the meeting at a time
    // that is wrong by hours, hand back what the invite said and let the
    // caller say it was not converted.
    return { date: `${Y}-${M}-${D}`, time: `${h}:${mi}`, allDay: false, unconverted: true };
  }
  return {
    date: `${local.y}-${pad(local.mo)}-${pad(local.d)}`,
    time: `${pad(local.h)}:${pad(local.mi)}`,
    allDay: false,
  };
}

/** The address out of an ORGANIZER or ATTENDEE line, which is a mailto URI. */
function addressOf(line) {
  if (!line) return '';
  const who = String(line.value || '').replace(/^mailto:/i, '').trim();
  const name = line.params.CN;
  if (name && who) return `${name} <${who}>`;
  return name || who;
}

/**
 * The first real event in a calendar.
 *
 * First rather than all: an invite carries one meeting, and a file carrying a
 * hundred is somebody's whole calendar being imported, which is a different
 * feature with different questions. A recurring event's exceptions arrive as
 * extra VEVENTs sharing the UID, and taking the first is the master.
 */
export function parseInvite(text, { zone = 'UTC' } = {}) {
  const raw = unfold(text);
  if (!/BEGIN:VCALENDAR/i.test(raw)) return { error: 'That is not a calendar file.' };

  const lines = raw.split('\n').map(readLine).filter(Boolean);

  let method = '';
  for (const l of lines) if (l.name === 'METHOD') method = l.value.trim().toUpperCase();

  const start = lines.findIndex((l) => l.name === 'BEGIN' && l.value.trim().toUpperCase() === 'VEVENT');
  if (start === -1) return { error: 'That calendar has no meeting in it.' };
  let end = lines.findIndex((l, i) => i > start && l.name === 'END'
    && l.value.trim().toUpperCase() === 'VEVENT');
  if (end === -1) end = lines.length;

  const ev = lines.slice(start + 1, end);
  const find = (name) => ev.find((l) => l.name === name);
  const all = (name) => ev.filter((l) => l.name === name);

  const from = readWhen(find('DTSTART'), zone);
  if (!from) return { error: 'That meeting has no start time this can read.' };
  const to = readWhen(find('DTEND'), zone);

  const uid = (find('UID') || {}).value;
  const seqLine = find('SEQUENCE');
  const statusLine = find('STATUS');
  const status = statusLine ? String(statusLine.value).trim().toUpperCase() : '';

  return {
    // What the sender meant by sending it. CANCEL means take it off the
    // calendar, which is a different act from adding one.
    method: method || 'PUBLISH',
    cancelled: method === 'CANCEL' || status === 'CANCELLED',
    uid: uid ? String(uid).trim().slice(0, 300) : null,
    sequence: seqLine ? Number(seqLine.value) || 0 : 0,
    title: unescapeText((find('SUMMARY') || {}).value).slice(0, 160) || 'Meeting',
    location: unescapeText((find('LOCATION') || {}).value).slice(0, 200),
    notes: unescapeText((find('DESCRIPTION') || {}).value).slice(0, 2000),
    organizer: addressOf(find('ORGANIZER')).slice(0, 200),
    attendees: all('ATTENDEE').map(addressOf).filter(Boolean).slice(0, 40),
    onDate: from.date,
    startTime: from.allDay ? '00:00' : from.time,
    // An all day thing has no end worth showing, and an invite that gives an
    // end before its start is a broken invite rather than a negative meeting.
    endTime: to && !to.allDay && !from.allDay && to.time > from.time ? to.time : null,
    allDay: Boolean(from.allDay),
    unconverted: Boolean(from.unconverted),
  };
}

/**
 * The calendar part of an email, if it has one.
 *
 * A forwarded invite is a MIME message with the calendar somewhere inside it,
 * usually as text/calendar and sometimes as a .ics attachment, and either can
 * be base64 encoded. This looks for the content rather than trusting the
 * structure: the marker that opens a calendar is unambiguous, and walking a
 * MIME tree correctly is a great deal of work to arrive at the same place.
 */
export function calendarPartOf(rawEmail) {
  const text = String(rawEmail || '');

  // The easy case: it is sitting there in plain sight.
  const plain = text.indexOf('BEGIN:VCALENDAR');
  if (plain !== -1) {
    const stop = text.indexOf('END:VCALENDAR', plain);
    if (stop !== -1) return text.slice(plain, stop + 'END:VCALENDAR'.length);
  }

  // Otherwise it is base64, somewhere inside a MIME part.
  //
  // Worked in whole lines rather than as a run of characters. A base64 body is
  // lines made only of base64 characters, and the header above it ends in the
  // word "base64", which is itself made only of base64 characters: a
  // character-run match swallows the header and then fails to decode the lot.
  // A block is consecutive lines of nothing but base64 characters. The last
  // line of one is nearly always short, so the length test is on the block and
  // not on each line: requiring every line to be long drops that tail and
  // decodes a calendar with its ending cut off.
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let block = [];
  const flush = () => {
    const joined = block.join('');
    if (joined.length >= 40 && joined.length % 4 === 0) blocks.push(joined);
    block = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (t && /^[A-Za-z0-9+/]+={0,2}$/.test(t)) block.push(t);
    else flush();
  }
  flush();

  for (const b of blocks) {
    try {
      const decoded = atob(b);
      const at = decoded.indexOf('BEGIN:VCALENDAR');
      if (at === -1) continue;
      const stop = decoded.indexOf('END:VCALENDAR', at);
      if (stop !== -1) return decoded.slice(at, stop + 'END:VCALENDAR'.length);
    } catch { /* not base64 after all, or not text; keep looking */ }
  }
  return null;
}
