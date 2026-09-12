// Is the migration sequence unambiguous?
//
// This exists because of a real outage, and the outage was invisible for days.
//
// This portal is a fork. Upstream reached 0054 on its own and so did this
// repo, so the fork ended up holding 0054_itinerary.sql and
// 0054_session_acting_as.sql, then the same again at 0056 and 0057. Nothing
// complained. The files sort, the schema builds, every check passed.
//
// What broke was the part no script was watching: a person applying migrations
// by hand reads the numbers, applies "up to 58", and never notices that three
// numbers had two files each. Three migrations were skipped. Weeks later the
// bookings table was missing two columns, every call to /api/bookings answered
// 500, and the symptom that reached anybody was a Status dropdown on the new
// reservation form that would not open.
//
// So the rule is that a number belongs to one migration. It is not about
// ordering, which happens to survive on filename sort; it is about a human
// being able to say which migrations they have applied.
//
//   node scripts/check-migrations.mjs

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function migrationProblems(root = ROOT) {
  const files = readdirSync(join(root, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const problems = [];
  const byNumber = new Map();

  for (const file of files) {
    const m = file.match(/^(\d{4})_[\w-]+\.sql$/);
    if (!m) {
      // A file that does not carry a number cannot be placed in the sequence,
      // so nobody can say whether it has been applied.
      problems.push(`${file} is not named NNNN_something.sql`);
      continue;
    }
    const list = byNumber.get(m[1]) || [];
    list.push(file);
    byNumber.set(m[1], list);
  }

  for (const [number, list] of [...byNumber].sort()) {
    if (list.length > 1) {
      problems.push(
        `${number} is used by ${list.length} migrations: ${list.join(', ')}. `
        + 'Renumber all but one onto the end of the sequence, so "applied up to N" '
        + 'means one thing.'
      );
    }
  }

  // A gap is not an error. Migrations get abandoned before they are merged and
  // renumbering the rest to close the hole would renumber files other people
  // have already applied, which is worse than the gap.

  return problems;
}

const problems = migrationProblems();
if (problems.length) {
  console.error(`check-migrations: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const total = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).length;
console.log(`check-migrations: ${total} migrations, every number used once`);
