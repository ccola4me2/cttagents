// Local copy of the CruiseFeed sailings catalog.
//
// The import loop is lifted from the CruiseShoppers portal, which has run it
// over ~75,000 rows. Keeping the proven shape rather than writing a second one
// matters: the awkward parts of this are not obvious, and they were learned
// the expensive way.
//
//   dedupe=true is required for a bulk import. With dedupe=false the API
//   returns each sailing once per source, which inflates the near-term rows so
//   much that paging by offset covers a couple of weeks of calendar and then
//   stops. It does not collapse distinct departure dates, so every date is
//   still captured.
//
//   The import is resumable and snapshot-aware: it pages by offset, saves the
//   cursor, and does nothing at all once the current monthly snapshot
//   (x-data-as-of) is fully imported. A cron can call it every five minutes
//   for a year and spend one request a day.
//
// What CTT wants from it is narrower than a shopper site: vendor and
// ship names spelled one way, real departure and return dates, and enough to
// build a reservation from a real sailing rather than from memory.

const BASE = 'https://api.cruisefeed.io';
const PAGE = 500;    // rows per API page
const DB_BATCH = 50; // rows per D1 batch write

/** Lowercased, alphanumeric-only key, for names that differ only in spacing. */
export function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function iso10(d) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(d == null ? '' : d));
  return m ? m[1] : null;
}

async function stateGet(env, k) {
  try {
    const r = await env.DB.prepare('SELECT v FROM catalog_import_state WHERE k = ?').bind(k).first();
    return r ? r.v : null;
  } catch { return null; }
}

