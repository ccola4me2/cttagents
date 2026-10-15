// Does every name a page uses actually exist?
//
// On 2026-10-15 every signed-in page on this portal threw before its own
// script ran:
//
//   Uncaught ReferenceError: actingAs is not defined
//       at mountShell (/js/app.js:1355)
//
// mountShell is the second line of every page script here, so the sidebar
// never mounted and nothing on any page loaded. It had been live for days.
//
// Half a port. cttagents destructures actingAs out of /api/auth/me because
// that portal really does let somebody sit in another advisor's seat. The line
// that used it crossed the fork and the line that declared it did not.
//
// Nothing caught it, and the two checks that look closest are both near
// misses: check-fork compares what two modules export, and this is neither an
// export nor a module; check-contracts verifies that every function a page
// calls is declared, and actingAs is a variable. CI was green and it shipped.
//
// So: every identifier a page script reads must be declared in that script,
// imported into it, or be something the browser provides. Anything else is a
// ReferenceError waiting for the first person to open the page.
//
//   node scripts/check-names.mjs
//
// This is a lexer and not a parser, which is a deliberate trade. A real parser
// means a dependency, and this repository has one dependency on purpose. The
// cost is that the analysis has to be conservative: it over-collects
// declarations, because a name wrongly thought declared is a miss and a name
// wrongly thought undeclared is a false alarm that wastes somebody's morning.
// Everything it cannot be sure about is treated as declared.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Names the browser provides, plus the ones this portal's pages legitimately
// reach for. Not exhaustive by design: anything missing shows up as a failure
// the first time a page uses it, which is the right way round for a list like
// this to be wrong.
const GLOBALS = new Set([
  // Language
  'globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'Function', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask',
  // Browser
  'window', 'document', 'console', 'location', 'history', 'navigator', 'screen',
  'localStorage', 'sessionStorage', 'fetch', 'Request', 'Response', 'Headers',
  'FormData', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'alert',
  'confirm', 'prompt', 'requestAnimationFrame', 'cancelAnimationFrame',
  'AbortController', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
  'CustomEvent', 'Event', 'Image', 'Option', 'Notification', 'crypto', 'btoa',
  'atob', 'TextEncoder', 'TextDecoder', 'matchMedia', 'getComputedStyle',
  'HTMLElement', 'Node', 'NodeList', 'DocumentFragment', 'Element', 'self',
  'performance', 'scrollTo', 'open', 'close', 'print', 'getSelection',
  // Binary and parsing, which the vendor import and the push subscription use
  'ArrayBuffer', 'DataView', 'Uint8Array', 'Uint16Array', 'Uint32Array',
  'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'Uint8ClampedArray', 'BigInt64Array', 'BigUint64Array', 'SharedArrayBuffer',
  'DecompressionStream', 'CompressionStream', 'ReadableStream', 'WritableStream',
  'TransformStream', 'DOMParser', 'XMLSerializer', 'AbortSignal', 'Audio',
  // Module and worker shapes a page may touch
  'import', 'export', 'this', 'arguments', 'super', 'new', 'await',
  'caches', 'indexedDB', 'Worker', 'SharedWorker', 'EventSource', 'WebSocket',
]);

// Words the lexer will meet that are syntax rather than names.
const KEYWORDS = new Set([
  'var', 'let', 'const', 'function', 'class', 'return', 'if', 'else', 'for',
  'while', 'do', 'break', 'continue', 'switch', 'case', 'default', 'throw',
  'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'instanceof', 'in',
  'of', 'void', 'this', 'super', 'null', 'true', 'false', 'async', 'await',
  'yield', 'static', 'get', 'set', 'import', 'export', 'from', 'as', 'extends',
  'arguments', 'debugger', 'with',
]);

/**
 * Strip what is not code: comments, and the literal parts of strings.
 *
 * Template literals keep their ${} contents, because those are real references
 * and are exactly where a page builds its markup. Everything else inside the
 * quotes becomes spaces, so a string that happens to contain the word "total"
 * is not mistaken for a variable.
 *
 * Spaces rather than deletion, so a later regex cannot accidentally join two
 * tokens that were separated by a string.
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  let prev = '';
  // A stack rather than a flag, because these pages nest templates inside
  // interpolations inside templates as a matter of course: a list renderer is
  // a template whose ${} holds a map whose body is another template. The first
  // version of this tracked one level and happily read every <span> in the
  // portal as a variable.
  const stack = [{ mode: 'code', braces: 0 }];
  const top = () => stack[stack.length - 1];
  const blank = (text) => text.replace(/[^\n]/g, ' ');

  while (i < src.length) {
    const t = top();
    const ch = src[i];
    const two = src.slice(i, i + 2);

    if (t.mode === 'template') {
      if (ch === '\\') { out += '  '; i += 2; continue; }
      if (ch === '`') { stack.pop(); out += ' '; i += 1; prev = ')'; continue; }
      if (two === '${') {
        stack.push({ mode: 'code', braces: 0 });
        out += '  '; i += 2; prev = '(';
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      out += ` ${blank(src.slice(i + 1, j))} `;
      i = Math.min(j + 1, src.length);
      prev = ')';
      continue;
    }

    if (ch === '`') {
      stack.push({ mode: 'template' });
      out += ' ';
      i += 1;
      continue;
    }

    if (ch === '/' && (regexCanStart(prev) || keywordBefore(out))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j += 1;
      }
      if (src[j] === '/') {
        let k = j + 1;
        while (k < src.length && /[a-z]/.test(src[k])) k += 1;
        out += blank(src.slice(i, k));
        i = k;
        prev = ')';
        continue;
      }
    }

    if (ch === '{') t.braces += 1;
    if (ch === '}') {
      // The closing brace of an interpolation, as opposed to one of an object
      // or a block inside it.
      if (t.braces === 0 && stack.length > 1) {
        stack.pop();
        out += ' ';
        i += 1;
        prev = ')';
        continue;
      }
      t.braces -= 1;
    }

    out += ch;
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return out;
}

/** After these, a slash is a regex rather than division. */
function regexCanStart(prev) {
  return prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev);
}

