// Clients as records: who they are, what they have bought, what they are owed.
//
// Built from this portal's own data rather than from the CRM mirror. The CRM
// knows who someone is; this knows what they have bought, what they are owed
// and when they last travelled, and it keeps working when the upstream API
// does not. A client who has never been synced but has three trips on file is
// still a client.
//
// A client record is created as a side effect of taking a reservation or
// recording a credit, so nobody has to maintain a list of people before they
// can do the work. Contact details are added afterwards, when there is a
// reason to.

import { json, badRequest, notFound, clean, cleanDate, oneOf, uid, now, readJson } from './util.js';
import { tenantFor } from './tenant.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { suppressionFor } from './suppression.js';
import { householdFor } from './households.js';
import { SOURCE_KINDS, SOURCE_KIND_IDS } from './attribution.js';

export async function handleListClients(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  // "mine" means mine, whoever is asking. An owner sees the agency's book
  // here, which is right for the Clients page and wrong for a box whose next
  // step only works on your own records.
  const mine = url.searchParams.get('mine') === '1';
  const scope = mine ? db.selfScope(user) : db.scopeFor(env, user, request);
  const query = clean(url.searchParams.get('q'), 80);
  const pinnedOnly = url.searchParams.get('pinned') === '1';
  const clients = await db.listClients(env, scope, {
    limit: url.searchParams.get('limit'),
    query,
    pinnedOnly,
  });
  // One row past the cap, so the page can say it was cut. Filtering a list
  // that is already short is how a search for somebody who exists comes back
  // with nothing.
  const { rows: shown, truncated } = db.capped(clients, url.searchParams.get('limit'), db.CLIENT_CAP);

  // Counted over the book rather than over the page. Everything below used to
  // be worked out from `shown`, which is capped, so the totals quietly became
  // facts about the cap instead of about the agency.
  const counted = await db.clientStats(env, scope, { query, pinnedOnly });

  // People who are in the CRM but have never been booked here.
  //
  // A client record only exists once somebody has made a reservation, so the
  // first time an advisor books an existing contact they type a name the
  // portal already knows and creates a second version of a person the CRM has
  // held for a year. These are offered alongside the local ones, marked as
  // coming from the CRM, and become client records the moment one is used.
  //
  // Read from the synced copy rather than GoHighLevel itself: a typeahead
  // People carried over from the CRM that used to sit behind this portal.
  //
  // The CRM is gone; its contacts are not. They were mirrored into D1 while it
  // was connected and those rows are still here, so the Clients page still
  // lists everybody it ever knew, with the ones who have never booked marked
  // as such. Read only now: nothing refreshes them and nothing ever will, and
  // they become editable people the moment somebody books one.
  //
  // Not while pinned-only is on. That filter means "the handful I have
  // starred", and filling the rest of the screen with the rest is the opposite
  // of what was asked for.
  // Not when the caller asked for their own either: these have no client row
  // behind them, so anything that needs one cannot use them.
  let fromCrm = [];
  if (!pinnedOnly && !mine) {
    const known = await db.clientKeys(env, scope);
    const { contacts } = await db.localContacts(env, tenantFor(env, user), {
      query: query || undefined,
      // Enough to be useful without turning the page into the CRM. Searching
      // narrows it, which is the way somebody finds one in particular.
      limit: query ? 25 : 100,
    }).catch(() => ({ contacts: [] }));

    fromCrm = (contacts || [])
      .filter((c) => c.name
        && !known.has(c.id)
        && !known.has(c.name.trim().toLowerCase())
        && !(c.email && known.has(c.email.trim().toLowerCase())))
      .map((c) => ({
        id: null, contactId: c.id, name: c.name, email: c.email || '',
        phone: c.phone || '', source: 'crm', trips: 0, lifetime_cents: 0,
      }));
  }

  return json({
    clients: shown,
    truncated,
    cap: db.CLIENT_CAP,
    fromCrm,
    stats: {
      total: counted.total,
      // Counted apart, because "people you have booked" and "people the CRM
      // knows" are different numbers and adding them together would flatter
      // the first. This one is genuinely about what was fetched: the CRM
      // mirror is read with its own small limit and is not the book.
      crmOnly: fromCrm.length,
      pinned: counted.pinned,
      // Somebody who has travelled and has nothing ahead of them. The same
      // question the dashboard asks, answerable from this list too.
      lapsed: counted.lapsed,
      lifetimeCents: counted.lifetimeCents,
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * A submission's answers, in the order they were asked and under the labels
 * the person read.
 *
 * A form stores its answers keyed by field key, and a key is what the database
 * calls a question rather than what anybody was shown: nobody filled in
 * "lead_asked_about". Where the form has since been edited, an answer whose
 * question is gone is still shown, under its key, because the answer is a
 * thing somebody wrote and losing it to a later edit would be worse than
 * showing it plainly.
 */
function labelled(fieldsJson, answers) {
  let fields = [];
  try { fields = JSON.parse(fieldsJson || '[]') || []; } catch { fields = []; }

  const out = [];
  const used = new Set();
  for (const f of fields) {
    if (!f || !f.key) continue;
    // Marked used before the heading is skipped, not after. A heading is not a
    // question and has no answer, and skipping it first let its key fall
    // through to the orphan pass and appear as one.
    used.add(f.key);
    if (f.type === 'heading') continue;
    const value = answers[f.key];
    if (value === undefined || value === null || value === '') continue;
    out.push({ label: f.label || f.key, value: String(value) });
  }
  // Anything the form no longer asks. Still theirs, still worth reading.
  for (const [key, value] of Object.entries(answers)) {
    if (used.has(key) || value === undefined || value === null || value === '') continue;
    out.push({ label: key.replace(/_/g, ' '), value: String(value), orphan: true });
  }
  return out;
}

export async function handleClientRecord(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const id = clean(url.searchParams.get('id'), 64);
  const name = clean(url.searchParams.get('name'), 120);
  if (!id && !name) return notFound('No client was named.');

  const scope = db.scopeFor(env, user, request);
  const client = await db.getClient(env, scope, { id, name });
  if (!client) return notFound('Client not found.');

  const bScope = db.scopeWhere(scope, 'b.user_id');
  const cScope = db.scopeWhere(scope, 'c.user_id');
  const tScope = db.scopeWhere(scope, 't.user_id');
  const today = new Date().toISOString().slice(0, 10);

  const [bookings, credits, tasks, household, unsubscribed, mail] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id, b.client_name, b.supplier, b.product_name, b.product_type, b.destination,
              b.confirmation_number, b.depart_date, b.return_date, b.status,
              b.gross_cents, b.commission_cents, b.commission_status, b.travellers,
              b.ghl_contact_id, b.user_id,
              COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                AS advisor_name
         FROM bookings b LEFT JOIN users u ON u.id = b.user_id
        WHERE ${bScope.sql} AND b.client_id = ?
        ORDER BY COALESCE(b.depart_date, '9999-12-31') DESC LIMIT 200`
    ).bind(...bScope.binds, client.id).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT c.id, c.vendor, c.kind, c.amount_cents, c.expires_on, c.used_on, c.reference
         FROM client_credits c WHERE ${cScope.sql} AND c.client_id = ?
        ORDER BY COALESCE(c.expires_on, '9999-12-31') ASC`
    ).bind(...cScope.binds, client.id).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.priority, t.done_at
         FROM tasks t JOIN bookings b ON b.id = t.booking_id
        WHERE ${tScope.sql} AND b.client_id = ?
        ORDER BY t.done_at IS NOT NULL ASC, COALESCE(t.due_date, '9999-12-31') ASC LIMIT 50`
    ).bind(...tScope.binds, client.id).all().catch(() => ({ results: [] })),

    // Who else lives there. Best effort: a client record that cannot load its
    // household is still a client record worth reading.
    householdFor(env, client, scope).catch(() => null),

    // Whether they have asked not to be emailed. On the record rather than
    // only inside the sender, because an advisor who cannot see it will write
    // to them personally and wonder why they never hear back.
    suppressionFor(env, user.agency_id, client.email),

    // What has already been sent to them, and what happened to it.
    //
    // Without this the marketing lives entirely on its own screen, and the
    // person about to ring a client has no way to know they were emailed on
    // Tuesday. "I sent you a note about Alaska last week" is the whole
    // difference between a call that starts cold and one that does not.
    //
    // Best effort: a client record that cannot load its mail is still a
    // client record worth reading, and this table is newer than the page.
    env.DB.prepare(
      `SELECT b.name, b.subject, r.status, r.detail, r.sent_at
         FROM broadcast_recipients r
         JOIN broadcasts b ON b.id = r.broadcast_id AND b.user_id = r.user_id
        WHERE r.client_id = ? AND r.user_id = ?
        ORDER BY r.sent_at DESC, b.created_at DESC
        LIMIT 20`
    ).bind(client.id, client.user_id).all().catch(() => ({ results: [] })),
  ]);

  const rows = bookings.results || [];
  const counted = rows.filter((b) => b.status === 'booked' || b.status === 'travelled');
  const past = counted.filter((b) => (b.return_date || b.depart_date) < today);
  const upcoming = counted.filter((b) => (b.return_date || b.depart_date) >= today);
  const liveCredits = (credits.results || []).filter((c) => !c.used_on);

  // Their form answers. Left joined to the form so the questions can be shown
  // with the words the person read rather than the keys they are stored under.
  const submissions = await env.DB.prepare(
    `SELECT s.id, s.data_json, s.created_at, f.name AS form_name, f.fields_json
       FROM form_submissions s
       LEFT JOIN forms f ON f.id = s.form_id
      WHERE s.contact_id = ?
      ORDER BY s.created_at DESC
      LIMIT 20`
  ).bind(client.id).all().catch(() => ({ results: [] }));

  return json({
    // The channels, from the one place they are written down, so the record's
    // dropdown and the report cannot disagree about what a channel is.
    sourceKinds: SOURCE_KINDS,
    client: {
      ...client,
      // Who sent them, by name. The record holds an id, which is the right
      // thing to store and the wrong thing to show anybody.
      referred_by_name: client.referred_by_client_id
        ? ((await env.DB.prepare('SELECT name FROM clients WHERE id = ? AND user_id = ?')
            .bind(client.referred_by_client_id, client.user_id).first()) || {}).name || ''
        : '',
      trips: counted.length,
      lifetimeCents: counted.reduce((n, b) => n + (b.gross_cents || 0), 0),
      commissionCents: counted.reduce((n, b) => n + (b.commission_cents || 0), 0),
      firstTravelled: past.length ? past[past.length - 1].depart_date : null,
      lastTravelled: past.length ? (past[0].return_date || past[0].depart_date) : null,
      // The one thing an advisor wants to know before they ring: is anything
      // already on the books.
      nextDeparture: upcoming.length ? upcoming[upcoming.length - 1].depart_date : null,
      vendors: [...new Set(counted.map((b) => b.supplier).filter(Boolean))],
      creditCents: liveCredits.reduce((n, c) => n + (c.amount_cents || 0), 0),
    },
    bookings: rows,
    credits: credits.results || [],
    tasks: tasks.results || [],
    // What they filled in, newest first. Attached by contact_id, which is set
    // when a submission is matched to somebody, so this is only ever their own.
    submissions: (submissions.results || []).map((s) => {
      let answers = {};
      try { answers = JSON.parse(s.data_json) || {}; } catch { answers = {}; }
      return {
        id: s.id,
        formName: s.form_name || 'A form',
        createdAt: s.created_at,
        // The questions in the order they were asked, with the labels the
        // person actually read. A key like lead_asked_about is what the
        // database calls it and not what anybody was shown.
        answers: labelled(s.fields_json, answers),
      };
    }),
    editable: db.mayWrite(user, client),
    // The marketing they have been sent, newest first. Empty rather than
    // absent when there is none, so the page has one shape to render.
    emails: mail.results || [],
    // Flat rather than a nested row, and always present. A field that is
    // sometimes an object and sometimes null is a field every reader has to
    // guard, and the contract checker cannot see inside the null one at all.
    unsubscribed: Boolean(unsubscribed),
    unsubscribedAt: unsubscribed ? unsubscribed.created_at : null,
    unsubscribedHow: unsubscribed ? (unsubscribed.source || unsubscribed.reason || null) : null,
    // Who else lives there, what the house is worth together, and the address
    // they share. Null when they live alone as far as the portal knows.
    household,
    today,
    scope: db.scopeLabel(scope, user),
  });
}

/**
 * The fields a vendor asks for, read off a request.
 *
 * Shared by create and update so the two cannot drift: a field added to one
 * and forgotten on the other is a field that saves on a new client and
 * silently refuses to change afterwards.
 */
function travelFields(body) {
  let loyalty = null;
  if (Array.isArray(body.loyalty)) {
    const rows = body.loyalty
      .map((l) => ({ line: clean(l && l.line, 60), number: clean(l && l.number, 60) }))
      .filter((l) => l.line || l.number)
      .slice(0, 20);
    loyalty = rows.length ? JSON.stringify(rows) : null;
  }
  return {
    // What they are actually called, as opposed to what is on the passport.
    nickname: clean(body.nickname, 80) || null,
    // Where they came from. Free text on purpose: every back office spells
    // these differently and an allowlist would drop the ones it had not met.
    source: clean(body.source, 80) || null,
    legalFirst: clean(body.legalFirst, 80) || null,
    legalMiddle: clean(body.legalMiddle, 80) || null,
    legalLast: clean(body.legalLast, 80) || null,
    gender: clean(body.gender, 40) || null,
    citizenship: clean(body.citizenship, 80) || null,
    passportNumber: clean(body.passportNumber, 40) || null,
    passportCountry: clean(body.passportCountry, 80) || null,
    passportIssued: cleanDate(body.passportIssued),
    passportExpiry: cleanDate(body.passportExpiry),
    address1: clean(body.address1, 160) || null,
    address2: clean(body.address2, 160) || null,
    city: clean(body.city, 80) || null,
    state: clean(body.state, 80) || null,
    postcode: clean(body.postcode, 24) || null,
    country: clean(body.country, 80) || null,
    loyaltyJson: loyalty,
    knownTraveler: clean(body.knownTraveler, 40) || null,
    redress: clean(body.redress, 40) || null,
  };
}

const TRAVEL_SET = `legal_first = ?, legal_middle = ?, legal_last = ?, gender = ?,
  citizenship = ?, passport_number = ?, passport_country = ?, passport_issued = ?,
  passport_expiry = ?, address1 = ?, address2 = ?, city = ?, state = ?,
  postcode = ?, country = ?, loyalty_json = ?, known_traveler = ?, redress = ?`;

const travelBinds = (f) => [
  f.legalFirst, f.legalMiddle, f.legalLast, f.gender, f.citizenship,
  f.passportNumber, f.passportCountry, f.passportIssued, f.passportExpiry,
  f.address1, f.address2, f.city, f.state, f.postcode, f.country,
  f.loyaltyJson, f.knownTraveler, f.redress,
];

/**
 * A client the agency has met but not yet booked.
 *
 * Until now the only way a client record came into being was as a side effect
 * of taking a reservation, which is right for the common case and wrong for
 * the one that comes first: somebody rings, you take their details, and the
 * trip is a fortnight of conversation away. There was nowhere to put them.
 *
 * resolveClient does the insert, so a name that already exists comes back as
 * the person who has it rather than as a second copy of them.
 */
/**
 * Create a client, or fill in the blanks on one already there.
 *
 * Lifted out of the request handler so the bulk import writes clients exactly
 * the way the Add a client dialog does. Two write paths for one record is how
 * an import quietly stores half a client: a field the form cleans and the
 * importer does not, a name normalised in one place and not the other.
 *
 * Returns the id and whether it already existed, or an { error } for the
 * caller to report however suits it. Throwing would make a five hundred row
 * import fall over on row twelve.
 */
export async function upsertClient(env, user, body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'A client needs a name.' };

  // Asked before creating, rather than worked out afterwards from how recent
  // the row looks. resolveClient is happy either way; the caller wants to be
  // told which happened.
  // The address first, the name second.
  //
  // Matching on name alone is what makes duplicates: a form filled in as Bob
  // Smith by the Robert Smith already on the book used to make a second
  // record, and the traveller block files whole families at once so it makes
  // them faster than anything before it.
  //
  // An email address is the closest thing to a person's identity this book
  // holds, so somebody writing in with an address already on a record is that
  // record, whatever they called themselves this time. Their name is left
  // alone: what the advisor filed them under is not a form's to overwrite.
  const email = clean(body.email, 160);
  let before = email
    ? await env.DB.prepare(
      `SELECT ${db.CLIENT_COLUMNS} FROM clients c
        WHERE c.user_id = ? AND LOWER(TRIM(c.email)) = LOWER(TRIM(?)) LIMIT 1`
    ).bind(user.id, email).first().catch(() => null)
    : null;
  if (!before) before = await db.getClient(env, db.selfScope(user), { name });
  const existed = Boolean(before);

  const existingId = before ? before.id : await db.resolveClient(env, user.id, name);
  if (!existingId) return { error: 'A client needs a name.' };

  // Everything else is optional and written over the top, so adding somebody
  // who turns out to be already known fills in what was missing rather than
  // refusing, and never blanks what was already there.
  const keep = (incoming, current) => (incoming === undefined || incoming === null
    || String(incoming).trim() === '' ? (current || null) : incoming);

  // Everything the record holds, not a subset. Somebody adding a client with
  // the passport in front of them should not have to save, reopen and type the
  // rest into a second form.
  const t = travelFields(body);
  await env.DB.prepare(
    `UPDATE clients SET email = ?, phone = ?, notes = ?, birthday = ?, anniversary = ?,
       legal_first = ?, legal_middle = ?, legal_last = ?, gender = ?, citizenship = ?,
       passport_number = ?, passport_country = ?, passport_issued = ?, passport_expiry = ?,
       address1 = ?, address2 = ?, city = ?, state = ?, postcode = ?, country = ?,
       loyalty_json = ?, known_traveler = ?, redress = ?, ghl_contact_id = ?,
       nickname = ?, source = ?, source_kind = ?, referred_by_client_id = ?,
       updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(
    keep(clean(body.email, 160), before?.email),
    keep(clean(body.phone, 40), before?.phone),
    keep(clean(body.notes, 4000), before?.notes),
    keep(cleanDate(body.birthday), before?.birthday),
    keep(cleanDate(body.anniversary), before?.anniversary),
    keep(t.legalFirst, before?.legal_first),
    keep(t.legalMiddle, before?.legal_middle),
    keep(t.legalLast, before?.legal_last),
    keep(t.gender, before?.gender),
    keep(t.citizenship, before?.citizenship),
    keep(t.passportNumber, before?.passport_number),
    keep(t.passportCountry, before?.passport_country),
    keep(t.passportIssued, before?.passport_issued),
    keep(t.passportExpiry, before?.passport_expiry),
    keep(t.address1, before?.address1),
    keep(t.address2, before?.address2),
    keep(t.city, before?.city),
    keep(t.state, before?.state),
    keep(t.postcode, before?.postcode),
    keep(t.country, before?.country),
    keep(t.loyaltyJson, before?.loyalty_json),
    keep(t.knownTraveler, before?.known_traveler),
    keep(t.redress, before?.redress),
    // Set when a CRM contact is being turned into a client, so the two stop
    // being two people. keep() means an existing link is never cut by a
    // create that did not mention one.
    keep(clean(body.contactId, 60), before?.ghl_contact_id),
    keep(t.nickname, before?.nickname),
    keep(t.source, before?.source),
    // Where somebody came from is a fact about the first time they turned up,
    // so keep() applies here as it does everywhere else on this record: a
    // later import or a second form fills in a blank and overwrites nothing.
    keep(oneOf(body.sourceKind, SOURCE_KIND_IDS), before?.source_kind),
    keep(clean(body.referredBy, 64), before?.referred_by_client_id),
    now(), existingId, user.id
  ).run();

  await db.logActivity(env, user.id, 'client.create', `Added ${name}`, { id: existingId });
  return { id: existingId, existed };
}

export async function handleCreateClient(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const out = await upsertClient(env, user, body);
  if (out.error) return badRequest(out.error);

  return json({
    ok: true,
    existing: out.existed,
    client: await db.getClient(env, db.selfScope(user), { id: out.id }),
  }, 201);
}

/**
 * Remove a client.
 *
 * There was no way to do this at all. Not in the interface, not in the API.
 * A name typed with a finger on the wrong key, a test record, somebody who
 * turned out to be two people and then turned out to be nobody: every one of
 * them stayed on the books for ever, and the only way to take one off was to
 * open the database by hand, which is not a thing an advisor can do or should
 * have to ask for.
 *
 * Refused while there is money attached, and that is the whole safety of it.
 * A reservation carries what the vendor paid, what the agency kept and what
 * the advisor is owed, and none of that stops being true because somebody
 * pressed a button on the client. A credit is money the client is owed. Both
 * refusals say how many and what to do instead, because a refusal that only
 * says no teaches people to look for a way round it.
 *
 * Everything else about a person goes with them: the tasks, the appointments,
 * the review requests, the form invites, the rows saying which broadcasts they
 * were sent. None of those mean anything without the person, and all of them
 * are reachable by nothing once the client is gone.
 *
 * Pointers held by other records are cleared rather than followed. Another
 * client who was referred by this one keeps their own record and loses the
 * link, and a form submission keeps its answers and stops claiming to be from
 * somebody who is not there. Deleting either would be deleting somebody
 * else's row because of a decision made about this one.
 *
 * Their own advisor, not an administrator. Merging already lets any advisor
 * destroy one of these rows, and it does more than this does: it moves a
 * person's whole history onto another record first. A delete that refuses
 * while any history exists is the smaller act of the two.
 */
export async function handleDeleteClient(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('Client not found.');

  const client = await env.DB.prepare(
    'SELECT id, name, household_id FROM clients WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (!client) return notFound('Client not found.');

  const trips = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM bookings WHERE client_id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (trips && trips.n) {
    return badRequest(`${client.name} has ${trips.n} reservation${trips.n === 1 ? '' : 's'} `
      + 'on the books. Delete or move those first, or merge this record into the one you '
      + 'are keeping, which moves the trips across rather than losing them.');
  }

  const credits = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM client_credits WHERE client_id = ? AND user_id = ?'
  ).bind(id, owner.id).first();
  if (credits && credits.n) {
    return badRequest(`${client.name} holds ${credits.n} credit${credits.n === 1 ? '' : 's'}, `
      + 'which is money owed to them. Clear those first if they really are nobody.');
  }

  const ts = now();

  // Written out rather than looped over a list with the table name
  // interpolated, for the reason the merge does the same: a built table name
  // is a statement no checker can read, and this is a delete.
  const gone = [];
  const drop = async (table, sql) => {
    try {
      const res = await env.DB.prepare(sql).bind(id, owner.id).run();
      const n = res && res.meta ? res.meta.changes : 0;
      if (n) gone.push({ table, rows: n });
    } catch (e) {
      // A table this deployment does not have is not a reason to leave a
      // client half deleted.
      console.error('delete client', table, e);
    }
  };
  await drop('tasks', 'DELETE FROM tasks WHERE client_id = ? AND user_id = ?');
  await drop('appointments', 'DELETE FROM appointments WHERE client_id = ? AND user_id = ?');
  await drop('reviews', 'DELETE FROM reviews WHERE client_id = ? AND user_id = ?');
  await drop('form_invites', 'DELETE FROM form_invites WHERE client_id = ? AND user_id = ?');
  await drop('broadcast_recipients',
    'DELETE FROM broadcast_recipients WHERE client_id = ? AND user_id = ?');

  // Somebody else's record, pointed at this one.
  await env.DB.prepare(
    'UPDATE clients SET referred_by_client_id = NULL, updated_at = ? WHERE referred_by_client_id = ? AND user_id = ?'
  ).bind(ts, id, owner.id).run().catch(() => {});

  // The submission belongs to the agency and keeps its answers; only the claim
  // about who sent it goes. There is no user_id on it, but there is an
  // agency_id, and naming it is what stops this statement reaching past the
  // caller: a client id is a uuid and will not collide in practice, but
  // "the id is unguessable" is not a fence, and this is an UPDATE with no
  // other bound on it.
  await env.DB.prepare(
    'UPDATE form_submissions SET contact_id = NULL WHERE contact_id = ? AND agency_id = ?'
  ).bind(id, tenantFor(env, user)).run().catch(() => {});

  await env.DB.prepare('DELETE FROM clients WHERE id = ? AND user_id = ?')
    .bind(id, owner.id).run();

  // One person is not a household. The same rule handleRemoveMember applies
  // when somebody leaves one, because this is somebody leaving one.
  let dissolved = false;
  if (client.household_id) {
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM clients WHERE household_id = ? AND user_id = ?'
    ).bind(client.household_id, owner.id).first();
    if ((left?.n || 0) < 2) {
      await env.DB.prepare(
        'UPDATE clients SET household_id = NULL WHERE household_id = ? AND user_id = ?'
      ).bind(client.household_id, owner.id).run().catch(() => {});
      await env.DB.prepare('DELETE FROM households WHERE id = ? AND user_id = ?')
        .bind(client.household_id, owner.id).run().catch(() => {});
      dissolved = true;
    }
  }

  await db.logActivity(env, owner.id, 'client.delete',
    db.byHand(`Removed ${client.name}`, user, owner), { client: id, gone });

  return json({ ok: true, name: client.name, gone, dissolved });
}

export async function handleUpdateClient(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'clients', id);
  if (!owner) return notFound('Client not found.');

  const body = await readJson(request);

  // Pinning is its own shape: it happens from a list, constantly, and should
  // not require sending a whole client back to say "this one matters today".
  if (Object.prototype.hasOwnProperty.call(body, 'pinned')) {
    const res = await env.DB.prepare(
      'UPDATE clients SET pinned_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(body.pinned ? now() : null, now(), id, owner.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Client not found.');
    return json({ ok: true });
  }

  const name = clean(body.name, 120);
  if (!name) return badRequest('A client needs a name.');

  // The name is the key reservations were matched on before this table
  // existed, so renaming has to carry them along or the trips would be
  // orphaned from the person who took them.
  const travel = travelFields(body);
  // nickname and source are set here as well as on the create.
  //
  // They were on one and not the other, which is the quiet half of that bug:
  // the write succeeded, the field was simply never in the statement, and the
  // value came back unchanged with nothing thrown. You could record what
  // somebody goes by when you first added them and never correct it, and
  // "where they came from" was the same, which is the only field that answers
  // which of your marketing is working.
  const res = await env.DB.prepare(
    `UPDATE clients SET name = ?, email = ?, phone = ?, notes = ?,
       birthday = ?, anniversary = ?, nickname = ?, source = ?,
       source_kind = ?, referred_by_client_id = ?,
       ${TRAVEL_SET}, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(name, clean(body.email, 160) || null, clean(body.phone, 40) || null,
         clean(body.notes, 4000) || null,
         // Kept as written, year and all. A birthday with no year is still a
         // birthday, but the field is a date input and half of these arrive
         // from a passport, so there is no reason to throw the year away.
         cleanDate(body.birthday), cleanDate(body.anniversary),
         travel.nickname, travel.source,
         // The channel and who sent them, editable for the same reason the note
         // beside them is: the first guess at where somebody came from is often
         // wrong, and a field nobody can correct is a field nobody trusts.
         oneOf(body.sourceKind, SOURCE_KIND_IDS) || null,
         clean(body.referredBy, 64) || null,
         ...travelBinds(travel),
         now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Client not found.');

  // A rename that reaches the client and not their reservations leaves the
  // same person under two names, so a failure here is the caller's problem.
  await env.DB.prepare('UPDATE bookings SET client_name = ? WHERE client_id = ? AND user_id = ?')
    .bind(name, id, owner.id).run();
  await env.DB.prepare('UPDATE client_credits SET client_name = ? WHERE client_id = ? AND user_id = ?')
    .bind(name, id, owner.id).run();

  return json({ ok: true, client: await db.getClient(env, db.selfScope(owner), { id }) });
}
