// The schema as the migrations actually leave it.
//
// Shared, because two checks need the same answer and a second copy of a SQL
// parser is a second thing to be subtly wrong. Which tables belong to an
// advisor is read from the schema rather than listed by hand, so a table added
// next month is covered the day it is created instead of the day somebody
// remembers to add it to a list.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CONSTRAINT = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i;

/**
 * @param root       repository root
 * @param options    { origins } an optional Map filled with "table.column" ->
 *                   the migration file that introduces it, so a missing column
 *                   can name the file that would add it.
 */
export function schemaFromMigrations(root, { origins } = {}) {
  const dir = join(root, 'migrations');
  const tables = new Map();

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8')
      // Comments first: a column named inside one is not a column.
      .replace(/--[^\n]*/g, '');

    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\s*\(([\s\S]*?)\n\s*\);/gi)) {
      const [, table, body] = m;
      const cols = tables.get(table) || new Set();
      // Split on commas that are not inside brackets, so DEFAULT (a, b) and
      // CHECK (x IN ('a','b')) do not each look like a new column.
      let depth = 0;
      let current = '';
      const parts = [];
      for (const ch of body) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += ch;
      }
      parts.push(current);

      for (const part of parts) {
        const line = part.trim();
        if (!line || CONSTRAINT.test(line)) continue;
        const name = line.match(/^([A-Za-z_][\w]*)/);
        if (name) {
          cols.add(name[1]);
          if (origins && !origins.has(`${table}.${name[1]}`)) origins.set(`${table}.${name[1]}`, file);
        }
      }
      tables.set(table, cols);
    }

    for (const m of sql.matchAll(/ALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+ADD\s+COLUMN\s+([A-Za-z_][\w]*)/gi)) {
      const [, table, col] = m;
      const cols = tables.get(table) || new Set();
      cols.add(col);
      tables.set(table, cols);
      if (origins && !origins.has(`${table}.${col}`)) origins.set(`${table}.${col}`, file);
    }

    // A rename is the one edit that both adds and removes. Without this the
    // expected schema keeps the old name for ever, so /api/admin/health reports
    // the new column as an extra and the old one as missing, on a database that
    // is in fact correct. The origin moves with the name, because the file that
    // renames a column is the file that would put it there.
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+RENAME\s+COLUMN\s+([A-Za-z_][\w]*)\s+TO\s+([A-Za-z_][\w]*)/gi)) {
      const [, table, from, to] = m;
      const cols = tables.get(table) || new Set();
      cols.delete(from);
      cols.add(to);
      tables.set(table, cols);
      if (origins) {
        origins.delete(`${table}.${from}`);
        origins.set(`${table}.${to}`, file);
      }
    }
  }

  return tables;
}

/** Tables with a user_id column: rows that belong to one advisor. */
export function ownedTables(tables) {
  return new Set([...tables].filter(([, cols]) => cols.has('user_id')).map(([name]) => name));
}

/** Tables scoped to a whole agency rather than to one advisor. */
export function agencyTables(tables) {
  return new Set([...tables]
    .filter(([, cols]) => !cols.has('user_id') && cols.has('agency_id'))
    .map(([name]) => name));
}
