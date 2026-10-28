// Reading the text off a picture, with Cloudflare's AI. Shared by the Import page and by forwarded email, so a screenshot attached
// to a message is read by the same code as one dropped on the page. Nothing is stored: the picture is sent, the words come back.

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


/** Bytes to base64, in pieces so a large picture does not overflow the call stack. */
export function toBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}
