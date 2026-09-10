// Does the database match the migrations?
//
// Migrations here are applied by hand, so "written" and "applied" are two
// different facts and only one of them is visible in the repository. When they
// disagree the symptom is a 500 from whichever page happens to read the
// missing column, with nothing in the code to look at, because the code is
// right. 0016_reminders.sql went unapplied and took the Payments page down;
// the query, the column list and every offline check were all correct.
//
// This asks the database directly and names what is missing. A page that
// cannot load is then a question with an answer instead of a mystery.

import { EXPECTED_SCHEMA, COLUMN_ORIGIN } from './schema-expected.js';

const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The migration that creates a table: the earliest file any of its columns
 * came from.
 *
 * Not the first one found. A table's columns are held in alphabetical order,
 * and a column added by a later ALTER TABLE sorts wherever its name puts it,
 * so the first entry is often not from the CREATE TABLE at all. `users` is the
 * clearest case: seven migrations touch it, and the alphabetically first
 * column is `agency_address`, added in 0026, which had this naming 0026 as the
 * file to run when the whole table was missing and the answer was 0001.
 *
 * Comparing the filenames as strings is enough to order them, because every
 * migration is named with the same zero-padded four-digit prefix.
 */
function tableOrigin(table) {
  let earliest = null;
  for (const col of EXPECTED_SCHEMA[table] || []) {
    const file = COLUMN_ORIGIN[`${table}.${col}`];
    if (file && (earliest === null || file < earliest)) earliest = file;
  }
  return earliest;
}

/**
 * Compare the live schema against what the migrations describe.
 *
 * Returns { ok, missingTables, missingColumns, checked }. Extra columns and
 * extra tables are not reported: a column the migrations no longer mention is
 * harmless, and treating it as a fault would make the check cry wolf on every
 * table left behind by a migration that dropped something.
 */
export async function schemaDrift(env) {
  const names = Object.keys(EXPECTED_SCHEMA).filter((t) => SAFE.test(t));

  // PRAGMA cannot take a bound parameter, hence the regex above: every name
  // comes from the generated file, and is checked anyway rather than trusted.
  let results;
  try {
    results = await env.DB.batch(names.map((t) => env.DB.prepare(`PRAGMA table_info(${t})`)));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), checked: 0, missingTables: [], missingColumns: [] };
  }

  const missingTables = [];
  const missingColumns = [];

  names.forEach((table, i) => {
    const rows = results[i]?.results || [];
    if (!rows.length) { missingTables.push(table); return; }
    const live = new Set(rows.map((r) => r.name));
    const absent = EXPECTED_SCHEMA[table].filter((c) => !live.has(c));
    if (absent.length) {
      const files = [...new Set(absent.map((c) => COLUMN_ORIGIN[`${table}.${c}`]).filter(Boolean))];
      missingColumns.push({ table, columns: absent, migrations: files });
    }
  });

  // Both kinds of absence, in one list. Built from missing columns alone at
  // first, which made pendingMigrations report nothing while missingTables
  // named a table: the one field meant to be the summary was the one that
  // left something out.
  const pending = [...new Set([
    ...missingTables.map(tableOrigin),
    ...missingColumns.flatMap((m) => m.migrations),
  ].filter(Boolean))].sort();

  return {
    ok: !missingTables.length && !missingColumns.length,
    checked: names.length,
    missingTables,
    missingColumns,
    // The migrations that would fix it, which is the only part anyone has to
    // act on.
    pendingMigrations: pending,
  };
}

/**
 * A one-line explanation for a D1 error that is really an unapplied migration.
 *
 * Returns null for anything else. The router adds this to its 500 so the page
 * that broke says what to run, instead of leaving somebody to work out that a
 * correct query against a stale database looks exactly like a bug in the code.
 */
export function migrationHint(message) {
  const m = /no such (column|table): (?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)/.exec(String(message || ''));
  if (!m) return null;
  const [, what, name] = m;

  if (what === 'table') {
    if (!EXPECTED_SCHEMA[name]) return null;
    const file = tableOrigin(name);
    return file
      ? `Table "${name}" is missing: run migration ${file}. See /api/admin/health for the full list.`
      : `Table "${name}" is missing: the database has not had every migration applied.`;
  }

  const key = Object.keys(COLUMN_ORIGIN).find((k) => k.endsWith(`.${name}`));
  if (!key) return null;
  return `Column "${name}" is missing: run migration ${COLUMN_ORIGIN[key]}. See /api/admin/health for the full list.`;
}
