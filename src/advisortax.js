// What the agency needs on file to report what it paid each advisor at the end of the year.
//
// An advisor is paid commission by the agency, and the agency reports that to the tax authority on a 1099-NEC for anyone
// paid $600 or more in the year. For that it needs the same few things every year: the advisor's legal name, the kind
// of taxpayer they are, the last four digits of their tax number, a mailing address and the date their W-9 arrived.
//
// Only the last four digits are ever kept here. The whole number belongs on the signed W-9 in the agency's own records,
// and a field that would hold it would be a field that has to be protected like a vault. This holds nothing a thief
// could use, and says so on the screen.
//
// An owner's, start to finish. An advisor never sees another's, and does not enter their own: the owner collects the W-9
// and records it.

import { json, badRequest, notFound, clean, cleanText, cleanDate, oneOf, now, readJson } from './util.js';
import { requireAdmin } from './auth.js';
import * as db from './db.js';

export const CLASSES = [
  ['individual', 'Individual or sole proprietor'],
  ['llc_single', 'LLC taxed as a sole proprietor'],
  ['llc_c', 'LLC taxed as a C corporation'],
  ['llc_s', 'LLC taxed as an S corporation'],
  ['llc_p', 'LLC taxed as a partnership'],
  ['c_corp', 'C corporation'],
  ['s_corp', 'S corporation'],
  ['partnership', 'Partnership'],
  ['other', 'Something else'],
];
const CLASS_KEYS = CLASSES.map(([k]) => k);
const TIN_TYPES = ['ssn', 'ein'];

// The amount at which a 1099-NEC is due for the year, in cents.
export const REPORT_AT_CENTS = 60000;

const noAgency = () => badRequest('This account is not part of an agency.');

/** GET /api/admin/tax?year= : every advisor, what is on file for them, and what they were paid in the year. */
export async function handleTaxList(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return noAgency();

  const thisYear = String(new Date().getUTCFullYear());
  const asked = clean(new URL(request.url).searchParams.get('year'), 4);
  const year = /^\d{4}$/.test(asked) ? asked : thisYear;

  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.status, u.role,
            t.legal_name, t.business_name, t.classification, t.tin_type, t.tin_last4, t.address, t.w9_on,
            t.backup_withholding, t.foreign_payee, t.notes
       FROM users u LEFT JOIN advisor_tax t ON t.user_id = u.id
      WHERE u.agency_id = ? AND u.status IN ('active', 'pending')
      ORDER BY u.first_name, u.last_name`
  ).bind(user.agency_id).all();

  const paid = await env.DB.prepare(
    `SELECT p.user_id AS user_id, COALESCE(SUM(p.amount_cents), 0) AS cents, COUNT(*) AS n
       FROM advisor_payouts p
      WHERE p.user_id IN (SELECT id FROM users WHERE agency_id = ?) AND substr(COALESCE(p.paid_on, ''), 1, 4) = ?
      GROUP BY p.user_id`
  ).bind(user.agency_id, year).all();
  const byUser = new Map((paid.results || []).map((r) => [r.user_id, r]));

  const years = await env.DB.prepare(
    `SELECT DISTINCT substr(COALESCE(p.paid_on, ''), 1, 4) AS y FROM advisor_payouts p
      WHERE p.user_id IN (SELECT id FROM users WHERE agency_id = ?) ORDER BY y DESC LIMIT 10`
  ).bind(user.agency_id).all();

  const advisors = (results || []).map((r) => {
    const p = byUser.get(r.user_id) || { cents: 0, n: 0 };
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email;
    return {
      userId: r.user_id, name, email: r.email, status: r.status,
      legalName: r.legal_name || '', businessName: r.business_name || '', classification: r.classification || '',
      tinType: r.tin_type || '', tinLast4: r.tin_last4 || '', address: r.address || '', w9On: r.w9_on || '',
      backupWithholding: Boolean(r.backup_withholding), foreignPayee: Boolean(r.foreign_payee), notes: r.notes || '',
      paidCents: p.cents, payouts: p.n,
      // Whether a 1099-NEC is due for them for this year, and whether what is on file is enough to file it.
      reportable: p.cents >= REPORT_AT_CENTS && !r.foreign_payee,
      missingW9: !r.w9_on,
    };
  });

  return json({
    year, years: [...new Set([year, thisYear, ...(years.results || []).map((x) => x.y).filter(Boolean)])].sort().reverse(),
    classes: CLASSES.map(([key, label]) => ({ key, label })),
    reportAtCents: REPORT_AT_CENTS,
    advisors,
    totals: {
      paidCents: advisors.reduce((n, a) => n + a.paidCents, 0),
      reportable: advisors.filter((a) => a.reportable).length,
      missingW9: advisors.filter((a) => a.missingW9).length,
      // The ones it matters for: paid this year and no W-9 yet.
      missingW9AndPaid: advisors.filter((a) => a.missingW9 && a.paidCents > 0).length,
    },
  });
}

/** PUT /api/admin/tax/:userId : record what is on file for one advisor. */
export async function handleTaxSave(request, env, userId) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return noAgency();

  const who = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND agency_id = ?').bind(userId, user.agency_id).first();
  if (!who) return notFound('That advisor is not here.');

  const body = await readJson(request);
  const rawTin = String(body.tinLast4 || '').trim();
  if (rawTin && !/^\d{4}$/.test(rawTin)) {
    return badRequest('Only the last four digits of the tax number go here. The whole number stays on the signed W-9.');
  }
  const w9On = body.w9On ? cleanDate(body.w9On) : null;
  if (body.w9On && !w9On) return badRequest('That date is not a real date. Check the year.');
  const tinType = oneOf(body.tinType, TIN_TYPES);
  if (rawTin && !tinType) return badRequest('Say whether that is a Social Security number or an EIN.');

  await env.DB.prepare(
    `INSERT INTO advisor_tax (user_id, legal_name, business_name, classification, tin_type, tin_last4, address, w9_on,
                              backup_withholding, foreign_payee, notes, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET legal_name = excluded.legal_name, business_name = excluded.business_name,
       classification = excluded.classification, tin_type = excluded.tin_type, tin_last4 = excluded.tin_last4,
       address = excluded.address, w9_on = excluded.w9_on, backup_withholding = excluded.backup_withholding,
       foreign_payee = excluded.foreign_payee, notes = excluded.notes, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).bind(
    userId, clean(body.legalName, 160) || null, clean(body.businessName, 160) || null,
    oneOf(body.classification, CLASS_KEYS), tinType, rawTin || null, cleanText(body.address, 400) || null, w9On,
    body.backupWithholding ? 1 : 0, body.foreignPayee ? 1 : 0, cleanText(body.notes, 500) || null, user.id, now(),
  ).run();
  await db.logActivity(env, user.id, 'tax.advisor', 'Updated an advisor\'s tax details', { id: userId });
  return json({ ok: true });
}
