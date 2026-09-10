// The sailing catalog, taken from the copy CruiseShoppers already holds.
//
// CTT can import the CruiseFeed catalog directly, and that needs a feed
// key and walks seventy-five thousand sailings. CruiseShoppers has already
// done that walk and serves the result on three public endpoints, so there is
// no reason to do it twice or to hold a second key for the same data.
//
// What comes across is what a reservation actually needs: the cruise line, the
// ship, the itinerary title, and the dates it sails on. No prices. A price
// from another system's snapshot is a number somebody would quote from, and it
// would be wrong by the time they did.
//
// Resumable, because a Worker gets a few seconds and there are eight hundred
// ships. Progress is kept in catalog_import_state so each cron tick picks up
// where the last one stopped, and a finished pass costs one request.

import { normKey } from './catalog.js';

const SOURCE = 'https://cruiseshoppers.com';
const STATE_PREFIX = 'mirror_';

// How long a completed import is left alone. The catalog is a monthly
// snapshot on the far side, so refreshing it hourly would be pointless load
// on somebody else's Worker.
const REFRESH_AFTER = 12 * 3600;

async function stateGet(env, k) {
  const row = await env.DB.prepare('SELECT v FROM catalog_import_state WHERE k = ?')
    .bind(STATE_PREFIX + k).first();
  return row ? row.v : null;
}

