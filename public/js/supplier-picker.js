// Choosing who you are booking with, and which sailing.
//
// This started as two hundred lines inside the new-reservation page. The
// groups form needs exactly the same thing, and the version of this that gets
// copied is the version that drifts: one page learns that "Holland America"
// and "Holland America Line" are the same supplier and the other does not.
// One implementation, mounted twice.
//
// Two pickers that behave as one. The vendor box offers the suppliers you
// sell, except when the trip is a cruise, in which case it offers cruise
// lines from the sailing catalog instead. Picking a line loads its ships, and
// picking a ship loads its departures, and picking a departure fills in the
// dates. Everything it sets can be typed over: a charter or a private group
// will not be in a feed.

import { api, esc, dateFmt } from '/js/app.js';

const VENDOR_TYPE = {
  'All-Inclusive Resorts': 'resort',
  'All-Inclusive Brands': 'resort',
  'Hotels & Resorts': 'hotel',
  'Rentals & Villas': 'hotel',
  'Escorted Tours': 'tour',
  'Package Providers': 'package',
  FIT: 'package',
  'River Cruises': 'cruise',
  'Expedition Experiences & Yacht': 'cruise',
  'Air Consolidator': 'air',
  'Car & Transfer Services': 'transfer',
  'Rail Vacations': 'rail',
  Attractions: 'attraction',
  Excursions: 'excursion',
  Insurance: 'insurance',
};

const CATALOG_CATEGORY = 'Cruise Lines';
const UNSHELVED = 'Not categorised yet';

// Names differing only in spacing or punctuation are the same supplier.
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * A departure, said the way somebody picks one.
 *
 * The date alone is not enough to choose between two sailings on the same
 * ship: a week in the Western Caribbean and a week in the Eastern leave from
 * the same pier a fortnight apart and read identically as dates. The
 * itinerary is what is actually being chosen, so it goes in the option next
 * to the date.
 */
export function sailingLabel(r) {
  // The feed writes the length into the itinerary title as often as not
  // ("7 Night Western Caribbean"), and printing "7 nights" after that reads
  // as a stutter. The prefix comes off; the count is shown once, at the end.
  const itinerary = String(r.name || r.destination || '')
    .replace(/^\s*\d+\s*[- ]?\s*(night|nt|day)s?\s+/i, '')
    .trim();
  return [
    dateFmt(r.depart_date),
    itinerary,
    r.nights ? `${r.nights} nights` : '',
  ].filter(Boolean).join('  ·  ');
}

const MARKUP = `
  <div class="field" data-role="field" hidden>
    <label data-role="label">Choose from your vendors</label>
    <select data-role="select"></select>
    <p class="field-hint" data-role="hint"></p>
    <div class="field-row" data-role="sailing" hidden style="margin-top:.6rem;">
      <div class="field"><label>Ship</label>
        <select data-role="ship" disabled><option value="">Ship</option></select></div>
      <div class="field"><label>Departure</label>
        <select data-role="date" disabled><option value="">Departure</option></select></div>
    </div>
    <p class="field-hint" data-role="picked" hidden></p>
  </div>`;

/**
 * Put a supplier picker in `host`.
 *
 * `typeOf()` says what kind of trip is being booked right now, in the
 * vocabulary of vendor shelves: cruise, hotel, tour, package and so on. The
 * two forms spell their own types differently, so each passes its own
 * translation rather than this having to know about both.
 *
 * `set(field, value)` is how the picker writes back. Again, the two forms
 * name their fields differently, and asking the caller to do the writing is
 * shorter than teaching this about either.
 */
