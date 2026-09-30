// A PDF that is locked but not closed.
//
// Cruise lines lock the contracts they send. The lock stops editing and copying
// and is set by the sender's software, not by anybody choosing a password, so
// the file opens in any viewer with nothing typed. Underneath it the whole
// document is scrambled and only the viewer knows how to undo it, which means a
// reader that does not shows 7 pages of nothing: no error, no text, and no way
// for the person who uploaded it to know why.
//
// This undoes the two oldest forms of that lock (RC4 with a 40 or 128 bit key),
// using the empty password that such files are opened with. It is plain
// JavaScript with no library and no Web Crypto, because the two primitives are
// short and because it then runs identically in a Worker and in the test
// harness here.
//
// What it does NOT do, on purpose:
//
//   - A file that genuinely needs a password is reported as such. The file
//     carries a check value for the password, so "the empty password did not
//     work" is something it knows rather than guesses.
//   - A newer form (AES) is reported as unsupported rather than attempted.
//     Returning garbage from a half-working decryptor is worse than returning
//     nothing, and the advisor can get round it in ten seconds by printing the
//     file to a fresh PDF, which is what the screen tells them.
//
// Only revision 2 has been checked against a real contract. Revision 3 is
// written from the specification, and is gated by the same password check, so
// if it is wrong it says the file could not be opened instead of reading it
// wrongly.

const PAD = Uint8Array.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

// ------------------------------------------------------------------ MD5 ---
const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

/** MD5 of some bytes, as 16 bytes. */
export function md5(input) {
  const data = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const total = ((data.length + 8) >>> 6) + 1;
  const words = new Uint32Array(total * 16);
  for (let i = 0; i < data.length; i += 1) words[i >> 2] |= data[i] << ((i % 4) * 8);
  words[data.length >> 2] |= 0x80 << ((data.length % 4) * 8);
  words[total * 16 - 2] = (data.length * 8) >>> 0;
  words[total * 16 - 1] = Math.floor((data.length * 8) / 4294967296) >>> 0;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let block = 0; block < total; block += 1) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = (a + f + MD5_K[i] + words[block * 16 + g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((t << MD5_SHIFT[i]) | (t >>> (32 - MD5_SHIFT[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((w, i) => {
    out[i * 4] = w & 255; out[i * 4 + 1] = (w >>> 8) & 255;
    out[i * 4 + 2] = (w >>> 16) & 255; out[i * 4 + 3] = (w >>> 24) & 255;
  });
  return out;
}

// ------------------------------------------------------------------ RC4 ---
/** RC4, which is its own inverse, so this both scrambles and unscrambles. */
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n += 1) {
    a = (a + 1) & 255;
    b = (b + s[a]) & 255;
    [s[a], s[b]] = [s[b], s[a]];
    out[n] = data[n] ^ s[(s[a] + s[b]) & 255];
  }
  return out;
}

// -------------------------------------------------------------- reading ---
const same = (a, b, n) => { for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return false; return true; };

/** A PDF string token, hex or literal, as bytes. */
function pdfString(token) {
  const t = token.trim();
  if (t.startsWith('<')) {
    const hex = t.slice(1, -1).replace(/\s+/g, '');
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const body = t.slice(1, -1);
  const out = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== '\\') { out.push(body.charCodeAt(i) & 255); continue; }
    i += 1;
    const e = body[i];
    if (/[0-7]/.test(e)) {
      let oct = e;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] || '')) { i += 1; oct += body[i]; }
      out.push(parseInt(oct, 8) & 255);
    } else if (e === '\n') {
      // A backslash at the end of a line continues it.
    } else {
      out.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[e] ?? e.charCodeAt(0));
    }
  }
  return Uint8Array.from(out);
}

const STRING = '(<[0-9A-Fa-f\\s]*>|\\((?:\\\\[\\s\\S]|[^\\\\)])*\\))';

/**
 * Whether this file is locked, and if it is, how to unlock it.
 *
 * `kind` is one of none, rc4 (unlocked, use decrypt), password (locked and the
 * empty password does not open it) or unsupported (locked in a newer way).
 * `raw` is the file as one string of code points 0 to 255.
 */
export function openEncryption(raw) {
  const ref = raw.match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/);
  if (!ref) return { kind: /\/Encrypt\b/.test(raw) ? 'unsupported' : 'none', decrypt: null };

  const obj = new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj([\\s\\S]*?)endobj`).exec(raw);
  if (!obj) return { kind: 'unsupported', decrypt: null };
  const d = obj[1];

  const number = (name) => { const m = d.match(new RegExp(`/${name}\\s+(-?\\d+)`)); return m ? Number(m[1]) : null; };
  const V = number('V') ?? 0;
  const R = number('R');
  const P = number('P');
  const bits = number('Length') ?? 40;
  const O = d.match(new RegExp(`/O\\s*${STRING}`));
  const U = d.match(new RegExp(`/U\\s*${STRING}`));
  const id = raw.match(/\/ID\s*\[\s*<([0-9A-Fa-f]+)>/);

  // Anything newer than the two RC4 forms: AES, or a crypt filter dictionary.
  if (!/\/Filter\s*\/Standard/.test(d) || V > 2 || (R !== 2 && R !== 3) || /\/CF\b/.test(d)
      || !O || !U || P === null || !id) {
    return { kind: 'unsupported', decrypt: null };
  }

  const owner = pdfString(O[1]);
  const user = pdfString(U[1]);
  const first = Uint8Array.from((id[1].match(/../g) || []).map((h) => parseInt(h, 16)));
  const n = R === 2 ? 5 : Math.max(5, Math.min(16, bits / 8));

  const perm = new Uint8Array([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >> 24) & 255]);
  const seed = new Uint8Array(PAD.length + 32 + 4 + first.length);
  seed.set(PAD, 0); seed.set(owner.slice(0, 32), PAD.length);
  seed.set(perm, PAD.length + 32); seed.set(first, PAD.length + 36);
  let hash = md5(seed);
  if (R === 3) for (let i = 0; i < 50; i += 1) hash = md5(hash.slice(0, n));
  const key = hash.slice(0, n);

  // The password check. The file carries a value computed from the password, so
  // whether the empty one opens it is known, not assumed.
  let opens;
  if (R === 2) {
    opens = same(rc4(key, PAD), user, 32);
  } else {
    const seedU = new Uint8Array(PAD.length + first.length);
    seedU.set(PAD, 0); seedU.set(first, PAD.length);
    let x = rc4(key, md5(seedU));
    for (let i = 1; i <= 19; i += 1) x = rc4(key.map((b) => b ^ i), x);
    opens = same(x, user, 16);
  }
  if (!opens) return { kind: 'password', decrypt: null };

  return {
    kind: 'rc4',
    // Each object has a key of its own, made from the file key and the object's
    // number, so the same text in two objects is not the same bytes.
    decrypt(data, num, gen = 0) {
      const tail = new Uint8Array(n + 5);
      tail.set(key, 0);
      tail[n] = num & 255; tail[n + 1] = (num >> 8) & 255; tail[n + 2] = (num >> 16) & 255;
      tail[n + 3] = gen & 255; tail[n + 4] = (gen >> 8) & 255;
      return rc4(md5(tail).slice(0, Math.min(n + 5, 16)), data);
    },
  };
}

