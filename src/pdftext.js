// Reading the words out of a PDF, with no library and no build step.
//
// This portal has no toolchain, so pdf.js is not an option: it is megabytes of
// code that has to be bundled, and nothing here is bundled. What a Worker does
// have is DecompressionStream, which is the only hard part of a PDF, and the
// rest is a few hundred bytes of format.
//
// Deliberately not a PDF renderer. It does not care about position, layout,
// tables or pages, and it makes no attempt to be correct about a document it
// has not seen. It answers one question, which is roughly what words are in
// here, in roughly the order they were drawn, and a caller that wants meaning
// reads that text with patterns it owns. See src/groupquote.js.
//
// Text in a PDF is drawn from a font's glyph ids rather than written in any
// encoding you can read. A font that says /Encoding /Identity means the bytes
// in the content stream are glyph numbers in that font and nothing else, which
// is why a naive reader of a modern PDF gets the odd stray word and a page of
// punctuation. The map back is the /ToUnicode stream, so that is what this
// reads first.

import { openEncryption } from './pdfcrypt.js';

/**
 * Is this stream uncompressed page content or a font map.
 *
 * Decided by what it is made of, not by whether it contains the letters BT.
 * Image and font data is random bytes, and random bytes contain "BT" and "Tj"
 * by chance often enough that a pattern alone admitted pages of garbage into
 * the text. Real page content is almost entirely printable characters, and
 * binary data is nothing like it.
 */
export function isPlainText(bytes) {
  const n = Math.min(bytes.length, 4000);
  if (n < 20) return false;
  let printable = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b === 10 || b === 13 || b === 9) printable += 1;
  }
  if (printable / n < 0.95) return false;
  const head = latin1(bytes.subarray(0, n));
  return /\bBT\b/.test(head) || /begincmap/.test(head);
}

/** Bytes as a string of code points 0 to 255, so patterns can be run over it. */
function latin1(bytes) {
  let s = '';
  // In slices, because String.fromCharCode.apply throws on a large array.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return s;
}

/**
 * Inflate, trying both wrappings.
 *
 * FlateDecode is zlib, but generators in the wild write raw deflate often
 * enough that trying the second costs nothing and saves a blank answer.
 */
async function inflate(bytes) {
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      // Response rather than a hand built ReadableStream: it gives the same
      // stream in one expression, and the bytes are already in memory.
      const piped = new Response(bytes).body.pipeThrough(new DecompressionStream(format));
      const out = await new Response(piped).arrayBuffer();
      if (out.byteLength) return new Uint8Array(out);
    } catch { /* the other wrapping, or not compressed at all */ }
  }
  return null;
}

/**
 * One /ToUnicode CMap, as code point to text.
 *
 * Both shapes: bfchar for single glyphs, bfrange for runs. A range whose
 * destination is a list rather than a start value is rare and skipped rather
 * than guessed at, because a wrong letter in a date is worse than a gap.
 */
export function parseCMap(text, into = new Map(), stats = null) {
  // Two fonts in one file may use the same glyph number for different letters,
  // and this reader keeps a single map. Merging is safe when they agree, which
  // every file checked so far did, and quietly wrong when they do not: a date
  // with a wrong digit in it looks exactly like a right one. So a disagreement
  // is counted and reported rather than overwritten in silence.
  const put = (code, value) => {
    if (stats && into.has(code) && into.get(code) !== value) stats.conflicts += 1;
    into.set(code, value);
  };
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m;
    while ((m = re.exec(block))) put(parseInt(m[1], 16), fromHexUtf16(m[2]));
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m;
    while ((m = re.exec(block))) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 65535);
      const base = parseInt(m[3], 16);
      for (let c = lo; c <= hi; c += 1) put(c, String.fromCodePoint(base + (c - lo)));
    }
  }
  return into;
}

