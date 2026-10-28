// The commission desk: money in from vendors, and when each advisor is paid for it.
//
// A vendor's check arrives with a page saying what it is for. Recording one means
// saying who sent it, what the page says they paid, what was taken out on the way,
// and which reservation each line belongs to and which pay date it goes out with.
// Everything after that is arithmetic on those facts: the advisor's share of each
// line, when it is theirs, what is still owed to the agency.
//
// Three rules are decided here and nowhere else.
//
//  - A fee on a check is the agency's. It is kept on the check so it can be counted
//    as the expense it is, and the advisor's share is a share of the statement
//    amount, never of what reached the bank.
//  - What an advisor can see is limited to money assigned to the next pay date or
//    earlier. That is paydates.js and the readers that apply it; this module is the
//    owner's side, which sees all of it.
//  - Only owners write any of this. An advisor who could record a check could
//    release their own pay.

import { json, badRequest, notFound, clean, cleanDate, toCents, oneOf, uid, now, readJson } from './util.js';
import { requireAdmin } from './auth.js';
import { COMMISSION_KIND_KEYS } from './pricing.js';
import { splitPct, SPLIT_PCT_SQL, shareOf, UNSPLIT_COMMISSION_KINDS } from './split.js';
import { syncCommissionStatus } from './reconcile.js';
import { bucketFor, BUCKETS } from './commissions.js';
import { pdfRead } from './pdftext.js';
import { readRemittance, readStatementText, nameFit, nameWords } from './remittance.js';
import { owedByDate } from './commissionschedule.js';
import { nextPayDate, payDatesFrom, suggestPayDate, todayIso } from './paydates.js';
import * as db from './db.js';

const MAX_UPLOAD = 6 * 1024 * 1024;
const MAX_LINES = 60;

// Commission the vendor has been asked about and has not answered. Its own group on the owed list, after the ageing ones.
const DISPUTED_BUCKET = { key: 'disputed', label: 'Disputed', hint: 'You have asked the vendor and are waiting on an answer' };

const isoYear = (v) => (/^\d{4}$/.test(String(v || '')) ? String(v) : todayIso().slice(0, 4));

function noAgency() {
  return badRequest('Your account is not part of an agency yet.');
}

// ---------------------------------------------------------------------------
// Finding the reservation a line belongs to
// ---------------------------------------------------------------------------

/**
 * Reservations that could be what a check line is for.
 *
 * By record locator, by the surname a ticket carries, or by words somebody typed:
 * the three ways a person actually finds a trip. Scoped to the agency and to
 * reservations that are booked or travelled, since commission is not paid on a
 * quote.
 */
