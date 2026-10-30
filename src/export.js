// Downloading the book: every reservation, and every client, as a spreadsheet file.
//
// The lists on screen stop at a few hundred rows so a page stays quick, which is right for reading and wrong for a report: a total or a
// count worked out from a cut list is a number that is quietly wrong. These read everything the person may see, with the same fence the
// lists use: an advisor gets their own, an owner gets the agency's or the advisor they have picked.
//
// What is left out is on purpose: no passport details, no notes, no document links. A spreadsheet is emailed and left on laptops.

import { requireUser } from './auth.js';
import { usDate } from './util.js';
import * as db from './db.js';

const STATUSES = ['quoted', 'booked', 'travelled', 'cancelled'];

const BOM = '﻿';
// Far more than any agency has, so the download is never cut. A cut that was not said would be worse than a slow file.
const EXPORT_CAP = 20000;

/** One cell. Quoted when it has a comma, a quote or a line break; and a text that starts like a formula is made plain text. */
function cell(value, isText) {
  let s = value === null || value === undefined ? '' : String(value);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV text. `columns` is [heading, read(row), 'text' | 'money' | 'date' | 'n']. */
export function csvOf(columns, rows) {
  const out = [columns.map(([h]) => cell(h)).join(',')];
  for (const row of rows) {
    out.push(columns.map(([, read, kind]) => {
      const v = read(row);
      if (kind === 'money') return cell(v === null || v === undefined || v === '' ? '' : (Number(v) / 100).toFixed(2));
      if (kind === 'date') return cell(usDate(v));
      return cell(v, kind === 'text');
    }).join(','));
  }
  return `${BOM}${out.join('\r\n')}\r\n`;
}

const dayOf = (epoch) => (epoch ? new Date(Number(epoch) * 1000).toISOString().slice(0, 10) : '');

function csvResponse(text, name) {
  return new Response(text, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

const RESERVATION_COLUMNS = [
  ['Client', (r) => r.client_name, 'text'], ['Advisor', (r) => r.advisor_name, 'text'], ['Status', (r) => r.status, 'text'],
  ['Vendor', (r) => r.supplier, 'text'], ['Ship or product', (r) => r.product_name, 'text'], ['Destination', (r) => r.destination, 'text'],
  ['Cabin', (r) => r.cabin, 'text'], ['Category', (r) => r.cabin_category, 'text'], ['Confirmation number', (r) => r.confirmation_number, 'text'],
  ['Departing', (r) => r.depart_date, 'date'], ['Returning', (r) => r.return_date, 'date'], ['Deposit due', (r) => r.deposit_due, 'date'],
  ['Final payment due', (r) => r.final_payment_due, 'date'], ['Travellers', (r) => r.travellers, 'n'], ['Trip total', (r) => r.gross_cents, 'money'],
  ['Deposit', (r) => r.deposit_cents, 'money'], ['Commission', (r) => r.commission_cents, 'money'], ['Commission status', (r) => r.commission_status, 'text'],
  ['Group', (r) => r.group_label, 'text'], ['Entered on', (r) => dayOf(r.created_at), 'date'],
];

/** Every reservation the person may see, as a CSV file. */
export async function handleExportReservations(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const scoped = db.scopeWhere(db.scopeFor(env, user, request), 'b.user_id');
  // The same narrowing the list was showing, so the file is that list.
  const more = db.bookingFilterSql(
    db.parseBookingFilters(new URL(request.url).searchParams, STATUSES));
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.user_id, b.client_name, b.status, b.supplier, b.product_name, b.destination, b.cabin, b.cabin_category,
            b.confirmation_number, b.depart_date, b.return_date, b.deposit_due, b.final_payment_due, b.travellers,
            b.gross_cents, b.deposit_cents, b.commission_cents, b.commission_status, b.group_label, b.created_at,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS advisor_name
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${[scoped.sql, ...more.where].join(' AND ')}
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC, b.created_at DESC
      LIMIT ?`
  ).bind(...scoped.binds, ...more.binds, EXPORT_CAP).all();
  // An advisor is not told commission has arrived until its pay date is near, in a download any more than on a screen.
  const rows = await db.maskCommissionStatus(env, user, results || []);
  return csvResponse(csvOf(RESERVATION_COLUMNS, rows), 'reservations');
}

const CLIENT_COLUMNS = [
  ['Name', (c) => c.name, 'text'], ['Nickname', (c) => c.nickname, 'text'], ['Advisor', (c) => c.advisor_name, 'text'],
  ['Email', (c) => c.email, 'text'], ['Phone', (c) => c.phone, 'text'], ['Birthday', (c) => c.birthday, 'date'],
  ['Anniversary', (c) => c.anniversary, 'date'], ['Gender', (c) => c.gender, 'text'],
  ['Address', (c) => [c.address1, c.address2].filter(Boolean).join(', '), 'text'], ['City', (c) => c.city, 'text'],
  ['State', (c) => c.state, 'text'], ['ZIP', (c) => c.postcode, 'text'], ['Country', (c) => c.country, 'text'],
  ['Where they came from', (c) => c.source, 'text'], ['Booked trips', (c) => c.trips, 'n'], ['Booked total', (c) => c.lifetime_cents, 'money'],
  ['Added on', (c) => dayOf(c.created_at), 'date'],
];

/** Every client the person may see, as a CSV file. */
export async function handleExportClients(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const scoped = db.scopeWhere(db.scopeFor(env, user, request), 'c.user_id');
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.user_id, c.name, c.nickname, c.email, c.phone, c.birthday, c.anniversary, c.gender,
            c.address1, c.address2, c.city, c.state, c.postcode, c.country, c.source, c.created_at,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS advisor_name,
            (SELECT COUNT(*) FROM bookings b WHERE b.client_id = c.id AND b.status IN ('booked','travelled')) AS trips,
            (SELECT COALESCE(SUM(b.gross_cents), 0) FROM bookings b WHERE b.client_id = c.id AND b.status IN ('booked','travelled')) AS lifetime_cents
       FROM clients c LEFT JOIN users u ON u.id = c.user_id
      WHERE ${scoped.sql}
      ORDER BY c.name COLLATE NOCASE ASC
      LIMIT ?`
  ).bind(...scoped.binds, EXPORT_CAP).all();
  return csvResponse(csvOf(CLIENT_COLUMNS, results || []), 'clients');
}