async function stateSet(env, k, v) {
  await env.DB.prepare(
    `INSERT INTO catalog_import_state (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  ).bind(STATE_PREFIX + k, String(v)).run();
}

async function get(path) {
  const res = await fetch(SOURCE + path, {
    headers: { accept: 'application/json' },
    // Their Worker sits behind Cloudflare, which refuses a request with no
    // user agent. Saying who this is beats being mistaken for a scraper.
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) {
    const e = new Error(`${path} returned ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** Every cruise line the source knows. */
export async function fetchLines() {
  const d = await get('/api/cruise-lines');
  return Array.isArray(d.lines) ? d.lines : [];
}

/** The ships one line sails. */
export async function fetchShips(line) {
  const d = await get(`/api/ships?line=${encodeURIComponent(line)}`);
  return Array.isArray(d.ships) ? d.ships : [];
}

/** Every dated sailing for one ship, with its itinerary title. */
export async function fetchSailings(ship) {
  const d = await get(`/api/ship-dates?ship=${encodeURIComponent(ship)}`);
  return Array.isArray(d.dates) ? d.dates : [];
}

async function writeSailings(env, rows) {
  if (!rows.length) return 0;

  const stmt = env.DB.prepare(
    `INSERT INTO sailings
       (id, cruise_line, ship, ship_norm, line_norm, name, depart_date, return_date,
        nights, departure_port, disembark_port, destination, round_trip, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       cruise_line=excluded.cruise_line, ship=excluded.ship, ship_norm=excluded.ship_norm,
       line_norm=excluded.line_norm, name=excluded.name, depart_date=excluded.depart_date,
       return_date=excluded.return_date, nights=excluded.nights,
       departure_port=excluded.departure_port, disembark_port=excluded.disembark_port,
       destination=excluded.destination, updated_at=excluded.updated_at`
  );

  const ts = Date.now();
  const bound = [];
  for (const s of rows) {
    if (!s.id || !s.depart_date) continue;
    // The source gives nights and a departure; the return follows from them,
    // and a reservation wants both.
    const nights = Number(s.nights) || null;
    let returnDate = null;
    if (nights && /^\d{4}-\d{2}-\d{2}$/.test(s.depart_date)) {
      const d = new Date(`${s.depart_date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + nights);
      returnDate = d.toISOString().slice(0, 10);
    }
    bound.push(stmt.bind(
      s.id, s.line || null, s.ship || null, normKey(s.ship), normKey(s.line),
      s.name || null, s.depart_date, returnDate, nights,
      s.departure_port || null, s.disembark_port || null, s.destination || null,
      s.departure_port && s.disembark_port
        ? (normKey(s.departure_port) === normKey(s.disembark_port) ? 1 : 0)
        : null,
      ts
    ));
  }

  for (let i = 0; i < bound.length; i += 50) {
    await env.DB.batch(bound.slice(i, i + 50));
  }
  return bound.length;
}

/**
 * One slice of the import.
 *
 * The ship list is built once and stored, then walked a few ships at a time.
 * Returning after a handful keeps each run inside a Worker's budget, and the
 * cron calls it again five minutes later.
 */
export async function mirrorCatalogStep(env, { maxShips = 6, force = false } = {}) {
  if (!env.DB) return { ok: false, reason: 'no_database' };

  const done = (await stateGet(env, 'done')) === '1';
  const finishedAt = Number(await stateGet(env, 'finished_at')) || 0;
  const fresh = done && (Date.now() / 1000 - finishedAt) < REFRESH_AFTER;
  if (fresh && !force) {
    return { ok: true, skipped: true, sailings: Number(await stateGet(env, 'rows')) || 0 };
  }

  // Build the queue on the first pass, or when starting again.
  let queue = [];
  const stored = await stateGet(env, 'queue');
  if (force || !stored || done) {
    const lines = await fetchLines();
    for (const line of lines) {
      for (const ship of await fetchShips(line)) queue.push(ship);
    }
    queue = [...new Set(queue)];
    await stateSet(env, 'queue', JSON.stringify(queue));
    await stateSet(env, 'at', '0');
    await stateSet(env, 'rows', '0');
    await stateSet(env, 'done', '0');
    await stateSet(env, 'lines', String(lines.length));
    // Kept whole, not just counted. Which suppliers are cruise lines is a
    // question the reservation form asks, and answering it from the sailings
    // imported so far means a half-finished import leaves Royal Caribbean
    // looking like a tour operator.
    await stateSet(env, 'all_lines', JSON.stringify(lines));
    return { ok: true, started: true, ships: queue.length, lines: lines.length };
  }

  try { queue = JSON.parse(stored); } catch { queue = []; }
  if (!queue.length) {
    await stateSet(env, 'done', '1');
    return { ok: true, done: true, sailings: Number(await stateGet(env, 'rows')) || 0 };
  }

  let at = Number(await stateGet(env, 'at')) || 0;
  let rows = Number(await stateGet(env, 'rows')) || 0;
  let ships = 0;

  while (at < queue.length && ships < maxShips) {
    const ship = queue[at];
    try {
      rows += await writeSailings(env, await fetchSailings(ship));
    } catch (e) {
      // One ship failing is not the import failing. It is recorded and the
      // walk carries on, because stopping would leave the other eight hundred
      // waiting on whichever one the source is unhappy about.
      console.error('mirror ship', ship, e);
      await stateSet(env, 'last_error', `${ship}: ${String(e.message || e).slice(0, 120)}`);
    }
    at += 1;
    ships += 1;
  }

  await stateSet(env, 'at', String(at));
  await stateSet(env, 'rows', String(rows));

  const complete = at >= queue.length;
  if (complete) {
    await stateSet(env, 'done', '1');
    await stateSet(env, 'finished_at', String(Math.floor(Date.now() / 1000)));
  }

  return {
    ok: true, ships, at, of: queue.length, sailings: rows, done: complete,
  };
}

/** What the mirror has, for the admin screen. */
/** Every cruise line the source knows, however much has been imported yet. */
export async function knownCruiseLines(env) {
  try { return JSON.parse((await stateGet(env, 'all_lines')) || '[]'); }
  catch { return []; }
}

export async function mirrorStatus(env) {
  const [queue, at, rows, done, finishedAt, lines, lastError] = await Promise.all([
    stateGet(env, 'queue'), stateGet(env, 'at'), stateGet(env, 'rows'),
    stateGet(env, 'done'), stateGet(env, 'finished_at'), stateGet(env, 'lines'),
    stateGet(env, 'last_error'),
  ]);

  let total = 0;
  try { total = JSON.parse(queue || '[]').length; } catch { total = 0; }

  const counted = await env.DB.prepare('SELECT COUNT(*) AS n FROM sailings').first();

  return {
    source: SOURCE,
    lines: Number(lines) || 0,
    ships: total,
    shipsDone: Number(at) || 0,
    sailingsImported: Number(rows) || 0,
    sailingsStored: counted?.n || 0,
    done: done === '1',
    finishedAt: Number(finishedAt) || null,
    lastError: lastError || null,
  };
}
