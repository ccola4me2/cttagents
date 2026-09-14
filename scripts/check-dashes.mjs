// Does anything this portal writes contain an em dash?
//
// A house rule, and one nothing else could enforce. Brent does not want them,
// in the portal's own words or in the code that writes them, and thirteen had
// found their way in: two in a client's quote, two in the admin role picker,
// three in dropdowns putting one between a client and a vendor, one in a
// comment. A rule kept
// by remembering is a rule that lasts until the next person, which is why it
// is here rather than in somebody's head.
//
// Both dashes are caught, and both spellings of each: the character and the
// HTML entity. A hyphen, a colon, a comma or the middot this portal already
// uses as its separator all say the same thing and are all easier to type.
//
// Two files match on purpose and are excused by name. Both are reading an em
// dash out of somebody else's text rather than writing one: a pasted vendor
// confirmation, or a supplier's own HTML. Stripping a character we do not use
// is the opposite of using it.
//
//   node scripts/check-dashes.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Keyed by path from the repo root, valued with why it is allowed to match.
const ALLOWED = new Map([
  ['src/confirm.js', 'matches a dash in a pasted vendor confirmation, rather than writing one'],
  ['src/vendors.js', 'strips an em dash out of a supplier\'s own HTML'],
]);

// Every spelling, so replacing the character with the entity is not a way past.
// Built from character codes, not written out. This file is read by the rule
// it carries, and a table of literal dashes would fail it.
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const entity = (name) => `&${name};`;
const DASHES = [
  [EM, 'an em dash'],
  [EN, 'an en dash'],
  [entity('mdash'), 'an em dash, written as an entity'],
  [entity('ndash'), 'an en dash, written as an entity'],
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...walk(full)); continue; }
    if (/\.(js|mjs|html|css|md|sql)$/.test(name)) out.push(full);
  }
  return out;
}

let problems = 0;
let checked = 0;
let excused = 0;

// The scripts are read too, this one included. A rule its own checker is
// exempt from is not a rule, and the dashes above are written as escapes here
// for exactly that reason.
for (const dir of ['src', 'public', 'scripts', 'migrations']) {
  let files;
  try { files = walk(join(ROOT, dir)); } catch { continue; }
  for (const full of files) {
    const rel = relative(ROOT, full);
    const why = ALLOWED.get(rel);
    const lines = readFileSync(full, 'utf8').split('\n');
    checked += 1;
    lines.forEach((line, i) => {
      for (const [dash, name] of DASHES) {
        if (!line.includes(dash)) continue;
        if (why) { excused += 1; return; }
        problems += 1;
        annotate('Dashes', `${rel}:${i + 1} uses ${name}`);
        console.log(`FAIL  ${rel}:${i + 1}  ${name}`);
        console.log(`        ${line.trim().slice(0, 100)}`);
        console.log('        A hyphen, a colon, a comma or a middot instead.');
        return;
      }
    });
  }
}

if (problems) {
  console.log(`\n${problems} line${problems === 1 ? '' : 's'} with a dash this portal does not use.`);
  process.exit(1);
}
console.log(`check-dashes: ${checked} files, no em or en dashes`
  + `${excused ? `, ${excused} line${excused === 1 ? '' : 's'} excused as reading rather than writing` : ''}.`);