function fromHexUtf16(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/** A literal string's escapes: \( \) \\ and the octal form \050. */
function unescapeLiteral(text) {
  return text.replace(/\\([0-7]{1,3}|[nrtbf()\\])/g, (all, e) => {
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8) & 255);
    return { n: '\n', r: '\r', t: '\t', b: '', f: '' }[e] ?? e;
  });
}

/**
 * The words in one content stream.
 *
 * Hex strings go through the map; literal strings are already readable and are
 * taken as they are, which is what the older simple fonts in the same document
 * use. Anything that moves the cursor to a new line becomes a newline, so the
 * caller gets something with the shape of the page rather than one long run.
 *
 * A TJ array is text interleaved with numbers that nudge the next piece along.
 * Most are kerning, a few hundredths of a letter either way. A jump of a fifth
 * of an em or more backwards is a word gap drawn as a move rather than typed as
 * a space, which is how some software lays out every line, and without reading
 * it "Sail Date" arrives as "SailDate" and no label can be found.
 */
export function decodeContent(text, cmap) {
  const out = [];
  const glyphs = (hex) => {
    const padded = hex.length % 4 ? hex + '0'.repeat(4 - (hex.length % 4)) : hex;
    let s = '';
    for (let i = 0; i < padded.length; i += 4) s += cmap.get(parseInt(padded.slice(i, i + 4), 16)) ?? '';
    return s;
  };

  // Property dictionaries are not text. A tagged PDF wraps every run in
  // /Span <</Lang (en-US)>> BDC, and that "en-US" is a literal string like any
  // other, so read as words it lands in the middle of a label. Taken out first.
  text = text.replace(/<<[\s\S]*?>>/g, ' ');

  const inner = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f]*)>|(-?\d+(?:\.\d+)?)/g;
  // Operands matter here. Td moves the cursor by (dx, dy): a vertical move is a
  // new line, a small sideways one is the next letter of the same word, and a
  // big sideways one is a column gap. Chrome writes every glyph as its own Td
  // with dy of zero, so treating each Td as a line break puts every letter on a
  // line of its own, and a proposal made by a browser reads as a column of
  // single characters.
  const re = new RegExp(
    '\\[((?:\\((?:\\\\.|[^\\\\()])*\\)|<[0-9A-Fa-f]*>|[^\\]])*)\\]\\s*TJ'
    + '|<([0-9A-Fa-f]+)>'
    + '|\\(((?:\\\\.|[^\\\\()])*)\\)'
    + '|(-?\\d*\\.?\\d+)\\s+(-?\\d*\\.?\\d+)\\s+T[dD]\\b'
    + '|\\/[^\\s\\/\\[\\]<>()]+\\s+(-?\\d*\\.?\\d+)\\s+Tf\\b'
    // T* has no word character after it, so a trailing \\b never matched and every
    // line a producer ended with T* ran into the next one.
    + '|(\\bT\\*|\\bTm\\b|\\bET\\b)', 'g');
  let size = 10;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) {
      inner.lastIndex = 0;
      let k;
      while ((k = inner.exec(m[1]))) {
        if (k[1] !== undefined) out.push(unescapeLiteral(k[1]));
        else if (k[2] !== undefined) out.push(glyphs(k[2]));
        else if (Number(k[3]) <= -180) out.push(' ');
      }
    } else if (m[2] !== undefined) {
      out.push(glyphs(m[2]));
    } else if (m[3] !== undefined) {
      out.push(unescapeLiteral(m[3]));
    } else if (m[4] !== undefined) {
      const dx = Number(m[4]);
      const dy = Number(m[5]);
      if (Math.abs(dy) > 0.5) out.push('\n');
      else if (dx > size * 1.6) out.push('  ');
    } else if (m[6] !== undefined) {
      size = Math.abs(Number(m[6])) || size;
    } else {
      out.push('\n');
    }
  }
  return out.join('');
}

