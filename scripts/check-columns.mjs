// Do the hand-written column lists still match the schema?
//
// Every read in this codebase names its columns in a shared constant:
//
//   const PAYMENT_COLUMNS = `p.id, p.booking_id, p.kind, ...`;
//
// which is good for consistency and has one failure mode, hit three times in
// one week. A migration adds a column, the constant is not updated, and the
// write succeeds while the read comes back undefined. Nothing throws. The
// field is simply always empty, and the bug is found later by a person
// wondering why a value they typed will not stay typed.
//
// So: build the real schema from the migrations, find every column list in
// src/, work out which table each one reads, and compare. Reported both ways.
// A column in the schema and not in the list is the bug above. A column in the
// list and not in the schema is a rename or a typo, which fails loudly at
// runtime but only on the path that runs the query.
//
// What it does not cover: a SELECT written inline rather than through a shared
// constant. Those are deliberately narrow, so a column missing from one is not
// evidence of anything, and checking them would report noise. The answer to an
// inline list that drifts is to delete it and use the constant, which is what
// the reservation record now does with PAYMENT_COLUMNS.
//
// Runs offline against the files. No database, no dev server.
//
//   node scripts/check-columns.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { schemaFromMigrations } from './lib/schema.mjs';
import { render, TARGET } from './gen-schema.mjs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Columns a list leaves out on purpose. Anything here needs a reason, because
// the whole point of the check is that silence is not evidence of intent.
const DELIBERATE = {
  users: {
    password_hash: 'read only by the sign-in path, which selects it explicitly',
  },
};

// ---------------------------------------------------------------------------
// The schema, as the migrations actually leave it
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The column lists, as the source actually writes them
// ---------------------------------------------------------------------------

/** A list is only a column list if every entry is a plain, optionally aliased, name. */
function parseList(body) {
  const entries = body.split(',').map((e) => e.trim()).filter(Boolean);
  if (!entries.length) return null;
  const columns = [];
  for (const entry of entries) {
    const m = entry.match(/^(?:([A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)$/);
    // Anything else (a COALESCE, a CASE, an AS alias) means this constant is
    // an expression rather than a column list, and comparing it to a table
    // would produce noise. Skipped rather than guessed at.
    if (!m) return null;
    columns.push(m[2]);
  }
  return columns;
}

/**
 * The table a column list is selected from.
 *
 * The first FROM after the constant is the wrong answer: these queries carry
 * correlated subqueries, so `SELECT ${CLIENT_COLUMNS}, (SELECT COUNT(*) FROM
 * bookings ...) FROM clients c` would report the list as reading bookings and
 * then declare twenty-six columns missing from it. So the search tracks
 * bracket depth and takes the first FROM belonging to the outer query.
 */
function tableFor(src, name) {
  const token = `\${${name}}`;
  let from = src.indexOf(token);
  while (from !== -1) {
    let depth = 0;
    for (let i = from + token.length; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') { depth += 1; continue; }
      if (ch === ')') { depth -= 1; continue; }
      // The end of this template literal: the constant was never selected
      // from anything here, so try the next place it is used.
      if (ch === '`') break;
      if (depth === 0 && /f/i.test(ch)) {
        const m = src.slice(i).match(/^FROM\s+([A-Za-z_][\w]*)/i);
        if (m) return m[1];
      }
    }
    from = src.indexOf(token, from + 1);
  }
  return null;
}

function listsFromSource() {
  const dir = join(ROOT, 'src');
  const found = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const src = readFileSync(join(dir, file), 'utf8');

    for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`/g)) {
      const [, name, body] = m;
      if (body.includes('${')) continue;
      const columns = parseList(body);
      if (!columns) continue;

      // Which table does it read? Worked out from the query rather than
      // declared in a comment, so a list that starts being used against a
      // different table is noticed instead of being taken on trust.
      found.push({ file: basename(file), name, columns, table: tableFor(src, name) });
    }
  }

  return found;
}

// ---------------------------------------------------------------------------

const tables = schemaFromMigrations(ROOT);
const lists = listsFromSource();

let problems = 0;
let checked = 0;
const skipped = [];

for (const list of lists) {
  if (!list.table) { skipped.push(`${list.file} ${list.name}: never used in a FROM`); continue; }
  const schema = tables.get(list.table);
  if (!schema) { skipped.push(`${list.file} ${list.name}: no table "${list.table}" in the migrations`); continue; }

  checked += 1;
  const have = new Set(list.columns);
  const excused = DELIBERATE[list.table] || {};

  const missing = [...schema].filter((c) => !have.has(c) && !excused[c]);
  const unknown = list.columns.filter((c) => !schema.has(c));

  if (!missing.length && !unknown.length) {
    console.log(`ok    ${list.file} ${list.name} -> ${list.table} (${list.columns.length} columns)`);
    continue;
  }

  problems += 1;
  annotate('Column list', `${list.file} ${list.name} -> ${list.table}: `
    + [missing.length ? `missing ${missing.join(', ')}` : '',
       unknown.length ? `not in the table: ${unknown.join(', ')}` : ''].filter(Boolean).join('; '));
  console.log(`FAIL  ${list.file} ${list.name} -> ${list.table}`);
  if (missing.length) {
    console.log(`        in the table, not in the list: ${missing.join(', ')}`);
    console.log('        reads of these come back undefined, silently');
  }
  if (unknown.length) {
    console.log(`        in the list, not in the table: ${unknown.join(', ')}`);
  }
}

for (const note of skipped) console.log(`~     ${note}`);

// The Worker ships a copy of the schema so it can check the live database
// against it at runtime. Generated, so this only has to confirm nobody added a
// migration and forgot to regenerate.
let generated = '';
try { generated = readFileSync(TARGET, 'utf8'); } catch { /* absent counts as stale */ }
if (generated !== render(ROOT)) {
  problems += 1;
  annotate('Column list', 'src/schema-expected.js is stale: run node scripts/gen-schema.mjs');
  console.log('FAIL  src/schema-expected.js is stale');
  console.log('        run: node scripts/gen-schema.mjs');
} else {
  console.log('ok    src/schema-expected.js matches the migrations');
}

console.log('');
if (problems) {
  console.log(`${problems} column list${problems === 1 ? '' : 's'} out of step with the schema.`);
  process.exit(1);
}
console.log(`All ${checked} column lists match the schema.`);