async function findReservations(env, admin, { locator, last, text, limit = 12 }) {
  const scoped = db.scopeWhere(db.agencyScope(admin), 'b.user_id');
  const where = [scoped.sql, "b.status IN ('booked','travelled')"];
  const binds = [...scoped.binds];

  const traveller = `EXISTS (SELECT 1 FROM travellers t WHERE t.booking_id = b.id
                              AND t.user_id = b.user_id AND UPPER(t.name) LIKE ?)`;
  const ors = [];
  if (locator) {
    ors.push('UPPER(b.confirmation_number) = ?');
    binds.push(String(locator).toUpperCase());
  }
  if (last) {
    const like = `%${String(last).toUpperCase().replace(/[%_]/g, '')}%`;
    ors.push('UPPER(b.client_name) LIKE ?', traveller);
    binds.push(like, like);
  }
  if (ors.length) where.push(`(${ors.join(' OR ')})`);

  const words = String(text || '').split(/\s+/).filter(Boolean).slice(0, 4);
  for (const w of words) {
    const like = `%${w.replace(/[%_]/g, '')}%`;
    where.push(`(b.client_name LIKE ? OR b.confirmation_number LIKE ? OR b.supplier LIKE ?
                 OR b.product_name LIKE ? OR ${traveller.replace('UPPER(t.name) LIKE ?', 't.name LIKE ?')})`);
    binds.push(like, like, like, like, like);
  }
  if (!ors.length && !words.length) return [];

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.product_type, b.depart_date,
            b.return_date, b.confirmation_number, b.commission_cents, b.commission_status,
            b.user_id,
            u.default_split_pct, u.lead_split_pct, b.personal, b.lead_source, b.advisor_split_pct,
            b.agreed_split_pct, b.agreed_lead_split_pct,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
              AS advisor_name,
            (SELECT GROUP_CONCAT(t.name, ' | ') FROM travellers t
              WHERE t.booking_id = b.id AND t.user_id = b.user_id) AS traveller_names,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id AND r.user_id = b.user_id), 0) AS received_cents
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC
      LIMIT ?`
  ).bind(...binds, Math.min(limit, 40)).all();

  const today = todayIso();
  return (results || []).map((b) => ({
    id: b.id,
    clientName: b.client_name,
    travellers: b.traveller_names ? String(b.traveller_names).split(' | ') : [],
    supplier: b.supplier,
    productName: b.product_name,
    productType: b.product_type,
    departDate: b.depart_date,
    returnDate: b.return_date,
    confirmationNumber: b.confirmation_number,
    expectedCents: b.commission_status === 'none' ? 0 : (b.commission_cents || 0),
    receivedCents: b.received_cents || 0,
    advisorId: b.user_id,
    advisorName: b.advisor_name,
    // The share the advisor keeps, so a line can say what it pays them before it is saved.
    splitPct: splitPct(b, b.default_split_pct, b.lead_split_pct),
    // The pay date this one would normally go out with: the first on or after 30 days before sailing.
    suggestedPayOn: suggestPayDate({ receivedOn: today, returnDate: b.return_date, departDate: b.depart_date }, today),
  }));
}

/** How well each reservation fits a line, best first, with an answer only when it is clear. */
function rankFor(line, found) {
  const ranked = found.map((b) => {
    const locatorHit = line.locator && b.confirmationNumber
      && String(b.confirmationNumber).toUpperCase() === line.locator.toUpperCase() ? 4 : 0;
    const names = [b.clientName, ...b.travellers];
    const fit = nameFit(line.traveller, names);
    return { ...b, score: locatorHit + fit };
  }).filter((b) => b.score > 0).sort((a, b) => b.score - a.score);

  // Only a reference match, or the surname and the first name together, is an
  // answer. A surname on its own is a short list for a person to choose from, and
  // choosing for them is how a commission goes to the wrong advisor.
  const [top, second] = ranked;
  const sure = top && top.score >= 3 && (!second || second.score < top.score);
  const named = top && top.score === 2 && (!second || second.score < 2);
  return { candidates: ranked.slice(0, 6), pick: sure || named ? top.id : null };
}

// ---------------------------------------------------------------------------
// Reading a remittance
// ---------------------------------------------------------------------------

/** The page that came with a check, read, and each line matched where it can be. */
export async function handleReadRemittance(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return noAgency();

  const buf = await request.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength) return badRequest('No file arrived.');
  if (buf.byteLength > MAX_UPLOAD) return badRequest('That file is larger than 6MB, which is more than a remittance.');

  // Rows pasted from a spreadsheet or saved as a CSV file, from any vendor, come as text. A PDF is the Travel Leaders
  // Network remittance as before.
  let remittance;
  if (/^text\//i.test(request.headers.get('content-type') || '')) {
    remittance = readStatementText(new TextDecoder().decode(buf));
    if (!remittance.read) {
      return badRequest('I could not find any rows with an amount on them. Paste one reservation on each row, with its confirmation number and what was paid.');
    }
  } else {
    const file = await pdfRead(buf);
    if (file.encryption === 'password' || file.encryption === 'unsupported') {
      return badRequest('That PDF is locked, so it cannot be read. Type the check in, or save an unlocked copy.');
    }
    if (!file.text.trim()) {
      return badRequest(file.images > 0
        ? 'That PDF is a picture of a page, not text I can read. Type the check in.'
        : 'There is no text in that file. Type the check in.');
    }
    remittance = readRemittance(file.text);
    // Not a Travel Leaders Network remittance: try it as rows, the way a pasted statement from any vendor is read, so a
    // commission statement from a cruise line or a host can be dropped in as it is.
    if (!remittance.read) remittance = readStatementText(file.text);
    if (!remittance.read) {
      return badRequest('I could not find rows with a confirmation number and an amount in that PDF. Paste its rows from a spreadsheet, or type the check in.');
    }
  }
  if (remittance.lines.length > MAX_LINES) {
    return badRequest(`That remittance has ${remittance.lines.length} lines, which is more than one check takes here (${MAX_LINES}).`);
  }

  const lines = [];
  for (const line of remittance.lines) {
    const last = line.traveller && nameWords(line.traveller.last)[0];
    let found = [];
    // A pasted row offers several things shaped like a confirmation number: the first one that is a reservation's wins.
    for (const token of (line.locators && line.locators.length ? line.locators : [line.locator])) {
      if (!token) continue;
      found = await findReservations(env, user, { locator: token, last });
      if (found.some((b) => String(b.confirmationNumber || '').toUpperCase() === token)) { line.locator = token; break; }
    }
    if (!found.length && !line.locator) found = await findReservations(env, user, { locator: null, last });
    const { candidates, pick } = rankFor(line, found);
    lines.push({ ...line, candidates, pick });
  }

  let duplicate = null;
  if (remittance.checkNumber) {
    duplicate = await env.DB.prepare(
      `SELECT id, received_on, statement_cents FROM commission_checks
        WHERE agency_id = ? AND reference = ? LIMIT 1`
    ).bind(user.agency_id, remittance.checkNumber).first();
  }

  return json({
    ok: true,
    remittance: { ...remittance, lines },
    duplicate,
    today: todayIso(),
    payDates: payDatesFrom(todayIso(), 10),
  });
}

/** Search the reservations by hand, for the line that did not find its own. */
export async function handleSearchForCheck(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return noAgency();

  const q = clean(new URL(request.url).searchParams.get('q'), 80);
  if (q.length < 2) return json({ reservations: [] });
  return json({ reservations: await findReservations(env, user, { text: q, limit: 12 }) });
}

// ---------------------------------------------------------------------------
// Recording a check
// ---------------------------------------------------------------------------

/**
 * A line amount in cents, with its sign. A vendor takes money back as often as it pays it: a line short because of a fee, or
 * a chargeback, is a negative on the reservation it came off. "-4.00" and "(4.00)" are both read as minus four dollars.
 */
function signedCents(value) {
  const text = String(value ?? '').trim();
  const negative = text.startsWith('-') || /^\(.*\)$/.test(text);
  const cents = toCents(text.replace(/^[-(]+|\)$/g, ''));
  return negative ? -cents : cents;
}

// "Not scheduled yet": money received but not assigned to any pay day. Held as a date no pay run reaches, so it is hidden from
// advisors, payable by nothing, and listed apart until somebody chooses a real day for it.
const NOT_SCHEDULED = '2100-12-31';

/** A pay out date as sent: a day, or "none" for not scheduled yet. */
function payoutDateOf(value) {
  return String(value || '').trim().toLowerCase() === 'none' ? NOT_SCHEDULED : cleanDate(value);
}

/** One line of a check, cleaned. */
function tidyLine(raw) {
  const bookingId = clean(raw && raw.bookingId, 64);
  if (!bookingId) return { error: 'Every line needs a reservation.' };
  const amountCents = signedCents(raw.amount);
  if (!amountCents) return { error: 'Every line needs an amount.' };
  return {
    line: {
      bookingId,
      amountCents,
      kind: oneOf(raw.kind, COMMISSION_KIND_KEYS),
      payoutOn: payoutDateOf(raw.payoutOn),
      // The day the advisor was already paid this, when it was paid before the check was entered.
      paidOutOn: cleanDate(raw.paidOutOn),
      notes: clean(raw.notes, 300) || null,
    },
  };
}

/**
 * Lines entered as already paid out: the advisor was paid their share on that day, before the check was recorded.
 *
 * Recorded as what it is, a payout to the advisor on that day covering this reservation, so it is not scheduled again
 * or shown as owed. One payout for each advisor and day, whatever number of lines it covers.
 */
async function recordAlreadyPaid(env, admin, entries, label) {
  const groups = new Map();
  for (const e of entries) {
    if (!e.paidOutOn || !e.owner || !e.booking) continue;
    const pct = splitPct(e.booking, e.owner.default_split_pct, e.owner.lead_split_pct);
    const share = shareOf(e.amountCents, pct, UNSPLIT_COMMISSION_KINDS.includes(e.kind) ? e.amountCents : 0).advisorCents;
    if (share <= 0) continue;
    const key = `${e.ownerId}|${e.paidOutOn}`;
    if (!groups.has(key)) groups.set(key, { ownerId: e.ownerId, date: e.paidOutOn, lines: [] });
    groups.get(key).lines.push({ bookingId: e.bookingId, cents: share });
  }
  const ts = now();
  const writes = [];
  for (const g of groups.values()) {
    const id = uid();
    writes.push(env.DB.prepare(
      `INSERT INTO advisor_payouts
         (id, user_id, paid_on, amount_cents, method, reference, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'other', ?, ?, ?, ?, ?)`
    ).bind(id, g.ownerId, g.date, g.lines.reduce((n, l) => n + l.cents, 0), label,
      'Recorded as already paid out when the commission was entered.', admin.id, ts, ts));
    for (const l of g.lines) {
      writes.push(env.DB.prepare(
        `INSERT INTO advisor_payout_lines (id, payout_id, booking_id, user_id, amount_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(uid(), id, l.bookingId, g.ownerId, l.cents, ts));
    }
  }
  if (writes.length) await env.DB.batch(writes);
  return groups.size;
}