async function stateSet(env, k, v) {
  await env.DB.prepare(
    'INSERT INTO catalog_import_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  ).bind(k, v == null ? '' : String(v)).run();
}

async function fetchPage(env, offset, limit) {
  const p = new URLSearchParams({
    dedupe: 'true', include_past: 'false', sort: 'departure_date',
    limit: String(limit), offset: String(offset),
  });
  const res = await fetch(`${BASE}/v1/cruises?${p.toString()}`, {
    headers: { Authorization: `Bearer ${env.CRUISEFEED_KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) { const e = new Error('cruisefeed_upstream'); e.status = res.status; throw e; }
  const data = await res.json();
  return {
    items: Array.isArray(data.items) ? data.items : [],
    total: data.total != null ? Number(data.total) : null,
    asOf: res.headers.get('x-data-as-of') || 'unknown',
    remaining: res.headers.get('x-results-remaining') != null
      ? Number(res.headers.get('x-results-remaining')) : null,
  };
}

async function upsertBatch(env, items) {
  const sql = `INSERT INTO sailings
    (id, cruise_line, ship, ship_norm, line_norm, name, depart_date, return_date, nights,
     departure_port, disembark_port, destination, round_trip, price_amount, price_currency, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      cruise_line=excluded.cruise_line, ship=excluded.ship, ship_norm=excluded.ship_norm,
      line_norm=excluded.line_norm, name=excluded.name, depart_date=excluded.depart_date,
      return_date=excluded.return_date, nights=excluded.nights,
      departure_port=excluded.departure_port, disembark_port=excluded.disembark_port,
      destination=excluded.destination, round_trip=excluded.round_trip,
      price_amount=excluded.price_amount, price_currency=excluded.price_currency,
      updated_at=excluded.updated_at`;
  const stmt = env.DB.prepare(sql);
  const ts = Date.now();
  const bound = [];
  for (const c of items) {
    const depart = iso10(c.departure_date);
    const id = c.id || (c.ship_name && depart ? `${normKey(c.ship_name)}|${depart}` : null);
    if (!id) continue;
    const nights = c.nights != null
      ? c.nights
      : (c.duration_days != null ? Math.max(0, c.duration_days - 1) : null);
    bound.push(stmt.bind(
      id, c.cruise_line || null, c.ship_name || null, normKey(c.ship_name), normKey(c.cruise_line),
      c.title || null, depart, iso10(c.return_date), nights,
      c.embark_port || null, c.disembark_port || null, c.region || null,
      c.round_trip ? 1 : 0,
      c.price_amount != null ? Number(c.price_amount) : null, c.price_currency || null, ts
    ));
  }
  for (let i = 0; i < bound.length; i += DB_BATCH) {
    await env.DB.batch(bound.slice(i, i + DB_BATCH));
  }
  return bound.length;
}

/**
 * One bounded step of the import. Safe to call repeatedly: it resumes from the
 * saved cursor and does nothing once the current snapshot is fully imported.
 */
export async function importCatalogStep(env, opts = {}) {
  if (!env.DB || !env.CRUISEFEED_KEY) return { ok: false, reason: 'not_configured' };
  const maxPages = opts.maxPages || 6;
  const reserve = opts.reserve != null ? opts.reserve : 0;
  const limit = opts.limit || PAGE;

  let head;
  try { head = await fetchPage(env, 0, 1); }
  catch (e) { return { ok: false, reason: 'fetch_failed', status: e.status || null }; }

  const asOf = head.asOf;
  const importedAsOf = await stateGet(env, 'imported_as_of');
  const cycleDone = (await stateGet(env, 'cycle_done')) === '1';

  if (cycleDone && importedAsOf === asOf && !opts.force) {
    return {
      ok: true, skipped: true, asOf, total: head.total,
      imported: Number(await stateGet(env, 'row_count')) || 0,
    };
  }

  if (importedAsOf !== asOf || opts.force) {
    if (opts.force) { try { await env.DB.prepare('DELETE FROM sailings').run(); } catch { /* fresh table */ } }
    await stateSet(env, 'imported_as_of', asOf);
    await stateSet(env, 'offset', '0');
    await stateSet(env, 'cycle_done', '0');
    await stateSet(env, 'row_count', '0');
  }

  let offset = Number(await stateGet(env, 'offset')) || 0;
  let imported = Number(await stateGet(env, 'row_count')) || 0;
  let pages = 0;
  let done = false;
  let remaining = head.remaining;
  let stepError = null;

  while (pages < maxPages) {
    let page;
    // On any failure, stop cleanly with progress saved rather than throwing:
    // the cursor was persisted after the previous page, so the next run picks
    // up where this one stopped.
    try {
      page = await fetchPage(env, offset, limit);
      if (page.remaining != null) remaining = page.remaining;
      if (!page.items.length) { done = true; break; }
      await upsertBatch(env, page.items);
    } catch (e) { stepError = String((e && e.message) || e); break; }

    imported += page.items.length;
    offset += page.items.length;
    pages++;
    await stateSet(env, 'offset', String(offset));
    await stateSet(env, 'row_count', String(imported));
    if (page.items.length < limit) { done = true; break; }
    if (remaining != null && remaining < reserve) break;
  }

  if (done) {
    await stateSet(env, 'cycle_done', '1');
    await stateSet(env, 'last_full_import', String(Date.now()));
  }
  await stateSet(env, 'last_run', String(Date.now()));
  await stateSet(env, 'last_remaining', remaining == null ? '' : String(remaining));
  return { ok: true, asOf, offset, imported, pages, done, remaining, total: head.total, error: stepError };
}

/** Whether there is anything local to read yet. */
export async function catalogReady(env) {
  if (!env.DB) return false;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sailings').first();
  return Boolean(row && row.n > 0);
}

export async function importStatus(env) {
  if (!env.DB) return { configured: false };
  const keys = ['imported_as_of', 'offset', 'row_count', 'cycle_done',
                'last_run', 'last_full_import', 'last_remaining'];
  const out = {};
  for (const k of keys) out[k] = await stateGet(env, k);
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sailings').first();
  return {
    configured: Boolean(env.CRUISEFEED_KEY),
    // Counted from the table rather than read from the cursor. The cursor says
    // how many rows were sent; this says how many are actually here, and the
    // two differ whenever a page failed midway.
    rows: row ? row.n : 0,
    ...out,
  };
}

/** Cruise lines with an upcoming departure. */
export async function catalogLines(env) {
  const { results } = await env.DB.prepare(
    `SELECT cruise_line AS name, COUNT(*) AS sailings FROM sailings
      WHERE cruise_line IS NOT NULL AND cruise_line != '' AND depart_date >= ?
      GROUP BY cruise_line ORDER BY cruise_line`
  ).bind(new Date().toISOString().slice(0, 10)).all().catch(() => ({ results: [] }));
  return results || [];
}

/** Ships for one line that actually have upcoming departures. */
export async function catalogShips(env, line) {
  // Prefix match, so "Margaritaville at Sea" finds sailings filed under
  // "Margaritaville at Sea Cruises". No leading wildcard, so the index is used.
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT ship AS name FROM sailings
      WHERE line_norm LIKE ? AND ship IS NOT NULL AND ship != '' AND depart_date >= ?
      ORDER BY ship`
  ).bind(`${normKey(line)}%`, new Date().toISOString().slice(0, 10))
   .all().catch(() => ({ results: [] }));
  return results || [];
}

/** Every upcoming departure for one ship. */
/**
 * The catalog searched the way somebody actually looks for a sailing.
 *
 * Not by line and ship, which is the picker on a reservation and assumes you
 * already know what you are booking. This is the other question: a client
 * wants the Caribbean in March for about a week, and the answer is a list of
 * sailings across every line.
 */
export async function catalogSearch(env, {
  q = '', line = '', destination = '', port = '',
  from = '', to = '', minNights = 0, maxNights = 0, limit = 60, offset = 0,
} = {}) {
  const where = ['depart_date IS NOT NULL'];
  const binds = [];

  if (q) {
    where.push('(name LIKE ? OR ship LIKE ? OR destination LIKE ? OR departure_port LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  if (line) { where.push('line_norm = ?'); binds.push(normKey(line)); }
  if (destination) { where.push('destination LIKE ?'); binds.push(`%${destination}%`); }
  if (port) { where.push('departure_port LIKE ?'); binds.push(`%${port}%`); }
  if (from) { where.push('depart_date >= ?'); binds.push(from); }
  if (to) { where.push('depart_date <= ?'); binds.push(to); }
  if (minNights) { where.push('nights >= ?'); binds.push(Number(minNights)); }
  if (maxNights) { where.push('nights <= ?'); binds.push(Number(maxNights)); }

  const cap = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const { results } = await env.DB.prepare(
    `SELECT id, cruise_line, ship, name, depart_date, return_date, nights,
            departure_port, disembark_port, destination
       FROM sailings WHERE ${where.join(' AND ')}
      ORDER BY depart_date ASC, cruise_line ASC
      LIMIT ? OFFSET ?`
  ).bind(...binds, cap, Number(offset) || 0).all();

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sailings WHERE ${where.join(' AND ')}`
  ).bind(...binds).first();

  return { sailings: (results || []).map(withReturn), total: countRow?.n || 0 };
}

/** The destinations and ports worth offering as filters. */
export async function catalogFacets(env) {
  const [dest, ports] = await Promise.all([
    env.DB.prepare(
      `SELECT destination AS name, COUNT(*) AS n FROM sailings
        WHERE destination IS NOT NULL AND destination != ''
        GROUP BY destination ORDER BY n DESC LIMIT 40`
    ).all(),
    env.DB.prepare(
      `SELECT departure_port AS name, COUNT(*) AS n FROM sailings
        WHERE departure_port IS NOT NULL AND departure_port != ''
        GROUP BY departure_port ORDER BY n DESC LIMIT 60`
    ).all(),
  ]);
  return { destinations: dest.results || [], ports: ports.results || [] };
}

/**
 * The return date, derived when the row does not carry one.
 *
 * A sailing that knows it is seven nights and leaves on the 26th also knows
 * it comes back on the 3rd, but not every row in the table says so: the feed
 * omits it, and rows imported before the mirror started computing it kept the
 * blank. The reservation form fills the return date from whatever is here, so
 * a blank in the table is a blank the advisor has to work out and type, which
 * is exactly the arithmetic that puts a final payment date a week wrong.
 *
 * Derived on the way out rather than backfilled, so it is right for rows that
 * arrive tomorrow as well as the ones already stored.
 */
export function withReturn(row) {
  if (!row) return row;
  if (row.return_date || !row.nights) return row;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.depart_date || '')) return row;
  const d = new Date(`${row.depart_date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(row.nights));
  return { ...row, return_date: d.toISOString().slice(0, 10) };
}

export async function catalogDates(env, ship, line) {
  const shipNorm = normKey(ship);
  if (!shipNorm) return [];
  const binds = [shipNorm, new Date().toISOString().slice(0, 10)];
  let sql = `SELECT id, cruise_line, ship, name, depart_date, return_date, nights,
                    departure_port, disembark_port, destination
               FROM sailings WHERE ship_norm = ? AND depart_date >= ?`;
  if (line) { sql += ' AND line_norm LIKE ?'; binds.push(`${normKey(line)}%`); }
  sql += ' ORDER BY depart_date ASC LIMIT 400';

  const { results } = await env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] }));
  const seen = new Set();
  const out = [];
  for (const r of results || []) {
    if (seen.has(r.depart_date)) continue;
    seen.add(r.depart_date);
    out.push(withReturn(r));
  }
  return out;
}

/**
 * The sailing a reservation is probably for, matched on ship and departure.
 *
 * Ship and date together are close to unique: a ship is in one place on one
 * day. Deliberately not matched on the vendor as well, because the vendor name
 * on a pasted reservation is exactly the thing most likely to be spelled
 * differently, and requiring it to agree would refuse the matches worth having.
 */
export async function matchSailing(env, ship, departDate) {
  const shipNorm = normKey(ship);
  const date = iso10(departDate);
  if (!shipNorm || !date) return null;
  return env.DB.prepare(
    `SELECT id, cruise_line, ship, name, depart_date, return_date, nights,
            departure_port, disembark_port, destination
       FROM sailings WHERE ship_norm = ? AND depart_date = ? LIMIT 1`
  ).bind(shipNorm, date).first().then(withReturn);
}
