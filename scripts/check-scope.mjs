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
import { annotate } from './lib/annotate.mjs';
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
  // Written from the client's own trip page and read behind the fence, which
  // is trip_messages again: the share code decides the trip, and every
  // statement names the advisor it belongs to anyway.
  'reviews',
  'hotlist_actions', 'specials', 'special_leads', 'households', 'form_templates',
  // A form sent to one person. It belongs to the advisor who sent it and is
  // read on screens scoped by user_id; the three statements that reach it by
  // its token instead are listed in ALLOWED, with why.
  'form_invites',
  // A browser that agreed to be notified. It belongs to the advisor signed in
  // on it, and nothing reads one except to push to its owner.
  'push_subscriptions',
  'advisor_billing',
  // A saved list is one advisor's question about their own book. The rules
  // it holds are run inside that advisor's scope, so the list itself is
  // theirs the same way a saved search would be.
  'segments',
  'broadcasts', 'broadcast_recipients',
  'itinerary_items', 'itinerary_library',
]);

// Shared by a whole agency, so agency_id is the predicate that matters rather
// than user_id. The key used to be a GoHighLevel sub-account and the column
// was called location_id; see 0073_agency_partition.sql.
//
// automations, automation_runs and crm_contacts are scoped the same way and
// are deliberately not in here yet. Most of their statements reach by primary
// key after the caller has already proved the row is theirs, so adding them
// would mean a dozen entries in ALLOWED, and a rule that only passes because
// of its exceptions is the failure this file warns about. Worth doing right.
const AGENCY_OWNED = new Set(['forms', 'form_submissions']);

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
  // A task template is either the agency's or the advisor's, and everybody
  // gets both. The two writes below reach a shared row, which by definition
  // belongs to somebody else: that is what shared means. The predicate in the
  // SQL is the outer bound, matching the read exactly so a statement can never
  // touch a row the caller could not see; mayWrite() in front of it is the
  // precise rule, and it lets only the agency owner change a shared one.
  ['UPDATE task_templates SET title = ?, kind = ?',
    'the agency\'s shared templates, which only its owner reaches: mayWrite gates '
    + 'the role, and this predicate stops the statement leaving the agency'],
  ['DELETE FROM task_templates\n      WHERE id = ? AND (user_id = ? OR (shared = 1 AND ${reach.sql}))',
    'the same, removing one'],
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
  // The itinerary library is the agency's for the same reason the supplier
  // directory is: how a shore excursion actually runs is what the agency knows
  // about that excursion, not one person's note, and a wrong meeting time is
  // worth fixing by whoever finds it. Listed statement by statement rather
  // than exempting the table, so this stays a claim about the library and not
  // a licence for the rest of the file.
  ['UPDATE itinerary_library SET name = ?, kind = ?',
    'the library is the agency\'s: anybody in it may correct a description'],
  ['DELETE FROM itinerary_library WHERE id = ? AND ${scoped.sql}',
    'the same, removing one; the trips built from it keep what they were given'],
  ['UPDATE itinerary_library SET used_count = used_count + 1 WHERE id = ? AND ${scoped.sql}',
    'a use counter on a row the same scope just fetched, so the popular ones rise'],
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
  // The broadcast sender, which runs on the cron as nobody and drains one
  // message at a time across every advisor. Same shape as the task digest
  // above it: the scope is in the rows, not in these statements. Every
  // recipient row was written by one advisor's own scoped query at the moment
  // they pressed send, and the four statements below only ever touch rows
  // belonging to the one broadcast that pass just claimed. Scoping them to a
  // user would mean asking whose send it is on every row of it, which the
  // broadcast_id already answers.
  ['UPDATE broadcast_recipients SET status = ?, detail = ?, attempts = ?, sent_at = ?',
    'the outcome of the one send that just happened, stamped on the row it happened to'],
  ['UPDATE broadcast_recipients SET attempts = ?, detail = ? WHERE id = ?',
    'the same row left queued after a rate limit, carrying the count that decides when '
    + 'to stop trying'],
  ['UPDATE broadcasts SET sent_count = sent_count + ?',
    'the running tally on the broadcast this pass is draining'],
  ["UPDATE broadcasts SET status = 'sent', finished_at = ?",
    'the same broadcast, when nothing is left queued on it'],
  ['SELECT COUNT(*) AS n FROM broadcast_recipients',
    'asks whether that send is finished; the count never leaves the check'],
  // Stripe's webhook knows its own customer id and nothing about this portal's
  // users, so the row has to be found by the id Stripe sent. There is no
  // session on that request to scope it to: it arrives from Stripe, and what
  // makes it trustworthy is the signature over the raw body, checked before
  // anything reads the payload. The lookup only ever returns the one advisor
  // that customer id belongs to, and an unknown one is answered and ignored.
  ['FROM advisor_billing WHERE stripe_customer_id = ?',
    'the Stripe webhook, which is signature-verified and identifies the advisor by '
    + 'the customer id Stripe issued; there is no session on that request'],
  // How a commission divides is the agency's decision, not the advisor's, so
  // the two statements behind it reach a reservation that by definition
  // belongs to somebody else. The fence is still there and is one step out:
  // handleSetBookingSplit reads the booking, then runs the owner through
  // reachable(), which is the same agency check the rest of admin.js uses, and
  // answers "not found" rather than "not yours" when it fails. Scoping these
  // to the caller would confine an owner to their own reservations, which is
  // the one thing the endpoint exists not to do.
  ['FROM bookings WHERE id = ? LIMIT 1',
    'the admin path onto one reservation: the caller is put through reachable() '
    + 'on the advisor who owns it before this runs. The LIMIT is what makes this '
    + 'fragment distinct from the scoped lookup it would otherwise be a prefix of'],
  ['UPDATE bookings SET advisor_split_pct = ?, lead_source = ?',
    'the same, writing the two fields an owner may set; the booking was fetched and '
    + 'its owner checked against the caller\'s agency first'],
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
  ['SELECT * FROM form_invites WHERE id = ? AND form_id = ?',
    'the public form page, which has no session to scope to. The id is a randomUUID and '
    + 'is the credential, the same way a trip share code and a password reset token are: '
    + 'knowing it is the whole permission. Narrowed by form_id as well, so a token for '
    + 'one form cannot be replayed against another'],
  ['UPDATE form_invites SET opened_at = ?, updated_at = ? WHERE id = ?',
    'the same page stamping the row it just proved it holds the token for'],
  ['UPDATE form_invites SET submitted_at = ?, submission_id = ?, updated_at = ?',
    'the same again, on submit, after loadInvite has matched the token to this form'],
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

