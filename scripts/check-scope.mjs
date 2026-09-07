// Can one advisor reach another advisor's data?
//
// The rule this portal is built on is small and easy to break: a read may
// widen to the whole agency when an owner asks, and every write is confined to
// the caller. Both halves live in the same helpers (scopeWhere, selfScope), so
// the failure mode is not a wrong scope but a missing one: a query written
// without any user predicate at all, which quietly returns or changes
// everybody's rows and looks perfectly normal in testing on one account.
//
// Nothing else catches it. The smoke test signs in as two people and checks
// what each can see, which covers the endpoints somebody thought to test; this
// covers every statement in the codebase, including the ones added since.
//
// A statement touching a table that belongs to a user must name user_id, or
// interpolate one of the scope helpers, or be listed below with a reason.
// "It is only ever called with an id we already checked" is a reason, and it
// has to be written down rather than assumed.
//
//   node scripts/check-scope.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaFromMigrations } from './lib/schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Which tables belong to an advisor is a judgement, not a column. sessions and
// password_reset_tokens carry a user_id and are found by their token, which is
// the secret; the CRM mirror and the automations belong to a sub-account.
// Deriving the list mechanically got all of those wrong, so it is written out.
//
// What is not left to memory is noticing a new one. Any table in the schema
// with a user_id column that appears in neither list below fails the check and
// asks to be classified, which is what would have happened when quote_options
// was added rather than it going unchecked.
const SCHEMA = schemaFromMigrations(ROOT);

const OWNED = new Set([
  'bookings', 'booking_payments', 'booking_pricing', 'quote_options', 'penalty_tiers', 'documents', 'components', 'travellers',
  'amenities', 'tasks', 'client_credits', 'clients', 'travel_groups', 'vendors',
  'goals', 'user_prefs', 'commission_statements', 'commission_receipts',
  'group_registrations', 'task_items', 'task_templates', 'trip_messages',
  'hotlist_actions', 'specials', 'special_leads',
]);

// Shared by a whole agency through a GoHighLevel sub-account, so location_id
// is the predicate that matters rather than user_id.
const LOCATION_OWNED = new Set(['forms', 'form_submissions']);

// Carries a user_id, and is not reached through one.
const EXEMPT = new Map([
  ['sessions', 'found by its token, which is the secret; the user_id is the answer, not the question'],
  ['password_reset_tokens', 'same: the token is the credential'],
  ['activity_log', 'written with a user id and read only through a scoped query'],
]);

