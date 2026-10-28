// Reading a confirmation that is not plain text: a screenshot or photo, or a saved email.
//
// A PDF is read in the browser, so only its text ever leaves the machine. A picture cannot be, so this sends it to Cloudflare's
// AI, which runs inside this portal's own Cloudflare account, asks for a plain transcription of what is printed on it, and
// forgets it: nothing is stored. What comes back goes into the same box a pasted confirmation goes into, so it is read by the
// same reader and checked by the same eyes before anything is saved. A transcription is only as good as the picture, which is
// why the reading is never trusted blind.

import { json, badRequest, readJson } from './util.js';
import { requireUser } from './auth.js';
import { bestReading } from './inbox.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_B64 = 6 * 1024 * 1024;
const MAX_EMAIL_CHARS = 6 * 1024 * 1024;
const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const PROMPT = 'Transcribe all the text in this image exactly as it is printed, line by line, in reading order. Keep every label '
  + 'with its value on the same line, like "Booking ID: 12345". Keep each row of a table on one line, with the columns '
  + 'separated by two spaces. Do not summarise, explain, translate or add anything. Output only the text.';

/** The model's answer, tidied: no code fences, and no sentence of its own before the transcription. */
function tidy(text) {
  let out = String(text || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  out = out.replace(/^(?:here is|here's|the text in the image|the image contains|sure[,!]?)[^\n]*:\s*\n/i, '');
  return out.replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
}

function answerOf(out) {
  if (!out) return '';
  if (typeof out === 'string') return out;
  return out.response || (out.result && out.result.response) || out.description || out.text || '';
}

function bytesFromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The text on a picture. Two request shapes are tried because the model has accepted both over time: a chat message holding
 * an image, then a prompt with the image as bytes. The first call may also be refused until the model's licence has been
 * accepted once for the account, which is a single request that says so; it is made here and the read is tried again.
 */
export async function transcribe(env, mime, b64) {
  const model = env.IMAGE_MODEL || MODEL;
  const url = `data:${mime};base64,${b64}`;
  const attempts = [
    () => env.AI.run(model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url } }] }],
      max_tokens: 2048,
    }),
    () => env.AI.run(model, { prompt: PROMPT, image: Array.from(bytesFromBase64(b64)), max_tokens: 2048 }),
  ];
  let last = null;
  let agreed = false;
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const text = tidy(answerOf(await attempts[i]()));
      if (text) return text;
      last = new Error('empty');
    } catch (e) {
      last = e;
      if (!agreed && /agree|licen[sc]e|terms/i.test(String(e && e.message))) {
        agreed = true;
        try { await env.AI.run(model, { prompt: 'agree' }); i -= 1; } catch { /* the next shape is tried */ }
      }
    }
  }
  throw last || new Error('no answer');
}

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