export async function handleCreateCheck(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!admin.agency_id) return noAgency();

  const body = await readJson(request);
  const vendorName = clean(body.vendorName, 120);
  if (!vendorName) return badRequest('Which vendor sent it?');

  const statementCents = toCents(body.statement);
  if (!statementCents) return badRequest('Enter the check total, the amount the check or remittance says it is for.');
  const feeCents = toCents(body.fee) || 0;
  if (feeCents < 0 || feeCents > Math.abs(statementCents)) {
    return badRequest('A fee cannot be negative or more than the check.');
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length > MAX_LINES) return badRequest(`That is more lines than one check takes (${MAX_LINES}).`);

  const receivedOn = cleanDate(body.receivedOn) || todayIso();
  const reference = clean(body.reference, 80) || null;

  const lines = [];
  for (const raw of rawLines) {
    const { line, error } = tidyLine(raw);
    if (error) return badRequest(error);
    // Whose reservation it is. Money lands on the advisor who earned it, whoever
    // recorded it, and a reservation in another agency is not there to be found.
    const owner = await db.writerForBooking(env, admin, line.bookingId);
    if (!owner) return notFound('One of those reservations was not found.');
    const booking = await db.getBooking(env, line.bookingId, owner.id);
    if (!booking) return notFound('One of those reservations was not found.');
    lines.push({
      ...line,
      ownerId: owner.id, owner, booking,
      // No date given is the date its trip says, which is the usual answer. A line already paid out is on that day.
      payoutOn: line.paidOutOn || line.payoutOn || suggestPayDate({
        receivedOn, returnDate: booking.return_date, departDate: booking.depart_date,
      }),
    });
  }

  const matched = lines.reduce((n, l) => n + l.amountCents, 0);
  if (Math.abs(matched) > Math.abs(statementCents) + 1) {
    return badRequest('The lines add up to more than the check does. Check the amounts.');
  }

  if (reference && !body.allowDuplicate) {
    const dupe = await env.DB.prepare(
      'SELECT id FROM commission_checks WHERE agency_id = ? AND reference = ? LIMIT 1'
    ).bind(admin.agency_id, reference).first();
    if (dupe) {
      return json({ error: 'A check with that number is already recorded.', code: 'duplicate', id: dupe.id }, 409);
    }
  }

  const id = uid();
  const ts = now();
  const writes = [env.DB.prepare(
    `INSERT INTO commission_checks
       (id, agency_id, added_by, vendor_id, vendor_name, reference, received_on, remitted_on,
        statement_cents, fee_cents, fee_note, notes, filename, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, admin.agency_id, admin.id, clean(body.vendorId, 64) || null, vendorName, reference,
         receivedOn, cleanDate(body.remittedOn), statementCents, feeCents,
         clean(body.feeNote, 200) || null, clean(body.notes, 1000) || null,
         clean(body.filename, 160) || null, ts, ts)];

  for (const l of lines) {
    writes.push(env.DB.prepare(
      `INSERT INTO commission_receipts
         (id, user_id, booking_id, statement_id, amount_cents, received_on, reference, notes,
          kind, check_id, payout_on, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uid(), l.ownerId, l.bookingId, l.amountCents, receivedOn, reference, l.notes,
           l.kind, id, l.payoutOn, ts, ts));
  }
  await env.DB.batch(writes);

  const paidBefore = await recordAlreadyPaid(env, admin, lines, `Check ${reference || vendorName}`);
  for (const l of lines) await syncCommissionStatus(env, l.ownerId, l.bookingId);

  await db.logActivity(env, admin.id, 'commission.check',
    `Recorded a ${vendorName} check${reference ? ` (${reference})` : ''} for ${(statementCents / 100).toFixed(2)}`
    + ` across ${lines.length} line${lines.length === 1 ? '' : 's'}`,
    { checkId: id, statementCents, feeCents });

  return json({
    ok: true, id, matchedCents: matched, unmatchedCents: statementCents - matched, alreadyPaidPayouts: paidBefore,
  }, 201);
}

/** Add a line to a check that has not been fully matched. */
export async function handleAddCheckLine(request, env, checkId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!admin.agency_id) return noAgency();

  const check = await env.DB.prepare(
    'SELECT id, statement_cents, received_on, reference FROM commission_checks WHERE id = ? AND agency_id = ?'
  ).bind(checkId, admin.agency_id).first();
  if (!check) return notFound('That check was not found.');

  const { line, error } = tidyLine(await readJson(request));
  if (error) return badRequest(error);

  const owner = await db.writerForBooking(env, admin, line.bookingId);
  if (!owner) return notFound('That reservation was not found.');
  const booking = await db.getBooking(env, line.bookingId, owner.id);
  if (!booking) return notFound('That reservation was not found.');

  const scopeR = db.scopeWhere(db.agencyScope(admin), 'r.user_id');
  const sum = await env.DB.prepare(
    `SELECT COALESCE(SUM(r.amount_cents), 0) AS matched FROM commission_receipts r
      WHERE r.check_id = ? AND ${scopeR.sql}`
  ).bind(checkId, ...scopeR.binds).first();
  if (Math.abs((sum?.matched || 0) + line.amountCents) > Math.abs(check.statement_cents) + 1) {
    return badRequest('That would make the lines add up to more than the check.');
  }

  const payoutOn = line.paidOutOn || line.payoutOn || suggestPayDate({
    receivedOn: check.received_on, returnDate: booking.return_date, departDate: booking.depart_date,
  });
  const ts = now();
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO commission_receipts
       (id, user_id, booking_id, statement_id, amount_cents, received_on, reference, notes,
        kind, check_id, payout_on, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, owner.id, line.bookingId, line.amountCents, check.received_on, check.reference,
         line.notes, line.kind, checkId, payoutOn, ts, ts).run();
  await recordAlreadyPaid(env, admin, [{ ...line, ownerId: owner.id, owner, booking }], `Check ${check.reference || ''}`.trim());
  await syncCommissionStatus(env, owner.id, line.bookingId);
  return json({ ok: true, id, payoutOn }, 201);
}

