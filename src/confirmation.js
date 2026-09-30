// What a confirmation says, turned into lines of a trip's itinerary.
//
// An advisor is sent a flight e-ticket, a hotel booking, a tour voucher, a rail
// ticket, and the facts in it (what time, which terminal, where to meet, what the
// reference is) are the facts the client's itinerary needs. Until now somebody
// retyped each one. This reads the PDF and proposes the lines.
//
// It is a proposal and never a save. The advisor sees every line, unticks the ones
// that are wrong and adds the rest. That matters more here than it does for a group
// proposal, because nobody has written an exact reader for any one airline's or
// hotel site's layout: this reads what is labelled, which is most of it and not
// all of it, and says so.
//
// What it will not do is guess. A time with no am or pm is read as the 24 hour
// clock and flagged, a date with no year takes the year that puts it nearest the
// trip, and anything it cannot place is left out rather than put on the wrong day.
// An itinerary line at the wrong hour is worse than one that was never there,
// because the client acts on it.
//
// Pure: text in, answer out, so scripts/check-confirmation.mjs can run it on what
// each kind of confirmation looks like without a Worker.

import { DATE_SOURCE, parseDate, titleCase } from './groupquote-util.js';

const MON = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?'
  + '|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const MON_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW = '(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)[a-z]*\\.?,?';

// Airline codes worth trusting. A flight number is two characters and some digits,
// which is also what a hotel's room code and a booking's suffix look like, so a
// code is only a flight if it is one somebody flies.
const AIRLINES = {
  AA: 'American', DL: 'Delta', UA: 'United', WN: 'Southwest', B6: 'JetBlue', AS: 'Alaska',
  NK: 'Spirit', F9: 'Frontier', HA: 'Hawaiian', G4: 'Allegiant', SY: 'Sun Country',
  AC: 'Air Canada', WS: 'WestJet', AM: 'Aeromexico', CM: 'Copa', AV: 'Avianca', LA: 'LATAM',
  IB: 'Iberia', BA: 'British Airways', AF: 'Air France', KL: 'KLM', LH: 'Lufthansa',
  LX: 'Swiss', OS: 'Austrian', SN: 'Brussels', AZ: 'ITA Airways', TP: 'TAP', UX: 'Air Europa',
  VY: 'Vueling', FR: 'Ryanair', U2: 'easyJet', EI: 'Aer Lingus', FI: 'Icelandair',
  SK: 'SAS', AY: 'Finnair', DY: 'Norwegian', TK: 'Turkish', EK: 'Emirates', QR: 'Qatar',
  EY: 'Etihad', QF: 'Qantas', NZ: 'Air New Zealand', SQ: 'Singapore', CX: 'Cathay Pacific',
  JL: 'Japan Airlines', NH: 'ANA', KE: 'Korean Air', OZ: 'Asiana', AI: 'Air India',
  ET: 'Ethiopian', MS: 'EgyptAir', SA: 'South African', LY: 'El Al', VS: 'Virgin Atlantic',
  WY: 'Oman Air', BW: 'Caribbean Airlines', PR: 'Philippine', CI: 'China Airlines',
  CA: 'Air China', MU: 'China Eastern', CZ: 'China Southern', TG: 'Thai', MH: 'Malaysia',
  GA: 'Garuda', VN: 'Vietnam Airlines', AR: 'Aerolineas Argentinas', AT: 'Royal Air Maroc',
};

const KIND_LABEL = { flight: 'flight', hotel: 'hotel', train: 'train', tour: 'tour or activity',
  transfer: 'transfer', car: 'car hire' };

// ---------------------------------------------------------------- text ---