// Statements that touch an owned table without naming a user, and why that is
// correct. Matched on a distinctive fragment of the SQL. Every entry is a
// claim that somebody checked, which is the point of writing it down instead
// of widening the rule until nothing fails.
const ALLOWED = [
  // The supplier directory is the agency's, not the advisor's, so every write
  // to it widens on purpose. Listed one at a time rather than exempting the
  // table, because "vendors are shared" is a claim about the directory and not
  // a licence for anything else in that file to reach across the agency.
  //
  // The bookings writes below are the awkward half and were thought about: a
  // shared vendor is pointed at by other people's reservations, so a rename
  // has to carry their supplier name with it and a delete has to clear their
  // vendor_id. Leaving those alone is how you get a dangling link on somebody
  // else's trip and a report that groups one supplier under two names. The
  // reach is always the agency, never the platform: agencyScope falls back to
  // the reader alone when they are in no agency.
  ['UPDATE bookings SET vendor_id = NULL WHERE vendor_id = ? AND ${scoped.sql}',
    'deleting a shared vendor: the agency\'s reservations lose the link, not just yours'],
  ['DELETE FROM vendors WHERE id = ? AND ${scoped.sql}',
    'the directory is the agency\'s, so anybody in it may remove an entry'],
  ['UPDATE vendors SET name = ?, final_days = ?',
    'the directory is the agency\'s: a renegotiated rate is a correction for everyone'],
  ['UPDATE bookings SET supplier = ? WHERE vendor_id = ? AND ${bScope.sql}',
    'a rename has to reach every reservation sold under the old name, whoever sold it, '
    + 'or the reports split one supplier in two'],
  ['UPDATE vendors SET favourite = ?, updated_at = ? WHERE id = ? AND ${starScope.sql}',
    'the star is on the shared record, the same as every other field on it'],
  ['UPDATE vendors SET ${sets.join(\', \')}, updated_at = ? WHERE id = ? AND ${flat.sql}',
    'merging fills blanks on the kept record from the ones being folded in'],
  ['UPDATE bookings SET vendor_id = ?, supplier = ?, updated_at = ?',
    'merging moves the reservations off the dropped records, which are usually '
    + 'another advisor\'s: that pair is the whole reason to merge'],
  ['DELETE FROM vendors WHERE ${flat.sql} AND id IN (${marks})',
    'the same merge removing the duplicates it just emptied'],
  ['FROM specials WHERE code = ?',
    'the public page for a deal. The code is the URL somebody was given, and it is '
    + 'unique across every advisor, so this looks up one published deal by the address '
    + 'that was handed out rather than asking whose it is'],
  ['SELECT COUNT(*) AS n FROM special_leads',
    'a rate limit on that public page, counted for the deal being enquired about; there '
    + 'is no session to scope it to and the count never leaves the check'],
  ['SELECT l.id, l.name, l.email, l.phone, l.party_size, l.notes, l.booking_id',
    'the enquiries on one deal, reached only after the deal itself was fetched under '
    + 'the reader\'s scope; a deal they cannot see returns before this runs'],
  ['SELECT id FROM travel_groups WHERE group_code = ?',
    'deliberately every advisor: the code is a public web address, so it has to be '
    + 'unique across all of them, not just within one book'],
  ['UPDATE tasks SET ${column} = ? WHERE id IN',
    'the nightly reminder pass, which runs as nobody and covers every advisor on '
    + 'purpose. It stamps only the ids it just selected, and each advisor was sent '
    + 'their own tasks and no one else\'s: the scope lives in who the digest went to, '
    + 'not in this write'],
  ['SELECT group_code FROM travel_groups WHERE group_code IN',
    'deliberately every advisor, for the same reason: it asks whether a code this '
    + 'advisor already holds is also held elsewhere. Only codes they can already see '
    + 'go in, and only those same codes come back, so it says "yours is not the only '
    + 'group on this code" and nothing about whose the other one is'],
  ['COUNT(*) AS n FROM group_registrations',
    'a rate limit on a public page, counted for the group being signed up to; there is '
    + 'no session on that request and the owner comes from the group'],
  ['UPDATE travellers SET is_lead = 0', 'follows an ownership check on the traveller being promoted'],
  ['UPDATE bookings SET travellers =', 'called only after the booking was fetched for this user'],
  ['UPDATE bookings SET gross_cents', 'called only after the booking was fetched for this user'],
  ['SELECT COUNT(*) AS n FROM travellers', 'counts rows on a booking already resolved for this user'],
  ['FROM travel_groups WHERE id = ?', 'the group id comes off a reservation already read in scope'],
  ['SELECT name, commission_pct FROM vendors WHERE id = ?',
    'the vendor id comes off a reservation already read in scope'],
  ['UPDATE clients SET ghl_contact_id = ?', 'the id came from a SELECT filtered by user_id'],
  ['FROM forms WHERE slug = ?',
    'a form slug is global because the public URL it serves is global'],
  ['UPDATE form_submissions SET contact_id = ? WHERE id = ?',
    'the id is the submission this request just inserted'],
  ['AS lifetime_cents',
    'the outer WHERE is built from scopeWhere; the bookings subqueries reach only this user\'s clients'],
];

function sqlStatements(src) {
  const out = [];
  const marker = 'env.DB.prepare(';
  let at = src.indexOf(marker);

  while (at !== -1) {
    let i = at + marker.length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    const quote = src[i];
    if (quote === '`' || quote === "'" || quote === '"') {
      i += 1;
      let sql = '';
      while (i < src.length) {
        if (src[i] === '\\') { sql += src[i] + src[i + 1]; i += 2; continue; }
        if (src[i] === quote) break;
        sql += src[i];
        i += 1;
      }
      out.push({ sql, line: src.slice(0, at).split('\n').length });
    }
    at = src.indexOf(marker, at + marker.length);
  }
  return out;
}

