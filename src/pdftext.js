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
      const stream = new ReadableStream({
        start(c) { c.enqueue(bytes); c.close(); },
      }).pipeThrough(new DecompressionStream(format));
      const out = await new Response(stream).arrayBuffer();
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
export function parseCMap(text, into = new Map()) {
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m;
    while ((m = re.exec(block))) into.set(parseInt(m[1], 16), fromHexUtf16(m[2]));
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m;
    while ((m = re.exec(block))) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 65535);
      const base = parseInt(m[3], 16);
      for (let c = lo; c <= hi; c += 1) into.set(c, String.fromCodePoint(base + (c - lo)));
    }
  }
  return into;
}

function fromHexUtf16(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/**
 * The words in one content stream.
 *
 * Hex strings go through the map; literal strings are already readable and are
 * taken as they are, which is what the older simple fonts in the same document
 * use. Anything that moves the cursor to a new line becomes a newline, so the
 * caller gets something with the shape of the page rather than one long run.
 */
export function decodeContent(text, cmap) {
  const out = [];
  const re = /<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\()])*)\)|\b(Td|TD|T\*|Tm)\b/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) {
      const hex = m[1].length % 4 ? m[1] + '0'.repeat(4 - (m[1].length % 4)) : m[1];
      let s = '';
      for (let i = 0; i < hex.length; i += 4) s += cmap.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
      out.push(s);
    } else if (m[2] !== undefined) {
      out.push(m[2].replace(/\\([()\\])/g, '$1'));
    } else {
      out.push('\n');
    }
  }
  return out.join('');
}

/**
 * Roughly the words in a PDF.
 *
 * Returns '' rather than throwing on anything it cannot read. Every caller of
 * this is offering to save somebody some typing, and the honest answer to a
 * file it does not understand is an empty form, not an error page.
 */
export async function pdfText(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const raw = latin1(bytes);

    // Every stream, with where it sits, so a ToUnicode object can be found by
    // the reference that points at it.
    const streams = [];
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw))) {
      const from = m.index + m[0].length;
      const to = raw.indexOf('endstream', from);
      if (to < 0) continue;
      streams.push({ at: m.index, from, to });
    }

    // Which streams are ToUnicode maps: the object number in the reference,
    // then that object's stream.
    const cmapAt = new Set();
    const refs = raw.match(/\/ToUnicode\s+(\d+)\s+0\s+R/g) || [];
    for (const ref of refs) {
      const num = ref.match(/(\d+)/)[1];
      const obj = new RegExp(`(?:^|[^0-9])${num}\\s+0\\s+obj`).exec(raw);
      if (!obj) continue;
      const s = streams.find((x) => x.at > obj.index);
      if (s) cmapAt.add(s.at);
    }

    const cmap = new Map();
    const bodies = [];
    for (const s of streams) {
      const data = await inflate(bytes.subarray(s.from, s.to));
      if (!data) continue;
      const text = latin1(data);
      if (cmapAt.has(s.at)) parseCMap(text, cmap);
      else if (/\bTJ\b|\bTj\b/.test(text)) bodies.push(text);
    }

    return bodies.map((b) => decodeContent(b, cmap)).join('\n');
  } catch (e) {
    console.error('pdfText', e);
    return '';
  }
}
