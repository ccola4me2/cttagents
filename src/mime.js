// Reading an email, enough to find the confirmation inside it.
//
// A vendor confirmation forwarded to the portal arrives as raw mail: headers, then a body that
// may be plain text, HTML, both, or a wrapper holding the original as an attachment, with a PDF
// beside it. This takes that apart and hands back the readable pieces and nothing else. It does
// not try to be a mail client: no threading, no inline images, no encodings beyond the ones mail
// actually uses.
//
// Pure. It takes bytes and returns pieces, so it can be run against a message that is a string in
// a test rather than a stream from a mail server, the same way inbound.js is.

const MAX_DEPTH = 6;
const MAX_PARTS = 60;

/** Bytes to a string with one character per byte, so structure can be searched before it is decoded. */
function latin1(bytes) {
  let out = '';
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return out;
}

function bytesOf(binary) {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

function splitHeadBody(text) {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return { head: text, body: '' };
  return { head: text.slice(0, m.index), body: text.slice(m.index + m[0].length) };
}

/** Header lines, unfolded, by lower case name. The first of any repeated name wins. */
function parseHeaders(head) {
  const out = new Map();
  const lines = head.split(/\r?\n/);
  let name = null;
  let value = '';
  const flush = () => {
    if (name && !out.has(name)) out.set(name, value.trim());
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && name) { value += ` ${line.trim()}`; continue; }
    flush();
    const i = line.indexOf(':');
    if (i < 1) { name = null; continue; }
    name = line.slice(0, i).toLowerCase();
    value = line.slice(i + 1);
  }
  flush();
  return out;
}

/** A parameter of a header such as Content-Type: boundary, charset, name. */
function param(value, key) {
  const m = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value || '');
  return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
}

/** Quoted-printable to bytes. */
function fromQuotedPrintable(body) {
  const soft = body.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < soft.length; i += 1) {
    const c = soft[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function fromBase64(body) {
  try {
    const binary = atob(body.replace(/[^A-Za-z0-9+/=]/g, ''));
    return bytesOf(binary);
  } catch {
    return new Uint8Array(0);
  }
}

function decodeBody(body, encoding) {
  const how = String(encoding || '').toLowerCase();
  if (how === 'base64') return fromBase64(body);
  if (how === 'quoted-printable') return fromQuotedPrintable(body);
  return bytesOf(body);
}

function decodeText(bytes, charset) {
  const label = (charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Every leaf of a message: its type, its charset, its file name if it has one, and its bytes.
 * A forwarded message attached whole is walked into, so what was forwarded is found whichever
 * way the forward was made.
 */
export function leavesOf(raw) {
  const bytes = raw instanceof Uint8Array ? raw : bytesOf(String(raw || ''));
  const leaves = [];
  const state = { parts: 0 };
  walk(latin1(bytes), 0, leaves, state);
  return leaves;
}

function walk(text, depth, leaves, state) {
  if (depth > MAX_DEPTH || state.parts > MAX_PARTS) return;
  state.parts += 1;
  const { head, body } = splitHeadBody(text);
  const headers = parseHeaders(head);
  const type = (headers.get('content-type') || 'text/plain').split(';')[0].trim().toLowerCase();
  const typeValue = headers.get('content-type') || '';

  if (type.startsWith('multipart/')) {
    const boundary = param(typeValue, 'boundary');
    if (!boundary) return;
    const marker = `--${boundary}`;
    const pieces = body.split(marker).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      walk(piece.replace(/^\r?\n/, ''), depth + 1, leaves, state);
    }
    return;
  }

  if (type === 'message/rfc822') {
    // The original, attached whole. Its own headers and body follow the wrapper's.
    const encoding = headers.get('content-transfer-encoding');
    const inner = encoding && /base64|quoted/i.test(encoding)
      ? latin1(decodeBody(body, encoding)) : body;
    walk(inner, depth + 1, leaves, state);
    return;
  }

  const disposition = headers.get('content-disposition') || '';
  const filename = param(disposition, 'filename') || param(typeValue, 'name');
  leaves.push({
    type,
    charset: param(typeValue, 'charset'),
    filename,
    bytes: decodeBody(body, headers.get('content-transfer-encoding')),
    headers,
  });
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '-', mdash: '-',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', bull: '*', copy: '(c)',
};

/**
 * HTML to the text a person would copy off the screen: a line for each row, a tab between
 * cells. The tab is what keeps a table's label and its figure on one line, which is the shape
 * the confirmation reader works on.
 */
export function htmlToText(html) {
  let s = String(html || '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : ' ';
  });
  return s.replace(/ /g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]*\t[ \t]*/g, '\t').replace(/[ ]{2,}/g, ' ').replace(/^\t+|\t+$/g, '').trim())
    .filter((line, i, all) => line || (all[i - 1] !== '' && i > 0))
    .join('\n')
    .trim();
}

/** A forward quoted with leading > marks, put back as it was written. */
function unquote(text) {
  const lines = text.split(/\r?\n/);
  const quoted = lines.filter((l) => /^\s*>/.test(l)).length;
  if (!quoted || quoted < lines.filter((l) => l.trim()).length / 2) return text;
  return lines.map((l) => l.replace(/^(\s*>)+ ?/, '')).join('\n');
}

/**
 * The readable pieces of a message: the plain text, the HTML as text, any PDF attachments and any pictures.
 * More than one comes back on purpose. A message that carries both a text and an HTML version
 * does not always carry the same thing in each, and which one reads best is for the confirmation
 * reader to say.
 */
export function readableParts(raw) {
  const out = { texts: [], pdfs: [], images: [], headers: new Map() };
  const bytes = raw instanceof Uint8Array ? raw : bytesOf(String(raw || ''));
  const { head } = splitHeadBody(latin1(bytes));
  out.headers = parseHeaders(head);

  for (const leaf of leavesOf(bytes)) {
    if (leaf.type === 'text/plain') {
      const text = unquote(decodeText(leaf.bytes, leaf.charset)).trim();
      if (text) out.texts.push({ source: 'text', text });
    } else if (leaf.type === 'text/html') {
      const text = htmlToText(decodeText(leaf.bytes, leaf.charset));
      if (text) out.texts.push({ source: 'html', text });
    } else if (leaf.type === 'application/pdf' || /\.pdf$/i.test(leaf.filename || '')) {
      if (leaf.bytes.length) out.pdfs.push({ filename: leaf.filename || 'attachment.pdf', bytes: leaf.bytes });
    } else if (['image/png', 'image/jpeg', 'image/webp'].includes(leaf.type) && leaf.bytes.length > 8000 && out.images.length < 4) {
      // A screenshot of a confirmation. A signature logo or a tracking pixel is smaller than this, which is why there is a floor.
      out.images.push({ filename: leaf.filename || 'picture', mime: leaf.type, bytes: leaf.bytes });
    }
  }
  return out;
}
