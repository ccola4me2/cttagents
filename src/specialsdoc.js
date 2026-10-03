// Reading a weekly supplier specials list out of a Word document.
//
// The list arrives as a .docx: a title, a few lines of overview, then one table
// per kind of supplier (cruise lines, tours, hotels) with a row per offer, and a
// recap at the bottom that repeats the ones about to end. Nothing here talks to
// the database, so the whole of it can be run against the real file offline.
//
// What it will not do is guess. A deadline it cannot read stays blank and the
// row is flagged, because an offer shown as running when it ended on Friday is
// worse than one shown with no date.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '(?:,?\\s+(\\d{4}))?';
const DATE = `\\b${MON}\\s+${DAY}${YEAR}`;

const MAX_INFLATED = 24 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The zip around the document
// ---------------------------------------------------------------------------

async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    // A file that claims to be a page of tables and inflates to a gigabyte is
    // not one, and a Worker that obliges finds out the expensive way.
    if (total > MAX_INFLATED) throw new Error('too big');
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** One named file out of a zip, or null when it is not there. */
export async function zipEntry(input, wanted) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (name === wanted) {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The document's text, with its structure
// ---------------------------------------------------------------------------

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function textOf(xml) {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
    out += m[1] === undefined ? ' ' : m[1];
  }
  return unescapeXml(out).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The document as a list of blocks: headings and paragraphs in order, and each
 * table as rows of cell text. Order is what matters, because the heading above
 * a table is what says which kind of supplier it holds.
 */
export function blocksFromXml(xml) {
  const blocks = [];
  for (const m of String(xml).matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const chunk = m[0];
    if (chunk.startsWith('<w:tbl>')) {
      const rows = [];
      for (const r of chunk.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
        rows.push([...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => textOf(c[0])));
      }
      blocks.push({ table: rows });
    } else {
      const style = chunk.match(/<w:pStyle w:val="([^"]+)"/);
      const text = textOf(chunk);
      if (text) blocks.push({ style: style ? style[1] : '', text });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

function validDay(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * A month and day with no year, placed in the year that makes sense for a
 * list issued on `anchor`: this year, unless that would be well in the past.
 */
function placed(m, d, y, anchor) {
  const issued = anchor || new Date().toISOString().slice(0, 10);
  let year = y || Number(issued.slice(0, 4));
  if (!y) {
    const guess = `${year}-${pad(m)}-${pad(d)}`;
    const gap = (Date.parse(`${issued}T00:00:00Z`) - Date.parse(`${guess}T00:00:00Z`)) / 86400000;
    if (gap > 120) year += 1;
  }
  return validDay(year, m, d) ? `${year}-${pad(m)}-${pad(d)}` : null;
}

function monthNo(word) {
  return MONTHS[String(word).slice(0, 3).toLowerCase()];
}

/**
 * When an offer starts and stops, from the words a supplier used for it.
 *
 * Brackets are dropped first: they carry the travel dates ("travel through
 * 2028"), which are not the booking window and would read as a deadline.
 * Several windows in one cell, separated by semicolons, are different offers
 * sharing a row, so the latest end is used and the row says it was a judgement.
 */
export function windowDates(text, issued) {
  const base = String(text || '').replace(/\([^)]*\)/g, ' ');
  let starts = null;
  let ends = null;
  let found = 0;

  const range = new RegExp(`${DATE}\\s+(?:to|through|thru|until|-)\\s+(?:${DATE}|${DAY}\\b)`, 'i');
  const single = new RegExp(DATE, 'i');

  for (const part of base.split(';')) {
    const r = part.match(range);
    if (r) {
      const m1 = monthNo(r[1]);
      let a;
      let b;
      if (r[4]) {
        // "Sep 22 to Nov 5, 2026": the first date borrows the year if it was left off.
        const y2 = r[6] ? Number(r[6]) : null;
        b = placed(monthNo(r[4]), Number(r[5]), y2, issued);
        a = placed(m1, Number(r[2]), r[3] ? Number(r[3]) : null, issued);
        if (!r[3] && b && a && a > b) a = placed(m1, Number(r[2]), Number(b.slice(0, 4)) - 1, issued);
      } else {
        // "Oct 1 to 5": the second is a day of the same month.
        a = placed(m1, Number(r[2]), r[3] ? Number(r[3]) : null, issued);
        b = a ? placed(m1, Number(r[7]), Number(a.slice(0, 4)), issued) : null;
      }
      if (a && b) {
        found += 1;
        if (!starts || a < starts) starts = a;
        if (!ends || b > ends) ends = b;
        continue;
      }
    }

    const s = part.match(single);
    if (!s) continue;
    const at = placed(monthNo(s[1]), Number(s[2]), s[3] ? Number(s[3]) : null, issued);
    if (!at) continue;
    found += 1;
    const before = part.slice(0, s.index).toLowerCase();
    if (/\b(launched|started|starts?|begins?|began|opens?|opened|from)\s*$/.test(before)) {
      if (!starts || at < starts) starts = at;
    } else if (!ends || at > ends) {
      ends = at;
    }
  }

  return { startsOn: starts, endsOn: ends, several: found > 1 && base.includes(';') };
}

// ---------------------------------------------------------------------------
// One row of the table
// ---------------------------------------------------------------------------

const NOT_CODES = new Set(['TLN', 'OBC', 'VISA', 'NCL', 'USA', 'VAX', 'NYC', 'MSG', 'BOGO']);

/**
 * The promotion code, when the notes name one.
 *
 * Only the notes, and not after "with" or "and": "Combinable with BOGO60" is
 * another offer's code mentioned in passing, and crediting it to this row would
 * put the wrong code in front of somebody about to quote it.
 */
export function codeFrom(offer, notes) {
  const n = String(notes || '');
  const said = n.match(/\b[Cc]ode\s+([A-Z0-9][A-Z0-9-]{2,})\b/);
  if (said) return said[1];

  // A whole cell that is one capitalised word is a code ("FLATOFF"). Inside a
  // sentence a capitalised word is only a code when it has a digit or a hyphen,
  // which is what keeps "Book through Internova SELECT" from being one.
  if (/^[A-Z][A-Z0-9-]{3,}$/.test(n.trim()) && !NOT_CODES.has(n.trim())) return n.trim();

  for (const m of n.matchAll(/\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*\b/g)) {
    if (NOT_CODES.has(m[0])) continue;
    if (/\b(with|and|plus|or)\s+$/i.test(n.slice(0, m.index))) continue;
    if (!/[\d-]/.test(m[0])) continue;
    return m[0];
  }

  // A code that leads the offer itself: "BOGO60 (60% off second guest)..."
  const lead = String(offer || '').match(/^([A-Z]{2,}[0-9]{1,}[A-Z0-9]*)\b/);
  return lead ? lead[1] : null;
}

/** "Hilton (Waldorf Astoria, Conrad)" is the brand Hilton with a programme. */
export function splitBrand(cell) {
  const s = String(cell || '').trim();
  const m = s.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  return m && m[1] ? { brand: m[1].trim(), program: m[2].trim() } : { brand: s, program: '' };
}

/** The shelf a heading names. Unknown headings keep their own words. */
export function categoryFrom(heading) {
  const h = String(heading || '').toLowerCase();
  if (/cruise|river|expedition|yacht/.test(h)) return 'Cruise lines';
  if (/tour|land|rail|escort/.test(h)) return 'Tours and land';
  if (/hotel|resort|villa|all.inclusive/.test(h)) return 'Hotels and resorts';
  return String(heading || '').trim().slice(0, 60) || 'Other';
}

/** Case and punctuation blind, for telling whether two rows are one offer. */
export function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** What makes a row the same offer next week: the brand, its programme, and the offer's words. */
export function matchKey(brand, program, offer) {
  return `${norm(brand)}|${norm(program)}|${norm(offer)}`.slice(0, 400);
}

function columns(header) {
  const find = (re) => header.findIndex((h) => re.test(h));
  return {
    brand: find(/^(brand|vendor|supplier|company)/i),
    offer: find(/^(offer|special|promo|deal)/i),
    window: find(/(book by|window|dates?|valid|ends?\b|expires?)/i),
    notes: find(/(code|notes?|details?)/i),
  };
}

/**
 * Everything a document says, as rows.
 *
 * `skipped` names what was left out and why, so the person uploading can see
 * the recap table was recognised and not simply missed.
 */
export function readSpecialsBlocks(blocks) {
  const out = { title: '', issuedOn: null, intro: '', rows: [], skipped: [] };

  let h2 = '';
  let h3 = '';
  let afterOverview = false;

  const first = blocks.find((b) => b.style === 'Heading1' || b.style === 'Title');
  if (first) out.title = first.text.slice(0, 160);

  for (const b of blocks) {
    if (!b.table) {
      if (b.style === 'Heading2') { h2 = b.text; h3 = ''; afterOverview = /overview|summary/i.test(b.text); continue; }
      if (b.style === 'Heading3') { h3 = b.text; continue; }
      if (!out.issuedOn && !b.style) {
        const d = b.text.match(new RegExp(DATE, 'i'));
        if (d) out.issuedOn = placed(monthNo(d[1]), Number(d[2]), d[3] ? Number(d[3]) : null, null);
      }
      if (afterOverview && !b.style && !out.intro) out.intro = b.text.slice(0, 1200);
      continue;
    }

    const [header, ...body] = b.table;
    if (!header) continue;
    const col = columns(header);
    if (col.brand < 0 || col.offer < 0) {
      out.skipped.push({ label: h3 || h2 || 'A table', count: body.length, why: 'no Brand and Offer columns' });
      continue;
    }
    // The recap of what ends soon repeats rows already listed above it, and
    // adding it would put every one in twice.
    if (/expiring|ending soon|ends soon/i.test(h2) || /^ends?$/i.test(header[0] || '')) {
      out.skipped.push({ label: h2 || 'Recap', count: body.length, why: 'repeats the offers above, so it was left out' });
      continue;
    }

    const category = categoryFrom(h3 || h2);
    for (const cells of body) {
      const brandCell = (cells[col.brand] || '').trim();
      const offer = (cells[col.offer] || '').trim();
      if (!brandCell || !offer) continue;
      const windowText = col.window >= 0 ? (cells[col.window] || '').trim() : '';
      const notes = col.notes >= 0 ? (cells[col.notes] || '').trim() : '';
      const { brand, program } = splitBrand(brandCell);
      const dates = windowDates(windowText, out.issuedOn);
      out.rows.push({
        category,
        brand,
        program,
        offer,
        windowText,
        startsOn: dates.startsOn,
        endsOn: dates.endsOn,
        datesNote: !windowText ? 'none' : (dates.several ? 'several' : (!dates.startsOn && !dates.endsOn ? 'unread' : '')),
        code: codeFrom(offer, notes),
        notes,
      });
    }
  }
  return out;
}

/** A .docx, as the bytes that arrived. */
export async function readSpecialsDocx(buffer) {
  const xmlBytes = await zipEntry(buffer, 'word/document.xml');
  if (!xmlBytes) return null;
  return readSpecialsBlocks(blocksFromXml(new TextDecoder().decode(xmlBytes)));
}
