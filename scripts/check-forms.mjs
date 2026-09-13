// Does anything read the boxes people type into?
//
// A form field is a name on a page and a property read on the server, and
// nothing connects the two. Rename one side, or add a field and forget the
// other half, and the box appears, accepts what somebody types, saves without
// complaint and throws the value away. No error, no log line, no failing
// request. The field is simply always empty afterwards, and it is found weeks
// later by somebody wondering why a value they typed will not stay typed.
//
// That has happened here twice at the layer below this one, where a column was
// missing from a statement rather than a field from a handler. check-columns
// and check-writes guard those. This is the same failure one step up.
//
// So: every name="..." on a page must be read somewhere in src/ as body.<name>
// or raw.<name>, or be listed below with the reason it is not.
//
//   node scripts/check-forms.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fields that never reach the server, and why. Every entry is a claim
// somebody checked, which is the point of writing it down rather than
// loosening the rule until nothing fails.
const ALLOWED = new Map([
  ['confirmPassword', 'checked against the other box in the browser and never sent; '
    + 'the server has the password itself to compare against'],
  ['loyaltyText', 'one line per cruise line, turned into the loyalty array before the '
    + 'request and deleted from it. The server reads body.loyalty'],
  ['reservationType', 'a two-way choice the page turns into values.personal, because '
    + '"mine" and "a client\'s" reads better on screen than a checkbox called personal'],
  ['template', 'the set of questions to start a form builder from. It fills the builder '
    + 'in the browser and what gets saved is the questions, not the choice'],
  // Attributes the browser gives meaning to, which are not form fields at all.
  ['robots', 'a meta tag'],
  ['viewport', 'a meta tag'],
  ['description', 'a meta tag'],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

// What the server reads. body.x is the usual shape; raw.x is the import
// parsers, which take a spreadsheet row rather than a request.
const reads = new Set();
for (const file of readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(join(ROOT, 'src', file), 'utf8');
  for (const m of src.matchAll(/\b(?:body|raw)\.([A-Za-z][A-Za-z0-9_]*)/g)) reads.add(m[1]);
  for (const m of src.matchAll(/\bbody\[['"]([A-Za-z][A-Za-z0-9_]*)['"]\]/g)) reads.add(m[1]);
}

const fields = new Map();
for (const file of walk(join(ROOT, 'public'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bname="([A-Za-z][A-Za-z0-9_]*)"/g)) {
    if (!fields.has(m[1])) fields.set(m[1], new Set());
    fields.get(m[1]).add(relative(ROOT, file));
  }
}

let problems = 0;

// A honeypot hidden from eyes and from nobody else.
//
// The spam trap is a field called "Company website" inside <div class="hp">,
// which the stylesheet moves to left:-9999px. That hides it from people looking
// at the page. A screen reader still reads it out as an ordinary field, and
// filling it in returns "Thanks." and files the enquiry nowhere: the visitor
// who could not see the trap was the only one who could fall into it, and
// neither end was told.
//
// Four copies of this markup existed and one of them had aria-hidden. The
// difference is invisible in review and invisible on screen, which is what this
// rule is for.
// Server-rendered public pages and static pages both, because the four copies
// were split across src/share.js, src/publicform.js and public/.
let hidden = 0;
const honeypotFiles = [
  ...readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => join(ROOT, 'src', f)),
  ...walk(join(ROOT, 'public')),
];
for (const file of honeypotFiles) {
  const src = readFileSync(file, 'utf8');
  const re = /class=(["'])hp\1([^>]*)>/g;
  for (let m; (m = re.exec(src));) {
    hidden += 1;
    if (/aria-hidden/.test(m[2])) continue;
    problems += 1;
    const line = src.slice(0, m.index).split('\n').length;
    const where = `${relative(ROOT, file)}:${line}`;
    console.log(`FAIL  honeypot visible to assistive tech`);
    console.log(`        ${where}`);
    console.log('        off-screen hides it from eyes only; a screen reader reads it out, '
      + 'and filling it in discards the message silently');
    annotate('Honeypot', `${where} -- a .hp honeypot without aria-hidden is read aloud `
      + 'by screen readers, and anything typed into it is discarded without notice');
  }
}

for (const [name, pages] of [...fields].sort()) {
  if (reads.has(name) || ALLOWED.has(name)) continue;
  problems += 1;
  const where = [...pages].sort().join(', ');
  const message = `nothing in src/ reads body.${name}, typed on ${where}`;
  console.log(`FAIL  ${name}`);
  console.log(`        on ${where}`);
  console.log('        the box saves without complaint and the value is thrown away');
  annotate('Form field', message);
}

console.log('');
if (problems) {
  console.log(`${problems} form field${problems === 1 ? '' : 's'} nothing reads. `
    + 'Read them, rename them to match, or add the reason to ALLOWED in this file.');
  process.exit(1);
}
console.log(`check-forms: all ${fields.size} form fields are read by something `
  + `(${ALLOWED.size} deliberately are not), ${hidden} honeypot`
  + `${hidden === 1 ? '' : 's'} hidden from assistive tech too`);