/**
 * Correct a check: what was typed about it and, when the request names them, its lines as a whole.
 *
 * With `lines`, they are the check's lines from now on: one that carries the id of an existing line and the same
 * reservation changes that line in place, one without an id is added, and an existing line left out is removed. A
 * line cannot be removed from a reservation an advisor has already been paid on, for the reason a check cannot be
 * deleted then: the payout is recorded against the reservation, and taking the money away would leave the books
 * saying the agency overpaid. Without `lines` only the check's own details change, as they always did.
 */
export async function handleUpdateCheck(request, env, id) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!admin.agency_id) return noAgency();

  const body = await readJson(request);
  const vendorName = clean(body.vendorName, 120);
  if (!vendorName) return badRequest('Which vendor sent it?');
  const statementCents = toCents(body.statement);
  if (!statementCents) return badRequest('Enter the statement amount.');
  const feeCents = toCents(body.fee) || 0;
  if (feeCents < 0 || feeCents > Math.abs(statementCents)) {
    return badRequest('A fee cannot be negative or more than the check.');
  }

  const scopeR = db.scopeWhere(db.agencyScope(admin), 'r.user_id');
  const sum = await env.DB.prepare(
    `SELECT COALESCE(SUM(r.amount_cents), 0) AS matched FROM commission_receipts r
      WHERE r.check_id = ? AND ${scopeR.sql}`
  ).bind(id, ...scopeR.binds).first();
  if (!Array.isArray(body.lines) && Math.abs(sum?.matched || 0) > Math.abs(statementCents) + 1) {
    return badRequest('The lines already on it add up to more than that.');
  }

  if (Array.isArray(body.lines)) {
    return updateCheckWithLines(env, admin, id, body, { vendorName, statementCents, feeCents, scopeR });
  }

  const res = await env.DB.prepare(
    `UPDATE commission_checks
        SET vendor_name = ?, reference = ?, received_on = ?, remitted_on = ?, statement_cents = ?,
            fee_cents = ?, fee_note = ?, notes = ?, updated_at = ?
      WHERE id = ? AND agency_id = ?`
  ).bind(vendorName, clean(body.reference, 80) || null, cleanDate(body.receivedOn),
         cleanDate(body.remittedOn), statementCents, feeCents, clean(body.feeNote, 200) || null,
         clean(body.notes, 1000) || null, now(), id, admin.agency_id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That check was not found.');
  return json({ ok: true });
}

async function updateCheckWithLines(env, admin, id, body, { vendorName, statementCents, feeCents, scopeR }) {
  const check = await env.DB.prepare(
    'SELECT id FROM commission_checks WHERE id = ? AND agency_id = ?'
  ).bind(id, admin.agency_id).first();
  if (!check) return notFound('That check was not found.');

  const rawLines = body.lines;
  if (rawLines.length > MAX_LINES) return badRequest(`That is more lines than one check takes (${MAX_LINES}).`);
  const receivedOn = cleanDate(body.receivedOn) || todayIso();
  const reference = clean(body.reference, 80) || null;

  const { results: existing } = await env.DB.prepare(
    `SELECT r.id, r.booking_id, r.user_id FROM commission_receipts r
      WHERE r.check_id = ? AND ${scopeR.sql}`
  ).bind(id, ...scopeR.binds).all();
  const byId = new Map((existing || []).map((r) => [r.id, r]));

  const keep = [];
  const adds = [];
  for (const raw of rawLines) {
    const { line, error } = tidyLine(raw);
    if (error) return badRequest(error);
    const was = raw && raw.id ? byId.get(String(raw.id)) : null;
    if (was && was.booking_id === line.bookingId) {
      const kept = { ...line, id: was.id, ownerId: was.user_id, hasNotes: raw.notes !== undefined };
      if (line.paidOutOn) {
        // Needed only to work out the advisor's share of a line now said to be already paid out.
        const o = await db.writerForBooking(env, admin, line.bookingId);
        const bk = o ? await db.getBooking(env, line.bookingId, o.id) : null;
        if (!o || !bk) return notFound('One of those reservations was not found.');
        kept.owner = o; kept.booking = bk; kept.payoutOn = line.paidOutOn;
      }
      keep.push(kept);
      continue;
    }
    const owner = await db.writerForBooking(env, admin, line.bookingId);
    if (!owner) return notFound('One of those reservations was not found.');
    const booking = await db.getBooking(env, line.bookingId, owner.id);
    if (!booking) return notFound('One of those reservations was not found.');
    adds.push({
      ...line, ownerId: owner.id, owner, booking,
      payoutOn: line.paidOutOn || line.payoutOn || suggestPayDate({
        receivedOn, returnDate: booking.return_date, departDate: booking.depart_date,
      }),
    });
  }

  const matched = [...keep, ...adds].reduce((n, l) => n + l.amountCents, 0);
  if (Math.abs(matched) > Math.abs(statementCents) + 1) {
    return badRequest('The lines add up to more than the check does. Check the amounts.');
  }

  const kept = new Set(keep.map((k) => k.id));
  const removed = (existing || []).filter((r) => !kept.has(r.id));
  if (removed.length) {
    const scopeL = db.scopeWhere(db.agencyScope(admin), 'l.user_id');
    const holes = removed.map(() => '?').join(', ');
    const paid = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM advisor_payout_lines l WHERE ${scopeL.sql} AND l.booking_id IN (${holes})`
    ).bind(...scopeL.binds, ...removed.map((r) => r.booking_id)).first();
    if (paid && paid.n > 0) {
      return badRequest('A line you are taking off is for a reservation an advisor has already been paid on. Take that payout back first.');
    }
  }

  const ts = now();
  const writes = [env.DB.prepare(
    `UPDATE commission_checks
        SET vendor_name = ?, reference = ?, received_on = ?, remitted_on = ?, statement_cents = ?,
            fee_cents = ?, fee_note = ?, notes = ?, updated_at = ?
      WHERE id = ? AND agency_id = ?`
  ).bind(vendorName, reference, receivedOn, cleanDate(body.remittedOn), statementCents, feeCents,
         clean(body.feeNote, 200) || null, clean(body.notes, 1000) || null, ts, id, admin.agency_id)];
  for (const k of keep) {
    writes.push(env.DB.prepare(
      `UPDATE commission_receipts
          SET amount_cents = ?, kind = ?, payout_on = COALESCE(?, payout_on), received_on = ?, reference = ?,
              notes = CASE WHEN ? = 1 THEN ? ELSE notes END, updated_at = ?
        WHERE id = ? AND user_id = ? AND check_id = ?`
    ).bind(k.amountCents, k.kind, k.payoutOn, receivedOn, reference, k.hasNotes ? 1 : 0, k.notes, ts, k.id, k.ownerId, id));
  }
  for (const r of removed) {
    writes.push(env.DB.prepare('DELETE FROM commission_receipts WHERE id = ? AND user_id = ? AND check_id = ?')
      .bind(r.id, r.user_id, id));
  }
  for (const l of adds) {
    writes.push(env.DB.prepare(
      `INSERT INTO commission_receipts
         (id, user_id, booking_id, statement_id, amount_cents, received_on, reference, notes,
          kind, check_id, payout_on, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uid(), l.ownerId, l.bookingId, l.amountCents, receivedOn, reference, l.notes, l.kind, id, l.payoutOn, ts, ts));
  }
  await env.DB.batch(writes);
  await recordAlreadyPaid(env, admin, [...keep, ...adds], `Check ${reference || vendorName}`);

  const touched = new Map();
  for (const l of [...keep, ...adds]) touched.set(`${l.ownerId}|${l.bookingId}`, { u: l.ownerId, b: l.bookingId });
  for (const r of removed) touched.set(`${r.user_id}|${r.booking_id}`, { u: r.user_id, b: r.booking_id });
  for (const t of touched.values()) await syncCommissionStatus(env, t.u, t.b);

  await db.logActivity(env, admin.id, 'commission.check.edit',
    `Corrected a ${vendorName} check${reference ? ` (${reference})` : ''}: ${keep.length} kept, ${adds.length} added, ${removed.length} taken off`,
    { checkId: id });
  return json({ ok: true, matchedCents: matched, unmatchedCents: statementCents - matched });
}

