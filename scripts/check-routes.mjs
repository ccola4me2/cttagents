// Does the router answer the addresses the pages actually call?
//
// The group page asked for /api/group-registrations/<id>/book and the router
// listened on /api/groups/registrations/<id>/book. Every other check passed:
// the page parsed, the handler existed, and the smoke suite called the
// router's own path and got a 200 back. The only thing that did not work was
// the button, which is the only part a person touches.
//
// Nothing else compares the two sides. The contract checker reads what a page
// does with a response, the smoke suite drives the API, and neither notices
// that the two are talking about different addresses.
//
// Matching is done segment by segment rather than by making up a path and
// running the router's regex over it. A route that names its options, like
// /api/account/(tags|custom-values|custom-fields), rejects any stand-in
// segment invented here, and a checker that reports working pages as broken
// gets switched off within a week.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const HOLE = 'QQHOLEQQ';

function pageFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(html|js)$/.test(e.name)) out.push(full);
    }
  };
  walk(join(root, 'public'));
  return out;
}

/** The API paths one file asks for, as segment lists. */
function calledPaths(src) {
  const found = new Set();

  // Strings tested against rather than fetched. api() checks whether a path
  // it was given starts with /api/auth/, which is not a call to anything.
  const tested = new Set(
    [...src.matchAll(/startsWith\(\s*['"`](\/api\/[^'"`]*)/g)].map((m) => m[1])
  );

  for (const m of src.matchAll(/['"`](\/api\/[^'"`\s]*)/g)) {
    const raw = m[1];
    if ([...tested].some((t) => raw === t || raw === t.replace(/\/$/, ''))) continue;

    let p = raw.replace(/\$\{[^}]*\}/g, HOLE);

    // An expression with no closing brace inside the quoted run. Whatever it
    // is, it ends the knowable part of the path: if it follows a slash the
    // segment is unknown, and if it follows text it is a suffix or a query on
    // a segment that is already named.
    const open = p.indexOf('${');
    if (open !== -1) p = p.slice(0, open) + (p[open - 1] === '/' ? HOLE : '');

    p = p.split('?')[0].replace(/\/+$/, '');
    if (!p.startsWith('/api/')) continue;

    const segs = p.split('/').slice(1).map((s) => (s.includes(HOLE) ? null : s));
    // Nothing but a placeholder says nothing about where it went.
    if (segs.length < 2 || segs.every((s) => s === null)) continue;
    found.add(JSON.stringify(segs));
  }
  return [...found].map((s) => JSON.parse(s));
}

const worker = readFileSync(join(root, 'src', 'worker.js'), 'utf8');

// Exact routes, as segment lists.
const literals = [...worker.matchAll(/path === '(\/api\/[^']*)'/g)]
  .map((m) => m[1].split('/').slice(1));

/**
 * The regex routes, read as segments.
 *
 * Captured to the closing "/)" rather than the first ")", which falls inside
 * ([^/]+) and truncated every pattern into something that would not compile.
 */
const patterns = [];
for (const m of worker.matchAll(/path\.match\((\/\^[\s\S]*?\/)\)/g)) {
  const body = m[1].slice(1, -1);
  if (!body.startsWith('^\\/api')) continue;
  const cleaned = body.replace(/^\^/, '').replace(/\$$/, '');
  // Split on the escaped slashes that separate segments, ignoring any inside
  // a character class such as [^/]+.
  const segs = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (ch === '\\' && cleaned[i + 1] === '/' && depth === 0) {
      segs.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  // A trailing "(?:\/)?" or similar leaves an empty last segment.
  patterns.push(segs.filter((s, i) => s !== '' || i === 0).map((s) => {
    // A plain word is a literal segment; anything else takes any one segment.
    const plain = s.replace(/\?$/, '');
    return /^[A-Za-z0-9_-]+$/.test(plain) ? plain : null;
  }).slice(1));
}

if (!patterns.length) {
  console.log('FAIL  no route patterns were read out of worker.js at all');
  console.log('        this checker is broken, not the router');
  process.exit(1);
}

/** A called path fits a route when every named segment lines up. */
function fits(called, route) {
  if (called.length !== route.length) return false;
  return called.every((seg, i) => {
    const want = route[i];
    // Either side unknown: any one segment goes there.
    if (want === null || seg === null) return true;
    return want === seg;
  });
}

const seen = new Map();
for (const file of pageFiles()) {
  for (const segs of calledPaths(readFileSync(file, 'utf8'))) {
    const key = JSON.stringify(segs);
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(file.replace(`${root}/`, ''));
  }
}

let missing = 0;
for (const [key, where] of [...seen].sort()) {
  const segs = JSON.parse(key);
  const shown = `/${segs.map((s) => (s === null ? ':x' : s)).join('/')}`;
  const ok = literals.some((r) => fits(segs, r)) || patterns.some((r) => fits(segs, r));
  if (ok) continue;
  missing += 1;
  console.log(`FAIL  ${shown}`);
  console.log(`        called by ${[...where].sort().join(', ')}`);
  console.log('        nothing in worker.js answers this address');
}

console.log('');
if (missing) {
  console.log(`${missing} of ${seen.size} addresses the pages call have no route.`);
  process.exit(1);
}
console.log(
  `All ${seen.size} addresses the pages call are routed. `
  + `(${patterns.length} patterns, ${literals.length} exact)`
);