/**
 * A statement whose table name is not written down.
 *
 * Every rule in this file reads the table out of the SQL, so a statement that
 * interpolates its table name is invisible to all of them: tablesIn finds
 * nothing, the loop moves on, and a query that could reach any table in the
 * database is the one query nobody checked.
 *
 * There is exactly one, db.writerFor, and of all the statements to leave
 * unchecked it is the worst: it is the one that decides who may write to a
 * reservation. So it is pinned here by its own text. The name it interpolates
 * comes from a set written out in db.js and never from a request, and the
 * predicate below is read by the ordinary rules. A second interpolated table
 * name appearing anywhere fails this check until somebody writes down why.
 */
const INTERPOLATED_TABLE = /\b(?:FROM|JOIN|UPDATE|DELETE\s+FROM|INTO)\s+\$\{/i;

const INTERPOLATED_ALLOWED = [
  ['SELECT t.user_id AS user_id FROM ${table} t',
    'db.writerFor, which resolves whose a reservation row is. The table comes from '
    + 'the WRITABLE set in db.js and nowhere else; the statement names t.user_id and '
    + 'joins users so the agency fence is in the SQL rather than in an if after it'],
];

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
    // Before the table rules, because these statements have no table to read.
    if (INTERPOLATED_TABLE.test(sql)) {
      checked += 1;
      const pinned = INTERPOLATED_ALLOWED.find(([fragment]) => sql.includes(fragment));
      if (!pinned) {
        problems += 1;
        const message = 'builds its table name, so no rule in this checker can see '
          + 'what it touches. Pin it in INTERPOLATED_ALLOWED with the reason, or '
          + 'write the table out.';
        console.log(`FAIL  src/${file}:${line}  ${message}`);
        console.log(`        ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
        annotate({ file: `src/${file}`, line, message });
        continue;
      }
      if (!/\buser_id\b/.test(sql)) {
        problems += 1;
        const message = 'is pinned in INTERPOLATED_ALLOWED and names no user_id.';
        console.log(`FAIL  src/${file}:${line}  ${message}`);
        annotate({ file: `src/${file}`, line, message });
      }
      continue;
    }

    const all = tablesIn(sql);
    const tables = [...all].filter((t) => OWNED.has(t));
    const byAgency = [...all].filter((t) => AGENCY_OWNED.has(t));
    if (!tables.length && !byAgency.length) continue;
    // An agency table is not subject to the write rule below: its predicate
    // is the agency, and reporting it as "no user_id" names the wrong fix.
    const writeRuleApplies = tables.length > 0;

    checked += 1;

    // An agency table is answered by agency_id, or by a form_id belonging
    // to a form the caller already proved is theirs.
    if (!tables.length) {
      if (/\bagency_id\b/.test(sql) || /\bform_id\b/.test(sql)) continue;
    }

    // Named directly, or through one of the helpers that writes the predicate.
    // `${scoped.sql}` is the usual shape; the calendar builds several at once
    // and names them b, t and g, so any `${x.sql}` counts.
    const viaHelper = /\$\{[^}]*[Ss]cope[^}]*\}/.test(sql)
      || /\$\{[A-Za-z_$][\w$]*\.sql\}/.test(sql);
    const namesUser = /\buser_id\b/.test(sql);

    // The other half of the rule, and the half that is a privilege bug rather
    // than a privacy one. A read may widen to the whole agency when an owner
    // asks by interpolating a scope; a write may never widen that way. Every
    // write in this codebase names user_id outright, and this keeps it that
    // way.
    //
    // An agency owner may now correct an advisor's reservation, which sounds
    // like the thing this rule forbids and is not. The widening happens once,
    // in db.writerFor, which answers whose the row is and hands back that
    // advisor; the write then names user_id and binds the advisor, so the row
    // stays theirs. One statement decides it, it is pinned above, and the
    // forty writes downstream are as narrow as they ever were.
    if (writeRuleApplies && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
      if (namesUser && !viaHelper) continue;
      const excused = ALLOWED.find(([fragment]) => sql.includes(fragment));
      if (excused) continue;
      problems += 1;
      const why = viaHelper
        ? 'through a scope helper, which can widen past the caller' : 'without naming user_id';
      annotate('Scope', `src/${file}:${line} writes to ${tables.join(', ')} ${why}: `
        + sql.replace(/\s+/g, ' ').trim().slice(0, 140));
      console.log(`FAIL  src/${file}:${line}  writes to ${tables.join(', ')} ${why}`);
      console.log(`        ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
      continue;
    }

    if (namesUser || viaHelper) continue;

    const excuse = ALLOWED.find(([fragment]) => sql.includes(fragment));
    if (excuse) continue;

    problems += 1;
    const named = tables.length ? tables.join(', ') : byAgency.join(', ');
    const kind = tables.length ? 'no user predicate' : 'no agency predicate';
    annotate('Scope', `src/${file}:${line} touches ${named} with ${kind}: `
      + sql.replace(/\s+/g, ' ').trim().slice(0, 140));
    console.log(`FAIL  src/${file}:${line}  touches ${named} with ${kind}`);
    console.log(`        ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  }
}

// A table that belongs to an advisor and is in neither list is not safe by
// default; it is unexamined. Failing here is the difference between a check
// that covers the codebase and one that covers what somebody remembered.
for (const [table, cols] of SCHEMA) {
  if (!cols.has('user_id')) continue;
  if (OWNED.has(table) || AGENCY_OWNED.has(table) || EXEMPT.has(table)) continue;
  problems += 1;
  annotate('Scope', `${table} has a user_id and is in none of the lists in check-scope: `
    + 'add it to OWNED, or to EXEMPT with the reason it is reached another way');
  console.log(`FAIL  ${table} has a user_id and is in none of the lists in this checker`);
  console.log('        add it to OWNED, or to EXEMPT with the reason it is reached another way');
}

console.log('');
if (problems) {
  console.log(`${problems} statement${problems === 1 ? '' : 's'} could reach another advisor's rows.`);
  process.exit(1);
}
console.log(`All ${checked} statements touching owned tables are scoped to a user.`);
