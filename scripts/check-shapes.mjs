// Does a call pass the keys the function actually destructures?
//
// This exists because of a real bug that cost a 500 on every statement, every
// invoice and every preview in the portal.
//
// buildStatement takes one object and destructures a property called `user`.
// The call site passed it as shorthand:
//
//   buildStatement({ booking, pricing, ..., client, user })
//
// In shorthand the name is the key as much as it is the value. A pass that
// renamed the local variable `user` to `owner` renamed the key with it, so
// buildStatement was handed `{ owner }` and read `user`, which is undefined.
// Nothing complained: it parsed, every check passed, and it threw at the
// moment somebody pressed Send. The smoke test caught it as three separate
// failures that each reported "undefined" and named nothing.
//
// A typed codebase gets this from the compiler. This one is deliberately plain
// JavaScript with no build step, so the equivalent has to be read out of the
// source: find the functions whose parameter is an object pattern, find the
// calls that hand them an object literal, and compare the two sets of names.
//
// Only literal keys are compared, and a call that spreads is skipped: `{ ...x }`
// can carry anything and this has no way to know what. A key the callee does
// not destructure is the failure; a key it destructures and the call omits is
// not, because an optional field is ordinary and common.
//
//   node scripts/check-shapes.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Calls that hand over a bag of fields on purpose, where an unknown key is the
// shape rather than a mistake. Matched on the function name.
const OPEN_SHAPES = new Set(['json', 'fireTrigger', 'logActivity']);

/** Functions declared as `function name({ a, b, c })`, with the names they take. */
function patternFunctions(src) {
  const out = new Map();
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(\s*\{([^}]*)\}/g;
  for (const m of src.matchAll(re)) {
    const keys = new Set();
    for (const part of m[2].split(',')) {
      const name = part.trim().split(/[:=]/)[0].trim();
      if (name && /^\w+$/.test(name)) keys.add(name);
    }
    if (keys.size) out.set(m[1], keys);
  }
  return out;
}

/** The balanced `{...}` starting at `i`, or null if it does not close. */
function braceAt(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    const c = src[j];
    if (c === '`' || c === "'" || c === '"') {
      const quote = c;
      j += 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j += 1;
      }
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(i + 1, j);
    }
  }
  return null;
}

/** Top-level keys of an object literal body, or null when it spreads. */
function keysOf(body) {
  const keys = new Set();
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '`' || c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < body.length) {
        if (body[i] === '\\') { i += 2; continue; }
        if (body[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith('...')) return null;      // a spread can carry anything
    if (part.startsWith('//')) continue;
    const name = part.split(':')[0].trim().replace(/^\/\/.*$/m, '').trim();
    if (!/^\w+$/.test(name)) return null;          // computed or something odd
    keys.add(name);
  }
  return keys;
}

const files = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js')).sort();
const sources = new Map(files.map((f) => [f, readFileSync(join(ROOT, 'src', f), 'utf8')]));

// Every object-pattern function in the whole of src, by name. A name declared
// twice with different shapes is dropped rather than guessed at.
const shapes = new Map();
const ambiguous = new Set();
for (const [, src] of sources) {
  for (const [name, keys] of patternFunctions(src)) {
    if (shapes.has(name) && [...shapes.get(name)].join() !== [...keys].join()) ambiguous.add(name);
    shapes.set(name, keys);
  }
}

let checked = 0;
let problems = 0;

for (const [file, src] of sources) {
  for (const [name, keys] of shapes) {
    if (ambiguous.has(name) || OPEN_SHAPES.has(name)) continue;
    const call = new RegExp(`\\b${name}\\s*\\(\\s*\\{`, 'g');
    for (const m of src.matchAll(call)) {
      // Skip the declaration itself.
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      if (/function\s+$/.test(before)) continue;

      const body = braceAt(src, src.indexOf('{', m.index));
      if (body === null) continue;
      const passed = keysOf(body);
      if (passed === null) continue;

      checked += 1;
      const unknown = [...passed].filter((k) => !keys.has(k));
      if (!unknown.length) continue;

      const line = src.slice(0, m.index).split('\n').length;
      const message = `${name} does not take ${unknown.join(', ')}. `
        + `It destructures ${[...keys].join(', ')}. A shorthand key is the property name `
        + 'as well as the variable, so renaming the variable renames the key.';
      problems += 1;
      console.log(`FAIL  src/${file}:${line}  ${message}`);
      annotate({ file: `src/${file}`, line, message });
    }
  }
}

console.log(`\n${problems} problem(s); ${checked} call(s) checked against ${shapes.size} shapes`);
process.exit(problems ? 1 : 0);