// Keywords a regex literal can follow. Without these, `return /[",\n]/.test(s)`
// reads as division, the quote inside the character class opens a string, and
// everything to the next quote is swallowed. That is not hypothetical: it is
// what this check did to reports.html on its second run, which then hid every
// function declared below that line.
const REGEX_AFTER = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'case', 'do', 'else', 'yield',
  'await', 'new', 'delete', 'void', 'throw',
]);

/** Was the last thing emitted one of those keywords? */
function keywordBefore(out) {
  const m = out.match(/([A-Za-z_$][\w$]*)\s*$/);
  return Boolean(m && REGEX_AFTER.has(m[1]));
}

/**
 * Every name this code declares, collected generously.
 *
 * Over-collection is the safe direction. A name wrongly counted as declared
 * means one missed bug; a name wrongly counted as undeclared means a false
 * alarm in a check that then gets ignored, which costs every future bug.
 */
function declaredIn(code) {
  const names = new Set();
  const add = (n) => { if (n && !KEYWORDS.has(n)) names.add(n); };
  const addPattern = (text) => {
    // Everything that looks like a binding inside a destructuring pattern or
    // a parameter list. Keys in `{ a: b }` bind b, not a, so a name directly
    // followed by a colon is skipped.
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*(:)?/g)) {
      if (m[2]) continue;
      add(m[1]);
    }
  };

  // import { a, b as c }, import d, import * as ns
  for (const m of code.matchAll(/\bimport\s+([^;]*?)\s+from\b/g)) addPattern(m[1]);
  // const/let/var, including destructuring patterns across lines
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\{[\s\S]*?\}|\[[\s\S]*?\]|[A-Za-z_$][\w$]*)/g)) {
    addPattern(m[1]);
  }
  // function name(params) and class name
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    add(m[1]);
    addPattern(m[2] || '');
  }
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // catch (e)
  for (const m of code.matchAll(/\bcatch\s*\(\s*([^)]*)\)/g)) addPattern(m[1]);
  // Arrow functions: (a, b) => and a =>
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addPattern(m[1]);
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // for (const x of y) is covered by the const rule; labels are not used here.
  // Object and class methods: name(...) { , which reads as a declaration and
  // is harmless to treat as one.
  for (const m of code.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
    add(m[1]);
    addPattern(m[2] || '');
  }
  return names;
}

/**
 * Every name this code reads.
 *
 * Property accesses are removed first, so `d.total` contributes d and not
 * total. Object literal keys go the same way: `{ total: 1 }` names no
 * variable. Both of those are where a naive version produces its false alarms.
 */
function usedIn(code) {
  const flat = code
    // a.b and a?.b
    .replace(/\??\.\s*[A-Za-z_$][\w$]*/g, '')
    // { key: value } and case labels, but not ternaries, which have a ? first
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1')
    // A loop label, which names no variable. Matched only when a loop or a
    // switch follows it, so this can never eat a real reference: `case FOO:`
    // and `a ? b : c` both keep their names.
    .replace(/(^|[;{}]\s*)([A-Za-z_$][\w$]*)\s*:(\s*(?:for|while|do|switch)\b)/g, '$1$3')
    // and the other half of a label: `break outer` names the label, not a
    // variable.
    .replace(/\b(break|continue)\s+[A-Za-z_$][\w$]*/g, '$1')
    // import and export specifiers, already counted as declarations
    .replace(/\bimport\s+[^;]*?\s+from\b/g, ' ')
    .replace(/\bexport\s*\{[^}]*\}/g, ' ');

  const used = new Map();
  const lines = flat.split('\n');
  for (const [n, line] of lines.entries()) {
    for (const m of line.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      if (KEYWORDS.has(name)) continue;
      if (!used.has(name)) used.set(name, n + 1);
    }
  }
  return used;
}

/** The module scripts on a page, with the line each one starts at. */
function scriptsIn(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(m[1])) continue;
    const before = html.slice(0, m.index);
    out.push({ code: m[2], line: before.split('\n').length });
  }
  return out;
}

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

