// Keeping the local CRM current.
//
// The portal owns its data now: reads come from D1 so they stay fast and keep
// working when the upstream API is slow or rate limiting. This module is what
// keeps that copy honest.
//
// Design notes worth knowing before changing anything here:
//
//   Resumable. A backfill of thousands of contacts cannot finish inside one
//   Worker invocation, so each run does a bounded number of pages and stores
//   its cursor. The cron picks up where the last run stopped. This mirrors the
//   catalog import pattern used on the cruiseshoppers site.
//
//   Idempotent. Rows are upserted on the upstream id, so re-running a sync
//   updates in place and never duplicates.
//
//   Never destructive. A sync only ever inserts or updates. It does not delete
//   local rows that are missing upstream, because a partial page or a failed
//   request would otherwise wipe real data.

import { now } from './util.js';
import * as ghl from './ghl.js';

const PAGES_PER_RUN = 4;
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------
function stateId(kind, locationId) {
  return `${kind}:${locationId}`;
}

export async function getSyncState(env, kind, locationId) {
  return env.DB.prepare('SELECT * FROM sync_state WHERE id = ?')
    .bind(stateId(kind, locationId)).first();
}

export async function listSyncState(env, locationId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM sync_state WHERE location_id = ? ORDER BY kind'
  ).bind(locationId).all();
  return results || [];
}

async function saveState(env, kind, locationId, patch) {
  const id = stateId(kind, locationId);
  const ts = now();
  const existing = await getSyncState(env, kind, locationId);
  const merged = {
    cursor: patch.cursor !== undefined ? patch.cursor : existing?.cursor ?? null,
    status: patch.status ?? existing?.status ?? 'idle',
    detail: patch.detail !== undefined ? patch.detail : existing?.detail ?? null,
    records: patch.records ?? existing?.records ?? 0,
    started_at: patch.started_at ?? existing?.started_at ?? null,
    finished_at: patch.finished_at !== undefined ? patch.finished_at : existing?.finished_at ?? null,
  };
  await env.DB.prepare(
    `INSERT INTO sync_state (id, kind, location_id, cursor, status, detail, records, started_at, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cursor = excluded.cursor, status = excluded.status, detail = excluded.detail,
       records = excluded.records, started_at = excluded.started_at,
       finished_at = excluded.finished_at, updated_at = excluded.updated_at`
  ).bind(id, kind, locationId, merged.cursor, merged.status, merged.detail,
         merged.records, merged.started_at, merged.finished_at, ts).run();
  return merged;
}