/** Every table named by a FROM, JOIN, UPDATE, INSERT INTO or DELETE FROM. */
function tablesIn(sql) {
  const found = new Set();
  const patterns = [
    /\bFROM\s+([A-Za-z_][\w]*)/gi,
    /\bJOIN\s+([A-Za-z_][\w]*)/gi,
    /\bUPDATE\s+([A-Za-z_][\w]*)/gi,
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][\w]*)/gi,
    /\bDELETE\s+FROM\s+([A-Za-z_][\w]*)/gi,
  ];
  for (const p of patterns) {
    for (const m of sql.matchAll(p)) found.add(m[1]);
  }
  return found;
}

const files = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js')).sort();
let checked = 0;
let problems = 0;

for (const file of files) {
  const src = readFileSync(join(ROOT, 'src', file), 'utf8');

  for (const { sql, line } of sqlStatements(src)) {
    const all = tablesIn(sql);
    const tables = [...all].filter((t) => OWNED.has(t));
    const byLocation = [...all].filter((t) => LOCATION_OWNED.has(t));
    if (!tables.length && !byLocation.length) continue;
    // A location table is not subject to the write rule below: its predicate
    // is a sub-account, and reporting it as "no user_id" names the wrong fix.
    const writeRuleApplies = tables.length > 0;

    checked += 1;

    // A location table is answered by location_id, or by a form_id belonging
    // to a form the caller already proved is theirs.
    if (!tables.length) {
      if (/\blocation_id\b/.test(sql) || /\bform_id\b/.test(sql)) continue;
    }

    // Named directly, or through one of the helpers that writes the predicate.
    // `${scoped.sql}` is the usual shape; the calendar builds several at once
    // and names them b, t and g, so any `${x.sql}` counts.
    const viaHelper = /\$\{[^}]*[Ss]cope[^}]*\}/.test(sql)
      || /\$\{[A-Za-z_$][\w$]*\.sql\}/.test(sql);
    const namesUser = /\buser_id\b/.test(sql);

    // The other half of the rule, and the half that is a privilege bug rather
    // than a privacy one. A read may widen to the whole agency when an owner
    // asks; a write may not, ever. An owner may see an associate's
    // reservation and may not change it, and the two would quietly become one
    // permission the moment a write borrowed the reading scope. Every write in
    // this codebase names user_id outright, and this keeps it that way.
    if (writeRuleApplies && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
      if (namesUser && !viaHelper) continue;
      const excused = ALLOWED.find(([fragment]) => sql.includes(fragment));
      if (excused) continue;
      problems += 1;
      console.log(`FAIL  src/${file}:${line}  writes to ${tables.join(', ')} ${
        viaHelper ? 'through a scope helper, which can widen past the caller' : 'without naming user_id'}`);
      console.log(`        ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
      continue;
    }

    if (namesUser || viaHelper) continue;

    const excuse = ALLOWED.find(([fragment]) => sql.includes(fragment));
    if (excuse) continue;

    problems += 1;
    const named = tables.length ? tables.join(', ') : byLocation.join(', ');
    const kind = tables.length ? 'no user predicate' : 'no location predicate';
    console.log(`FAIL  src/${file}:${line}  touches ${named} with ${kind}`);
    console.log(`        ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  }
}

// A table that belongs to an advisor and is in neither list is not safe by
// default; it is unexamined. Failing here is the difference between a check
// that covers the codebase and one that covers what somebody remembered.
for (const [table, cols] of SCHEMA) {
  if (!cols.has('user_id')) continue;
  if (OWNED.has(table) || LOCATION_OWNED.has(table) || EXEMPT.has(table)) continue;
  problems += 1;
  console.log(`FAIL  ${table} has a user_id and is in none of the lists in this checker`);
  console.log('        add it to OWNED, or to EXEMPT with the reason it is reached another way');
}

console.log('');
if (problems) {
  console.log(`${problems} statement${problems === 1 ? '' : 's'} could reach another advisor's rows.`);
  process.exit(1);
}
console.log(`All ${checked} statements touching owned tables are scoped to a user.`);
