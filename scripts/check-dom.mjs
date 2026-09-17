// Does the markup have the thing the script reaches for?
//
// A page is two halves that nothing connects: markup that declares ids and
// attributes, and a module that looks them up by name. Delete a dialog, port a
// page between the two portals and miss a block, rename an id on one side, and
// getElementById returns null. The next line is almost always .addEventListener
// or .showModal, which throws while the module is still evaluating, so the rest
// of the page's script never runs and the half above it never finished either.
// The page renders its shell and then sits there.
//
// There is no error anybody sees without opening a console. That is how
// trip-vara's Clients page shipped broken: the whole "add a household" flow was
// in the script and none of it in the markup, from the day households landed.
//
// So: every getElementById('x') needs an id="x" on a page the script can see,
// and every querySelector('[attr]') needs that attribute written somewhere.
// Both sides may be built inside a template literal, which is why this matches
// text rather than parsing: a rule that only understood static markup would
// have to excuse most of the pages here.
//
//   node scripts/check-dom.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ids and attributes that no page declares because the shell writes them in.
// Every entry is a claim somebody checked, which is the point of writing it
// down rather than loosening the rule until nothing fails.
const ALLOWED = new Map([]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // Third party source, kept as its author published it. Our rules are
    // about our own code, and editing a vendored file to satisfy one of
    // them breaks the only thing that makes vendoring safe.
    if (name === 'vendor' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.html') || name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'public'));

// What the shared modules under public/js declare. mountShell writes the
// sidebar and the search box into every page, so a page reaching for one of
// those is right even though its own markup never mentions it.
const shared = files.filter((f) => f.includes(`${'/'}js${'/'}`)).map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * The text of a file with its own lookups removed, so a name cannot vouch for
 * itself, and with `el.id = 'x'` rewritten as an attribute, because an element
 * built in script declares its id that way and it is the same declaration.
 */
function declarations(src) {
  return src
    .replace(/getElementById\(\s*['"`][^'"`]+['"`]\s*\)/g, '')
    .replace(/querySelectorAll?\(\s*['"`][^'"`]+['"`]\s*\)/g, '')
    .replace(/\.id\s*=\s*['"`]([\w-]+)['"`]/g, 'id="$1"');
}

let problems = 0;
let checked = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const own = declarations(src);
  const pool = `${own}\n${declarations(shared)}`;

  for (const m of src.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) {
    const id = m[1];
    checked += 1;
    if (ALLOWED.has(id)) continue;
    // id="x", id='x', id=`x`, or id="${...}x" built into a template.
    if (new RegExp(`id=["'\`][^"'\`]*\\b${id}\\b`).test(pool)) continue;
    problems += 1;
    const line = src.slice(0, m.index).split('\n').length;
    annotate('DOM', `${rel}:${line} reaches for #${id}, which no markup declares`);
    console.log(`FAIL  ${rel}:${line}  getElementById('${id}') with no id="${id}" anywhere`);
  }

  for (const m of src.matchAll(/querySelectorAll?\(\s*['"]\[([\w-]+)\]['"]\s*\)/g)) {
    const attr = m[1];
    checked += 1;
    if (ALLOWED.has(attr)) continue;
    // Valueless attributes are ordinary here, so the name may be followed by
    // a space, a > or an =.
    if (new RegExp(`\\b${attr}(=|\\s|>)`).test(pool)) continue;
    problems += 1;
    const line = src.slice(0, m.index).split('\n').length;
    annotate('DOM', `${rel}:${line} queries [${attr}], which no markup writes`);
    console.log(`FAIL  ${rel}:${line}  querySelector('[${attr}]') with no ${attr} anywhere`);
  }
}

if (problems) {
  console.log(`\n${problems} lookup${problems === 1 ? '' : 's'} with nothing behind it.`);
  process.exit(1);
}
console.log(`check-dom: ${checked} lookups, every one of them declared.`);
