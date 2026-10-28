// Reading a confirmation that is not plain text: a screenshot or photo, or a saved email.
//
// A PDF is read in the browser, so only its text ever leaves the machine. A picture cannot be, so this sends it to Cloudflare's
// AI, which runs inside this portal's own Cloudflare account, asks for a plain transcription of what is printed on it, and
// forgets it: nothing is stored. What comes back goes into the same box a pasted confirmation goes into, so it is read by the
// same reader and checked by the same eyes before anything is saved. A transcription is only as good as the picture, which is
// why the reading is never trusted blind.

import { json, badRequest, readJson } from './util.js';
import { pdfRead } from './pdftext.js';
import { requireUser } from './auth.js';
import { bestReading } from './inbox.js';
import { transcribe } from './transcribe.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_B64 = 6 * 1024 * 1024;
const MAX_EMAIL_CHARS = 6 * 1024 * 1024;
/** POST /api/import/image { mime, data } : the text printed on a screenshot or photo of a confirmation. */
export async function handleReadImage(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);
  const mime = String(body.mime || '').toLowerCase();
  const data = String(body.data || '').replace(/^data:[^,]*,/, '');
  if (!IMAGE_TYPES.has(mime)) return badRequest('A picture has to be a PNG, JPEG or WebP. Take a screenshot of it instead.');
  if (!data) return badRequest('There is no picture there.');
  if (data.length > MAX_IMAGE_B64) return json({ error: 'That picture is too big. Take a screenshot of just the confirmation.' }, 413);
  if (!env.AI) return json({ error: 'Reading pictures is not switched on for this portal yet. Paste the text, or use a PDF.' }, 503);
  try {
    const text = await transcribe(env, mime, data);
    return json({ ok: true, text });
  } catch (e) {
    console.error('image read', e && e.message);
    return json({ error: 'That picture could not be read. Try a clearer one, or paste the text.' }, 502);
  }
}

/** POST /api/import/email-file { raw } : the confirmation inside a saved email (.eml), by the same reader the inbox uses. */
export async function handleReadEmailFile(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);
  const raw = String(body.raw || '');
  if (!raw.trim()) return badRequest('That email is empty.');
  if (raw.length > MAX_EMAIL_CHARS) return json({ error: 'That email is too big to read.' }, 413);
  try {
    const { best } = await bestReading(raw);
    if (!best || !best.text || !best.text.trim()) {
      return badRequest('I could not find a confirmation in that email. Paste the text instead.');
    }
    return json({ ok: true, text: best.text, from: best.source });
  } catch (e) {
    console.error('email read', e && e.message);
    return badRequest('That email could not be opened. Paste the text instead.');
  }
}

/**
 * POST /api/import/pdf-text, the PDF itself as the body : its text, read by the portal.
 *
 * The Import page reads a PDF in the browser with a library from a content network, which an office firewall or an ad blocker
 * can stop from loading, and which cannot open every file. This is the second try, so a PDF that the browser could not read is
 * read here before anybody is told to paste it by hand.
 */
export async function handleReadPdfText(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  const buf = await request.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength) return badRequest('No file arrived.');
  if (buf.byteLength > 10 * 1024 * 1024) return json({ error: 'That PDF is larger than 10MB.' }, 413);
  try {
    const file = await pdfRead(buf);
    if (file.encryption === 'password' || file.encryption === 'unsupported') {
      return badRequest('That PDF is locked, so it cannot be read. Save an unlocked copy, or paste its text.');
    }
    if (!file.text || !file.text.trim()) {
      return badRequest(file.images > 0 ? 'That PDF is a picture of a page.' : 'There is no text in that PDF.');
    }
    return json({ ok: true, text: file.text });
  } catch (e) {
    console.error('pdf text', e && e.message);
    return badRequest('That PDF could not be opened.');
  }
}
