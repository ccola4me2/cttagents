// Is every route in worker.js somewhere it can actually be reached?
//
// routeRequest hands anything starting with /api/ to routeApi and everything
// else to routePage. So a route defined inside routeApi that does not begin
// /api/ is dead code that looks exactly like working code: the handler is
// written, the matcher is correct, the import resolves, and the address
// answers a static 404.
//
// That is not hypothetical. /u/<token>, the unsubscribe link carried by every
// marketing email this portal sends, sat inside routeApi for as long as it
// existed. Nothing noticed, because nothing was looking: check-routes asks
// whether the pages' addresses are answered, and no page calls /u/. The only
// caller is a client's mail client, weeks later.
//
// Also: a page route pointing at a file that is not there. The address is in
// the map, the nav links to it, and it 404s.
//
//   node scripts/check-wiring.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src', 'worker.js'), 'utf8');

/** The body of a named function declaration, by brace depth. */
function bodyOf(name) {
  const at = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at === -1) return null;
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (!depth) return source.slice(open, i);
    }
  }
  return null;
}

const problems = [];

// ---------------------------------------------------------------------------
// Every address routeApi answers has to start with /api/
// ---------------------------------------------------------------------------

const apiBody = bodyOf('routeApi');
if (!apiBody) {
  problems.push('routeApi is not a function declaration in worker.js any more, '
    + 'so this check cannot see its routes');
} else {
  // path === '/somewhere'
  for (const m of apiBody.matchAll(/path\s*===\s*'([^']+)'/g)) {
    if (!m[1].startsWith('/api/')) {
      problems.push(`routeApi answers ${m[1]}, which never reaches it: `
        + 'routeRequest sends anything outside /api/ to routePage');
    }
  }
  // path.match(/^\/somewhere\/...
  for (const m of apiBody.matchAll(/path\.match\(\/\^\\\/([A-Za-z_][\w-]*)/g)) {
    if (m[1] !== 'api') {
      problems.push(`routeApi matches /${m[1]}/..., which never reaches it: `
        + 'routeRequest sends anything outside /api/ to routePage');
    }
  }
}

// ---------------------------------------------------------------------------
// Every page route points at a file that exists
// ---------------------------------------------------------------------------

// The map is a series of '/address': '/file.html' pairs. Read as pairs rather
// than by finding the object, so a rename of the constant does not silently
// turn this half of the check off.
let pages = 0;
for (const m of source.matchAll(/'(\/[\w/.-]*)':\s*'(\/[\w/.-]+\.html)'/g)) {
  pages += 1;
  const file = join(ROOT, 'public', m[2]);
  if (!existsSync(file)) {
    problems.push(`${m[1]} is routed to public${m[2]}, which is not there`);
  }
}
if (!pages) {
  problems.push('no page routes found in worker.js, so this check saw nothing');
}

// ---------------------------------------------------------------------------

if (problems.length) {
  console.error(`check-wiring: ${problems.length} route${problems.length === 1 ? '' : 's'} `
    + 'cannot be reached.\n');
  for (const p of problems) {
    console.error(`  ${p}`);
    annotate('Wiring', p);
  }
  process.exit(1);
}

console.log(`check-wiring: every routeApi address is under /api/, and all ${pages} `
  + 'page routes point at a file that exists');
