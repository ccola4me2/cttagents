// Is every \u escape one that means what it looks like?
//
// \uXXXX takes exactly four hex digits. Write five and JavaScript reads the
// first four and treats the fifth as an ordinary character, silently. Nothing
// throws, nothing warns, and the string is wrong in a way that only shows on
// screen.
//
// That is not hypothetical: three of the eight icons on the client's itinerary
// were written 'ὬF', 'Ὡ8' and 'ἷ4'. A client opening their trip
// before they travelled saw a Greek capital omicron followed by the letter F
// where a bed should be, and the same for the car and the cutlery. It had been
// that way since the page was written.
//
// A character above U+FFFF needs braces: '\u{1F6CF}'. This asks for that
// everywhere, which is a true statement about the language rather than a
// preference, so there is nothing to argue with and nothing to allow.
//
//   node scripts/check-escapes.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Third party source, kept as its author published it. Our rules are about
    // our own code, and editing a vendored file to satisfy one of them breaks
    // the only thing that makes vendoring safe: that it is unchanged.
    if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const problems = [];
for (const dir of ['src', 'public', 'scripts']) {
  for (const file of walk(join(ROOT, dir))) {
    const source = readFileSync(file, 'utf8');
    // Comments out first, with the same care the other checkers take over the
    // // inside an https:// . An escape written in a comment is prose about an
    // escape, and the note explaining this very bug contains one.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (whole, before) => before + ' '.repeat(whole.length - 1));
    // \u followed by five or more hex digits and no brace: the fifth digit is
    // not part of the escape and almost certainly was meant to be.
    for (const m of code.matchAll(/\\u(?!\{)([0-9a-fA-F]{5,})/g)) {
      const line = source.slice(0, m.index).split('\n').length;
      const four = m[1].slice(0, 4);
      const rest = m[1].slice(4);
      problems.push(`${relative(ROOT, file)}:${line} \\u${m[1]} reads as U+${four} `
        + `followed by "${rest}". Write \\u{${m[1]}} if that is one character.`);
    }
  }
}

if (problems.length) {
  console.error(`check-escapes: ${problems.length} escape${problems.length === 1 ? '' : 's'} `
    + 'that does not mean what it looks like.\n');
  for (const p of problems) {
    console.error(`  ${p}`);
    annotate('Escape', p);
  }
  process.exit(1);
}

console.log('check-escapes: every \\u escape is four hex digits or braced');
