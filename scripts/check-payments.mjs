// Does every money total know about the soft twin?
//
// A final balance is two rows in booking_payments. The hard row is the
// vendor's deadline. The soft row is this portal's own reminder to chase the
// same money a week earlier. They are one obligation stored twice, which is a
// good design for chasing and a trap for arithmetic: any total that sums both
// reports a $2,000 balance as $4,000.
//
// That trap has been walked into five times, on five screens, by me, in one
// day: the reservation tile, the payments table, the payments stat tiles, the
// sales board and the dashboard's Passed tab. Each was fixed where it was
// found, and the next one turned up on the screen next door. Fixing instances
// of a rule nothing enforces is how you keep fixing it.
//
// So the rule is written down here. A SUM over booking_payments.amount_cents
// names payment_class, or it appears below with a reason somebody thought
// about.
//
//   node scripts/check-payments.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Totals that deliberately count every row, and why that is right.
//
// Matched on a distinctive fragment of the statement. An entry is a claim that
// somebody checked, which is the point of writing it down rather than widening
// the rule until nothing fails.
const ALLOWED = [
  // Nothing yet. When the first real exception turns up it goes here with its
  // reason, rather than the check being loosened to let it through quietly.
];

/** Statements in a file, with the line each starts on. */
function statements(source) {
  const out = [];
  for (const m of source.matchAll(/`([^`]*)`/g)) {
    out.push({ sql: m[1], line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

export function paymentProblems(root = ROOT) {
  const dir = join(root, 'src');
  const problems = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    // Generated, and a list of column names rather than a query.
    if (file === 'schema-expected.js') continue;
    const source = readFileSync(join(dir, file), 'utf8');

    for (const { sql, line } of statements(source)) {
      if (!/booking_payments/i.test(sql)) continue;
      // Comments inside the SQL mention payment_class when explaining the
      // rule, which would excuse a statement that does not apply it.
      const bare = sql.replace(/--[^\n]*/g, '');
      const sums = bare.match(/SUM\s*\([^)]*amount_cents[^)]*\)/gi) || [];
      if (!sums.length) continue;
      if (ALLOWED.some(([fragment]) => sql.includes(fragment))) continue;

      // A statement whose WHERE already pins the class has answered the
      // question for every total in it.
      const pinned = /WHERE[\s\S]*payment_class/i.test(bare);
      if (pinned) continue;

      // Otherwise each total answers for itself. Checking the statement as a
      // whole was the first version of this check and it was too coarse to
      // catch the bug that prompted it: paymentStats filtered the class on its
      // posted and outstanding sums and not on past_due, so the statement
      // mentioned payment_class and the wrong total sailed through.
      const bad = sums.filter((sum) => !/payment_class/i.test(sum));
      if (!bad.length) continue;

      problems.push({
        where: `${relative(root, join(dir, file))}:${line}`,
        sums: bad.map((x) => x.replace(/\s+/g, ' ')),
      });
    }
  }

  return problems;
}

const problems = paymentProblems();
if (problems.length) {
  console.error(
    `check-payments: ${problems.length} total${problems.length === 1 ? '' : 's'} `
    + 'over booking_payments that never mention payment_class.\n\n'
    + 'A soft row is the same balance as its hard twin, a week early. Summing\n'
    + 'both counts the money twice. Add the class filter, or add the statement\n'
    + 'to ALLOWED in this file with the reason it is right.\n');
  for (const p of problems) {
    console.error(`  ${p.where}`);
    for (const s of p.sums) console.error(`      ${s}`);
    annotate('Payment totals', `${p.where}: ${p.sums.join(' ')} does not name payment_class`);
  }
  process.exit(1);
}

console.log('check-payments: every total over booking_payments names payment_class');