/** One line of text, with the separators PDFs use made into plain spaces. */
function prep(text) {
  return String(text || '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- dates ---

function real(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const monthNo = (s) => MON_KEYS.indexOf(String(s).slice(0, 3).toLowerCase()) + 1;

/**
 * The year a day and month without one most likely belong to: the one that puts
 * it nearest the trip. A sailing in January booked in November is next year's, and
 * a flight "Nov 5" on a trip that starts Nov 4 is this year's.
 */
function yearFor(month, day, ref) {
  const anchor = ref ? Date.parse(`${ref}T00:00:00Z`) : Date.now();
  const ry = new Date(anchor).getUTCFullYear();
  let best = '';
  let gap = Infinity;
  for (const y of [ry - 1, ry, ry + 1]) {
    const iso = real(y, month, day);
    if (!iso) continue;
    const d = Math.abs(Date.parse(`${iso}T00:00:00Z`) - anchor);
    if (d < gap) { gap = d; best = iso; }
  }
  return best;
}

/** Every date in the text, in the order they appear, each with where. */
export function findDates(t, ref) {
  const found = [];
  const taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  const add = (iso, at, end) => {
    if (!iso || !free(at, end)) return;
    taken.push([at, end]);
    found.push({ iso, at, end });
  };

  // With a four digit year: unambiguous, and first so the shorter shapes below
  // cannot claim half of one.
  for (const m of t.matchAll(new RegExp(DATE_SOURCE, 'gi'))) {
    add(parseDate(m[1]), m.index, m.index + m[0].length);
  }
  // 05NOV26 and 05NOV, the way an airline writes one.
  for (const m of t.matchAll(/\b(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})?\b/g)) {
    const iso = m[3] ? real(2000 + Number(m[3]), monthNo(m[2]), Number(m[1]))
      : yearFor(monthNo(m[2]), Number(m[1]), ref);
    add(iso, m.index, m.index + m[0].length);
  }
  // "Thu, Nov 5" and "Nov 5": no year written, so it is worked out.
  for (const m of t.matchAll(new RegExp(`\\b(?:${DOW}\\s+)?(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*[:,]?\\s*\\d)`, 'gi'))) {
    add(yearFor(monthNo(m[1]), Number(m[2]), ref), m.index, m.index + m[0].length);
  }
  // "5 Nov" and "Fri 6 November".
  for (const m of t.matchAll(new RegExp(`\\b(?:${DOW}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})\\b(?!\\s*,?\\s*\\d{4})`, 'gi'))) {
    add(yearFor(monthNo(m[2]), Number(m[1]), ref), m.index, m.index + m[0].length);
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Every time, as HH:MM, in the order they appear. No am or pm is the 24 hour clock. */
export function findTimes(t) {
  const out = [];
  const re = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])\.?[Mm]?\.?(?![A-Za-z])|\b(\d{1,2}):(\d{2})(?![\d:])|\b(\d{1,2})\s*([AaPp])\.?[Mm]\.?(?![A-Za-z])/g;
  for (const m of t.matchAll(re)) {
    let h;
    let min;
    let ap = '';
    if (m[1] !== undefined) { h = Number(m[1]); min = m[2]; ap = m[3]; }
    else if (m[4] !== undefined) { h = Number(m[4]); min = m[5]; }
    else { h = Number(m[6]); min = '00'; ap = m[7]; }
    if (Number(min) > 59) continue;
    if (ap) {
      if (h < 1 || h > 12) continue;
      const pm = ap.toLowerCase() === 'p';
      h = (h % 12) + (pm ? 12 : 0);
    } else if (h > 23) continue;
    out.push({ hhmm: `${String(h).padStart(2, '0')}:${min}`, at: m.index, end: m.index + m[0].length, ampm: Boolean(ap) });
  }
  return out;
}

// --------------------------------------------------------------- labels ---

const STOP = 'Address|Phone|Tel|Telephone|Check[- ]?in|Check[- ]?out|Confirmation|Reservation|Booking'
  + '|Itinerary|Room|Guests?|Email|Date|Time|Total|Price|Status|Cancellation|Meeting|Pick[- ]?up'
  + '|Participants?|Travell?ers?|Passengers?|Seat|Terminal|Departs?|Arrives?|Duration|Duration';

/** The text after a label, cut at the next label or a separator. */
function labelled(t, labels, { max = 90 } = {}) {
  const m = t.match(new RegExp(`(?:${labels})\\s*:\\s*(.{2,${max}}?)(?=\\s+(?:${STOP})\\b|\\s+[\u00b7|]\\s|\\s+\\(|$)`, 'i'));
  return m ? m[1].trim().replace(/[.,;]+$/, '') : '';
}

const REF_LABELS = [
  'confirmation\\s*(?:number|code|no\\.?|#)?', 'booking\\s*(?:reference|ref\\.?|number|code|id|no\\.?|#)',
  'record\\s*locator', 'reservation\\s*(?:number|code|id|no\\.?|#)?', 'itinerary\\s*(?:number|no\\.?|#)',
  'order\\s*(?:number|no\\.?|#)', 'localizador', 'PNR', 'reference(?:\\s*(?:number|code))?', 'locator',
];
const REF_WORDS = new Set(['NUMBER', 'CONFIRMATION', 'RESERVATION', 'BOOKING', 'REFERENCE', 'DETAILS', 'CODE']);

/** The reference a confirmation is known by: the first one a label puts next to a code. */
export function findReference(t) {
  for (const label of REF_LABELS) {
    for (const m of t.matchAll(new RegExp(`(?:^|[^A-Za-z])${label}\\s*(?:\\(\\w+\\))?\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{4,19})(?![A-Za-z0-9-])`, 'gi'))) {
      const v = m[1];
      // Only a code: capitals and digits. A lower case word after "reservation"
      // is a sentence, and this label is followed by sentences more often than codes.
      if (v !== v.toUpperCase() || REF_WORDS.has(v)) continue;
      if (!/\d/.test(v) && v.length > 8) continue;
      return v;
    }
  }
  return '';
}

// ----------------------------------------------------------------- kinds ---

function scoreKinds(t) {
  const n = (re) => (t.match(re) || []).length;
  const flightNo = [...t.matchAll(/\b([A-Z][A-Z0-9])\s?(\d{1,4})\b/g)].filter((m) => AIRLINES[m[1]]).length;
  return {
    flight: (flightNo ? 2 : 0) + n(/\b(flight|e-?ticket|boarding|airline|airport|record locator|baggage)\b/gi)
      + n(/\(([A-Z]{3})\)/g),
    hotel: (/check[- ]?in/i.test(t) ? 2 : 0) + (/check[- ]?out/i.test(t) ? 2 : 0)
      + n(/\b(hotel|resort|room|nights?|guests?|breakfast|property)\b/gi),
    train: n(/\b(train|rail|railway|renfe|amtrak|eurostar|trenitalia|sncf|coach|platform|station|ave|alvia|tgv)\b/gi),
    tour: n(/\b(tour|excursion|activity|experience|voucher|meeting point|participants?|getyourguide|viator|ticket)\b/gi),
    transfer: n(/\b(transfer|pick-?up|drop-?off|driver|shuttle|chauffeur)\b/gi),
    car: n(/\b(car rental|rental car|pick-?up location|drop-?off location|hertz|avis|enterprise|sixt)\b/gi),
  };
}

/** The kind the text is most about, and how sure: nothing under three signals. */
export function classify(t) {
  const s = scoreKinds(t);
  // A hotel booking mentions flights and tours as things it is not, and a flight
  // mentions hotels. The one with a check in and a check out is a hotel; a flight
  // number and two airports is a flight; the rest go by weight.
  const ranked = Object.entries(s).sort((a, b) => b[1] - a[1]);
  const [kind, score] = ranked[0];
  if (score < 3) return { kind: 'unknown', score };
  if (s.hotel >= 6 && /check[- ]?in/i.test(t) && /check[- ]?out/i.test(t) && s.flight < s.hotel + 3) {
    return { kind: 'hotel', score: s.hotel };
  }
  return { kind, score };
}

// -------------------------------------------------------------- readers ---

const nearest = (list, at, back, ahead) => list.find((x) => x.at >= at - back && x.at <= at + ahead);

/** 2026-11-06 as "Nov 6". */
function shortDay(iso) {
  const m = String(iso).match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[1]) - 1]} ${Number(m[2])}` : iso;
}

/** "18:30" as a person says it. */
function say12(hhmm) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * Which of the times after a place is the departure and which the arrival.
 *
 * A label right beside the time settles it ("Depart: 10:15", "Arrives 4:00 PM"),
 * which is how a ticket prints it and how a sentence reads. Without labels the
 * order does: the first is when it leaves and the second is when it gets there.
 */
function legTimes(win, at, times) {
  const here = times.filter((x) => x.at >= at && x.at <= at + win.length);
  const tagged = (x) => {
    const before = win.slice(Math.max(0, x.at - at - 28), x.at - at);
    if (/(?:depart\w*|leav\w*|dep)[\s:.-]*(?:\w+ ){0,3}$/i.test(before) && !/arriv|land/i.test(before.slice(-14))) return 'dep';
    if (/(?:arriv\w*|land\w*|arr)[\s:.-]*(?:\w+ ){0,3}$/i.test(before)) return 'arr';
    return '';
  };
  const dep = here.find((x) => tagged(x) === 'dep') || here.find((x) => !tagged(x)) || here[0];
  const arr = here.find((x) => tagged(x) === 'arr')
    || here.find((x) => x !== dep && tagged(x) !== 'dep');
  return { dep, arr };
}

function readFlights(t, dates, times, ref, reference, warnings) {
  const best = new Map();
  for (const m of t.matchAll(/\b([A-Z][A-Z0-9])\s?(\d{1,4})\b/g)) {
    const code = m[1];
    if (!AIRLINES[code]) continue;
    const flight = `${code} ${m[2]}`;
    const at = m.index;
    const win = t.slice(at, at + 430);
    if (!/\b(depart|arriv|terminal|gate|boarding|seat|flight|lands?|from|to)\b/i.test(win)) continue;

    // Airports: in brackets, or the pair either side of a dash or "to"; and two
    // different ones, because "(MCO) ... MCO Terminal C" is one airport twice.
    let ports = [...new Set([...win.matchAll(/\(([A-Z]{3})\)/g)].map((x) => x[1]))];
    if (ports.length < 2) {
      const pair = win.match(/\b([A-Z]{3})\s*(?:-|to|>|\u2192)\s*([A-Z]{3})\b/);
      if (pair && pair[1] !== pair[2]) ports = [pair[1], pair[2]];
    }

    const { dep, arr } = legTimes(win, at, times);
    if (!dep) continue;
    // The date the flight leaves: the first one written after the flight number
    // and before its departure time, else the last one before the number.
    const onLeg = dates.filter((d) => d.at >= at && d.at <= dep.at);
    const before = dates.filter((d) => d.at < at && d.at >= at - 170);
    const day = onLeg[0] || before[before.length - 1] || dates.find((d) => d.at >= dep.at && d.at <= dep.at + 40);
    if (!day) continue;
    // A date written between the two times is the arrival's.
    const arrDay = arr ? dates.find((d) => d.at > dep.at && d.at <= arr.at + 40 && d.iso !== day.iso) : null;

    const term = win.match(/\bTerminal\s+([A-Z0-9]{1,3})\b/i);
    const seat = win.match(/\bSeats?\s*:?\s*(\d{1,2}[A-K])\b/);
    const score = (ports.length >= 2 ? 2 : 0) + (arr ? 2 : 0) + (term ? 1 : 0) + (seat ? 1 : 0);
    const cand = { flight, code, at, score, day, dep, arr, arrDay, ports, term, seat };
    const held = best.get(flight);
    if (!held || cand.score > held.score) best.set(flight, cand);
  }

  const items = [];
  for (const c of [...best.values()].sort((a, b) => a.at - b.at)) {
    const sameDay = !c.arrDay && c.arr && c.arr.hhmm > c.dep.hhmm;
    const bits = [];
    if (c.arr && !sameDay) bits.push(`Arrives ${say12(c.arr.hhmm)}${c.arrDay ? ` on ${shortDay(c.arrDay.iso)}` : ' the next day'}`);
    if (c.seat) bits.push(`Seat ${c.seat[1]}`);
    if (!c.dep.ampm) warnings.push(`The time for ${c.flight} has no am or pm, so it was read as a 24 hour time (${c.dep.hhmm}). Check it.`);
    items.push({
      date: c.day.iso,
      startTime: c.dep.hhmm,
      endTime: sameDay ? c.arr.hhmm : '',
      kind: 'flight',
      title: `${AIRLINES[c.code]} ${c.flight}${c.ports.length >= 2 ? `, ${c.ports[0]} to ${c.ports[1]}` : ''}`,
      location: c.ports[0] ? `${c.ports[0]}${c.term ? ` Terminal ${c.term[1]}` : ''}` : '',
      detail: bits.join('. '),
      confirmation: reference,
    });
  }
  return items;
}

function readHotel(t, dates, times, ref, reference, warnings, fields) {
  const inAt = t.search(/check[- ]?in/i);
  const outAt = t.search(/check[- ]?out/i);
  const dateAfter = (at) => (at < 0 ? null : dates.find((d) => d.at >= at && d.at <= at + 120));
  const timeAfter = (at) => (at < 0 ? null : times.find((x) => x.at >= at && x.at <= at + 90));
  const din = dateAfter(inAt);
  const dout = dateAfter(outAt);
  if (!din) return [];

  let name = labelled(t, 'hotel(?:\\s*name)?|property(?:\\s*name)?|accommodation');
  if (!name) {
    const W = "[A-Z][\\w&'\u2019.-]*";
    const before = inAt > 0 ? t.slice(0, inAt) : t;
    // "UMusic Hotel Madrid" (the word in the middle or at the end), or "Hotel Arts
    // Barcelona" and "Parador de Antequera" (the word first).
    const m = before.match(new RegExp(`(${W}(?:\\s+[A-Z&][\\w&'\u2019.-]*){0,4}\\s+(?:Hotel|Resort|Inn|Suites|Lodge|Hostel|Villas?|Palace|B&B)(?:\\s+${W})?)`))
      || before.match(new RegExp(`((?:Hotel|Hostal|Hostel|Parador|Resort|Villa|Palacio)\\s+(?:(?:de|del|la|el|of|the|&)\\s+)?${W}(?:\\s+${W}){0,2})`));
    name = m ? m[1].trim() : '';
  }
  name = titleCase(name);
  const address = labelled(t, 'address', { max: 120 });
  const tin = timeAfter(inAt);
  const tout = timeAfter(outAt);
  if (tin && !tin.ampm) warnings.push(`The check in time has no am or pm, so it was read as a 24 hour time (${tin.hhmm}). Check it.`);

  fields.productName = name || '';
  fields.supplier = fields.supplier || '';
  fields.departDate = din.iso;
  if (dout) fields.returnDate = dout.iso;
  const items = [{
    date: din.iso, startTime: tin ? tin.hhmm : '', endTime: '', kind: 'hotel',
    title: name ? `Check in: ${name}` : 'Hotel check in', location: address, detail: '', confirmation: reference,
  }];
  if (dout) {
    items.push({
      date: dout.iso, startTime: tout ? tout.hhmm : '', endTime: '', kind: 'hotel',
      title: name ? `Check out: ${name}` : 'Hotel check out', location: address, detail: '', confirmation: '',
    });
  }
  return items;
}

function readTrain(t, dates, times, ref, reference, warnings, fields) {
  const num = t.match(/\b(AVE|ALVIA|AVLO|AV City|TGV|ICE|Acela|Eurostar|Amtrak|Regional|Intercity|Thalys|Frecciarossa|Italo)\s*(?:train\s*)?(?:no\.?\s*)?(\d{2,6})\b/i)
    || t.match(/\btrain\s*(?:no\.?|number|#)?\s*:?\s*([A-Z]{0,4}\s?\d{2,6})\b/i);
  if (!num) return [];
  const label = num[2] ? `${num[1]} ${num[2]}` : num[1];
  const at = num.index;
  const day = nearest(dates, at, 200, 400);
  const { dep, arr } = legTimes(t.slice(at, at + 400), at, times);
  if (!day || !dep) return [];

  const route = t.match(/\b[Ff]rom\s+([A-Z][\w .'-]{2,40}?)\s+to\s+([A-Z][\w .'-]{2,40}?)(?=\s+(?:Depart\w*|Arriv\w*|Coach|Seat|Date|Passenger|on|at)\b|[.,;]|\s*$)/);
  fields.productName = `Train ${label}`;
  if (!dep.ampm) warnings.push(`The departure time has no am or pm, so it was read as a 24 hour time (${dep.hhmm}). Check it.`);
  return [{
    date: day.iso, startTime: dep.hhmm, endTime: arr && arr.hhmm > dep.hhmm ? arr.hhmm : '', kind: 'transfer',
    title: `Train ${label}${route ? `: ${route[1]} to ${route[2]}` : ''}`, location: route ? route[1] : '',
    detail: (t.match(/\bCoach\s*(\d+)\b/i) ? `Coach ${t.match(/\bCoach\s*(\d+)\b/i)[1]}` : '')
      + (t.match(/\bSeat\s*:?\s*(\d{1,2}[A-K])\b/i) ? `${t.match(/\bCoach\s*(\d+)\b/i) ? ', ' : ''}seat ${t.match(/\bSeat\s*:?\s*(\d{1,2}[A-K])\b/i)[1]}` : ''),
    confirmation: reference,
  }];
}

function readTour(t, dates, times, ref, reference, warnings, fields, kind) {
  let title = labelled(t, 'activity|tour|experience|excursion|product|ticket', { max: 110 });
  if (!title) {
    const m = t.match(/\b([A-Z][a-z][\w&'\u2019-]*(?:\s+(?:&|and|of|the|with|[A-Z][\w&'\u2019-]+)){0,9}\s+(?:Tour|Tasting|Excursion|Experience|Tickets?|Class|Walk|Transfer|Cruise))\b/);
    title = m ? m[1] : '';
  }
  title = titleCase(title);
  const dlabel = t.search(/\b(date|when|tour date|activity date|travel date|pick-?up)\b\s*:?/i);
  const day = (dlabel >= 0 ? dates.find((d) => d.at >= dlabel && d.at <= dlabel + 100) : null) || dates[0];
  if (!day) return [];
  const tlabel = t.search(/\b(start(?:ing)? time|time|meeting time|pick-?up time|departure time)\b\s*:?/i);
  const at = tlabel >= 0 ? times.find((x) => x.at >= tlabel && x.at <= tlabel + 60) : times.find((x) => x.at >= day.at && x.at <= day.at + 80);
  const meet = labelled(t, 'meeting point|meet at|meet(?:ing)? location|pick-?up(?:\\s+(?:point|location))?(?!\\s*(?:date|time))', { max: 140 });
  if (at && !at.ampm) warnings.push(`The start time has no am or pm, so it was read as a 24 hour time (${at.hhmm}). Check it.`);
  fields.productName = title;
  return [{
    date: day.iso, startTime: at ? at.hhmm : '', endTime: '', kind: kind === 'transfer' ? 'transfer' : 'activity',
    title: title || (kind === 'transfer' ? 'Transfer' : 'Tour'), location: meet, detail: '', confirmation: reference,
  }];
}

// ---------------------------------------------------------------- entry ---

/**
 * What a confirmation holds, as itinerary lines and reservation facts.
 *
 * ctx.depart and ctx.ret are the reservation's own dates, used only to decide which
 * year a date written without one belongs to.
 */
export function readConfirmationLines(rawText, ctx = {}) {
  const t = prep(rawText);
  const out = { read: false, kind: 'unknown', kindLabel: '', fields: {}, items: [], warnings: [], missing: [] };
  if (t.length < 40) return out;

  const ref = ctx.depart || ctx.ret || '';
  const dates = findDates(t, ref);
  const times = findTimes(t);
  const reference = findReference(t);
  const { kind } = classify(t);
  const fields = {};
  if (reference) fields.confirmationNumber = reference;

  let items = [];
  if (kind === 'flight') items = readFlights(t, dates, times, ref, reference, out.warnings);
  else if (kind === 'hotel') items = readHotel(t, dates, times, ref, reference, out.warnings, fields);
  else if (kind === 'train') items = readTrain(t, dates, times, ref, reference, out.warnings, fields);
  else if (kind === 'tour' || kind === 'transfer') items = readTour(t, dates, times, ref, reference, out.warnings, fields, kind);

  if (kind === 'flight' && items.length) {
    fields.supplier = items[0].title.replace(/ [A-Z][A-Z0-9] \d.*$/, '');
    fields.departDate = items[0].date;
    if (items.length > 1) fields.returnDate = items[items.length - 1].date;
    fields.productName = 'Flights';
    const first = items[0].title.match(/([A-Z]{3}) to ([A-Z]{3})/);
    const last = items[items.length - 1].title.match(/([A-Z]{3}) to ([A-Z]{3})/);
    if (first && last) fields.productName = first[1] === last[2] && items.length > 1
      ? `Flights ${first[1]} to ${first[2]} and back` : `Flights ${first[1]} to ${last[2]}`;
  }
  if ((kind === 'tour' || kind === 'transfer' || kind === 'train') && items.length) fields.departDate = items[0].date;

  // Items sorted by when they happen; a line with no date never gets this far.
  items.sort((a, b) => (a.date + (a.startTime || '99:99')).localeCompare(b.date + (b.startTime || '99:99')));

  const productType = { flight: 'air', hotel: 'hotel', train: 'rail', tour: 'tour', transfer: 'transfer', car: 'car' }[kind];
  if (productType && items.length) fields.productType = productType;

  out.kind = items.length ? kind : 'unknown';
  out.kindLabel = KIND_LABEL[kind] || '';
  out.fields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
  out.items = items;
  out.read = items.length > 0;
  if (!items.length && reference) out.fields = { confirmationNumber: reference };
  if (!reference) out.missing.push('confirmation number');
  if (items.length && items.every((i) => !i.startTime)) out.missing.push('times');
  return out;
}
