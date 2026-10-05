/**
 * The weekly supplier specials list is read the way it was written.
 *
 * What goes wrong with a list like this is quiet. A deadline read from the travel
 * dates in brackets instead of the booking window, so an offer shows as running a
 * year after it ended. A promotion code taken from a sentence ("Combinable with
 * BOGO60") and credited to the wrong offer, so somebody quotes a code that does not
 * apply. The recap table at the bottom added as well as the offers it repeats, so
 * every one that is about to end is in twice. A day and month with no year put in
 * the wrong year. Each is pinned here.
 *
 * The document below is invented and shaped like Word writes one: a styled
 * heading, a table per kind of supplier, a recap. It proves the reader copes with
 * the shape, and the first real list is the proof that it copes with the real thing.
 */

import {
  blocksFromXml, readSpecialsBlocks, windowDates, codeFrom, splitBrand, categoryFrom,
  matchKey, zipEntry, readSpecialsJson, promoId,
} from '../src/specialsdoc.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::specialsdoc: ${label}: ${detail}`);
};
const is = (label, got, want) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

const ISSUED = '2026-10-02';
const win = (text, issued = ISSUED) => {
  const r = windowDates(text, issued);
  return [r.startsOn, r.endsOn];
};

// ---------------------------------------------------------------- dates ---
is('a single date is the deadline', win('Dec 31, 2026'), [null, '2026-12-31']);
is('a range inside one month', win('Oct 1 to 5'), ['2026-10-01', '2026-10-05']);
is('a range across months, with the year at the end', win('Sep 22 to Nov 5, 2026'), ['2026-09-22', '2026-11-05']);
is('travel dates in brackets are not the booking window',
  win('Sep 22 to Nov 5, 2026 (sailings to May 10, 2028)'), ['2026-09-22', '2026-11-05']);
is('a bracketed travel date alone does not become the deadline',
  win('Nov 30, 2026 (travel through 2028)'), [null, '2026-11-30']);
is('"through" is an end date', win('Through Oct 5'), [null, '2026-10-05']);
is('"through" with travel dates after it', win('Through Oct 31 (travel to Mar 31, 2027)'), [null, '2026-10-31']);
is('"launched" is a start date', win('Launched Sep 23'), ['2026-09-23', null]);
is('"started" is a start date', win('Started Oct 1'), ['2026-10-01', null]);
is('"deposited by" is an end date', win('Deposited by Nov 15, 2026'), [null, '2026-11-15']);
is('"deposited" and a range', win('Deposited Sep 23 to Oct 11'), ['2026-09-23', '2026-10-11']);
is('words with no date give no date', win('Through sailing date'), [null, null]);
is('"varies" gives no date', win('Varies'), [null, null]);
is('a year with no number gives no date', win('Winter 2027 sailings'), [null, null]);
is('several windows in one cell use the latest end', win('Oct 6; Dec 31; Dec 31'), [null, '2026-12-31']);
is('and say it was a judgement', windowDates('Oct 6; Dec 31; Dec 31', ISSUED).several, true);
is('a note in front of a window does not stop it being read', win('Last call; Latitudes Oct 1 to 31'), ['2026-10-01', '2026-10-31']);
is('a day and month with no year, late in the year, are next year',
  win('Jan 5', '2026-12-20'), [null, '2027-01-05']);
is('a range that crosses new year puts the end in the new year',
  win('Nov 30 to Jan 15', '2026-11-01'), ['2026-11-30', '2027-01-15']);
is('a day that does not exist is not a date', win('Feb 30, 2026'), [null, null]);

// ---------------------------------------------------------------- codes ---
is('a code alone in the cell', codeFrom('Weekend sale', 'FLATOFF'), 'FLATOFF');
is('a code after the word code', codeFrom('x', 'Add code TLNMAX-COM by final payment (800-626-0126)'), 'TLNMAX-COM');
is('a numeric code after the word code', codeFrom('x', 'TLN vacation code 4369'), '4369');
is('a capitalised word in a sentence is not a code', codeFrom('x', 'Book through Internova SELECT'), null);
is('a code mentioned after "with" belongs to another offer', codeFrom('x', 'Combinable with BOGO60 and Kids Sail Free'), null);
is('a code that opens the offer is its own', codeFrom('BOGO60 (60% off second guest)', 'Score More Sale also runs Oct 2 to 5'), 'BOGO60');
is('plain notes have no code', codeFrom('x', 'Reach out to past clients with unused credits'), null);
is('a short acronym is not a code', codeFrom('x', 'From VAX'), null);