/** Clears the cursor so the next run starts a full backfill. */
export async function resetSync(env, kind, locationId) {
  return saveState(env, kind, locationId, {
    cursor: null, status: 'idle', records: 0, detail: null,
    started_at: now(), finished_at: null,
  });
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------
export async function upsertContact(env, locationId, c) {
  await env.DB.prepare(
    `INSERT INTO crm_contacts
       (id, location_id, first_name, last_name, name, email, phone, source,
        tags_json, city, state, country, assigned_to, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       first_name = excluded.first_name, last_name = excluded.last_name,
       name = excluded.name, email = excluded.email, phone = excluded.phone,
       source = excluded.source, tags_json = excluded.tags_json,
       city = excluded.city, state = excluded.state, country = excluded.country,
       assigned_to = excluded.assigned_to, updated_at = excluded.updated_at,
       synced_at = excluded.synced_at`
  ).bind(
    c.id, locationId, c.firstName || null, c.lastName || null, c.name || null,
    c.email || null, c.phone || null, c.source || null,
    JSON.stringify(c.tags || []), c.city || null, c.state || null, c.country || null,
    c.assignedTo || null, c.createdAt || null, c.updatedAt || null, now()
  ).run();
}

export async function upsertOpportunity(env, locationId, o) {
  await env.DB.prepare(
    `INSERT INTO crm_opportunities
       (id, location_id, pipeline_id, stage_id, name, status, monetary_value,
        contact_id, contact_name, contact_email, contact_phone, assigned_to,
        source, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pipeline_id = excluded.pipeline_id, stage_id = excluded.stage_id,
       name = excluded.name, status = excluded.status,
       monetary_value = excluded.monetary_value, contact_id = excluded.contact_id,
       contact_name = excluded.contact_name, contact_email = excluded.contact_email,
       contact_phone = excluded.contact_phone, assigned_to = excluded.assigned_to,
       source = excluded.source, updated_at = excluded.updated_at,
       synced_at = excluded.synced_at`
  ).bind(
    o.id, locationId, o.pipelineId || null, o.stageId || null, o.name || null,
    o.status || null, Number(o.monetaryValue || 0), o.contactId || null,
    o.contactName || null, o.contactEmail || null, o.contactPhone || null,
    o.assignedTo || null, o.source || null, o.createdAt || null,
    o.updatedAt || null, now()
  ).run();
}

export async function upsertPipeline(env, locationId, p) {
  await env.DB.prepare(
    `INSERT INTO crm_pipelines (id, location_id, name, stages_json, synced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, stages_json = excluded.stages_json, synced_at = excluded.synced_at`
  ).bind(p.id, locationId, p.name || null, JSON.stringify(p.stages || []), now()).run();
}

// ---------------------------------------------------------------------------
// Sync steps
// ---------------------------------------------------------------------------
/**
 * Take out of the mirror what GoHighLevel no longer has.
 *
 * Every sync step here was insert-or-update and nothing else, so the mirror
 * only ever grew. Delete a pipeline in CTT Tools and the portal's board keeps
 * offering it forever; delete or merge an opportunity and its card stays on
 * the board as something nobody can open. The mirror was not a mirror, it was
 * a high water mark.
 *
 * Two shapes, because the two kinds of sync know different things.
 *
 * `pruneMissing` is for a step that fetches the whole list in one call: what
 * came back is the whole truth, so anything else for this location is gone.
 * A failed fetch throws out of ghl.request rather than returning nothing, so
 * an empty list means a real answer of none, and deleting the lot is right.
 *
 * `pruneStale` is for a step that pages across several cron runs. Nothing can
 * be deleted part way through, because the rows for the pages not fetched yet
 * look exactly like rows that are gone. So it runs only when a pass finishes,
 * and takes out whatever was not touched during it. A row written by something
 * other than the sync, an opportunity created from the board, carries a stamp
 * from after the pass began and survives.
 */
// The only three tables either of these may touch. They interpolate a table
// name, which check-scope cannot follow and which nothing else in this codebase
// does, so the set is written down rather than trusted: these are mirrors of
// somebody else's data, keyed by location, and a name that is not one of them
// is a bug rather than a new feature.
const MIRRORS = new Set(['crm_pipelines', 'crm_opportunities', 'crm_contacts']);

async function pruneMissing(env, table, locationId, ids) {
  if (!MIRRORS.has(table)) throw new Error(`pruneMissing: ${table} is not a CRM mirror`);
  const keep = [...new Set(ids.filter(Boolean))];
  const holes = keep.map(() => '?').join(',');
  const sql = keep.length
    ? `DELETE FROM ${table} WHERE location_id = ? AND id NOT IN (${holes})`
    : `DELETE FROM ${table} WHERE location_id = ?`;
  const res = await env.DB.prepare(sql).bind(locationId, ...keep).run();
  return (res.meta && res.meta.changes) || 0;
}

async function pruneStale(env, table, locationId, since) {
  if (!MIRRORS.has(table)) throw new Error(`pruneStale: ${table} is not a CRM mirror`);
  if (!since) return 0;
  const res = await env.DB.prepare(
    `DELETE FROM ${table} WHERE location_id = ? AND COALESCE(synced_at, 0) < ?`
  ).bind(locationId, since).run();
  return (res.meta && res.meta.changes) || 0;
}

export async function syncPipelines(env, locationId) {
  const pipelines = await ghl.listPipelines(env, locationId);
  for (const p of pipelines) await upsertPipeline(env, locationId, p);
  await pruneMissing(env, 'crm_pipelines', locationId, pipelines.map((p) => p.id));
  await saveState(env, 'pipelines', locationId, {
    status: 'complete', records: pipelines.length,
    started_at: now(), finished_at: now(), detail: null,
  });
  return pipelines.length;
}

export async function syncContacts(env, locationId, { pages = PAGES_PER_RUN } = {}) {
  const state = await getSyncState(env, 'contacts', locationId);
  let cursor = state?.cursor ? JSON.parse(state.cursor) : null;
  let total = state?.status === 'complete' ? 0 : (state?.records || 0);

  const passStart = state?.started_at || now();
  await saveState(env, 'contacts', locationId, {
    status: 'running', started_at: passStart, finished_at: null,
  });

  try {
    for (let i = 0; i < pages; i++) {
      const res = await ghl.listContacts(env, locationId, {
        limit: PAGE_SIZE,
        startAfterId: cursor?.startAfterId,
        startAfter: cursor?.startAfter,
      });

      for (const c of res.contacts) await upsertContact(env, locationId, c);
      total += res.contacts.length;

      // No next cursor, or a short page, means we have reached the end.
      const more = res.contacts.length === PAGE_SIZE && res.nextStartAfterId;
      if (!more) {
        await pruneStale(env, 'crm_contacts', locationId, passStart);
        await saveState(env, 'contacts', locationId, {
          cursor: null, status: 'complete', records: total, finished_at: now(), detail: null,
        });
        return { done: true, records: total };
      }
      cursor = { startAfterId: res.nextStartAfterId, startAfter: res.nextStartAfter };
    }

    await saveState(env, 'contacts', locationId, {
      cursor: JSON.stringify(cursor), status: 'running', records: total,
    });
    return { done: false, records: total };
  } catch (e) {
    await saveState(env, 'contacts', locationId, {
      status: 'error', detail: String(e && e.message ? e.message : e), records: total,
    });
    throw e;
  }
}

export async function syncOpportunities(env, locationId, { pages = PAGES_PER_RUN } = {}) {
  const state = await getSyncState(env, 'opportunities', locationId);
  let page = state?.cursor ? Number(state.cursor) : 1;
  let total = state?.status === 'complete' ? 0 : (state?.records || 0);

  // The start of this pass, not of this run. A pass spans several cron runs and
  // the sweep at the end of it has to spare everything the earlier runs wrote.
  const passStart = state?.started_at || now();
  await saveState(env, 'opportunities', locationId, {
    status: 'running', started_at: passStart, finished_at: null,
  });

  try {
    for (let i = 0; i < pages; i++) {
      const res = await ghl.searchOpportunities(env, locationId, { limit: PAGE_SIZE, page });
      for (const o of res.opportunities) await upsertOpportunity(env, locationId, o);
      total += res.opportunities.length;

      if (res.opportunities.length < PAGE_SIZE) {
        await pruneStale(env, 'crm_opportunities', locationId, passStart);
        await saveState(env, 'opportunities', locationId, {
          cursor: null, status: 'complete', records: total, finished_at: now(), detail: null,
        });
        return { done: true, records: total };
      }
      page += 1;
    }
    await saveState(env, 'opportunities', locationId, {
      cursor: String(page), status: 'running', records: total,
    });
    return { done: false, records: total };
  } catch (e) {
    await saveState(env, 'opportunities', locationId, {
      status: 'error', detail: String(e && e.message ? e.message : e), records: total,
    });
    throw e;
  }
}

/**
 * One scheduled pass. Advances whichever jobs still have work, and no-ops
 * cheaply once everything is complete and recently refreshed.
 */
export async function runSync(env, locationId, { force = false } = {}) {
  if (!ghl.ghlConfigured(env) || !locationId) return { skipped: true };

  const out = {};
  try { out.pipelines = await syncPipelines(env, locationId); }
  catch (e) { out.pipelinesError = String(e.message || e); }

  const contactState = await getSyncState(env, 'contacts', locationId);
  const oppState = await getSyncState(env, 'opportunities', locationId);

  // A completed job is refreshed at most every 15 minutes, so idle cron runs
  // cost one cheap request rather than a full walk.
  const stale = (s) => !s || s.status !== 'complete' || (now() - (s.updated_at || 0)) > 900;

  if (force || stale(contactState)) {
    if (force) await resetSync(env, 'contacts', locationId);
    try { out.contacts = await syncContacts(env, locationId); }
    catch (e) { out.contactsError = String(e.message || e); }
  }
  if (force || stale(oppState)) {
    if (force) await resetSync(env, 'opportunities', locationId);
    try { out.opportunities = await syncOpportunities(env, locationId); }
    catch (e) { out.opportunitiesError = String(e.message || e); }
  }
  return out;
}