/**
 * Mark a check as at the bank, or take that back. The pay run warns before an advisor is paid out of a check that has not
 * been confirmed there.
 */
export async function handleDepositCheck(request, env, id) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!admin.agency_id) return noAgency();
  const body = await readJson(request);
  const on = body.on === '' || body.on === null || body.on === undefined ? null : cleanDate(body.on);
  if (body.on && !on) return badRequest('That is not a date.');
  const res = await env.DB.prepare(
    'UPDATE commission_checks SET deposited_on = ?, updated_at = ? WHERE id = ? AND agency_id = ?'
  ).bind(on, now(), id, admin.agency_id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That check was not found.');
  return json({ ok: true, depositedOn: on });
}

/**
 * Take a check back out, with its lines.
 *
 * Refused once any reservation on it has been paid out to an advisor. Payouts are
 * recorded against reservations and not against lines, so there is no telling
 * which line paid what, and removing money somebody has already been paid from
 * would leave the books saying the agency overpaid. Take the payout back first.
 */
export async function handleDeleteCheck(request, env, id) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!admin.agency_id) return noAgency();

  const check = await env.DB.prepare(
    'SELECT id, vendor_name, reference FROM commission_checks WHERE id = ? AND agency_id = ?'
  ).bind(id, admin.agency_id).first();
  if (!check) return notFound('That check was not found.');

  const scopeR = db.scopeWhere(db.agencyScope(admin), 'r.user_id');
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT r.booking_id, r.user_id FROM commission_receipts r
      WHERE r.check_id = ? AND ${scopeR.sql}`
  ).bind(id, ...scopeR.binds).all();
  const touched = results || [];

  if (touched.length) {
    const scopeL = db.scopeWhere(db.agencyScope(admin), 'l.user_id');
    const holes = touched.map(() => '?').join(', ');
    const paid = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM advisor_payout_lines l
        WHERE ${scopeL.sql} AND l.booking_id IN (${holes})`
    ).bind(...scopeL.binds, ...touched.map((t) => t.booking_id)).first();
    if (paid && paid.n > 0) {
      return badRequest('Some of this has already been paid out to an advisor. Take that payout back first, then remove the check.');
    }
  }

  // One delete per advisor whose reservations were on it, naming that advisor, rather
  // than one sweeping delete across the agency. The advisors are the ones the
  // agency-scoped read above found, so nothing outside the agency is reachable.
  const advisors = [...new Set(touched.map((t) => t.user_id))];
  await env.DB.batch([
    ...advisors.map((advisorId) => env.DB.prepare(
      'DELETE FROM commission_receipts WHERE check_id = ? AND user_id = ?'
    ).bind(id, advisorId)),
    env.DB.prepare('DELETE FROM commission_checks WHERE id = ? AND agency_id = ?')
      .bind(id, admin.agency_id),
  ]);
  for (const t of touched) await syncCommissionStatus(env, t.user_id, t.booking_id);

  await db.logActivity(env, admin.id, 'commission.check.delete',
    `Removed a ${check.vendor_name} check${check.reference ? ` (${check.reference})` : ''}`, { checkId: id });
  return json({ ok: true, lines: touched.length });
}

/** How many days before sailing a vendor can no longer take a commission back if the client cancels. */
const SAFE_DAYS = 30;

function minusDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
}