/**
 * What a PDF says, and how much of it could be read.
 *
 * The text, plus enough about the file to explain an empty answer. Nothing in
 * here can tell "this is a scan" from "this is a format I do not understand"
 * without looking, and those need different words on the screen: one is a file
 * nobody could read without character recognition, the other is a bug.
 *
 *   images     pictures in the file. A page that is only a picture has no text
 *              stream at all, which is what a scan or an exported brochure is.
 *   conflicts  character codes two fonts disagree about. Non-zero means the
 *              text may have wrong letters in it, and whoever reads it should
 *              say so rather than present it as certain.
 *
 * `inflate` is a parameter so the reader can be tested somewhere that has no
 * DecompressionStream; in a Worker the default is the one that is wanted.
 *
 * Never throws. Every caller of this is offering to save somebody some typing,
 * and the honest answer to a file it does not understand is an empty form, not
 * an error page.
 */
export async function pdfRead(buffer, { inflate: inflater = inflate } = {}) {
  const info = {
    text: '', streams: 0, cmaps: 0, content: 0, images: 0, conflicts: 0,
    // none, rc4 (was locked and has been opened), password (locked, and the
    // empty password does not open it) or unsupported (locked in a newer way).
    encryption: 'none',
  };
  try {
    const bytes = new Uint8Array(buffer);
    const raw = latin1(bytes);
    info.images = (raw.match(/\/Subtype\s*\/Image/g) || []).length;

    const lock = openEncryption(raw);
    info.encryption = lock.kind;
    // Nothing past here can read a locked file it cannot open, and pretending to
    // would return blank pages with no reason given.
    if (lock.kind === 'password' || lock.kind === 'unsupported') return info;

    // Where each object begins, so a stream can be traced to the object it
    // belongs to. An encrypted file has a key for every object.
    const heads = [];
    const headRe = /(?:^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g;
    let h;
    while ((h = headRe.exec(raw))) heads.push({ at: h.index, num: Number(h[1]), gen: Number(h[2]) });
    const objectAt = (pos) => {
      let lo = 0;
      let hi = heads.length - 1;
      let best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (heads[mid].at < pos) { best = heads[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      return best;
    };

    const streams = [];
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw))) {
      const from = m.index + m[0].length;
      const to = raw.indexOf('endstream', from);
      if (to < 0) continue;
      // The end of line before the keyword belongs to the file, not to the
      // stream: exactly one, and only one. Trimming every trailing newline was
      // harmless on a compressed stream and wrong on an encrypted one, where the
      // last byte of the data can be any value at all, including a newline.
      let end = to;
      if (raw[end - 2] === '\r' && raw[end - 1] === '\n') end -= 2;
      else if (raw[end - 1] === '\n' || raw[end - 1] === '\r') end -= 1;
      streams.push({ at: m.index, from, to: end });
    }
    info.streams = streams.length;

    // A font map is recognised by what is in it rather than by following the
    // reference that points at it. The reference lives in the font's own
    // dictionary, and in a file written by newer software that dictionary is
    // packed into a compressed object stream where no pattern on the raw bytes
    // can see it. The map itself is always plainly a map.
    const cmap = new Map();
    const bodies = [];
    for (const s of streams) {
      let body = bytes.slice(s.from, s.to);
      if (lock.kind === 'rc4') {
        const owner = objectAt(s.at);
        if (owner) body = lock.decrypt(body, owner.num, owner.gen);
      }
      // A stream with no compression at all is text already. Read as it stands
      // when it plainly is, rather than dropped for having failed to inflate.
      let data = await inflater(body);
      if (!data && isPlainText(body)) data = body;
      if (!data) continue;
      const text = latin1(data);
      if (/begincmap/.test(text)) {
        info.cmaps += 1;
        parseCMap(text, cmap, info);
      } else if (/\bTJ\b|\bTj\b/.test(text)) {
        bodies.push(text);
      }
    }
    info.content = bodies.length;
    info.text = bodies.map((b) => decodeContent(b, cmap)).join('\n');
  } catch (e) {
    console.error('pdfRead', e);
  }
  return info;
}

/** Roughly the words in a PDF, or nothing. See pdfRead for what else is known. */
export async function pdfText(buffer) {
  return (await pdfRead(buffer)).text;
}
