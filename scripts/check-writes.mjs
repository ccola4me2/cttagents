// Do two full-record saves of the same table agree about its columns?
//
// A table usually has one statement that writes the whole record. When it has
// two, they should set the same fields, and when they do not, one of them is
// almost always missing something rather than deliberately leaving it out.
//
// That is not a guess. handleUpdateClient wrote every field on a client except
// nickname and source, which upsertClient a hundred lines above it did write.
// Nothing failed: the write succeeded, the columns were simply not in the
// statement, and the value came back unchanged. You could record what somebody
// went by when you first added them and never correct it, and "where they came
// from" was the same field, which is the only one that answers which of your
// marketing is working.
//
// check-columns exists for this failure and reads SELECT lists, so it had
// nothing to say about an UPDATE. This is the other half.
//
// Only statements setting eight columns or more, because that is what makes
// one a full-record save rather than a stamp on one field. updated_at is
// ignored for the same reason a comma is.
//
//   node scripts/check-writes.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FULL_RECORD = 8;

// Statements that leave a column out on purpose, and why. Matched on
// "table:column" plus a fragment of the statement, so an entry excuses one
// omission in one place rather than the column everywhere.
//
// Every entry is a claim somebody checked. That is the point of writing them
// down instead of raising the threshold until nothing fails.
const ALLOWED = [
  ['clients:name', 'UPDATE clients SET email = ?',
    'the create path, which fills in blanks on somebody already on the books. It is '
    + 'reached by name, so renaming from it would rename the person it just matched'],
  ['clients:ghl_contact_id', 'UPDATE clients SET name = ?',
    'the edit form has no CRM field. The link is made when a contact is turned into a '
    + 'client and is not the sort of thing to clear by saving a phone number'],
  ['vendors:favourite', 'UPDATE vendors SET name = ?',
    'the star has its own endpoint. Writing it from a form with no star field cleared '
    + 'the star every time a supplier was edited, which is how it got one'],
];

// The partner list is what a supplier's own record says about them, and the
// edit form does not show any of it. Listed as a group because the reason is
// one reason rather than six.
for (const column of ['partner_status', 'travel_types', 'budget_category', 'bdm_info',
  'vendor_login', 'categories_json']) {
  ALLOWED.push([`vendors:${column}`, 'UPDATE vendors SET name = ?',
    'comes from the partner list import, which is the record for it, and is shown on '
    + 'the supplier page rather than edited there']);
}

// And the other way: the import refreshes what the partner list knows and has
// no business touching what an advisor negotiated or typed.
for (const column of ['name', 'email', 'phone', 'website', 'portal_url', 'signup_url',
  'account_number', 'commission_pct', 'deposit_days', 'final_days']) {
  ALLOWED.push([`vendors:${column}`, 'UPDATE vendors SET\n           category = COALESCE(?, category)',
    'the supplier list import. It matched on the name and must not rewrite the terms '
    + 'an advisor negotiated or the addresses they corrected']);
}

/** Constants that are whole SQL fragments, so a SET list built from one is seen. */
function constants(sources) {
  const found = new Map();
  for (const src of sources) {
    for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`/g)) {
      if (!m[2].includes('${')) found.set(m[1], m[2]);
    }
  }
  return found;
}

const files = readdirSync(join(ROOT, 'src'))
  .filter((f) => f.endsWith('.js') && f !== 'schema-expected.js').sort()
  .map((f) => [f, readFileSync(join(ROOT, 'src', f), 'utf8')]);

const CONSTANTS = constants(files.map(([, src]) => src));
const expand = (sql) => sql.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) =>
  (CONSTANTS.has(name) ? CONSTANTS.get(name) : ''));

const byTable = new Map();
for (const [file, src] of files) {
  for (const m of src.matchAll(/`([^`]*)`/g)) {
    const sql = expand(m[1]);
    // Comments out first. A SET list is read up to its WHERE, and the comment
    // above one of these statements says "Filled where blank", which ended the
    // list four columns early and hid the very omission this check went on to
    // report. Found by running the check over the commit it was written for.
    const bare = sql.replace(/--[^\n]*/g, '');
    for (const u of bare.matchAll(/UPDATE\s+([A-Za-z_]\w*)\s+SET\s+([\s\S]*?)(?:\sWHERE\s|$)/gi)) {
      const columns = new Set([...u[2].matchAll(/([A-Za-z_]\w*)\s*=/g)].map((c) => c[1]));
      columns.delete('updated_at');
      if (columns.size < FULL_RECORD) continue;
      const line = src.slice(0, m.index).split('\n').length;
      if (!byTable.has(u[1])) byTable.set(u[1], []);
      byTable.get(u[1]).push({ where: `src/${file}:${line}`, columns, sql });
    }
  }
}

let problems = 0;
for (const [table, saves] of [...byTable].sort()) {
  if (saves.length < 2) continue;
  const everything = new Set(saves.flatMap((s) => [...s.columns]));
  for (const save of saves) {
    const gaps = [...everything].filter((c) => !save.columns.has(c)).sort()
      .filter((c) => !ALLOWED.some(([key, fragment]) =>
        key === `${table}:${c}` && save.sql.includes(fragment)));
    if (!gaps.length) continue;
    problems += 1;
    const message = `${save.where} saves ${table} without ${gaps.join(', ')}, `
      + 'which another full save of the same table sets';
    console.log(`FAIL  ${message}`);
    console.log('        either add them, or add the reason to ALLOWED in this file');
    annotate('Write list', message);
  }
}

console.log('');
if (problems) {
  console.log(`${problems} full-record save${problems === 1 ? '' : 's'} disagree with `
    + 'another save of the same table.');
  process.exit(1);
}
console.log(`check-writes: every full-record save agrees with the others on its table `
  + `(${[...byTable.values()].filter((v) => v.length > 1).length} tables with more than one)`);
