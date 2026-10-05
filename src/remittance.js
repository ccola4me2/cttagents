// Reading a vendor's payment remittance, the page that comes with a commission check.
//
// What a vendor sends is a list of what they are paying for and a total. This reads
// the Travel Leaders Network one, which is the one the agency receives today, and
// is shaped so another vendor's can be added beside it: every vendor's page ends
// up as the same few things (a check number, a date, a total, and lines each with
// a traveller, a reference and an amount), and everything after this module works
// with those and not with any vendor's layout.
//
// Like the confirmation reader it reads what is labelled and says so when it has
// not understood, rather than guessing: a commission recorded against the wrong
// person's trip is paid to the wrong advisor.

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_NO = Object.fromEntries(MONTHS.split('|').map((m, i) => [m.toLowerCase(), i + 1]));

const pad = (n) => String(n).padStart(2, '0');

/** "1,234.50", "-12.50" and "(12.50)" as cents. */
export function centsFrom(text) {
  const s = String(text ?? '').trim();
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

function usDate(text) {
  const m = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null;
}

function longDate(text) {
  const m = String(text || '').match(new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2}),\\s+(\\d{4})`, 'i'));
  return m ? `${m[3]}-${pad(MONTH_NO[m[1].toLowerCase()])}-${pad(m[2])}` : null;
}

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * One line of the remittance.
 *
 * The traveller is written the way a ticket writes a name, SURNAME/FIRST with an
 * optional title, and comes last; the record locator sits between underscores; and
 * the travel date is the one with an underscore on each side, which is how it is
 * told from the document date that ends the line.
 */
function readLine(body, docDate, amountCents) {
  const text = collapse(body);
  const docNumber = (text.match(/^(\S+)/) || [])[1] || '';
  const rest = text.slice(docNumber.length).trim();

  const traveller = rest.match(/(?:^|[_\s|])([A-Z][A-Z'.-]+)\/([A-Z][A-Z'. -]*?)(?:\s+(?:MR|MRS|MS|MISS|MSTR|DR))?$/);
  const locator = (rest.match(/_([A-Z0-9]{5,8})_/) || [])[1] || null;
  const ticket = (rest.match(/Ticket-(\d{4,})/i) || [])[1] || null;
  const travelDate = usDate((rest.match(/_(\d{1,2}\/\d{1,2}\/\d{4})_/) || [])[1]);
  const agent = (rest.match(/^([A-Za-z][A-Za-z' .-]*?)_/) || [])[1] || null;

  // What was sold, in the vendor's words, when it says. Only the ones seen so far
  // are mapped; everything else is left to the person looking at the line.
  let product = null;
  if (/airline ticket|\bARC\b/i.test(rest)) product = 'air';
  else if (/\bhotel\b|\bresort\b/i.test(rest)) product = 'hotel';
  else if (/\bcruise\b/i.test(rest)) product = 'cruise';
  else if (/\btour\b/i.test(rest)) product = 'tour';

  return {
    docNumber,
    description: rest,
    docDate,
    amountCents,
    traveller: traveller ? { last: traveller[1], first: collapse(traveller[2]) } : null,
    locator,
    ticket,
    travelDate,
    agent: agent ? collapse(agent) : null,
    product,
  };
}

/**
 * The remittance as the things a person would copy off it.
 *
 * `read` is true only when there is a check number and at least a total or a line,
 * so a page that is not a remittance at all is not offered as one.
 */
export function readRemittance(input) {
  const text = String(input || '');
  const out = {
    read: false, payer: null, checkNumber: null, vendorNo: null, remittedOn: null,
    totalCents: null, lines: [], warnings: [],
  };
  if (!/remittance/i.test(text)) return out;

  // The payer is the first line after the title.
  const after = text.split(/Payment\s+Remittance/i)[1] || '';
  out.payer = collapse(after.split('\n').map((l) => l.trim()).find(Boolean)) || null;

  out.checkNumber = (text.match(/Check\s*#\s*([0-9A-Za-z/-]+)/i) || [])[1] || null;
  out.vendorNo = (text.match(/Vendor\s*No\.?:?\s*([A-Z0-9]+)/i) || [])[1] || null;
  out.remittedOn = longDate(text.slice(0, text.search(/Doc\s*Number/i) > 0 ? text.search(/Doc\s*Number/i) : undefined));

  const totals = [...text.matchAll(/\bTotal\s+(-?\(?[\d,]+\.\d{2}\)?)/g)];
  if (totals.length) out.totalCents = centsFrom(totals[totals.length - 1][1]);

  // The table starts after the "Amount" that ends the headings and runs to Total.
  const head = text.search(/Doc\s*Number[\s\S]*?Amount/i);
  if (head >= 0) {
    const headEnd = head + text.slice(head).search(/Amount/i) + 'Amount'.length;
    const tail = text.slice(headEnd);
    const stop = tail.search(/\bTotal\s+-?\(?[\d,]+\.\d{2}/);
    const rows = stop >= 0 ? tail.slice(0, stop) : tail;

    // Every line ends with its document date and its net amount, and nothing
    // inside a line looks like that pair, so the pair is what separates them.
    const end = /(\d{2}\/\d{2}\/\d{4})\s+(-?\(?[\d,]+\.\d{2}\)?)/g;
    let from = 0;
    let m;
    while ((m = end.exec(rows))) {
      const body = rows.slice(from, m.index);
      from = m.index + m[0].length;
      if (collapse(body)) out.lines.push(readLine(body, usDate(m[1]), centsFrom(m[2])));
    }
  }

  const sum = out.lines.reduce((n, l) => n + l.amountCents, 0);
  if (out.totalCents !== null && out.lines.length && sum !== out.totalCents) {
    out.warnings.push('The lines do not add up to the total on the page, so check each one.');
  }
  if (out.totalCents === null && out.lines.length) out.totalCents = sum;

  out.read = Boolean(out.checkNumber && (out.lines.length || out.totalCents !== null));
  return out;
}

/** The names on a reservation, broken into the words a ticket would use. */
export function nameWords(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z' -]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 1);
}

/**
 * How well a reservation's names fit a ticket's SURNAME/FIRST.
 *
 * The surname has to be there; the first name raises it. A surname alone is a
 * candidate and not an answer, because two families called Smith are normal.
 */
export function nameFit(traveller, names) {
  if (!traveller) return 0;
  const words = new Set(names.flatMap(nameWords));
  const last = nameWords(traveller.last);
  if (!last.length || !last.every((w) => words.has(w))) return 0;
  const first = nameWords(traveller.first);
  return first.length && first.some((w) => words.has(w)) ? 2 : 1;
}
