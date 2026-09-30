/**
 * The course points at things that still exist.
 *
 * Every lesson names a section of the manual and a page to do the work on.
 * Both are strings in a different file from the thing they refer to, which is
 * the arrangement that rots: a manual section gets renamed, a page gets moved,
 * and the only person who finds out is a brand new advisor following a link on
 * their first morning. That is the worst possible person to find out.
 *
 * So the strings are checked against the real files. Anchors against the
 * manual's own ids, pages against what is on disk under public/.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LESSONS } from '../src/training.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::training: ${label}: ${detail}`);
};

console.log('\nThe getting started course');

const manual = readFileSync(join(PUBLIC, 'app/manual.html'), 'utf8');
const anchors = new Set([...manual.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const seen = new Set();
for (const l of LESSONS) {
  if (seen.has(l.key)) bad(`lesson ${l.key}`, 'two lessons share a key');
  seen.add(l.key);

  for (const field of ['title', 'why', 'doing', 'manual', 'page']) {
    if (!l[field] || !String(l[field]).trim()) bad(`lesson ${l.key}`, `${field} is empty`);
  }

  if (anchors.has(l.manual)) ok(`${l.key}: manual has #${l.manual}`);
  else bad(`${l.key}: manual anchor`, `#${l.manual} is not an id in app/manual.html`);

  // "/app/clients" is public/app/clients.html; "/app/manual#boards" is the
  // same file with a fragment, and a trailing slash means the directory index.
  const [path, frag] = l.page.split('#');
  const rel = path.replace(/^\//, '');
  const file = path.endsWith('/') ? join(PUBLIC, rel, 'index.html') : join(PUBLIC, `${rel}.html`);
  if (existsSync(file)) ok(`${l.key}: page ${path} exists`);
  else bad(`${l.key}: page`, `${path} is not a file under public/`);

  if (frag && !anchors.has(frag) && path === '/app/manual') {
    bad(`${l.key}: page fragment`, `#${frag} is not an id in app/manual.html`);
  }
}

// The page numbers the lessons, so the order in the file is the order somebody
// is taught in. Worth one assertion that it has not been shuffled by accident.
if (LESSONS[0].key === 'start') ok('the course still starts at the beginning');
else bad('order', `first lesson is ${LESSONS[0].key}, expected start`);

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) { console.log(`${failures} failed`); process.exit(1); }
