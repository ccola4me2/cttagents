// Which reservation does each file belong to? Found by the confirmation number on it.
//
// An advisor with twenty documents from three vendors does not want to open twenty reservations. Each file is sent here on its
// own, and the strings in its name and, for a PDF, in its text that look like a confirmation number are looked up among the
// reservations the asker may attach to: their own, or the whole agency for an owner. The answer lists the reservations those
// numbers belong to, best match first, and the page shows it for the advisor to confirm before anything is attached. Nothing is
// stored here: the file is read and forgotten, and is only kept once it is attached to a reservation by the normal route.

import { json, badRequest } from './util.js';
import { requireUser } from './auth.js';
import { pdfRead } from './pdftext.js';
import * as db from './db.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOKENS = 400;
const CHUNK = 80;

/** A confirmation number with the spaces, dashes and slashes people add taken out, so "ABC-123 45" finds "ABC12345". */
const norm = (t) => String(t || '').toUpperCase().replace(/[\s\-/]/g, '');

/** Everything in some text shaped like a reference: five to thirty letters and digits, with at least one digit. */
export function tokensFrom(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/[A-Za-z0-9][A-Za-z0-9\-/]{4,29}/g)) {
    const t = norm(m[0]);
    if (t.length >= 5 && t.length <= 30 && /\d/.test(t)) out.add(t);
    if (out.size >= MAX_TOKENS) break;
  }
  return [...out];
}

/** POST /api/documents/match, a form with the file's name and, for a PDF, the file : the reservations its numbers belong to. */
export async function handleMatchDocument(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  let form;
  try { form = await request.formData(); } catch { form = null; }
  if (!form) return badRequest('There is no file to match.');
  const name = String(form.get('name') || '').slice(0, 300);
  const file = form.get('file');

  // The name first, because it is the one thing every kind of file has. A scan or a picture has nothing else.
  const fromName = tokensFrom(name.replace(/\.[a-z0-9]{2,5}$/i, ' '));
  let fromText = [];
  let read = 'name';
  if (file && typeof file !== 'string' && file.size && file.size <= MAX_BYTES && (/pdf/i.test(file.type || '') || /\.pdf$/i.test(name))) {
    try {
      const got = await pdfRead(await file.arrayBuffer());
      if (got && got.text && got.text.trim()) { fromText = tokensFrom(got.text.slice(0, 40000)); read = 'pdf'; }
    } catch { /* a PDF that cannot be opened is read by its name alone */ }
  }
  const all = [...new Set([...fromName, ...fromText])].slice(0, MAX_TOKENS);
  const named = new Set(fromName);

  const scope = user.role === 'admin' ? db.agencyScope(user) : db.selfScope(user);
  const scoped = db.scopeWhere(scope, 'b.user_id');
  const byBooking = new Map();
  for (let i = 0; i < all.length; i += CHUNK) {
    const part = all.slice(i, i + CHUNK);
    const marks = part.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date, b.status, b.confirmation_number,
              COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email) AS advisor
         FROM bookings b JOIN users u ON u.id = b.user_id
        WHERE ${scoped.sql} AND b.confirmation_number IS NOT NULL AND b.confirmation_number <> ''
          AND UPPER(REPLACE(REPLACE(REPLACE(b.confirmation_number, ' ', ''), '-', ''), '/', '')) IN (${marks})
        LIMIT 200`
    ).bind(...scoped.binds, ...part).all();
    for (const r of results || []) {
      const found = byBooking.get(r.id) || { ...r, hits: 0, inName: false };
      found.hits += 1;
      if (named.has(norm(r.confirmation_number))) found.inName = true;
      byBooking.set(r.id, found);
    }
  }

  // The best first: a number in the file's name is the clearest sign, then the most numbers found in the text.
  const reservations = [...byBooking.values()]
    .sort((a, b) => (Number(b.inName) - Number(a.inName)) || (b.hits - a.hits))
    .slice(0, 12)
    .map((b) => ({
      id: b.id, client: b.client_name, supplier: b.supplier || '', product: b.product_name || '', departDate: b.depart_date || '',
      status: b.status, confirmation: b.confirmation_number, advisor: b.advisor, hits: b.hits, inName: b.inName,
    }));
  return json({ ok: true, read, reservations });
}
