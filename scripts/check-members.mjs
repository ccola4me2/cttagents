// Does the module you imported actually have the thing you reached for?
//
// `import { reservationPipeline } from './db.js'` is caught by the bundler the
// moment the export is gone: a named import that does not exist is a build
// error and never reaches anybody. `import * as db from './db.js'` is not.
// db.reservationPipeline is just a property lookup, and a property that is not
// there is undefined, and undefined is only a problem at the instant somebody
// calls it.
//
// So trip-vara's Pipeline page threw on every load for four days. src/db.js
// had lost reservationPipeline and RESERVATION_STAGES when the CRM went, and
// src/pipeline.js went on asking for them. Every offline check passed, the
// deploy succeeded, and the page 500ed. Nothing in this repository was looking
// at the one thing that was wrong.
//
// This is that one thing: for every `import * as NS from './mod.js'`, each
// NS.member has to be something mod.js exports.
//
//   node scripts/check-members.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/**
 * What a module offers by name.
 *
 * Every shape the source actually uses: a function, an async function, a
 * const, a class, and a re-export list. Deliberately not a parser. A form this
 * misses shows up as a false failure on a working call, which is loud, and a
 * checker that fails loudly on something real is fixed the same day.
 */
function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();

  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const as = bit.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(dir, e.name));
}

const problems = [];

for (const file of sourceFiles(SRC)) {
  const src = readFileSync(file, 'utf8');
  // The import lines themselves are not uses. `from './db.js'` contains the
  // text db.js, which read as a member lookup says db.js is not exported by
  // db.js, once per file, which is a checker nobody would run twice.
  const body = src.replace(/^import\b[\s\S]*?from\s*['"][^'"]+['"];?$/gm,
    (m) => m.replace(/\S/g, ' '));

  // import * as NS from './mod.js'
  for (const imp of src.matchAll(
    /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"](\.[^'"]+)['"]/g
  )) {
    const [, ns, spec] = imp;
    const target = resolve(dirname(file), spec);
    let offered;
    try {
      offered = exportsOf(target);
    } catch {
      problems.push({
        file, line: 1,
        message: `imports * as ${ns} from ${spec}, which is not a file that exists.`,
      });
      continue;
    }

    const seen = new Set();
    for (const use of body.matchAll(
      new RegExp(`\\b${ns}\\.([A-Za-z_$][\\w$]*)`, 'g')
    )) {
      const member = use[1];
      if (seen.has(member) || offered.has(member)) continue;
      seen.add(member);
      problems.push({
        file,
        line: body.slice(0, use.index).split('\n').length,
        message: `${ns}.${member} is not exported by ${spec}. `
          + 'A missing member on a namespace import is undefined rather than an '
          + 'error, so this throws the first time it is called and nothing before '
          + 'then says so.',
      });
    }
  }
}

for (const p of problems) {
  console.log(`FAIL  ${relative(ROOT, p.file)}:${p.line}`);
  console.log(`        ${p.message}`);
}

console.log(`\n${problems.length} problem(s)`);
report('Members', problems, (p) => `${relative(ROOT, p.file)}:${p.line} ${p.message}`);
