// What every group proposal reader needs, whichever cruise line wrote the page.
//
// Kept apart from the readers so a new cruise line is one more small module and
// one line in the registry, and nothing here has to change.

/**
 * The document text, tidied into something patterns can be written against.
 *
 * A PDF is drawn rather than written, and three artefacts of that get in the
 * way of every label: dates arrive as "2027 - 10 - 22" because the hyphen is
 * kerned, "7 - Night" loses its hyphen's neighbours the same way, and a
 * capital can be a different glyph from the letters after it, so "Amenities"
 * comes out as "A menities". None of it is what a reader sees.
 */
export function tidy(text) {
  let t = String(text || '').replace(/ /g, ' ').replace(/ en-US/g, ' ');
  t = t.replace(/(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})/g, '$1-$2-$3');
  t = t.replace(/(\d)\s+-\s+([A-Za-z])/g, '$1-$2');
  t = t.replace(/\bA\s+menities\b/g, 'Amenities');
  return t.replace(/\s+/g, ' ').trim();
}

/** The text after a label, to the first thing that could be the next one. */
export const after = (t, label, pattern) => {
  const m = t.match(new RegExp(`${label}\\s*:?\\s*${pattern}`));
  return m ? m[1].trim() : '';
};

export const money = (s) => {
  const n = Number(String(s || '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export const toCents = (n) => Math.round(Number(n) * 100);

export const dollars = (cents) =>
  `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

// ---------------------------------------------------------------- dates ---
const MONTH_NAMES = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?'
  + '|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The shapes a date is written in, as one pattern with one capture.
 *
 * Four-digit years only. "10/22/27" is 2027 to a person and 1927 to a parser
 * that has to guess, and a wrong century on the day cabins are released is the
 * kind of mistake that does not look like one.
 */
export const DATE_SOURCE = '('
  + '\\d{4}-\\d{1,2}-\\d{1,2}'
  + '|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}'
  + `|(?:${MONTH_NAMES})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`
  + `|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_NAMES})\\.?,?\\s+\\d{4}`
  + ')';

function real(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return '';
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * One written date as YYYY-MM-DD, or nothing.
 *
 * 10/11/2027 is ambiguous and is read the American way, month first, because
 * that is who is uploading it. A first number above twelve can only be a day,
 * so that one is read the other way round rather than refused.
 */
export function parseDate(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return real(Number(m[1]), Number(m[2]), Number(m[3]));

  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 12 ? real(Number(m[3]), b, a) : real(Number(m[3]), a, b);
  }

  m = s.match(new RegExp(`^(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$`, 'i'));
  if (m) return real(Number(m[3]), MONTH_KEYS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]));

  m = s.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?,?\\s+(\\d{4})$`, 'i'));
  if (m) return real(Number(m[3]), MONTH_KEYS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1]));

  return '';
}