// Names this check is told about rather than widening a rule for. Every entry
// is a claim somebody checked.
const ALLOWED = new Map([
  // Set by an inline script earlier on the page than the module that reads it.
  ['__TV_BOOT__', 'a boot flag written by an inline script above the module'],
]);

/**
 * The checker, checked.
 *
 * The danger with a lexer is not that it is wrong, it is that being wrong
 * makes it blind: a stripper that loses its place swallows the rest of the
 * file and then reports every page as clean for ever. That is a worse outcome
 * than not having the check, because it is believed.
 *
 * So a table of small cases runs first, including the three the first two
 * attempts at this got wrong, and the whole check fails if any of them moves.
 */
const SELF_TEST = [
  ['const a = 1; a;', [], 'a declaration and a use'],
  ['b;', ['b'], 'a bare name nothing declares'],
  ['const d = {}; d.total;', [], 'a property is not a variable'],
  ['const o = { foo: 1 };', [], 'an object key is not a variable'],
  ['const bar = 1; const o = { bar };', [], 'shorthand reads the variable'],
  ['const o = { bar };', ['bar'], 'and shorthand is still a read when it is missing'],
  ['const { a = 1 } = o; a;', ['o'], 'a destructuring default still binds'],
  ['const [x, y] = z; x; y;', ['z'], 'and so does an array pattern'],
  ['[1].map((n) => n + 1);', [], 'arrow parameters are declared'],
  ['try { x(); } catch (e) { e.message; }', ['x'], 'a catch parameter is declared'],
  ['const t = `plain text`;', [], 'template text is not code'],
  ['const t = `<span class="muted">x</span>`;', [], 'nor is markup inside one'],
  ['const n = 1; const t = `${n}`;', [], 'but an interpolation is'],
  ['const t = `${q}`;', ['q'], 'and a name missing from one is caught'],
  // The one the second attempt got wrong: a template whose interpolation holds
  // another template. Every list renderer in this portal is shaped like this.
  ['const rows = []; const t = `<ul>${rows.map((r) => `<li>${r.name}</li>`).join("")}</ul>`;',
    [], 'a template nested inside an interpolation'],
  // The one the third attempt got wrong, and the reason reports.html went dark.
  ['function f(s) { return /[",\n]/.test(s); }\nfunction g() {}\ng();',
    [], 'a regex literal after return, with a quote in its character class'],
  ['const i = 1; const r = 4 / i / 2;', [], 'and division is still division'],
  ['function outer() { inner(); }\nfunction inner() {}', [], 'declared later in the file'],
  ['class K { go() { return 1; } }\nnew K();', [], 'a class and its method'],
  ['label: for (const k of [1]) { if (k) break label; }', [], 'a loop over a literal'],
];

for (const [code, want, what] of SELF_TEST) {
  const stripped = stripNonCode(code);
  const declared = declaredIn(stripped);
  const got = [...usedIn(stripped).keys()]
    .filter((n) => !declared.has(n) && !GLOBALS.has(n) && !ALLOWED.has(n))
    .sort();
  const expected = [...want].sort();
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    annotate('Name checker self test', `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    console.log(`FAIL  self test: ${what}`);
    console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    console.log('        The lexer has moved. Until this passes the check below '
      + 'proves nothing, because a stripper that loses its place reports every page as clean.');
    process.exit(1);
  }
}

let problems = 0;
let scanned = 0;

const targets = [
  ...walk(join(ROOT, 'public'), '.html').map((f) => ({ file: f, html: true })),
  ...walk(join(ROOT, 'public', 'js'), '.js')
    // Vendored third-party code. It is not written to this portal's rules and
    // changing it to satisfy a checker of ours would be the wrong way round.
    .filter((f) => !f.includes(`${'js'}/vendor/`))
    .map((f) => ({ file: f, html: false })),
];

for (const { file, html } of targets) {
  const src = readFileSync(file, 'utf8');
  const blocks = html
    ? scriptsIn(src)
    : [{ code: src, line: 1 }];

  for (const block of blocks) {
    if (!block.code.trim()) continue;
    scanned += 1;
    const code = stripNonCode(block.code);
    const declared = declaredIn(code);
    const used = usedIn(code);

    for (const [name, line] of used) {
      if (declared.has(name) || GLOBALS.has(name) || ALLOWED.has(name)) continue;
      problems += 1;
      const where = `${relative(ROOT, file)}:${block.line + line - 1}`;
      annotate('Undeclared name', `${where} reads ${name}, which nothing declares`);
      console.log(`FAIL  ${where}  reads ${name}, and nothing declares it`);
      console.log('        A page that reads a name nothing declares throws a '
        + 'ReferenceError the moment it runs.');
      console.log('        Declare it, import it, or add it to GLOBALS or ALLOWED here.');
    }
  }
}

console.log(problems
  ? `\n${problems} name${problems === 1 ? '' : 's'} nothing declares.`
  : `\ncheck-names: ${scanned} page scripts, every name declared, imported or a browser global.`);
process.exit(problems ? 1 : 0);