export async function mountSupplierPicker(host, { typeOf, set, onSailing }) {
  host.innerHTML = MARKUP;
  const q = (role) => host.querySelector(`[data-role="${role}"]`);
  const field = q('field');
  const sel = q('select');
  const hint = q('hint');
  const sailingRow = q('sailing');
  const pickShip = q('ship');
  const pickDate = q('date');
  const picked = q('picked');

  let vendors = [];
  try { vendors = (await api('/api/vendors')).vendors || []; } catch { vendors = []; }

  const shelvesOf = (v) => {
    let list = [];
    try { const a = JSON.parse(v.categories_json || '[]'); if (Array.isArray(a)) list = a; }
    catch { list = []; }
    if (v.category && !list.includes(v.category)) list.unshift(v.category);
    return list;
  };

  // Which vendors are cruise lines is a question the catalog answers, and the
  // category does not: most vendor records were created from a booking and
  // have no category at all, so filtering on the shelf alone left Carnival,
  // Royal Caribbean and Celebrity sitting in Other and being offered twice.
  let catalogLines = new Set();
  let catalogRows = [];
  try {
    const c = await api('/api/catalog/lines');
    catalogRows = c.lines || [];
    // knownCruiseLines is every line the source knows; lines is only what has
    // been imported so far. Both, so a part-finished import still keeps cruise
    // lines out of a list they do not belong in.
    catalogLines = new Set([
      ...(c.knownCruiseLines || []).map(norm),
      ...(c.lines || []).map((l) => norm(l.name)),
    ]);
  } catch { catalogLines = new Set(); }

  // A supplier that only sells cruises comes from the catalog. Vendor records
  // are named the way an advisor says them and the catalog uses the full legal
  // name: "Oceania" against "Oceania Cruises", "Holland America" against
  // "Holland America Line". An exact match left those in a list of tour
  // operators, so one name being the start of the other counts. Six characters
  // minimum, so a short word cannot swallow an unrelated supplier.
  const lineList = [...catalogLines];
  const isCruiseLine = (name) => {
    const n = norm(name);
    if (!n) return false;
    if (catalogLines.has(n)) return true;
    return lineList.some((l) => (
      (l.startsWith(n) && n.length >= 6) || (n.startsWith(l) && l.length >= 6)
    ));
  };

  const offered = vendors
    .map((v) => ({ v, shelves: shelvesOf(v).filter((c) => c !== CATALOG_CATEGORY) }))
    .filter((x) => !isCruiseLine(x.v.name))
    .filter((x) => x.shelves.length || !shelvesOf(x.v).length);

  const typesOf = (v) => [...new Set(
    shelvesOf(v).map((shelf) => VENDOR_TYPE[shelf]).filter(Boolean)
  )];

  // ------------------------------------------------------- the sailing pair
  let dateRows = [];
  let pickedLine = '';

  async function loadShips(line) {
    pickedLine = line || '';
    pickShip.innerHTML = '<option value="">Ship</option>';
    pickDate.innerHTML = '<option value="">Departure</option>';
    pickShip.disabled = true;
    pickDate.disabled = true;
    dateRows = [];
    sailingRow.hidden = !line;
    if (!line) return;

    const d = await api(`/api/catalog/ships?line=${encodeURIComponent(line)}`).catch(() => null);
    if (!d || !d.ships.length) {
      picked.hidden = false;
      picked.textContent = `No sailings imported for ${line} yet. Type the ship and dates in.`;
      return;
    }
    picked.hidden = true;
    pickShip.innerHTML = '<option value="">Ship</option>'
      + d.ships.map((sh) => `<option value="${esc(sh.name)}">${esc(sh.name)}</option>`).join('');
    pickShip.disabled = false;
  }

  pickShip.addEventListener('change', async () => {
    pickDate.innerHTML = '<option value="">Departure</option>';
    pickDate.disabled = true;
    dateRows = [];
    if (!pickShip.value) return;
    const d = await api(`/api/catalog/dates?ship=${encodeURIComponent(pickShip.value)}`
      + `&line=${encodeURIComponent(pickedLine)}`).catch(() => null);
    if (!d || !d.dates.length) return;
    dateRows = d.dates;
    pickDate.innerHTML = '<option value="">Departure</option>'
      + d.dates.map((r) => `<option value="${esc(r.depart_date)}">${esc(sailingLabel(r))}</option>`)
        .join('');
    pickDate.disabled = false;
  });

  pickDate.addEventListener('change', () => {
    const r = dateRows.find((x) => x.depart_date === pickDate.value);
    if (!r) return;
    if (onSailing) onSailing(r);
    picked.hidden = false;
    picked.textContent = `Filled from ${r.cruise_line}: ${r.name || r.ship}. `
      + 'Change anything below that is not right.';
  });

  // ------------------------------------------------------------- the vendors
  function draw() {
    const want = typeOf();

    if (want !== 'cruise') { sailingRow.hidden = true; picked.hidden = true; }

    if (want === 'cruise') {
      // The lines come from the catalog, not from the vendor records. It is
      // the same list the sailing pair uses, so choosing a line here loads its
      // ships rather than leaving two pickers that know different things.
      const lines = (catalogRows || []).map((l) => l.name);
      sel.innerHTML = '<option value="">Type the name, or pick a cruise line</option>'
        + lines.map((n) => `<option value="line:${esc(n)}">${esc(n)}</option>`).join('');
      hint.textContent = lines.length
        ? `${lines.length} cruise line${lines.length === 1 ? '' : 's'} from the catalog. `
          + 'Picking one loads its ships and sailing dates.'
        : 'The sailing catalog has not been imported yet, so there are no cruise lines to '
          + 'pick from. Type the name instead.';
      field.hidden = false;
      return;
    }

    // Only the vendors that sell this kind of trip. Picking Rooms and then
    // scrolling past sixty tour operators is the list being unhelpful in a way
    // that is worse than no list. A vendor with no category cannot be ruled
    // out, so it stays offered whatever the type.
    const matching = offered.filter(({ v }) => {
      const types = typesOf(v);
      return !want || !types.length || types.includes(want);
    });

    if (!matching.length && !offered.length) { field.hidden = true; return; }

    const byShelf = new Map();
    for (const { v, shelves } of matching) {
      const key = shelves[0] || UNSHELVED;
      if (!byShelf.has(key)) byShelf.set(key, []);
      byShelf.get(key).push(v);
    }

    const last = (k) => (k === UNSHELVED ? 2 : k === 'Other' ? 1 : 0);
    const order = [...byShelf.keys()].sort((a, b) => (
      last(a) - last(b) || a.localeCompare(b)));

    sel.innerHTML = '<option value="">Type the name, or pick one</option>'
      + order.map((shelf) => `<optgroup label="${esc(shelf)}">${
        byShelf.get(shelf)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')
      }</optgroup>`).join('');

    const n = matching.length;
    hint.textContent = n
      ? `${n} vendor${n === 1 ? '' : 's'} you sell for this kind of trip. Cruise lines are not `
        + 'here: pick those with the type set to cruise, where the ship and the sailing dates '
        + 'come with them.'
      : 'No vendors on your list sell this kind of trip yet. Type the name and it becomes one.';

    field.hidden = false;
  }

  sel.addEventListener('change', () => {
    if (sel.value.startsWith('line:')) {
      const line = sel.value.slice(5);
      set('supplier', line);
      loadShips(line);
      return;
    }
    const v = vendors.find((x) => x.id === sel.value);
    if (!v) return;
    // The name has to match the vendor record exactly: that string is what
    // joins the trip to the record, and every report groups by it.
    set('supplier', v.name);
    set('vendor', v);
  });

  draw();

  return {
    /** Redraw after the kind of trip changes, keeping the choice if it survives. */
    refresh() {
      const chosen = sel.value;
      draw();
      sel.value = [...sel.options].some((o) => o.value === chosen) ? chosen : '';
    },
    /** Point the sailing pair at a line without going through the box. */
    useLine: loadShips,
  };
}