// ---------------------------------------------------------------- names ---
is('a programme in brackets is split off', splitBrand('AmaWaterways (TLN AmaMAX)'), { brand: 'AmaWaterways', program: 'TLN AmaMAX' });
is('no brackets, no programme', splitBrand('Sandals'), { brand: 'Sandals', program: '' });
is('shelves from headings', [categoryFrom('Cruise lines'), categoryFrom('Tours and land'), categoryFrom('Hotels and resorts')],
  ['Cruise lines', 'Tours and land', 'Hotels and resorts']);
is('an unknown heading keeps its words', categoryFrom('Insurance partners'), 'Insurance partners');
is('the same offer next week has the same key',
  matchKey('NCL', '', 'Weekend Sale: up to $750 off!'), matchKey('ncl', '', 'weekend sale up to 750 off'));
is('a different programme is a different offer',
  matchKey('AmaWaterways', 'TLN AmaMAX', 'x') === matchKey('AmaWaterways', '', 'x'), false);

// ------------------------------------------------------------- document ---
const run = (t, bold) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (style, t) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}</w:pPr>${run(t)}</w:p>`;
const cell = (t) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p>${run(t)}</w:p></w:tc>`;
const table = (rows) => `<w:tbl><w:tblPr/><w:tblGrid/>${rows.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`;

const HEAD = ['Brand', 'Offer', 'Book by / window', 'Code or notes'];
const XML = `<?xml version="1.0"?><w:document><w:body>
  ${para('Heading1', 'Weekly Specials by Brand')}
  ${para('', 'Oct 2, 2026 &#183; @Someone')}
  ${para('Heading2', 'Overview')}
  ${para('', 'The biggest offers are Sample Cruises and Example Tours &amp; Travel.')}
  ${para('Heading2', 'Specials by brand')}
  ${para('Heading3', 'Cruise lines')}
  ${table([HEAD,
    ['Sample Cruises (Early Bird)', 'Up to $500 off per stateroom &amp; a free upgrade', 'Dec 31, 2026 (sailings to 2028)', 'EARLY27'],
    ['Sample Cruises', 'Flash sale: 3 nights from $279', 'Oct 2 to 6', 'Combinable with BOGO60'],
  ])}
  ${para('Heading3', 'Hotels and resorts')}
  ${table([HEAD,
    ['Example Resorts', 'Free night', 'Through Oct 31', 'TLN vacation code 4364'],
    ['Example Resorts', '', 'Through Oct 31', ''],
  ])}
  ${para('Heading2', 'Expiring soon')}
  ${table([['Ends', 'Brand', 'Offer'], ['Oct 6', 'Sample Cruises', 'Flash sale']])}
  ${para('', 'Already ended this week: Old Sale (Sep 30).')}
</w:body></w:document>`;

{
  const doc = readSpecialsBlocks(blocksFromXml(XML));
  is('the title', doc.title, 'Weekly Specials by Brand');
  is('the date the list was issued, not today', doc.issuedOn, '2026-10-02');
  is('the overview, with its entities decoded', doc.intro, 'The biggest offers are Sample Cruises and Example Tours & Travel.');
  is('one row per offer, and a row with no offer is dropped', doc.rows.length, 3);
  is('the recap is left out and says so', doc.skipped.map((s) => [s.label, s.count]), [['Expiring soon', 1]]);

  const [a, b, c] = doc.rows;
  is('shelf comes from the heading above the table', [a.category, c.category], ['Cruise lines', 'Hotels and resorts']);
  is('brand and programme', [a.brand, a.program], ['Sample Cruises', 'Early Bird']);
  is('entities in a cell are decoded', a.offer, 'Up to $500 off per stateroom & a free upgrade');
  is('the booking window, not the travel dates', [a.startsOn, a.endsOn], [null, '2026-12-31']);
  is('its own code', a.code, 'EARLY27');
  is('a range and no code of its own', [b.startsOn, b.endsOn, b.code], ['2026-10-02', '2026-10-06', null]);
  is('a code after the word code', c.code, '4364');
  is('a row whose date could not be read says so', readSpecialsBlocks(blocksFromXml(
    `<w:document><w:body>${para('Heading1', 'T')}${para('Heading3', 'Cruise lines')}${table([HEAD, ['X', 'An offer', 'Through sailing date', '']])}</w:body></w:document>`)).rows[0].datesNote, 'unread');
  is('a table with no Brand and Offer columns is not read', readSpecialsBlocks(blocksFromXml(
    `<w:document><w:body>${table([['Name', 'Phone'], ['A', '1']])}</w:body></w:document>`)).rows.length, 0);
}