/**
 * GET /api/commission-recall : where commission the vendor could still take back is, and where it has been.
 *
 * A cruise line pays the commission once the client has paid in full, and takes it back if they then cancel. So
 * what has arrived is not safe to pay out until 30 days before sailing. This reads every reservation with money
 * on it, any status, and says which are safe, which are being held, which were paid out before they were safe,
 * and which were cancelled with commission in or paid out that may have to be given back. Owners only.
 */
export async function handleCommissionRecall(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!admin.agency_id) return noAgency();

  const scopeB = db.scopeWhere(db.agencyScope(admin), 'b.user_id');
  const unsplitKinds = UNSPLIT_COMMISSION_KINDS.map((k) => `'${k}'`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.confirmation_number, b.status, b.depart_date,
            b.return_date, b.commission_cents, b.user_id, ${SPLIT_PCT_SQL()} AS split_pct,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS advisor_name,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id AND r.user_id = b.user_id), 0) AS received_cents,
            COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                       WHERE r.booking_id = b.id AND r.user_id = b.user_id AND r.kind IN (${unsplitKinds})), 0) AS unsplit_cents,
            COALESCE((SELECT SUM(l.amount_cents) FROM advisor_payout_lines l
                       WHERE l.booking_id = b.id AND l.user_id = b.user_id), 0) AS paid_out_cents
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scopeB.sql} AND b.status IN ('booked','travelled','cancelled')
        AND (EXISTS (SELECT 1 FROM commission_receipts r WHERE r.booking_id = b.id AND r.user_id = b.user_id)
          OR EXISTS (SELECT 1 FROM advisor_payout_lines l WHERE l.booking_id = b.id AND l.user_id = b.user_id))
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC
      LIMIT 1000`
  ).bind(...scopeB.binds).all();

  const today = todayIso();
  const rows = (results || []).map((b) => {
    const safeOn = b.depart_date ? minusDays(b.depart_date, SAFE_DAYS) : null;
    const share = shareOf(b.received_cents, b.split_pct, b.unsplit_cents).advisorCents;
    const due = Math.max(share - b.paid_out_cents, 0);
    const before = Boolean(safeOn && today < safeOn);
    let state = 'safe';
    let note = '';
    if (b.status === 'cancelled') {
      state = 'cancelled';
      note = b.paid_out_cents > 0
        ? 'Cancelled. The vendor may take the commission back, and the advisor has already been paid.'
        : 'Cancelled. The vendor may take the commission back. Nothing has been paid out yet, so hold it.';
    } else if (b.paid_out_cents > 0 && before) {
      state = 'early';
      note = `Paid out before the safe date, ${safeOn}. If the client cancels the commission may have to be given back.`;
    } else if (before && due > 0) {
      state = 'hold';
      note = `Hold until ${safeOn}, 30 days before sailing.`;
    } else if (!b.depart_date) {
      state = 'nodate';
      note = 'No sailing date on the reservation, so there is no safe date to work from.';
    }
    return {
      id: b.id, clientName: b.client_name, advisorName: b.advisor_name, supplier: b.supplier, productName: b.product_name,
      confirmation: b.confirmation_number, status: b.status, departDate: b.depart_date, safeOn,
      receivedCents: b.received_cents, advisorShareCents: share, paidOutCents: b.paid_out_cents, dueCents: due,
      state, note,
    };
  });

  const total = (state, key) => rows.filter((r) => r.state === state).reduce((n, r) => n + (r[key] || 0), 0);
  return json({
    today, safeDays: SAFE_DAYS, rows,
    totals: {
      holdCents: total('hold', 'dueCents'), holdCount: rows.filter((r) => r.state === 'hold').length,
      earlyCents: total('early', 'paidOutCents'), earlyCount: rows.filter((r) => r.state === 'early').length,
      // What the vendor may take back and what the agency would then have to get back from an advisor.
      cancelledReceivedCents: total('cancelled', 'receivedCents'), cancelledPaidOutCents: total('cancelled', 'paidOutCents'),
      cancelledCount: rows.filter((r) => r.state === 'cancelled').length,
      noDateCount: rows.filter((r) => r.state === 'nodate').length,
    },
  });
}

/** Move one line to another pay date. */
export async function handleSetPayDate(request, env, receiptId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, admin, 'commission_receipts', receiptId);
  if (!owner) return notFound('That line was not found.');

  const payoutOn = payoutDateOf((await readJson(request)).payoutOn);
  if (!payoutOn) return badRequest('Choose a date.');

  const res = await env.DB.prepare(
    'UPDATE commission_receipts SET payout_on = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(payoutOn, now(), receiptId, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('That line was not found.');
  return json({ ok: true, payoutOn });
}

// ---------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------

/** Everything the desk page shows, for one year. */
export async function handleCommissionDesk(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!admin.agency_id) return noAgency();

  const year = isoYear(new URL(request.url).searchParams.get('year'));
  const today = todayIso();
  const next = nextPayDate(today);

  const scope = db.agencyScope(admin);
  const scopeR = db.scopeWhere(scope, 'r.user_id');
  const scopeB = db.scopeWhere(scope, 'b.user_id');
  const scopeP = db.scopeWhere(scope, 'p.user_id');
  const scopeL = db.scopeWhere(scope, 'l.user_id');

  const [receivedRow, feeRow, checkRows, paidRow, payoutRows, receiptRows, paidLines, bookingRows,
    years] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(r.amount_cents), 0) AS cents, COUNT(*) AS lines
         FROM commission_receipts r
        WHERE ${scopeR.sql}
          AND substr(COALESCE(r.received_on, date(r.created_at, 'unixepoch')), 1, 4) = ?`
    ).bind(...scopeR.binds, year).first(),

    env.DB.prepare(
      `SELECT COALESCE(SUM(fee_cents), 0) AS cents FROM commission_checks
        WHERE agency_id = ? AND substr(COALESCE(received_on, ''), 1, 4) = ?`
    ).bind(admin.agency_id, year).first(),

    env.DB.prepare(
      `SELECT c.id, c.vendor_name, c.reference, c.received_on, c.remitted_on, c.statement_cents,
              c.fee_cents, c.fee_note, c.notes, c.filename, c.created_at, c.deposited_on,
              COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                         WHERE r.check_id = c.id AND ${scopeR.sql}), 0) AS matched_cents,
              (SELECT COUNT(*) FROM commission_receipts r
                WHERE r.check_id = c.id AND ${scopeR.sql}) AS lines
         FROM commission_checks c
        WHERE c.agency_id = ? AND substr(COALESCE(c.received_on, ''), 1, 4) = ?
        ORDER BY c.received_on DESC, c.created_at DESC
        LIMIT 300`
    ).bind(...scopeR.binds, ...scopeR.binds, admin.agency_id, year).all(),

    env.DB.prepare(
      `SELECT COALESCE(SUM(p.amount_cents), 0) AS cents, COUNT(*) AS payouts
         FROM advisor_payouts p
        WHERE ${scopeP.sql} AND substr(COALESCE(p.paid_on, ''), 1, 4) = ?`
    ).bind(...scopeP.binds, year).first(),

    env.DB.prepare(
      `SELECT p.id, p.paid_on, p.amount_cents, p.method, p.reference, p.user_id,
              COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                AS advisor_name,
              (SELECT COUNT(*) FROM advisor_payout_lines l WHERE l.payout_id = p.id AND ${scopeL.sql}) AS trips,
              (SELECT GROUP_CONCAT(pb.client_name, ', ') FROM advisor_payout_lines l
                 JOIN bookings pb ON pb.id = l.booking_id WHERE l.payout_id = p.id AND ${scopeL.sql}) AS names
         FROM advisor_payouts p JOIN users u ON u.id = p.user_id
        WHERE ${scopeP.sql} AND substr(COALESCE(p.paid_on, ''), 1, 4) = ?
        ORDER BY p.paid_on DESC, p.created_at DESC
        LIMIT 300`
    ).bind(...scopeL.binds, ...scopeL.binds, ...scopeP.binds, year).all(),

    // Every line, with what the split needs. The schedule is worked out here rather
    // than in SQL because it is running totals per reservation, which is the part
    // SQLite makes awkward and JavaScript makes plain.
    env.DB.prepare(
      `SELECT r.id, r.booking_id, r.amount_cents, r.kind, r.payout_on, r.received_on, r.check_id,
              (SELECT ck.deposited_on FROM commission_checks ck WHERE ck.id = r.check_id AND ck.agency_id = ?) AS check_deposited_on,
              b.depart_date, b.user_id, b.commission_status, b.personal, b.lead_source, b.advisor_split_pct,
              b.agreed_split_pct, b.agreed_lead_split_pct, b.client_name, b.supplier, b.product_name,
              u.default_split_pct, u.lead_split_pct,
              COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                AS advisor_name
         FROM commission_receipts r
         JOIN bookings b ON b.id = r.booking_id AND b.user_id = r.user_id
         JOIN users u ON u.id = r.user_id
        WHERE ${scopeR.sql}
        ORDER BY r.received_on DESC
        LIMIT 8000`
    ).bind(admin.agency_id, ...scopeR.binds).all(),

    env.DB.prepare(
      `SELECT l.booking_id, COALESCE(SUM(l.amount_cents), 0) AS cents FROM advisor_payout_lines l
        WHERE ${scopeL.sql} GROUP BY l.booking_id`
    ).bind(...scopeL.binds).all(),

    env.DB.prepare(
      `SELECT b.id, b.client_name, b.supplier, b.product_name, b.product_type, b.depart_date,
              b.return_date, b.confirmation_number, b.commission_cents, b.user_id,
              b.commission_chase, b.commission_chase_note, b.commission_chase_at,
              COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                AS advisor_name,
              COALESCE((SELECT SUM(r.amount_cents) FROM commission_receipts r
                         WHERE r.booking_id = b.id AND r.user_id = b.user_id), 0) AS received_cents
         FROM bookings b LEFT JOIN users u ON u.id = b.user_id
        WHERE ${scopeB.sql} AND b.status IN ('booked','travelled') AND b.commission_cents > 0
          AND b.commission_status != 'none'
        ORDER BY COALESCE(b.return_date, b.depart_date, '9999-12-31') ASC
        LIMIT 3000`
    ).bind(...scopeB.binds).all(),

    env.DB.prepare(
      `SELECT DISTINCT substr(COALESCE(r.received_on, date(r.created_at, 'unixepoch')), 1, 4) AS y
         FROM commission_receipts r WHERE ${scopeR.sql} ORDER BY y DESC LIMIT 12`
    ).bind(...scopeR.binds).all(),
  ]);

  // What each advisor is owed, by pay date.
  const paidBy = new Map((paidLines.results || []).map((r) => [r.booking_id, r.cents]));
  const byBooking = new Map();
  for (const r of receiptRows.results || []) {
    if (!byBooking.has(r.booking_id)) byBooking.set(r.booking_id, []);
    byBooking.get(r.booking_id).push(r);
  }

  const dates = new Map();
  for (const [bookingId, lines] of byBooking) {
    const head = lines[0];
    // A waived reservation pays nobody, whatever arrived against it.
    if (head.commission_status === 'none') continue;
    const pct = splitPct(head, head.default_split_pct, head.lead_split_pct);
    for (const b of owedByDate(lines, pct, paidBy.get(bookingId) || 0, next)) {
      if (b.cents === 0) continue;
      if (!dates.has(b.date)) dates.set(b.date, new Map());
      const advisors = dates.get(b.date);
      if (!advisors.has(head.user_id)) {
        advisors.set(head.user_id, { userId: head.user_id, name: head.advisor_name, cents: 0, trips: [] });
      }
      const a = advisors.get(head.user_id);
      a.cents += b.cents;
      // The lines behind this amount that fall on this date, so a pay date can be changed from the schedule.
      const onDate = lines.filter((r) => (r.payout_on && r.payout_on > next ? r.payout_on : next) === b.date);
      const onThisDate = onDate.map((r) => r.id);
      // Money that came on a check nobody has confirmed at the bank. Money entered one reservation at a time has no check to ask.
      const notAtBank = onDate.some((r) => r.check_id && !r.check_deposited_on);
      a.trips.push({ bookingId, client: head.client_name, supplier: head.supplier, cents: b.cents, receipts: onThisDate,
        departDate: head.depart_date || null, notAtBank });
    }
  }
  const payDates = [...dates.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([date, advisors]) => {
    const list = [...advisors.values()].filter((a) => a.cents !== 0).sort((x, y) => y.cents - x.cents);
    return {
      date,
      isNext: date === next,
      unscheduled: date === NOT_SCHEDULED,
      totalCents: list.reduce((n, a) => n + a.cents, 0),
      advisors: list.map((a) => ({ ...a, notAtBank: a.trips.some((t) => t.notAtBank) })),
    };
  }).filter((d) => d.advisors.length);

  // Still owed to the agency: expected from vendors, less what has arrived.
  const outstanding = [];
  // Marked as not going to be collected. Kept apart and counted on their own, so the owed figure is only money that is
  // still expected, and nothing written off is lost from view.
  const writtenOff = [];
  let owedToUs = 0;
  let writtenOffCents = 0;
  for (const b of bookingRows.results || []) {
    const owed = (b.commission_cents || 0) - (b.received_cents || 0);
    if (owed <= 1) continue;
    const back = b.return_date || b.depart_date;
    const days = back ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${back}T00:00:00Z`)) / 86400000) : null;
    const chase = b.commission_chase === 'disputed' || b.commission_chase === 'written_off' ? b.commission_chase : null;
    const row = {
      id: b.id, clientName: b.client_name, supplier: b.supplier, productName: b.product_name,
      productType: b.product_type, travelDate: back, daysSince: days, bucket: bucketFor(days),
      expectedCents: b.commission_cents || 0, receivedCents: b.received_cents || 0, owedCents: owed,
      advisorName: b.advisor_name, confirmationNumber: b.confirmation_number,
      chase, chaseNote: b.commission_chase_note || '', chaseAt: b.commission_chase_at || null,
    };
    if (chase === 'written_off') { writtenOff.push(row); writtenOffCents += owed; continue; }
    owedToUs += owed;
    outstanding.push(chase === 'disputed' ? { ...row, bucket: 'disputed' } : row);
  }
  outstanding.sort((x, y) => (y.daysSince ?? -9999) - (x.daysSince ?? -9999));

  const buckets = [...BUCKETS, DISPUTED_BUCKET].map((bk) => ({
    ...bk,
    count: outstanding.filter((o) => o.bucket === bk.key).length,
    cents: outstanding.filter((o) => o.bucket === bk.key).reduce((n, o) => n + o.owedCents, 0),
  }));

  // The lines of each check, so opening one on the page needs no second request.
  const checkLines = {};
  for (const r of receiptRows.results || []) {
    if (!r.check_id) continue;
    if (!checkLines[r.check_id]) checkLines[r.check_id] = [];
    checkLines[r.check_id].push({
      id: r.id, booking_id: r.booking_id, client_name: r.client_name, supplier: r.supplier,
      advisor_name: r.advisor_name, amount_cents: r.amount_cents, payout_on: r.payout_on,
      product_name: r.product_name, split_pct: splitPct(r, r.default_split_pct, r.lead_split_pct),
    });
  }

  // Money filed one reservation at a time, before there were checks, or typed on a
  // reservation's own page. Listed beside the checks so the year's total and its list
  // agree about what arrived.
  const loose = (receiptRows.results || [])
    .filter((r) => !r.check_id
      && String(r.received_on || '').slice(0, 4) === year)
    .map((r) => ({
      id: r.id, booking_id: r.booking_id, received_on: r.received_on, client_name: r.client_name,
      supplier: r.supplier, advisor_name: r.advisor_name, amount_cents: r.amount_cents,
      payout_on: r.payout_on, split_pct: splitPct(r, r.default_split_pct, r.lead_split_pct),
    }));

  // Everything waiting on a pay run, with or without a day yet, as the other portal counts it; the part with no day is shown apart.
  const scheduledCents = payDates.reduce((n, d) => n + d.totalCents, 0);
  const unscheduledCents = payDates.filter((d) => d.unscheduled).reduce((n, d) => n + d.totalCents, 0);
  const received = receivedRow?.cents || 0;
  const fees = feeRow?.cents || 0;

  const yearList = [...new Set([year, today.slice(0, 4), ...(years.results || []).map((r) => r.y)])]
    .filter(Boolean).sort().reverse();

  return json({
    year, years: yearList, today, nextPayDate: next, payDatesList: payDatesFrom(today, 10),
    tiles: {
      receivedCents: received,
      receivedLines: receivedRow?.lines || 0,
      feesCents: fees,
      // What reached the bank, which is what was received less what was taken out.
      netCents: received - fees,
      paidOutCents: paidRow?.cents || 0,
      payouts: paidRow?.payouts || 0,
      scheduledCents,
      unscheduledCents,
      owedToUsCents: owedToUs,
      owedToUsCount: outstanding.length,
      writtenOffCents,
      writtenOffCount: writtenOff.length,
    },
    checkLines,
    loose,
    checks: (checkRows.results || []).map((c) => ({
      ...c,
      net_cents: (c.statement_cents || 0) - (c.fee_cents || 0),
      unmatched_cents: (c.statement_cents || 0) - (c.matched_cents || 0),
    })),
    payDates,
    paid: payoutRows.results || [],
    buckets,
    outstanding: outstanding.slice(0, 500),
    outstandingTruncated: outstanding.length > 500,
    writtenOff: writtenOff.slice(0, 500),
  });
}

/**
 * POST /api/bookings/:id/commission-chase { state: 'disputed' | 'written_off' | '', note }
 *
 * An owner's call, on a reservation anywhere in their agency. Disputed sets the amount apart from routine chasing;
 * written off takes it out of what is owed; an empty state puts it back. Nothing about what was expected or what
 * arrived is touched, so it can always be undone.
 */
export async function handleSetCommissionChase(request, env, bookingId) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.agency_id) return noAgency();

  const body = await readJson(request);
  const state = body.state === 'disputed' || body.state === 'written_off' ? body.state : null;
  const note = clean(body.note, 300) || null;
  const res = await env.DB.prepare(
    `UPDATE bookings SET commission_chase = ?, commission_chase_note = ?, commission_chase_at = ?
      WHERE id = ? AND user_id IN (SELECT id FROM users WHERE agency_id = ?)`
  ).bind(state, state ? note : null, state ? now() : null, bookingId, user.agency_id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Reservation not found.');
  await db.logActivity(env, user.id, 'commission.chase',
    state === 'written_off' ? 'Wrote off an unpaid commission' : state === 'disputed' ? 'Marked an unpaid commission as disputed'
      : 'Put an unpaid commission back to normal', { id: bookingId, state });
  return json({ ok: true, state });
}
