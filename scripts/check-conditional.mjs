// A selector whose element is only drawn in one branch, read without a guard.
//
// check-dom asks whether the markup declares the thing a script reaches for.
// It did, so check-dom passed, and the page threw anyway:
//
//   ${f.type === 'heading'
//     ? '<span>section heading</span>'
//     : `<input type="checkbox" class="req">`}
//   ...
//   li.querySelector('.req').addEventListener('change', ...)
//
// A heading row has no checkbox, querySelector returns null, and
// .addEventListener on null throws inside a forEach, which takes the rest of
// the render with it. Every row after the first heading lost its editing and
// its drag to reorder, and the page showed a red banner where the questions
// should have been.
//
// Only the innermost literal counts. A row built inside .map() sits in a
// substitution full of ternaries and is drawn every time; what decides whether
// *this* markup exists is what stands immediately before the quote that opens
// it.
//
//   node scripts/check-conditional.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN = /querySelector\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g;

/**
 * The module body, and the offset it starts at.
 *
 * Only the script. An apostrophe in prose ("nobody's") is not a quote, and a
 * scanner that thinks it is misreads everything after it.
 */
function scriptOf(src, rel) {
  if (rel.endsWith('.js')) return { body: src, offset: 0 };
  const open = src.match(/<script type="module">/);
  if (!open) return { body: '', offset: 0 };
  const start = open.index + open[0].length;
  const end = src.indexOf('</script>', start);
  return { body: src.slice(start, end), offset: start };
}

/**
 * For each index, the start of the innermost string literal holding it.
 *
 * A scan rather than a regex, because this is the question regexes cannot
 * answer: template literals nest, ${...} inside one re-enters code, and a
 * quote inside a comment is not a quote at all.
 */
function literalStarts(src) {
  const out = new Array(src.length).fill(null);
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const cur = stack.length ? stack[stack.length - 1] : null;

    if (!cur || cur.q === '{') {
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const j = src.indexOf('*/', i + 2);
        i = j === -1 ? src.length : j + 2;
        continue;
      }
    }
    if (cur && cur.q !== '{' && c === '\\') {
      out[i] = cur.at;
      if (i + 1 < src.length) out[i + 1] = cur.at;
      i += 2;
      continue;
    }
    if (cur && cur.q === '`' && c === '$' && src[i + 1] === '{') {
      stack.push({ q: '{', at: null });
      out[i] = cur.at;
      i += 2;
      continue;
    }
    if (cur && cur.q === '{') {
      if (c === '{') stack.push({ q: '{', at: null });
      else if (c === '}') stack.pop();
      else if (c === "'" || c === '"' || c === '`') stack.push({ q: c, at: i });
      out[i] = null;
      i += 1;
      continue;
    }
    if (cur && c === cur.q) { out[i] = cur.at; stack.pop(); i += 1; continue; }
    if (cur) { out[i] = cur.at; i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      stack.push({ q: c, at: i });
      out[i] = i;
      i += 1;
      continue;
    }
    out[i] = null;
    i += 1;
  }
  return out;
}

/** Is the literal holding this markup an arm that may not be taken? */
function isConditional(src, at, starts) {
  const start = starts[at];
  if (start === null || start === undefined) return false;
  let j = start - 1;
  while (j >= 0 && ' \t\r\n'.includes(src[j])) j -= 1;
  if (j < 0) return false;
  if (src[j] === '?') return true;
  if (src[j] === '&' && src[j - 1] === '&') return true;
  if (src[j] !== ':') return false;

  // A colon also ends an object key, a label and a CSS declaration. Only the
  // second arm of a ternary counts, so there has to be a ? on the way back, at
  // the same bracket depth, skipping anything inside a string.
  let k = j - 1;
  let depth = 0;
  while (k >= 0) {
    if (starts[k] !== null && starts[k] !== undefined) { k -= 1; continue; }
    const ch = src[k];
    if (')]}'.includes(ch)) depth += 1;
    else if ('([{'.includes(ch)) { if (!depth) return false; depth -= 1; }
    else if (!depth && (ch === ';' || ch === ',')) return false;
    else if (ch === '?' && !depth) return true;
    k -= 1;
  }
  return false;
}

/** Where the markup would have to write this selector for it to match. */
function targetOf(sel) {
  const s = sel.trim();
  if (s.startsWith('.')) return { kind: 'class', name: s.slice(1) };
  if (s.startsWith('#')) return { kind: 'id', name: s.slice(1) };
  const attr = s.match(/^\[([A-Za-z_:][-\w:.]*)/);
  if (attr) return { kind: 'attr', name: attr[1] };
  if (/^[a-z]+$/.test(s)) return { kind: 'tag', name: s };
  return null;
}

function writesOf(src, { kind, name }) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = kind === 'class' ? `class="[^"]*\\b${esc}\\b[^"]*"`
    : kind === 'id' ? `id="${esc}"`
      : kind === 'attr' ? `\\b${esc}\\b(?==|[\\s>])`
        : `<${esc}\\b`;
  return [...src.matchAll(new RegExp(pat, 'g'))].map((m) => m.index);
}

function pageFiles() {
  const out = [];
  for (const d of ['public/app', 'public/js']) {
    const full = join(ROOT, d);
    if (!existsSync(full)) continue;
    for (const n of readdirSync(full).sort()) {
      if (n.endsWith('.html') || n.endsWith('.js')) out.push(`${d}/${n}`);
    }
  }
  return out;
}

const problems = [];

for (const rel of pageFiles()) {
  const whole = readFileSync(join(ROOT, rel), 'utf8');
  const { body, offset } = scriptOf(whole, rel);
  if (!body) continue;
  const starts = literalStarts(body);

  for (const m of body.matchAll(CHAIN)) {
    const [, , sel, member] = m;
    const target = targetOf(sel);
    if (!target) continue;
    const spots = writesOf(body, target);
    // No markup at all is check-dom's question, not this one.
    if (!spots.length) continue;
    if (!spots.every((s) => isConditional(body, s, starts))) continue;

    problems.push({
      file: rel,
      line: whole.slice(0, offset + m.index).split('\n').length,
      message: `querySelector('${sel}').${member}, and ${sel} is only ever written `
        + `inside a branch (${spots.length} place(s)). On the rows that take the `
        + 'other branch this is null, and the read throws. Hold the result and '
        + 'check it before using it.',
    });
  }
}

for (const p of problems) {
  console.log(`FAIL  ${p.file}:${p.line}`);
  console.log(`        ${p.message}`);
}

console.log(`\n${problems.length} problem(s)`);
report('Conditional', problems, (p) => `${p.file}:${p.line} ${p.message}`);