// ------------------------------------------------- the TLN promotions file ---
// Consumer promotions come with a link that carries the agency's agent id. Losing or
// tidying that id sends the lead somewhere that credits nobody, and a "Today" in a
// travel period goes stale a week after it was written. Both are pinned here.
const TLN = JSON.stringify({
  updated: '2026-10-05',
  source: 'Example source, Cruise + Consumer Promotions',
  specials: [
    { featured: true, cruiseLine: 'Sample Cruises', headline: 'A Headline', offer: '60% Off 2nd Guest + $600 Off Airfare + More',
      bookBy: '10/30/2026', travelPeriod: 'Today - 11/30/2028',
      link: 'https://www.example.com/promotions/70525?nav=0&agentId=123456' },
    { featured: false, cruiseLine: 'Other Line', headline: 'Second', offer: 'Free upgrade',
      bookBy: '05/01/2027', travelPeriod: 'All 2027 sailings',
      link: 'https://www.travelleaders.com/promotions/70508?nav=0&agentId=532210' },
    { cruiseLine: '', offer: 'no line' },
    { cruiseLine: 'Bad Link Line', offer: 'Odd one', bookBy: 'soon', link: 'javascript:alert(1)' },
  ],
});
{
  const r = readSpecialsJson(TLN);
  is('the file is read', r && r.rows.length, 3);
  is('a line with no cruise line is left out and said', r.skipped.length, 1);
  is('the date on the file', r.issuedOn, '2026-10-05');
  is('a book-by date, as a date and as it is printed', [r.rows[0].endsOn, r.rows[0].windowText], ['2026-10-30', 'Oct 30, 2026']);
  is('a year on the far side of New Year', r.rows[1].endsOn, '2027-05-01');
  is('"Today" in a travel period is the day the file was pulled', r.rows[0].travelPeriod, '10/5/2026 - 11/30/2028');
  is('a travel period with no "Today" is left as worded', r.rows[1].travelPeriod, 'All 2027 sailings');
  is('the link is kept exactly as given, agent id and all',
    r.rows[0].link, 'https://www.example.com/promotions/70525?nav=0&agentId=123456');
  is('featured is a 1 or a 0', [r.rows[0].featured, r.rows[1].featured], [1, 0]);
  is('the headline and the offer as worded', [r.rows[0].headline, r.rows[0].offer], ['A Headline', '60% Off 2nd Guest + $600 Off Airfare + More']);
  is('a link that is not a web address is never kept', r.rows[2].link, null);
  is('and the person is told', r.warnings.length, 1);
  is('a book-by that is not a date is flagged, not guessed', [r.rows[2].endsOn, r.rows[2].datesNote], [null, 'unread']);
  is('a promotion is known by its own number', promoId('https://www.travelleaders.com/promotions/70508?nav=0&agentId=532210'), '70508');
  is('a link from anywhere else has no number', promoId('https://www.example.com/promotions/70525'), null);
  is('a file that is not JSON is not read', readSpecialsJson('not json at all'), null);
  is('JSON that is not a list of specials is not read', readSpecialsJson('{"hello": 1}'), null);
  is('a bare list is read as the specials', readSpecialsJson('[{"cruiseLine":"A","offer":"B"}]').rows.length, 1);
}

// ------------------------------------------------------------------ zip ---
// A zip with one stored (uncompressed) file, built by hand. Deflated entries go
// through DecompressionStream, which this runner may not have, and the live upload
// is what proves that half.
function storedZip(name, text) {
  const enc = new TextEncoder();
  const n = enc.encode(name);
  const data = enc.encode(text);
  const local = new Uint8Array(30 + n.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(26, n.length, true);
  local.set(n, 30); local.set(data, 30 + n.length);
  const cen = new Uint8Array(46 + n.length);
  const cv = new DataView(cen.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 0, true);
  cv.setUint32(20, data.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, 0, true);
  cen.set(n, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(10, 1, true);
  ev.setUint32(12, cen.length, true); ev.setUint32(16, local.length, true);
  const all = new Uint8Array(local.length + cen.length + end.length);
  all.set(local, 0); all.set(cen, local.length); all.set(end, local.length + cen.length);
  return all;
}
{
  const zip = storedZip('word/document.xml', '<x>hello</x>');
  const got = await zipEntry(zip, 'word/document.xml');
  is('a file is found in the zip by name', got ? new TextDecoder().decode(got) : null, '<x>hello</x>');
  is('a name that is not there is null', await zipEntry(zip, 'word/other.xml'), null);
  is('something that is not a zip is null', await zipEntry(new TextEncoder().encode('not a zip at all, just text'), 'word/document.xml'), null);
}

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) process.exit(1);
