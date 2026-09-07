/**
 * Smoke test: drive the flows that have never run in production.
 *
 * The contract checker asks whether a page reads fields the API returns. It
 * says nothing about whether a sequence of requests does the right thing, and
 * three of this portal's paths had never been executed end to end at all:
 *
 *   signup -> pending -> admin approval -> first sign in
 *   a hosted form submission arriving as a lead
 *   an automation firing from that submission and running to completion
 *
 * Each is only exercised by a real person doing a real thing weeks apart, so a
 * regression in one would sit undetected until it cost someone a lead. This
 * runs the lot against a local dev server in a few seconds.
 *
 * Usage: node scripts/smoke.mjs [baseUrl] [adminEmail] [adminPassword]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const ADMIN_EMAIL = process.argv[3] || 'local@test.dev';
const ADMIN_PASSWORD = process.argv[4] || 'local-test-12345';

const stamp = Date.now().toString(36);
const ADVISOR_EMAIL = `smoke-${stamp}@test.dev`;
const ADVISOR_PASSWORD = 'smoke-test-12345';

let failures = 0;
let checks = 0;
// Sections that could not run here rather than sections that passed. Counted
// apart from the checks and named at the end, because a suite that quietly
// shrinks by eight on a machine with no catalog is a suite reporting a number
// that means something different from run to run.
const skips = [];

function ok(label) { checks++; console.log(`  ok    ${label}`); }
function fail(label, detail) {
  checks++; failures++;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}
function check(condition, label, detail) {
  condition ? ok(label) : fail(label, detail);
  return Boolean(condition);
}
function skip(what, why) {
  skips.push(what);
  console.log(`  skip  ${what}`);
  console.log(`        ${why}`);
}
function step(name) { console.log(`\n${name}`); }

/** A cookie jar, because sessions are the thing under test. */
function jar() {
  const cookies = new Map();
  return {
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      // Workers send one Set-Cookie per header; getSetCookie keeps them apart.
      const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      for (const line of raw) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
  };
}

async function call(cookieJar, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookieJar && cookieJar.header() ? { cookie: cookieJar.header() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  if (cookieJar) cookieJar.absorb(res);
  // The body once, as text, then parsed if it will parse. Pages are checked
  // for what they must not contain, and a checker that can only see JSON
  // cannot look at a page at all.
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* not every response is JSON */ }
  return { status: res.status, data, raw };
}

/**
 * Attach a file, which is the one request here that is not a JSON body.
 * Returns the created document, or null if the bucket is not bound: document
 * storage is optional, and a suite that fails without R2 is a suite nobody
 * can run locally.
 */
async function uploadDoc(cookieJar, bookingId, filename, content) {
  const body = new FormData();
  body.append('file', new Blob([content], { type: 'text/plain' }), filename);
  body.append('category', 'other');
  const res = await fetch(`${BASE}/api/bookings/${bookingId}/documents`, {
    method: 'POST',
    headers: { ...(cookieJar.header() ? { cookie: cookieJar.header() } : {}) },
    body,
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// Anything created gets registered here immediately. An earlier version tidied
// up only on the happy path, so a run that bailed half way left a form behind,
// and that stray form went on to confuse the contract checker on the next run.
// Test data that outlives its test is worse than no test data.
const cleanups = [];
function cleanup(label, fn) { cleanups.push({ label, fn }); }
async function runCleanups() {
  // Drained, not iterated, so the happy path can tidy up and assert on the
  // result while the finally below stays a no-op rather than deleting twice.
  while (cleanups.length) {
    const { label, fn } = cleanups.pop();
    try { await fn(); } catch (e) { console.log(`  note  could not clean up ${label}: ${e.message}`); }
  }
}
class Bail extends Error {}

// Both live at module scope so the finally below can still reach them.
const admin = jar();
let advisorId = null;

async function main() {
  console.log(`Smoke test against ${BASE}`);

  // ---------------------------------------------------------------- admin --
  step('Admin signs in');
  const login = await call(admin, 'POST', '/api/auth/login',
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (!check(login.status === 200, 'admin signs in', `status ${login.status}`)) {
    throw new Bail('Cannot continue without an admin session. Is the dev server seeded?');
  }

  // ------------------------------------------------- signup and approval --
  step('A new advisor signs up and waits for approval');
  const signup = await call(null, 'POST', '/api/auth/signup', {
    email: ADVISOR_EMAIL, password: ADVISOR_PASSWORD,
    firstName: 'Smoke', lastName: 'Tester', agencyName: 'Smoke Travel',
  });
  check(signup.status === 200 && signup.data?.status === 'pending',
    'signup returns pending', JSON.stringify(signup.data));

  const advisor = jar();
  const blocked = await call(advisor, 'POST', '/api/auth/login',
    { email: ADVISOR_EMAIL, password: ADVISOR_PASSWORD });
  check(blocked.status === 403 && blocked.data?.status === 'pending',
    'a pending advisor cannot sign in', `status ${blocked.status}`);

  const list = await call(admin, 'GET', '/api/admin/advisors');
  const created = (list.data?.users || []).find((a) => a.email === ADVISOR_EMAIL);
  if (!check(created, 'the signup shows up for the admin')) throw new Bail('No advisor to approve.');
  // Deliberately not registered with the other cleanups: suspending the
  // advisor kills their session, and the checks after cleanup are made as the
  // advisor. Registered here it ran first and those checks then passed against
  // 401 bodies, which is worse than not running them.
  advisorId = created.id;
  const adminId = (await call(admin, 'GET', '/api/auth/me')).data?.user?.id;
  check(created.status === 'pending', 'and shows up as pending', created.status);

  const approve = await call(admin, 'PUT', `/api/admin/advisors/${created.id}/status`,
    { status: 'active' });
  check(approve.status === 200, 'admin approves them', `status ${approve.status}`);

  const signedIn = await call(advisor, 'POST', '/api/auth/login',
    { email: ADVISOR_EMAIL, password: ADVISOR_PASSWORD });
  check(signedIn.status === 200, 'the advisor can now sign in', `status ${signedIn.status}`);
  const me = await call(advisor, 'GET', '/api/auth/me');
  check(me.data?.user?.email === ADVISOR_EMAIL, 'and the session is theirs', me.data?.user?.email);

  // ------------------------------------------ reservation and its schedule --
  step('A reservation, and the schedule built from it');
  const res = await call(advisor, 'POST', '/api/bookings', {
    clientName: 'Smoke Client', supplier: 'Carnival', productName: 'Western Caribbean',
    productType: 'cruise', confirmationNumber: `SMK${stamp}`,
    departDate: isoDay(120), returnDate: isoDay(127),
    depositDue: isoDay(5), finalPaymentDue: isoDay(60),
    gross: '5000', deposit: '500', commission: '600', status: 'booked',
  });
  const bookingId = res.data?.booking?.id;
  const clientId = res.data?.booking?.client_id;
  if (!check(res.status === 201 && bookingId, 'reservation created', `status ${res.status}`)) {
    throw new Bail('No reservation to schedule.');
  }
  cleanup('the reservation', () => call(advisor, 'DELETE', `/api/bookings/${bookingId}`));
  check(res.data.booking.deposit_cents === 50000,
    'the deposit is stored and read back', res.data.booking.deposit_cents);

  const sched = await call(advisor, 'POST', `/api/bookings/${bookingId}/schedule`, {});
  const rows = sched.data?.created || [];
  check(sched.status === 201, 'schedule built', `status ${sched.status}`);

  const deposit = rows.find((p) => p.kind === 'deposit');
  const hardFinal = rows.find((p) => p.kind === 'final' && p.payment_class === 'hard');
  const softFinal = rows.find((p) => p.kind === 'final' && p.payment_class === 'soft');

  check(deposit?.payment_class === 'hard' && deposit?.amount_cents === 50000,
    'a hard deposit for the deposit amount', JSON.stringify(deposit));
  check(hardFinal?.amount_cents === 450000 && hardFinal?.due_date === isoDay(60),
    'a hard balance on the vendor date, net of the deposit', JSON.stringify(hardFinal));
  check(softFinal?.amount_cents === 450000 && softFinal?.due_date === isoDay(53),
    'a soft reminder one week earlier', JSON.stringify(softFinal));

  const again = await call(advisor, 'POST', `/api/bookings/${bookingId}/schedule`, {});
  check((again.data?.created || []).length === 0,
    'building it twice does not duplicate the schedule', JSON.stringify(again.data?.created));

  // The dashboard is the thing an advisor actually looks at, so check the
  // schedule reaches it rather than trusting the write.
  const dash = await call(advisor, 'GET', '/api/dashboard');
  const due = dash.data?.payStats || {};
  check(due.hardDueCents >= 50000, 'the dashboard counts the hard deadlines', due.hardDueCents);

  // The soft row is a reminder to chase the same balance a week early, not a
  // second amount owed. Totalling both reported a $5,000 trip as owing $9,500
  // on every screen that summed a schedule.
  // The new reservation page and the record page both build their selects from
  // this, so a form and the validator behind it cannot disagree about what a
  // status may be. The old dialog kept its own copies and drifted twice.
  const opts = (await call(advisor, 'GET', '/api/bookings?limit=1')).data?.fieldOptions || {};
  check(opts.statuses?.includes('quoted') && opts.productTypes?.includes('cruise')
    && opts.insuranceStatuses?.[0] === 'unknown',
    'the field lists come from the API rather than being written into each page',
    JSON.stringify(Object.keys(opts)));

  const bal = await call(advisor, 'GET', '/api/payments?state=all');
  const thisTrip = (bal.data?.balances || []).find((b) => b.id === bookingId);
  check(thisTrip && (thisTrip.paid_cents + thisTrip.scheduled_cents) <= thisTrip.gross_cents,
    'a schedule never totals more than the trip it is for',
    thisTrip && `${thisTrip.paid_cents} + ${thisTrip.scheduled_cents} vs ${thisTrip.gross_cents}`);

  // ------------------------------------------------ who can see what ------
  step('An associate sees their own records; an owner sees the agency');

  // The reservation above belongs to the associate, since the whole earlier
  // section runs as them. The owner needs one of their own or "cannot see the
  // owner's records" is a check that proves nothing. An earlier draft of this
  // test compared the associate against their own reservation and reported a
  // leak that was not there.
  const ownerRes = await call(admin, 'POST', '/api/bookings', {
    clientName: `Owner Client ${stamp}`, supplier: 'Virgin Voyages',
    departDate: isoDay(210), gross: '8000', commission: '800', status: 'booked',
  });
  const ownerBookingId = ownerRes.data?.booking?.id;
  // Creating a reservation creates the client behind it, which is where these
  // come from: there is no endpoint that makes a client on its own.
  const ownerClientId = ownerRes.data?.booking?.client_id;
  if (ownerBookingId) {
    cleanup('the owner reservation', () => call(admin, 'DELETE', `/api/bookings/${ownerBookingId}`));
  }
  check(ownerRes.status === 201 && ownerBookingId, 'the owner creates a reservation of their own');

  // Now the associate's own.
  const theirs = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Associate Client ${stamp}`, supplier: 'Royal Caribbean',
    departDate: isoDay(200), gross: '3000', commission: '300', status: 'booked',
  });
  const theirBookingId = theirs.data?.booking?.id;
  if (theirBookingId) {
    cleanup('the associate reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${theirBookingId}`));
  }
  check(theirs.status === 201 && theirBookingId, 'the associate creates a reservation');

  const mine = await call(advisor, 'GET', '/api/bookings');
  const mineIds = (mine.data?.bookings || []).map((b) => b.id);
  check(mineIds.includes(theirBookingId) && !mineIds.includes(ownerBookingId),
    'the associate sees their own reservation and not the owner\'s',
    `${mineIds.length} reservation(s) visible`);
  check(mine.data?.scope && mine.data.scope.canPick === false,
    'and is offered no advisor picker', JSON.stringify(mine.data?.scope));

  // The one that matters: an associate cannot widen their own scope by
  // editing the query string.
  const forged = await call(advisor, 'GET', `/api/bookings?advisor=${encodeURIComponent(created.id)}&advisor=all`);
  const forgedIds = (forged.data?.bookings || []).map((b) => b.id);
  check(!forgedIds.includes(ownerBookingId),
    'and cannot widen their scope with ?advisor=', `${forgedIds.length} reservation(s)`);

  // Asked for that advisor. The agency list is capped, so scanning it turns
  // "can the owner see this" into "how many reservations exist", and the two
  // answers diverge the moment the book is bigger than the cap.
  const allRes = await call(admin, 'GET', `/api/bookings?advisor=${advisorId}`);
  const allIds = (allRes.data?.bookings || []).map((b) => b.id);
  check(allIds.includes(theirBookingId),
    'the owner sees the associate\'s reservation', `${allIds.length} reservation(s)`);
  const attributed = (allRes.data?.bookings || []).find((b) => b.id === theirBookingId);
  check(attributed && attributed.advisor_name,
    'attributed to whoever booked it', attributed && attributed.advisor_name);
  // The default scope, asked without narrowing: this one is about the label
  // rather than the list, so it does not care how many reservations exist.
  const wideScope = await call(admin, 'GET', '/api/bookings');
  check(wideScope.data?.scope?.all === true && wideScope.data.scope.canPick === true,
    'and the agency view says so, with a picker to narrow it down',
    JSON.stringify(wideScope.data?.scope));

  const narrowed = await call(admin, 'GET', `/api/bookings?advisor=${encodeURIComponent(created.id)}`);
  const narrowedIds = (narrowed.data?.bookings || []).map((b) => b.id);
  check(narrowedIds.includes(theirBookingId) && !narrowedIds.includes(ownerBookingId),
    'and narrowing to one advisor shows only theirs', `${narrowedIds.length} reservation(s)`);

  // Seeing is not editing. This is the distinction the code keeps by using a
  // separate scope for writes, and it is worth proving rather than assuming.
  const ownerRead = await call(admin, 'GET', `/api/bookings/${theirBookingId}`);
  check(ownerRead.status === 200, 'an owner can open an associate\'s reservation', `status ${ownerRead.status}`);
  const ownerWrite = await call(admin, 'PUT', `/api/bookings/${theirBookingId}`,
    { clientName: 'Should not apply' });
  check(ownerWrite.status === 404, 'but cannot write to it', `status ${ownerWrite.status}`);
  const stillTheirs = await call(advisor, 'GET', `/api/bookings/${theirBookingId}`);
  check(stillTheirs.data?.booking?.client_name === `Associate Client ${stamp}`,
    'and the record is unchanged', stillTheirs.data?.booking?.client_name);

  const associateRead = await call(advisor, 'GET', `/api/bookings/${ownerBookingId}`);
  check(associateRead.status === 404,
    'an associate cannot open the owner\'s reservation', `status ${associateRead.status}`);

  const report = await call(admin, 'GET', '/api/reports/production?months=12');
  const lines = report.data?.byAdvisor || [];
  check(lines.some((r) => r.user_id === created.id) && lines.length >= 2,
    'combined reporting breaks down per advisor', `${lines.length} line(s)`);

  const ownReport = await call(advisor, 'GET', '/api/reports/production?months=12');
  const ownLines = ownReport.data?.byAdvisor || [];
  check(ownLines.length === 1 && ownLines[0].user_id === created.id,
    'an associate\'s report covers only themselves', `${ownLines.length} line(s)`);

  const findAll = await call(admin, 'GET', `/api/search?q=Associate%20Client%20${stamp}`);
  check((findAll.data?.groups || []).some((g) => g.items.length),
    'the owner can find the associate\'s reservation in search');
  const findMine = await call(advisor, 'GET', `/api/search?q=Owner%20Client%20${stamp}`);
  check(!(findMine.data?.groups || []).some((g) => g.items.length),
    'and search does not leak the owner\'s records to the associate',
    JSON.stringify(findMine.data?.groups));

  // --------------------------------------------- form, submission, lead --
  step('A hosted form takes a submission');
  const formRes = await call(advisor, 'POST', '/api/myforms', {
    name: `Smoke enquiry ${stamp}`,
    headline: 'Tell us about your trip',
    fields: [
      { label: 'First name', type: 'text', required: true },
      { label: 'Last name', type: 'text' },
      { label: 'Email', type: 'email', required: true },
      { label: 'Where to?', type: 'text' },
    ],
  });
  const form = formRes.data?.form;
  if (!check(formRes.status === 201 && form?.slug, 'form created', `status ${formRes.status}`)) {
    throw new Bail('No form to submit to.');
  }
  cleanup('the form', () => call(advisor, 'DELETE', `/api/myforms/${form.id}`));

  const page = await fetch(`${BASE}/f/${form.slug}`);
  check(page.status === 200, 'its hosted page is public', `status ${page.status}`);

  // An automation on this form, so the submission has something to fire.
  const autoRes = await call(advisor, 'POST', '/api/automations', {
    name: `Smoke follow up ${stamp}`,
    triggerType: 'form.submitted',
    formId: form.id,
    steps: [{ action: 'notify_team', subject: 'New enquiry', body: 'A smoke test enquiry arrived.' }],
  });
  const automationId = autoRes.data?.automation?.id;
  check(autoRes.status === 200 && automationId, 'automation created', `status ${autoRes.status}`);
  if (automationId) {
    cleanup('the automation', () => call(advisor, 'DELETE', `/api/automations/${automationId}`));
  }

  const submit = await call(null, 'POST', `/api/public/forms/${form.slug}`, {
    first_name: 'Anna', last_name: 'Submitter',
    email: `anna-${stamp}@test.dev`, where_to: 'Cozumel',
  });
  check(submit.status === 200 || submit.status === 201,
    'the public submission is accepted', `status ${submit.status} ${JSON.stringify(submit.data)}`);

  const withSubs = await call(advisor, 'GET', `/api/myforms/${form.id}`);
  const subs = withSubs.data?.submissions || [];
  check(subs.some((s) => s.email === `anna-${stamp}@test.dev`),
    'and lands as a submission on the form', `${subs.length} submission(s)`);

  // ------------------------------------------------------ the lead report --
  step('What the forms brought in');

  const listed = await call(advisor, 'GET', '/api/myforms');
  const templates = listed.data?.templates || [];
  check(templates.length >= 5, 'the builder offers ready-made lead forms',
    `${templates.length} template(s)`);
  // A template whose fields carry no key would have them derived from labels,
  // which is how the first version of these quietly produced "your_name".
  check(templates.every((t) => t.fields.length && t.fields.every((f) => f.key && f.label)),
    'each with named fields, not just labels');
  check(templates.every((t) => t.fields.some((f) => f.type === 'email')),
    'and every one asks for an email, since a lead you cannot reach is not one');

  const fieldCatalogue = listed.data?.catalogue || [];
  check(fieldCatalogue.length >= 5, 'the builder offers a catalogue of known client fields',
    `${fieldCatalogue.length} group(s)`);
  const catKeys = new Set(fieldCatalogue.flatMap((g) => g.fields.map((f) => f.key)));
  check(catKeys.has('mobile_phone') && catKeys.has('passport_number'),
    'covering contact details through to travel documents');
  check(fieldCatalogue.some((g) => g.sensitive),
    'with the sensitive group marked, so a passport number is a deliberate choice');
  // One key per question, or the same answer arrives under two names and the
  // catalogue was pointless. A template using `phone` while the catalogue used
  // `mobile_phone` put "Mobile" on a form twice.
  const templateKeys = templates.flatMap((t) => t.fields.map((f) => f.key));
  const strays = [...new Set(templateKeys)].filter((k) => !catKeys.has(k));
  check(strays.every((k) => ['wedding_date', 'sailing', 'sailed_before', 'best_time'].includes(k)),
    'and the templates draw their questions from it', `outside it: ${strays.join(', ')}`);

  // A form that closes before it opens is a form nobody can fill in.
  const formBackwards = await call(advisor, 'POST', '/api/myforms', {
    name: `Backwards ${stamp}`, startsOn: isoDay(30), endsOn: isoDay(10),
    fields: [{ label: 'Email', key: 'email', type: 'email', required: true }],
  });
  check(formBackwards.status === 400, 'a form cannot close before it opens',
    `status ${formBackwards.status}`);

  const formBadNotify = await call(advisor, 'POST', '/api/myforms', {
    name: `Bad notify ${stamp}`, notifyEmail: 'not-an-address',
    fields: [{ label: 'Email', key: 'email', type: 'email', required: true }],
  });
  check(formBadNotify.status === 400, 'and a notification address has to look like one',
    `status ${formBadNotify.status}`);

  const leadReport = await call(advisor, 'GET', '/api/myforms/report?days=90');
  check(leadReport.status === 200, 'the lead report loads', `status ${leadReport.status}`);
  const myLead = (leadReport.data?.submissions || []).find((x) => x.email === `anna-${stamp}@test.dev`);
  check(Boolean(myLead), 'a submission shows up in it across every form');
  check(myLead?.formName === form.name, 'named by the form it came from', myLead?.formName);
  check(leadReport.data?.totals?.submissions >= 1, 'with a count for the period');
  // Leads that never reached the CRM are the ones nobody is chasing, so they
  // get their own number instead of being buried in the total.
  check(leadReport.data.totals.reachedCrm + leadReport.data.totals.strandedHere
    === leadReport.data.totals.submissions,
    'and the ones that reached the CRM plus the ones that did not are all of them',
    JSON.stringify(leadReport.data.totals));

  const shortWindow = await call(advisor, 'GET', '/api/myforms/report?days=1');
  check(shortWindow.status === 200 && shortWindow.data?.days === 1,
    'the period can be narrowed', `${shortWindow.data?.days}`);

  // --------------------------------------------- a lead becomes a quote --
  step('From lead to reservation');

  const quoted = await call(advisor, 'POST',
    `/api/leads/submissions/${myLead.id}/reservation`);
  check(quoted.status === 200 && quoted.data?.bookingId,
    'a lead can be turned into a reservation', `status ${quoted.status}`);

  const fromLead = await call(advisor, 'GET', `/api/bookings/${quoted.data.bookingId}/record`);
  const lb = fromLead.data?.booking;
  // Quoted, never booked. Nobody has agreed to anything by filling in a form,
  // and a booked reservation would land in production and commission owed.
  check(lb?.status === 'quoted', 'as a quote, not a booking', lb?.status);
  check(lb?.client_name === myLead.name, 'under the name they gave', lb?.client_name);
  // A budget of "10,000 to 20,000" is not a price and must not become one.
  check(lb?.gross_cents === 0, 'with no price on it, since a budget is not a quote',
    `${lb?.gross_cents}`);
  check((lb?.notes || '').includes(form.name),
    'and the notes say which form it came from');
  // resolveClient answers with an id, not a row. Reading it as an object left
  // the reservation unattached to the client it was for.
  check(Boolean(lb?.client_id), 'attached to a client record', `client_id ${lb?.client_id}`);
  const leadTravellers = fromLead.data?.travellers || [];
  check(leadTravellers.length === 1 && leadTravellers[0].is_lead === 1,
    'with the person who filled it in as the first traveller');
  check(leadTravellers[0]?.email === myLead.email,
    'carrying the email they gave, so nobody has to ask twice');

  cleanup('the reservation from a lead',
    () => call(advisor, 'DELETE', `/api/bookings/${quoted.data.bookingId}`));

  const notALead = await call(advisor, 'POST', '/api/leads/submissions/nope/reservation');
  check(notALead.status === 404, 'and an unknown lead is refused',
    `status ${notALead.status}`);

  // ------------------------------------------------------- automation run --
  step('The submission drives the automation');
  let detail = await call(advisor, 'GET', `/api/automations/${automationId}`);
  check((detail.data?.runs || []).length === 1,
    'the submission started exactly one run', `${(detail.data?.runs || []).length} run(s)`);

  // Runs are rows, not in-memory jobs: something has to come along and advance
  // them. In production that is the cron; here it is this request.
  //
  // Named, not a blanket pass. A pass takes the oldest runs that are due and
  // stops at a ceiling, so on a database with anything queued the run made a
  // second ago sits behind all of it and is never reached. That is correct for
  // a queue and made this block fail roughly one run in ten, depending on how
  // much unrelated work happened to be waiting.
  await call(advisor, 'POST', '/api/automations/run', { automationId });
  detail = await call(advisor, 'GET', `/api/automations/${automationId}`);
  const run = (detail.data?.runs || [])[0];
  // What "advanced correctly" means depends on the environment. With email
  // configured the run should finish. Without it the send throws, and the
  // run should fail immediately with the reason on it: retrying a missing API
  // key four times leaves it sitting in `waiting`, which reads as patience
  // when it is really a broken automation nobody is being told about.
  const health = await call(admin, 'GET', '/api/admin/health');

  // The database against the migrations. CI applies every migration before
  // this runs, so a failure here means the generated schema and real SQLite
  // disagree: the parser in scripts/lib/schema.mjs read something wrong. On a
  // live deployment the same check answers a different question, and the one
  // that actually bit us: whether the migrations were ever applied at all.
  const schema = health.data?.schema;
  const drift = [
    ...(schema?.missingTables || []).map((t) => `table ${t}`),
    ...(schema?.missingColumns || []).map((m) => `${m.table}.${m.columns.join('/')}`),
  ];
  check(schema?.ok === true, 'the database has every column the migrations describe',
    drift.length ? `missing: ${drift.join(', ')}` : String(schema?.error || 'no schema report'));
  check((schema?.checked || 0) >= 25, 'and the check covered the whole schema',
    `${schema?.checked || 0} tables`);

  const mailConfigured = Boolean(health.data?.email?.resendKeyPresent);
  if (mailConfigured) {
    check(run && run.status === 'done',
      'and it runs to completion', run ? `${run.status}: ${run.last_error || ''}` : 'no run');
  } else {
    check(run && run.status === 'failed' && /RESEND_API_KEY/.test(run.last_error || ''),
      'and, with email unconfigured, it fails at once and says why',
      run ? `${run.status}: ${run.last_error || 'no error recorded'}` : 'no run');
    check(run && !run.next_run_at,
      'without scheduling a retry that cannot help', run ? `retry at ${run.next_run_at}` : 'no run');
  }
  check((detail.data?.logs || []).length >= 1,
    'leaving a log of what it did', `${(detail.data?.logs || []).length} log line(s)`);

  const notOurs = await call(advisor, 'POST', '/api/automations/run',
    { automationId: 'no-such-automation' });
  check(notOurs.status === 404, 'and an id is not permission to run somebody else\'s rules',
    `status ${notOurs.status}`);

  // ------------------------------------------------------- group space ------
  step('Group space, and the option date that ends it');

  const badDate = await call(advisor, 'POST', '/api/groups', {
    name: `Bad dates ${stamp}`, departDate: isoDay(100), optionDate: isoDay(120),
  });
  check(badDate.status === 400, 'an option date after departure is refused', `status ${badDate.status}`);

  const grp = await call(advisor, 'POST', '/api/groups', {
    name: `Islander New Year ${stamp}`, vendor: 'Margaritaville at Sea', groupCode: '4668',
    departDate: isoDay(120), returnDate: isoDay(126), optionDate: isoDay(30), cabinsHeld: 20,
  });
  const groupId = grp.data?.group?.id;
  check(grp.status === 201 && groupId, 'a group is opened', `status ${grp.status}`);
  if (groupId) cleanup('the group', () => call(advisor, 'DELETE', `/api/groups/${groupId}`));
  check(grp.data?.group?.cabins_sold === 0, 'holding cabins none of which are sold yet',
    grp.data?.group?.cabins_sold);

  const inGroup = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Group Client ${stamp}`, supplier: 'Margaritaville at Sea',
    departDate: isoDay(120), gross: '2400', status: 'booked', groupId,
  });
  const inGroupId = inGroup.data?.booking?.id;
  check(inGroup.data?.booking?.group_id === groupId,
    'a reservation sold from the block records the group', inGroup.data?.booking?.group_id);
  if (inGroupId) cleanup('the group reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${inGroupId}`));

  // Sold is counted from the reservations rather than stored, so it cannot
  // drift away from the truth.
  const groupDetail = await call(advisor, 'GET', `/api/groups/${groupId}`);
  check(groupDetail.data?.group?.cabins_sold === 1, 'and the sold count follows from it',
    groupDetail.data?.group?.cabins_sold);
  check((groupDetail.data?.bookings || []).some((b) => b.id === inGroupId),
    'with the reservation listed in the block');

  const groupList = await call(advisor, 'GET', '/api/groups?status=open');
  check(groupList.data?.stats?.held >= 20 && groupList.data.stats.sold >= 1,
    'held and sold roll up across groups', JSON.stringify(groupList.data?.stats));

  const ownerEdit = await call(admin, 'PUT', `/api/groups/${groupId}`, { name: 'Not yours' });
  check(ownerEdit.status === 404, 'an owner cannot rewrite an associate\'s group',
    `status ${ownerEdit.status}`);

  // A block is a commercial arrangement; the trips sold out of it are real
  // holidays people have paid for. Deleting one must not delete the other.
  // Checked here rather than after cleanup, where the reservation has already
  // been removed and a 404 would look like a pass for the wrong reason.
  await call(advisor, 'DELETE', `/api/groups/${groupId}`);
  const survivor = await call(advisor, 'GET', `/api/bookings/${inGroupId}`);
  check(survivor.status === 200 && !survivor.data.booking.group_id,
    'deleting a group keeps its reservations and clears the link',
    `status ${survivor.status}, group ${survivor.data?.booking?.group_id}`);

  // ------------------------------------------------------------- tasks ------
  step('The task list');

  const t1 = await call(advisor, 'POST', '/api/tasks',
    { title: `Ring the client ${stamp}`, dueDate: isoDay(-2), priority: 'high' });
  const t2 = await call(advisor, 'POST', '/api/tasks', { title: `Send documents ${stamp}`, dueDate: isoDay(3) });
  const t3 = await call(advisor, 'POST', '/api/tasks', { title: `Someday idea ${stamp}` });
  const taskId = t1.data?.task?.id;
  check(t1.status === 201 && taskId, 'a task is created', `status ${t1.status}`);
  if (taskId) cleanup('the tasks', async () => {
    for (const t of [t1, t2, t3]) {
      if (t.data?.task?.id) await call(advisor, 'DELETE', `/api/tasks/${t.data.task.id}`);
    }
  });

  // oneOf falls back to the first entry of its list, so a list ordered wrongly
  // silently promotes every task. This shipped that way for about ten minutes.
  check(t2.data?.task?.priority === 'normal',
    'a task with no priority given is normal, not high', t2.data?.task?.priority);

  const open = await call(advisor, 'GET', '/api/tasks?state=open');
  check(open.data?.counts?.overdue >= 1 && open.data.counts.open >= 3,
    'overdue and open are counted', JSON.stringify(open.data?.counts));
  const order = (open.data?.tasks || []).map((t) => t.title);
  check(order.indexOf(`Ring the client ${stamp}`) < order.indexOf(`Someday idea ${stamp}`),
    'dated tasks sort above undated ones');

  const ticked = await call(advisor, 'PUT', `/api/tasks/${taskId}`, { done: true });
  check(ticked.data?.task?.done_at, 'ticking one off records when');
  const stillOpen = await call(advisor, 'GET', '/api/tasks?state=open');
  check(!(stillOpen.data?.tasks || []).some((t) => t.id === taskId),
    'and it leaves the open list');
  const done = await call(advisor, 'GET', '/api/tasks?state=done');
  check((done.data?.tasks || []).some((t) => t.id === taskId), 'but is still on the done list');

  // Pinning is not priority. Priority says how important a task is; a pin says
  // this is the one being worked on now, and it outranks any date.
  const pinned = await call(advisor, 'PUT', `/api/tasks/${t2.data.task.id}`, { pinned: true });
  check(pinned.data?.task?.pinned_at, 'a task can be pinned', pinned.data?.task?.pinned_at);
  const pinnedList = await call(advisor, 'GET', '/api/tasks?state=open');
  check(pinnedList.data?.tasks?.[0]?.id === t2.data.task.id,
    'and a pinned task sorts above a nearer due date',
    pinnedList.data?.tasks?.[0]?.title);
  check(pinnedList.data?.counts?.pinned === 1, 'and is counted', pinnedList.data?.counts?.pinned);

  // Pushing an overdue task to tomorrow is the commonest edit there is, and it
  // has to work without sending the whole record back: the drawer that offers
  // it holds a title and a date, not a task.
  const pushed = await call(advisor, 'PUT', `/api/tasks/${t2.data.task.id}`,
    { dueDate: isoDay(1) });
  check(pushed.data?.task?.due_date === isoDay(1),
    'a due date can be moved on its own, without a title', pushed.data?.task?.due_date);
  check(pushed.data?.task?.title === `Send documents ${stamp}`,
    'and nothing else about the task changes', pushed.data?.task?.title);

  const unpinned = await call(advisor, 'PUT', `/api/tasks/${t2.data.task.id}`, { pinned: false });
  check(unpinned.data?.task?.pinned_at === null, 'and unpinned again', unpinned.data?.task?.pinned_at);

  const notMine = await call(admin, 'PUT', `/api/tasks/${taskId}`, { done: false });
  check(notMine.status === 404, 'an owner cannot tick off an associate\'s task', `status ${notMine.status}`);
  // Asked for that advisor rather than the whole agency: the list is capped,
  // so on a big book "is it in there" is a question about how many tasks exist
  // rather than about who can see what. Narrowing to one advisor is also the
  // thing an owner actually does.
  const ownerSees = await call(admin, 'GET', `/api/tasks?state=all&advisor=${advisorId}`);
  check((ownerSees.data?.tasks || []).some((t) => t.id === taskId),
    'though they can see it when they look at that advisor');

  const foreign = await call(advisor, 'POST', '/api/tasks',
    { title: 'Linked to someone else', bookingId: ownerBookingId });
  check(foreign.status === 400,
    'and a task cannot be linked to another advisor\'s reservation', `status ${foreign.status}`);

  // Braced, so the names below are this block's own. The suite is long
  // enough that a fresh `const` is a coin toss against something declared
  // a thousand lines up, and the failure is a parse error, not a test.
  {
    // ------------------------------------------------ what a task is about ----
    step('A task that says what it is and who it is for');

    const detailed = await call(advisor, 'POST', '/api/tasks', {
      title: `Ring about the deposit ${stamp}`, kind: 'call', priority: 'high',
      dueDate: isoDay(0), dueTime: '9:30', clientId, notes: 'Two lines.\n\nSecond one.',
    });
    check(detailed.status === 201, 'a task carries a kind, a time and a client',
      `status ${detailed.status}`);
    if (detailed.data?.task?.id) {
      cleanup('the detailed task',
        () => call(advisor, 'DELETE', `/api/tasks/${detailed.data.task.id}`));
    }
    check(detailed.data?.task?.kind === 'call', 'the kind it is', detailed.data?.task?.kind);
    // Written as 9:30 and stored as 09:30, so it sorts the way it reads.
    check(detailed.data?.task?.due_time === '09:30', 'the time, padded so it sorts',
      detailed.data?.task?.due_time);
    check(detailed.data?.task?.client_name, 'and the client it is about',
      detailed.data?.task?.client_name);
    check((detailed.data?.task?.notes || '').includes('\n\n'),
      'with the paragraphs in the notes left alone');

    const noDay = await call(advisor, 'POST', '/api/tasks',
      { title: 'A time and no day', dueTime: '09:00' });
    check(noDay.status === 400, 'a time with no day is refused rather than dropped',
      `status ${noDay.status}`);

    const wrongKind = await call(advisor, 'POST', '/api/tasks',
      { title: `Nonsense kind ${stamp}`, kind: 'telepathy' });
    check(wrongKind.data?.task?.kind === 'other',
      'an unknown kind falls back to other, not to the first real one',
      wrongKind.data?.task?.kind);
    if (wrongKind.data?.task?.id) {
      cleanup('the odd-kind task',
        () => call(advisor, 'DELETE', `/api/tasks/${wrongKind.data.task.id}`));
    }

    const foreignClient = await call(advisor, 'POST', '/api/tasks',
      { title: 'Somebody else\'s client', clientId: ownerClientId });
    check(foreignClient.status === 400,
      'and a task cannot be hung on another advisor\'s client',
      `status ${foreignClient.status}`);

    // ------------------------------------------------- putting it on somebody -
    step('An owner puts a task on an advisor');

    const assigned = await call(admin, 'POST', '/api/tasks', {
      title: `Chase the contract ${stamp}`, kind: 'call', assignTo: advisorId,
    });
    check(assigned.status === 201 && assigned.data?.task?.user_id === advisorId,
      'the task lands on their list, not the owner\'s', assigned.data?.task?.user_id);
    check(assigned.data?.task?.assigned_by, 'and says who put it there',
      assigned.data?.task?.assigned_by);
    if (assigned.data?.task?.id) {
      cleanup('the assigned task',
        () => call(admin, 'DELETE', `/api/tasks/${assigned.data.task.id}`));
    }

    const advisorInbox = await call(advisor, 'GET', '/api/tasks?state=open');
    check((advisorInbox.data?.tasks || []).some((t) => t.id === assigned.data?.task?.id),
      'the advisor sees it as their own');

    // The links were checked against the person assigning, so carrying one over
    // would put a dead reference on somebody else's list.
    const assignedAndLinked = await call(admin, 'POST', '/api/tasks',
      { title: 'Both at once', assignTo: advisorId, bookingId: ownerBookingId });
    check(assignedAndLinked.status === 400,
      'a task for somebody else cannot carry the owner\'s own records',
      `status ${assignedAndLinked.status}`);

    const associateAssigns = await call(advisor, 'POST', '/api/tasks',
      { title: 'Not allowed', assignTo: adminId });
    check(associateAssigns.status === 400,
      'and an associate cannot put work on anybody', `status ${associateAssigns.status}`);
  }

  // ------------------------------------------------- being told what is due -
  step('The list chases you rather than waiting to be opened');
  {
    const due = await call(advisor, 'POST', '/api/tasks',
      { title: `Due today ${stamp}`, dueDate: isoDay(0) });
    const late = await call(advisor, 'POST', '/api/tasks',
      { title: `Late already ${stamp}`, dueDate: isoDay(-4) });
    const someday = await call(advisor, 'POST', '/api/tasks',
      { title: `No date at all ${stamp}` });
    for (const t of [due, late, someday]) {
      if (t.data?.task?.id) {
        cleanup('a reminder task',
          () => call(advisor, 'DELETE', `/api/tasks/${t.data.task.id}`));
      }
    }

    // Forced, because the pass is meant to fire once a morning and waiting
    // until tomorrow is not a test.
    const first = await call(admin, 'POST', '/api/admin/task-reminders', {});
    check(first.status === 200 && first.data?.tasks >= 2,
      'a pass picks up what is due and what is late', JSON.stringify(first.data));

    const again = await call(admin, 'POST', '/api/admin/task-reminders', {});
    check(again.data?.tasks === 0,
      'and says nothing twice about the same task', JSON.stringify(again.data));

    // A task with no date is a someday task. It is not late, it is not due,
    // and putting it in a morning email is how the email stops being read.
    const stamped = await call(advisor, 'GET', '/api/tasks?state=open');
    const undated = (stamped.data?.tasks || []).find((t) => t.id === someday.data?.task?.id);
    check(undated && !undated.reminded_at && !undated.overdue_reminded_at,
      'an undated task is never chased');

    // Moving the date puts it back in the queue. Without this a task pushed to
    // next week is never mentioned again, which is the failure nobody notices
    // until the thing it was about has gone wrong.
    const moved = await call(advisor, 'PUT', `/api/tasks/${due.data.task.id}`,
      { title: `Due today ${stamp}`, dueDate: isoDay(1) });
    check(moved.data?.task?.reminded_at === null,
      'and rescheduling a task starts it chasing again', `${moved.data?.task?.reminded_at}`);

    const notAdmin = await call(advisor, 'POST', '/api/admin/task-reminders', {});
    check(notAdmin.status === 403 || notAdmin.status === 404,
      'and only an owner can set a pass running', `status ${notAdmin.status}`);
  }

  // -------------------------------------------------- work that comes back --
  step('Repeating tasks, checklists, and the tasks a trip brings with it');
  {
    // A Monday three weeks gone, so ticking it off is ticking off something
    // long overdue: the next one must be next Monday, not three late ones.
    const monday = (() => {
      const d = new Date();
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
      d.setUTCDate(d.getUTCDate() - 21);
      return d.toISOString().slice(0, 10);
    })();

    const weekly = await call(advisor, 'POST', '/api/tasks', {
      title: `Check final payments ${stamp}`, kind: 'payment',
      dueDate: monday, repeatRule: 'weekly',
    });
    check(weekly.data?.task?.repeat_rule === 'weekly', 'a task can be set to come back',
      weekly.data?.task?.repeat_rule);

    const undated = await call(advisor, 'POST', '/api/tasks',
      { title: 'Weekly nothing', repeatRule: 'weekly' });
    check(undated.status === 400, 'but not without a date to repeat from',
      `status ${undated.status}`);

    const stepOne = await call(advisor, 'POST', `/api/tasks/${weekly.data.task.id}/items`,
      { label: 'Run the report' });
    check(stepOne.status === 201 && stepOne.data?.items?.length === 1,
      'a task holds a checklist', `${stepOne.data?.items?.length} step(s)`);

    const itemId = stepOne.data.items[0].id;
    const tickStep = await call(advisor, 'PUT', `/api/task-items/${itemId}`, { done: true });
    check(tickStep.data?.items?.[0]?.done_at, 'and a step can be ticked on its own');

    const counted = await call(advisor, 'GET', '/api/tasks?state=open');
    const withSteps = (counted.data?.tasks || []).find((t) => t.id === weekly.data.task.id);
    check(withSteps?.steps === 1 && withSteps?.steps_done === 1,
      'the list says how far through it is without asking per task',
      `${withSteps?.steps_done}/${withSteps?.steps}`);

    const ticked = await call(advisor, 'PUT', `/api/tasks/${weekly.data.task.id}`, { done: true });
    const nextId = ticked.data?.repeated;
    check(nextId, 'ticking a repeating task off makes the next one');
    if (nextId) cleanup('the repeat', () => call(advisor, 'DELETE', `/api/tasks/${nextId}`));
    cleanup('the repeating task',
      () => call(advisor, 'DELETE', `/api/tasks/${weekly.data.task.id}`));

    const openNow = await call(advisor, 'GET', '/api/tasks?state=open');
    const next = (openNow.data?.tasks || []).find((t) => t.id === nextId);
    const today = new Date().toISOString().slice(0, 10);
    check(next && next.due_date > today,
      'in the future, not three weeks of them already late', next?.due_date);
    check(next && new Date(`${next.due_date}T00:00:00Z`).getUTCDay() === 1,
      'and still on a Monday', next?.due_date);

    // A weekly task whose six steps are already crossed off is a task that
    // looks done before anybody has touched it.
    const nextSteps = await call(advisor, 'GET', `/api/tasks/${nextId}/items`);
    check(nextSteps.data?.items?.length === 1 && !nextSteps.data.items[0].done_at,
      'the checklist comes with it, unticked');

    const undo = await call(advisor, 'PUT', `/api/tasks/${weekly.data.task.id}`, { done: false });
    check(undo.data?.undone === 1, 'and un-ticking takes the new one back again',
      `${undo.data?.undone} removed`);

    // ------------------------------------------------------------ templates --
    const tpl = await call(advisor, 'POST', '/api/task-templates', {
      title: `Template docs ${stamp}`, kind: 'document',
      anchor: 'depart_date', offsetDays: -14, productType: 'cruise',
    });
    check(tpl.status === 201, 'a template says what to make and when',
      `status ${tpl.status}`);
    const tplId = (tpl.data?.templates || []).find((t) => t.title === `Template docs ${stamp}`)?.id;
    if (tplId) {
      cleanup('the task template',
        () => call(advisor, 'DELETE', `/api/task-templates/${tplId}`));
    }

    const silly = await call(advisor, 'POST', '/api/task-templates',
      { title: 'Miles away', anchor: 'depart_date', offsetDays: 5000 });
    check(silly.status === 400, 'and an offset of years is refused', `status ${silly.status}`);

    const cruise = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Template Cruise ${stamp}`, supplier: 'NCL', productType: 'cruise',
      departDate: isoDay(120), status: 'quoted',
    });
    check(cruise.data?.tasksMade >= 1, 'booking a cruise makes the tasks that follow it',
      `${cruise.data?.tasksMade} made`);
    if (cruise.data?.booking?.id) {
      cleanup('the templated reservation',
        () => call(advisor, 'DELETE', `/api/bookings/${cruise.data.booking.id}`));
    }

    const made = await call(advisor, 'GET', '/api/tasks?state=open');
    const doc = (made.data?.tasks || []).find((t) => t.title === `Template docs ${stamp}`);
    check(doc?.due_date === isoDay(106),
      'dated from the reservation, not from today', doc?.due_date);
    check(doc?.booking_id === cruise.data?.booking?.id,
      'and tied to the trip it came from');

    // A hotel is not a cruise, and a template that fires on both is one
    // somebody deletes.
    const hotel = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Template Hotel ${stamp}`, supplier: 'Marriott', productType: 'hotel',
      departDate: isoDay(120), status: 'quoted',
    });
    check(hotel.data?.tasksMade === 0, 'a cruise template leaves a hotel alone',
      `${hotel.data?.tasksMade} made`);
    if (hotel.data?.booking?.id) {
      cleanup('the untemplated reservation',
        () => call(advisor, 'DELETE', `/api/bookings/${hotel.data.booking.id}`));
    }

    // Deleting a reservation takes its tasks with it, which is the only reason
    // the cleanups above are enough.
    const noDates = await call(advisor, 'POST', '/api/task-templates', {
      title: `Final payment ${stamp}`, anchor: 'final_payment_due', offsetDays: -7,
    });
    const noDatesId = (noDates.data?.templates || [])
      .find((t) => t.title === `Final payment ${stamp}`)?.id;
    if (noDatesId) {
      cleanup('the dateless template',
        () => call(advisor, 'DELETE', `/api/task-templates/${noDatesId}`));
    }
    const sparse = await call(advisor, 'POST', '/api/bookings', {
      clientName: `No final date ${stamp}`, supplier: 'NCL', productType: 'cruise',
      departDate: isoDay(120), status: 'quoted',
    });
    const sparseTasks = await call(advisor, 'GET', '/api/tasks?state=open');
    check(!(sparseTasks.data?.tasks || []).some((t) => t.title === `Final payment ${stamp}`),
      'a template whose date the trip does not have makes nothing');
    if (sparse.data?.booking?.id) {
      cleanup('the dateless reservation',
        () => call(advisor, 'DELETE', `/api/bookings/${sparse.data.booking.id}`));
    }

    const foreignTpl = await call(admin, 'DELETE', `/api/task-templates/${tplId}`);
    check(foreignTpl.status === 404, 'and templates are one advisor\'s own',
      `status ${foreignTpl.status}`);
  }

  // -------------------------------------------------- the client's own page --
  step('A trip page the client can open, and cannot leak');
  {
    const before = await call(null, 'GET', `/t/${bookingId}`);
    check(before.status === 404, 'the booking id is not an address', `status ${before.status}`);

    const on = await call(advisor, 'POST', `/api/bookings/${bookingId}/share`, { on: true });
    const code = on.data?.code;
    check(on.status === 200 && code && code.length >= 16,
      'sharing gives a code of its own, long enough not to be guessed', `${code}`);
    check(code !== bookingId, 'and it is not the booking id');
    cleanup('the shared trip page',
      () => call(advisor, 'POST', `/api/bookings/${bookingId}/share`, { on: false }));

    const page = await call(null, 'GET', `/t/${code}`);
    check(page.status === 200, 'the page is public, with no session at all',
      `status ${page.status}`);

    // The whole reason this page is dangerous. Every one of these is on the
    // reservation it was built from.
    const body = page.raw || '';
    check(!/commission/i.test(body), 'and says nothing about commission');
    check(!/mark ?up/i.test(body), 'nor about the mark up, which is a real charge with a bad name');
    check(!body.includes(bookingId), 'nor the booking id');
    check(body.includes('Smoke Client') || body.includes('Western Caribbean'),
      'while showing the trip itself');

    // Documents are the sharpest edge: the agent confirmation the importer
    // reads has the commission printed on it.
    const upload = await uploadDoc(advisor, bookingId, 'agent-confirmation.txt',
      'AGENT CONFIRMATION\nCommission: 778.00\n');
    if (upload?.id) {
      const docId = upload.id;
      const hidden = await call(null, 'GET', `/t/${code}/d/${docId}`);
      check(hidden.status === 404, 'a document nobody shared cannot be fetched by its id',
        `status ${hidden.status}`);

      const shared = await call(advisor, 'POST', `/api/documents/${docId}/share`, { shared: true });
      check(shared.status === 200, 'until it is shared on purpose');
      const now = await call(null, 'GET', `/t/${code}/d/${docId}`);
      check(now.status === 200, 'and then it can', `status ${now.status}`);

      const off = await call(advisor, 'POST', `/api/documents/${docId}/share`, { shared: false });
      check(off.status === 200, 'and it can be taken back');
      const gone = await call(null, 'GET', `/t/${code}/d/${docId}`);
      check(gone.status === 404, 'which stops it being fetched again', `status ${gone.status}`);
      cleanup('the shared document',
        () => call(advisor, 'DELETE', `/api/documents/${docId}`));
    }

    // The only thing a client can do here.
    const note = await call(null, 'POST', `/t/${code}`,
      { body: 'Could we look at the oceanview instead?' });
    check(note.data?.ok, 'the client can leave a note', JSON.stringify(note.data));

    const bot = await call(null, 'POST', `/t/${code}`,
      { body: 'buy pills', company_website: 'http://spam' });
    check(bot.data?.ok && bot.data?.message === 'Thanks.',
      'a bot is thanked rather than told');

    const blank = await call(null, 'POST', `/t/${code}`, { body: '   ' });
    check(blank.status === 400, 'and an empty note is refused', `status ${blank.status}`);

    const record = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
    const notes = record.data?.messages || [];
    check(notes.length === 1 && notes[0].body.includes('oceanview'),
      'one note reaches the advisor, not the bot\'s', `${notes.length} note(s)`);

    const off = await call(advisor, 'POST', `/api/bookings/${bookingId}/share`, { on: false });
    check(off.status === 200, 'sharing can be turned off');
    const dead = await call(null, 'GET', `/t/${code}`);
    check(dead.status === 404, 'and the link stops working at once', `status ${dead.status}`);

    const notMine = await call(admin, 'POST', `/api/bookings/${bookingId}/share`, { on: true });
    check(notMine.status === 404, 'and only the advisor whose trip it is can share it',
      `status ${notMine.status}`);
  }

  // ------------------------------------------ chasing the client for money --
  step('Reminding the client before the vendor deadline');
  {
    const off = await call(admin, 'POST', '/api/admin/payment-reminders', {});
    check(off.status === 200, 'the pass runs', `status ${off.status}`);

    // The switch is the whole safety story: this sends email to somebody's
    // clients over their name.
    const me = await call(advisor, 'GET', '/api/auth/me');
    check(me.data?.user?.autoRemindClients === false,
      'and an advisor starts with it turned off',
      `${me.data?.user?.autoRemindClients}`);

    const trip = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Chase Me ${stamp}`, supplier: 'Royal Caribbean',
      productName: 'Icon of the Seas', productType: 'cruise',
      departDate: isoDay(120), gross: '5000', status: 'booked',
    });
    const tripId = trip.data?.booking?.id;
    if (tripId) {
      cleanup('the chased reservation', () => call(advisor, 'DELETE', `/api/bookings/${tripId}`));
    }

    // Somebody to write to. Without an address the pass counts the payment and
    // moves on without stamping it, so that it tries again once there is one.
    const madeClient = trip.data?.booking?.client_id;
    await call(advisor, 'PUT', `/api/clients/${madeClient}`,
      { name: `Chase Me ${stamp}`, email: `chase-${stamp}@example.com` });

    // Two rows for one payment: the vendor's real deadline, and the advisor's
    // own buffer a week earlier. Only the first is the client's business.
    const hard = await call(advisor, 'POST', '/api/payments', {
      bookingId: tripId, kind: 'final', amount: '4100',
      dueDate: isoDay(5), paymentClass: 'hard',
    });
    await call(advisor, 'POST', '/api/payments', {
      bookingId: tripId, kind: 'final', amount: '4100',
      dueDate: isoDay(5), paymentClass: 'soft',
    });

    const stillOff = await call(admin, 'POST', '/api/admin/payment-reminders', {});
    check(!(stillOff.data?.considered > 0) || stillOff.data.sent === 0,
      'nothing goes out while the switch is off', JSON.stringify(stillOff.data));

    await call(advisor, 'PUT', '/api/auth/profile',
      { firstName: 'Smoke', lastName: 'Tester', autoRemindClients: true });
    const on = await call(advisor, 'GET', '/api/auth/me');
    check(on.data?.user?.autoRemindClients === true, 'the advisor can turn it on');
    cleanup('the reminder switch', () => call(advisor, 'PUT', '/api/auth/profile',
      { firstName: 'Smoke', lastName: 'Tester', autoRemindClients: false }));

    const pass = await call(admin, 'POST', '/api/admin/payment-reminders', {});
    check(pass.status === 200, 'the pass runs with it on', JSON.stringify(pass.data));

    // Counting what the pass considered says nothing useful: this advisor has
    // other reservations with their own deadlines. The invariant is per row.
    const after = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
    const rows = after.data?.payments || [];
    const hardRow = rows.find((p) => p.payment_class === 'hard');
    const softRow = rows.find((p) => p.payment_class === 'soft');

    check(hardRow && hardRow.auto_lead_sent !== null,
      'the vendor deadline is noticed and written down', `${hardRow?.auto_lead_sent}`);
    // The soft row is the advisor's own buffer for the same money. Telling the
    // client twice about one payment is the bug this exists to prevent.
    check(softRow && softRow.auto_lead_sent === null,
      'and the internal buffer is left alone', `${softRow?.auto_lead_sent}`);
    check(hardRow?.auto_lead_sent === 7,
      'at the notice its date has reached', `${hardRow?.auto_lead_sent}`);

    await call(admin, 'POST', '/api/admin/payment-reminders', {});
    const twice = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
    const hardAgain = (twice.data?.payments || []).find((p) => p.payment_class === 'hard');
    check(hardAgain?.auto_lead_sent === hardRow?.auto_lead_sent,
      'and the same notice does not go a second time', `${hardAgain?.auto_lead_sent}`);

    const notAdmin = await call(advisor, 'POST', '/api/admin/payment-reminders', {});
    check(notAdmin.status === 403 || notAdmin.status === 404,
      'and only an owner can set a pass running', `status ${notAdmin.status}`);
  }

  // ------------------------------------- the invoice going out of date ------
  step('Knowing the invoice the client holds is stale');
  {
    const inv = await call(advisor, 'POST', `/api/bookings/${bookingId}/statement`,
      { preview: true });
    check(inv.status === 200 && inv.data?.fingerprint,
      'a statement has a fingerprint of what it would say', `${inv.data?.fingerprint}`);
    check(inv.data?.changedSince === false,
      'nothing has changed while nothing has been sent', `${inv.data?.changedSince}`);

    // The send needs a working mail key, which a local run does not have, so
    // the fingerprint is written the way a send would write it. What is being
    // checked is the comparison, not the emailing.
    const sent = inv.data.fingerprint;
    const record = () => call(advisor, 'GET', `/api/bookings/${bookingId}/record`);

    // The commission, which is the single thing that most must not reach a
    // client, changed through the narrow endpoint so nothing else moves with
    // it. An earlier version of this rebuilt the whole reservation by hand and
    // blanked the money it forgot to mention, which moved the fingerprint for
    // reasons that had nothing to do with the note it was testing.
    const wasCommission = (await record()).data?.booking?.commission_cents || 0;
    await call(advisor, 'PUT', `/api/bookings/${bookingId}/quick`, { commission: '1234' });
    const afterNote = await call(advisor, 'POST', `/api/bookings/${bookingId}/statement`,
      { preview: true });
    check(afterNote.data?.fingerprint === sent,
      'changing the commission does not change what the client would be told',
      `${afterNote.data?.fingerprint}`);
    // Put back at once. Later checks add up this reservation's money, and a
    // test that leaves the figures it borrowed lying around breaks the one
    // after it for reasons that look nothing like the cause.
    await call(advisor, 'PUT', `/api/bookings/${bookingId}/quick`,
      { commission: String(wasCommission / 100) });

    // Something the client does see.
    const extra = await call(advisor, 'POST', '/api/payments', {
      bookingId, kind: 'installment', amount: '250',
      dueDate: isoDay(20), paidDate: isoDay(0), paymentClass: 'hard',
    });
    const afterPayment = await call(advisor, 'POST', `/api/bookings/${bookingId}/statement`,
      { preview: true });
    check(afterPayment.data?.fingerprint !== sent,
      'posting a payment does', `${afterPayment.data?.fingerprint}`);

    // Taken away here rather than at the end. A later check adds this
    // reservation's money up against its total, and a borrowed payment left
    // sitting there until cleanup fails that check instead of this one.
    if (extra.data?.payment?.id) {
      await call(advisor, 'DELETE', `/api/payments/${extra.data.payment.id}`);
    }
    const restored = await call(advisor, 'POST', `/api/bookings/${bookingId}/statement`,
      { preview: true });
    check(restored.data?.fingerprint === sent,
      'and taking it away again puts the fingerprint back', `${restored.data?.fingerprint}`);

    // And the reservation says so without anybody opening the preview.
    const before = await record();
    check(before.data?.statementStale === false,
      'a reservation nothing was sent for is not stale', `${before.data?.statementStale}`);
  }

  // ------------------------------ what an owner may see but may not touch ---
  step('Reading the agency, writing only your own');
  {
    // The payments list reads at the viewing scope and every write on it is
    // self scoped. The page has to carry enough to tell the two apart, or it
    // offers buttons the server is right to refuse: that shipped on the vendor
    // stars, on the to do drawer, and here.
    const agency = await call(admin, 'GET', '/api/payments');
    const rows = agency.data?.payments || [];
    check(rows.length === 0 || rows.every((p) => p.user_id),
      'every payment row says whose it is', `${rows.length} row(s)`);

    const theirs = rows.find((p) => p.user_id === advisorId);
    if (theirs) {
      // The button on the page, which takes almost no body and so answers
      // about the row rather than about what was sent.
      const posted = await call(admin, 'POST', `/api/payments/${theirs.id}/paid`, {});
      check(posted.status === 404,
        'and an owner cannot post an associate\'s payment as paid',
        `status ${posted.status}`);
    } else {
      check(false, 'the suite made an associate payment for this to be about');
    }
  }

  // ------------------------------------------ a list that admits it is cut --
  step('A list says when it is only part of the answer');
  {
    // Two rows asked for out of however many exist. The point is not the
    // number: it is that the answer says it is partial, and that a search
    // reaches what the cut left out. A list quietly returning the first two
    // hundred of a thousand is how a search for a client who is right there
    // comes back empty.
    for (const [path, key] of [
      ['/api/bookings?limit=2', 'bookings'],
      ['/api/tasks?state=all&limit=2', 'tasks'],
      ['/api/clients?limit=2', 'clients'],
      ['/api/payments?limit=2', 'payments'],
    ]) {
      const res = await call(advisor, 'GET', path);
      const rows = res.data?.[key] || [];
      const enough = rows.length >= 2;
      check(!enough || res.data?.truncated === true,
        `${key} says so when it is cut`,
        `${rows.length} row(s), truncated ${res.data?.truncated}`);
      check(!enough || rows.length === 2,
        `and hands back what was asked for, not the probe row`, `${rows.length}`);
    }

    // The way out. Narrowing has to reach past the cut, or the flag is just an
    // apology.
    const narrowed = await call(advisor, 'GET',
      `/api/bookings?limit=2&q=${encodeURIComponent(stamp)}`);
    check(narrowed.status === 200,
      'and searching narrows rather than filtering what came back',
      `status ${narrowed.status}`);
    const payQ = await call(advisor, 'GET', '/api/payments?q=Smoke');
    check(payQ.status === 200, 'payments can be searched too', `status ${payQ.status}`);
    const taskQ = await call(advisor, 'GET', `/api/tasks?state=all&q=${encodeURIComponent(stamp)}`);
    check(taskQ.status === 200 && (taskQ.data?.tasks || []).length > 0,
      'and so can the task list', `${(taskQ.data?.tasks || []).length} found`);
  }

  // --------------------------------------------- merging keeps the detail ---
  step('Merging two records for one supplier');
  {
    // The duplicate is normally the one the import filled in: the phone, the
    // commission rate, the desk contact and how to book all sit on the record
    // about to be deleted. Merging used to move the reservations and throw the
    // rest away, which left a tidy list and none of the detail.
    const thin = await call(advisor, 'POST', '/api/vendors', {
      name: `Kestrel ${stamp}`, category: 'Cruise Lines', commissionPct: '16',
    });
    const rich = await call(advisor, 'POST', '/api/vendors', {
      name: `Kestrel ${stamp} Cruises`, category: 'Escorted Tours',
    });
    const keepId = thin.data?.id;
    const dropId = rich.data?.id;
    check(keepId && dropId, 'two records for one supplier',
      `${keepId} / ${dropId}`);

    // Filled in on the duplicate, which is where the detail normally is: the
    // import writes everything and the hand-made record has a name and a rate.
    await call(advisor, 'PUT', `/api/vendors/${dropId}`, {
      name: `Kestrel ${stamp} Cruises`, category: 'Escorted Tours',
      phone: '1-800-555-0100', email: `desk-${stamp}@example.com`,
      bookingInstructions: 'Ring the desk, quote the agency number.',
      commissionPct: '10', notes: 'Pays base plus a bonus on groups.',
    });

    await call(advisor, 'POST', `/api/vendors/${dropId}/favourite`, { favourite: true });

    const merged = await call(advisor, 'POST', '/api/vendors/merge',
      { keep: keepId, drop: [dropId] });
    check(merged.status === 200, 'they merge', `status ${merged.status}`);
    if (keepId) {
      cleanup('the merged vendor', () => call(advisor, 'DELETE', `/api/vendors/${keepId}`));
    }

    const after = (await call(advisor, 'GET', `/api/vendors?q=${encodeURIComponent(stamp)}`))
      .data?.vendors?.find((v) => v.id === keepId);

    check(after?.name === `Kestrel ${stamp}`,
      'under the name that was ticked', after?.name);
    check(after?.phone === '1-800-555-0100',
      'and the blank it had is filled from the one folded in', after?.phone);
    check((after?.booking_instructions || '').includes('Ring the desk'),
      'including how to book them');
    // The kept record already said sixteen. The advisor chose it; a merge does
    // not get to overrule that with the other record's ten.
    check(Number(after?.commission_pct) === 16,
      'while what it already knew is left alone', `${after?.commission_pct}`);
    check(after?.favourite === 1,
      'starred on either record means starred', `${after?.favourite}`);

    const shelves = JSON.parse(after?.categories_json || '[]');
    check(shelves.includes('Cruise Lines') && shelves.includes('Escorted Tours'),
      'and it sits on both their shelves', JSON.stringify(shelves));

    check((merged.data?.filled || []).length > 0,
      'the answer names what came across rather than counting it',
      JSON.stringify(merged.data?.filled));

    const gone = (await call(advisor, 'GET', `/api/vendors?q=${encodeURIComponent(stamp)}`))
      .data?.vendors?.find((v) => v.id === dropId);
    check(!gone, 'and the duplicate is gone');
  }

  // ---------------------------------------------------- client credits ------
  step('Credits a client holds with a vendor');

  const badExpiry = await call(advisor, 'POST', '/api/credits', {
    clientName: 'Backwards', amount: '100', issuedOn: isoDay(0), expiresOn: isoDay(-10),
  });
  check(badExpiry.status === 400, 'an expiry before the issue date is refused',
    `status ${badExpiry.status}`);

  const cr = await call(advisor, 'POST', '/api/credits', {
    clientName: `Credit Client ${stamp}`, vendor: 'Oceania Cruises', kind: 'credit',
    amount: '250.00', reference: `FCC-${stamp}`, issuedOn: isoDay(-100), expiresOn: isoDay(40),
  });
  const creditId = cr.data?.credit?.id;
  check(cr.status === 201 && cr.data?.credit?.amount_cents === 25000,
    'a credit is recorded in cents', cr.data?.credit?.amount_cents);
  if (creditId) cleanup('the credit', () => call(advisor, 'DELETE', `/api/credits/${creditId}`));

  const lapsed = await call(advisor, 'POST', '/api/credits', {
    clientName: `Lapsed Client ${stamp}`, amount: '75', expiresOn: isoDay(-5),
  });
  if (lapsed.data?.credit?.id) cleanup('the lapsed credit', () =>
    call(advisor, 'DELETE', `/api/credits/${lapsed.data.credit.id}`));

  const creditList = await call(advisor, 'GET', '/api/credits?state=open');
  const cs = creditList.data?.stats || {};
  check(cs.expiringCents >= 25000, 'one expiring inside 90 days is counted', cs.expiringCents);
  check(cs.lapsedCents >= 7500, 'and one already past its date is reported, not hidden', cs.lapsedCents);

  // Marking it used takes it out of the money at risk without deleting the
  // record, which is the difference between a credit that was spent and one
  // that was never there.
  await call(advisor, 'PUT', `/api/credits/${creditId}`, {
    clientName: `Credit Client ${stamp}`, amount: '250.00', expiresOn: isoDay(40), usedOn: isoDay(-1),
  });
  const afterUse = await call(advisor, 'GET', '/api/credits?state=open');
  check(!(afterUse.data?.credits || []).some((c) => c.id === creditId),
    'marking one used takes it off the unused list');
  const usedList = await call(advisor, 'GET', '/api/credits?state=used');
  check((usedList.data?.credits || []).some((c) => c.id === creditId),
    'but keeps it on the record');

  const ownerCredit = await call(admin, 'PUT', `/api/credits/${creditId}`, {
    clientName: 'Not yours', amount: '1',
  });
  check(ownerCredit.status === 404, 'an owner cannot rewrite an associate\'s credit',
    `status ${ownerCredit.status}`);

  // ------------------------------------------------------ worth a call ------
  step('Clients worth ringing');

  const past = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Lapsed Traveller ${stamp}`, supplier: 'Celebrity Cruises',
    departDate: isoDay(-400), returnDate: isoDay(-393), gross: '3200', status: 'travelled',
  });
  if (past.data?.booking?.id) cleanup('the past reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${past.data.booking.id}`));

  let callList = await call(advisor, 'GET', '/api/dashboard');
  check((callList.data?.rebook || []).some((r) => r.client_name === `Lapsed Traveller ${stamp}`),
    'someone who travelled and has nothing booked is worth a call');

  // The whole point of the query: booking them again takes them off the list.
  const rebooked = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Lapsed Traveller ${stamp}`, supplier: 'Celebrity Cruises',
    departDate: isoDay(90), gross: '4000', status: 'booked',
  });
  if (rebooked.data?.booking?.id) cleanup('the rebooking', () =>
    call(advisor, 'DELETE', `/api/bookings/${rebooked.data.booking.id}`));

  callList = await call(advisor, 'GET', '/api/dashboard');
  check(!(callList.data?.rebook || []).some((r) => r.client_name === `Lapsed Traveller ${stamp}`),
    'and booking them again takes them off the list');

  // ------------------------------------------------- year on year -----------
  step('This year against the same days last year');

  // Two reservations a year apart to the day, so the comparison has something
  // real on both sides rather than a zero and a shrug.
  const thisYear = await call(advisor, 'POST', '/api/bookings', {
    clientName: `YoY Now ${stamp}`, departDate: isoDay(-10), gross: '5000',
    commission: '500', status: 'travelled',
  });
  const lastYear = await call(advisor, 'POST', '/api/bookings', {
    clientName: `YoY Then ${stamp}`, departDate: isoDay(-375), gross: '2500',
    commission: '250', status: 'travelled',
  });
  for (const r of [thisYear, lastYear]) {
    if (r.data?.booking?.id) cleanup('a year on year reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
  }

  const prod = await call(advisor, 'GET', '/api/reports/production?months=12');
  const dep = prod.data?.comparison?.departure?.ytd;
  check(dep && dep.now.grossCents >= 500000 && dep.prev.grossCents >= 250000,
    'both years have figures on the departure basis',
    dep && `${dep.now.grossCents} vs ${dep.prev.grossCents}`);
  check(dep && dep.prevFrom.slice(4) === dep.from.slice(4) && dep.prevTo.slice(4) === dep.to.slice(4),
    'compared over the same days, not the same length of year',
    dep && `${dep.from}..${dep.to} vs ${dep.prevFrom}..${dep.prevTo}`);
  // Checked against the totals rather than a fixed number: the database this
  // runs on has other reservations in both years, and an assertion that only
  // holds on an empty database is an assertion that will be deleted later.
  const expected = dep && dep.prev.grossCents
    ? Math.round(((dep.now.grossCents - dep.prev.grossCents) / dep.prev.grossCents) * 1000) / 10
    : null;
  check(dep && dep.change.gross === expected,
    'and the percentage change follows from the two totals',
    dep && `${dep.change.gross} vs ${expected}`);

  // created_at is unix seconds. Comparing it to an ISO date matches nothing at
  // all and looks like a quiet year rather than a broken query.
  const pur = prod.data?.comparison?.purchase?.ytd;
  check(pur && pur.now.bookings > 0,
    'the purchase basis counts reservations taken this year', pur && pur.now.bookings);

  const zero = prod.data?.comparison?.departure?.mtd;
  check(zero && (zero.prev.grossCents > 0 || zero.change.gross === null),
    'and a period with nothing to compare against says so rather than showing 0%',
    zero && JSON.stringify(zero.change));

  // ------------------------------------------------------------- pricing ----
  {
  step('What the client pays, and what earns commission');

  const priced = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Priced ${stamp}`, supplier: `Petrel Line ${stamp}`,
    departDate: isoDay(250), status: 'booked',
  });
  const pricedId = priced.data?.booking?.id;
  if (pricedId) cleanup('the priced reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${pricedId}`));

  const vl = await call(advisor, 'GET', '/api/vendors');
  const kestrel = (vl.data?.vendors || []).find((v) => v.name === `Petrel Line ${stamp}`);
  await call(advisor, 'PUT', `/api/vendors/${kestrel.id}`,
    { name: kestrel.name, commissionPct: 16 });

  // A real cruise price: fare earns, non-commissionable fare and taxes do not.
  await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'fare', label: 'Cruise fare', amount: '1400.00', commissionable: true, commission: '224.00' });
  await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'ncf', label: 'NCF', amount: '298.00' });
  await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'taxes', label: 'Port taxes', amount: '298.00' });

  const rec = await call(advisor, 'GET', `/api/bookings/${pricedId}/record`);
  const sum = rec.data?.priceSummary;
  check(sum.clientTotalCents === 199600, 'the client total is every line added up', sum.clientTotalCents);
  check(sum.commissionableCents === 140000,
    'and the commissionable part excludes taxes and NCF', sum.commissionableCents);

  // The whole reason for the split. The rate against everything the client
  // paid looks like an underpayment; the rate against what the vendor pays on
  // is exactly their stated rate.
  check(sum.effectivePct === 11.2 && sum.truePct === 16,
    'so the two rates differ, and only one of them means anything',
    `${sum.effectivePct}% of everything, ${sum.truePct}% of the commissionable part`);
  check(sum.expectedCents === 22400 && sum.varianceCents === 0,
    'and the vendor paid exactly their own rate', JSON.stringify({ e: sum.expectedCents, v: sum.varianceCents }));

  // The headline figures follow the breakdown, so two sets of numbers cannot
  // drift apart.
  check(rec.data?.booking?.gross_cents === 199600 && rec.data.booking.commission_cents === 22400,
    'the reservation totals follow the breakdown');

  // A short payment is the thing an agency never notices.
  const lines = rec.data.pricing;
  const fare = lines.find((l) => l.kind === 'fare');
  await call(advisor, 'PUT', `/api/pricing/${fare.id}`,
    { kind: 'fare', label: 'Cruise fare', amount: '1400.00', commissionable: true, commission: '180.00' });
  const short = await call(advisor, 'GET', `/api/bookings/${pricedId}/record`);
  check(short.data?.priceSummary?.varianceCents === -4400,
    'and a vendor paying under their rate shows as a shortfall',
    short.data?.priceSummary?.varianceCents);

  // A discount reduces what the client pays without ever earning commission,
  // and goes in as a positive number so nobody has to type a minus sign.
  await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'discount', label: 'Onboard credit applied', amount: '100.00', commissionable: true });
  const discounted = await call(advisor, 'GET', `/api/bookings/${pricedId}/record`);
  check(discounted.data?.priceSummary?.clientTotalCents === 189600,
    'a discount is subtracted from what the client pays',
    discounted.data?.priceSummary?.clientTotalCents);
  check(discounted.data?.priceSummary?.commissionableCents === 140000,
    'and never counts as commissionable, whatever the box said',
    discounted.data?.priceSummary?.commissionableCents);

  const silly = await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'fare', amount: '100.00', commission: '500.00' });
  check(silly.status === 400, 'commission larger than its own line is refused',
    `status ${silly.status}`);

  // No breakdown means no summary. An empty one reads as zero, and zero is a
  // claim rather than an absence.
  const bare2 = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check(bare2.data?.priceSummary === null, 'a reservation with no breakdown reports none');
  }

  // ---------------------------------------------- the people on the trip ----
  {
  step('Travellers, passports and amenities');

  const trip = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Party Lead ${stamp}`, supplier: 'Cunard', status: 'booked',
    departDate: isoDay(300), returnDate: isoDay(314), gross: '9000', commission: '900',
    cabin: '1223', cabinCategory: 'Picturesque Oceanview', itinerary: '14 Night Transatlantic',
    insuranceStatus: 'declined', bookingMethod: 'portal',
  });
  const tripId = trip.data?.booking?.id;
  if (tripId) cleanup('the party reservation', () => call(advisor, 'DELETE', `/api/bookings/${tripId}`));
  check(trip.data?.booking?.cabin === '1223' && trip.data.booking.cabin_category === 'Picturesque Oceanview',
    'a reservation carries a cabin and its category', trip.data?.booking?.cabin);

  // Insurance is not a boolean. Declined is a different fact from not asked,
  // and it is the difference that matters if something goes wrong later.
  check(trip.data?.booking?.insurance_status === 'declined',
    'and records that the client declined insurance, rather than nothing',
    trip.data?.booking?.insurance_status);
  const silent = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Silent ${stamp}`, departDate: isoDay(300), status: 'quoted',
  });
  if (silent.data?.booking?.id) cleanup('the quiet reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${silent.data.booking.id}`));
  check(silent.data?.booking?.insurance_status === 'unknown',
    'while saying nothing leaves it unknown, not declined',
    silent.data?.booking?.insurance_status);

  const lead = await call(advisor, 'POST', `/api/bookings/${tripId}/travellers`, {
    name: 'Ada Lovelace', dob: '1965-12-10', email: 'ada@example.com',
    passportNumber: 'P1', passportExpiry: isoDay(3000), isLead: true,
  });
  check(lead.status === 201, 'a traveller can be named');

  // Six months past the return date, not six months from today: the rule is
  // applied on arrival, so a passport valid now can still be refused later.
  await call(advisor, 'POST', `/api/bookings/${tripId}/travellers`, {
    name: 'Soon Expiring', passportNumber: 'P2', passportExpiry: isoDay(400),
  });
  await call(advisor, 'POST', `/api/bookings/${tripId}/travellers`, {
    name: 'Already Expired', passportNumber: 'P3', passportExpiry: isoDay(310),
  });

  const rec3 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  const byName = Object.fromEntries((rec3.data?.travellers || []).map((t) => [t.name, t]));
  check(byName['Already Expired']?.passportWarning === 'expires before they get home',
    'a passport that runs out mid trip is flagged',
    byName['Already Expired']?.passportWarning);
  check(/six months/.test(byName['Soon Expiring']?.passportWarning || ''),
    'and so is one inside the six month rule',
    byName['Soon Expiring']?.passportWarning);
  check(byName['Ada Lovelace']?.passportWarning === null,
    'while a valid one says nothing at all');
  check(byName['Ada Lovelace']?.is_lead === 1, 'the lead traveller is marked');

  // The count follows the people, so the two can never disagree.
  check(rec3.data?.booking?.travellers === 3,
    'and the traveller count follows the names on the record',
    rec3.data?.booking?.travellers);

  // Only one lead: a vendor confirmation names one person.
  await call(advisor, 'PUT', `/api/travellers/${byName['Soon Expiring'].id}`,
    { name: 'Soon Expiring', isLead: true });
  const rec4 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  check((rec4.data?.travellers || []).filter((t) => t.is_lead).length === 1,
    'and naming a second lead moves it rather than adding one');

  const amenity = await call(advisor, 'POST', `/api/bookings/${tripId}/amenities`, {
    description: 'Onboard credit', amount: '250', source: 'vendor', status: 'requested',
  });
  check(amenity.status === 201, 'an amenity can be recorded');
  const rec5 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  const am = (rec5.data?.amenities || [])[0];
  check(am && am.amount_cents === 25000 && am.status === 'requested',
    'with its value and where it stands', am && `${am.amount_cents} ${am.status}`);

  await call(advisor, 'PUT', `/api/amenities/${am.id}`, { status: 'applied' });
  const rec6 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  check((rec6.data?.amenities || [])[0]?.status === 'applied',
    'and it can be moved along without resending the whole thing');

  const notYours2 = await call(admin, 'POST', `/api/bookings/${tripId}/travellers`, { name: 'Intruder' });
  check(notYours2.status === 404, 'an owner cannot add a traveller to an associate\'s reservation',
    `status ${notYours2.status}`);
  }

  // ------------------------------------------------------------- vendors ----
  {
  step('Vendors, their spelling and their terms');

  // Two spellings of one vendor, exactly as a pasted book produces.
  const v1 = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Vendor A ${stamp}`, supplier: `Kestrel Cruises ${stamp}`,
    departDate: isoDay(200), gross: '3000', commission: '300', status: 'booked',
  });
  const v2 = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Vendor B ${stamp}`, supplier: `Kestrel Cruises ${stamp} - Ocean`,
    departDate: isoDay(220), gross: '4000', commission: '400', status: 'booked',
  });
  for (const r of [v1, v2]) {
    if (r.data?.booking?.id) cleanup('a vendor reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
  }

  const vlist = await call(advisor, 'GET', '/api/vendors');
  const mine2 = (vlist.data?.vendors || []).filter((v) => v.name.includes(`Kestrel Cruises ${stamp}`));
  check(mine2.length === 2, 'booking a vendor creates its record', `${mine2.length} vendor(s)`);
  check(mine2.some((v) => v.trips === 1), 'with its reservations counted');

  const group = (vlist.data?.stats?.possibleDuplicates || [])
    .find((g) => g.some((v) => v.name.includes(`Kestrel Cruises ${stamp}`)));
  check(group && group.length === 2,
    'and two spellings of one name are offered as a possible duplicate',
    group && group.map((v) => v.name).join(' / '));

  // Every duplicate offered has to be mergeable, which means every vendor in
  // the group has to belong to the caller. Grouping across advisors offers a
  // merge that would quietly move nothing.
  const everyGroupIsMine = (vlist.data?.stats?.possibleDuplicates || []).every((g) =>
    g.every((v) => (vlist.data.vendors.find((x) => x.id === v.id) || {}).user_id
      === (vlist.data.vendors.find((x) => x.id === g[0].id) || {}).user_id));
  check(everyGroupIsMine, 'and a group never spans two advisors');

  const keep = group.find((v) => v.trips === 1) || group[0];
  const merged = await call(advisor, 'POST', '/api/vendors/merge', {
    keep: keep.id, drop: group.filter((v) => v.id !== keep.id).map((v) => v.id),
  });
  check(merged.data?.reservationsMoved >= 1, 'merging moves the reservations',
    JSON.stringify(merged.data));

  // Searched on the full stamped name rather than "Kestrel": another section
  // creates its own vendor, and a query loose enough to catch it turns a
  // passing assertion into a puzzle.
  const afterMerge = await call(advisor, 'GET',
    `/api/bookings?q=${encodeURIComponent(`Kestrel Cruises ${stamp}`)}`);
  const suppliers = new Set((afterMerge.data?.bookings || []).map((b) => b.supplier));
  check(suppliers.size === 1,
    'and rewrites the name on them, so a report stops splitting', [...suppliers].join(' / '));

  // ----------------------------------------------------- the vendors hub --
  step('The vendor directory');

  const starred = await call(advisor, 'POST', `/api/vendors/${keep.id}/favourite`,
    { favourite: true });
  check(starred.status === 200, 'a vendor can be starred', `status ${starred.status}`);

  const hub = await call(advisor, 'GET', '/api/vendors');
  check((hub.data?.categories || []).includes('Cruise Lines'),
    'the hub offers a fixed set of categories to shelve them under');
  check(hub.data?.stats?.favourites >= 1, 'and counts what is starred',
    `${hub.data?.stats?.favourites}`);

  // The bug this test exists for. The star has its own endpoint; writing it
  // from the full save cleared it every time a vendor was edited, because the
  // edit form has no star field on it.
  await call(advisor, 'PUT', `/api/vendors/${keep.id}`, {
    name: keep.name, finalDays: 90, category: 'Cruise Lines',
    bdmName: 'Dana Reyes', bdmEmail: 'dana@example.com',
    signupUrl: 'https://example.com/signup', accountNumber: 'AG-4471',
  });
  const afterEdit = await call(advisor, 'GET', '/api/vendors');
  const edited = (afterEdit.data?.vendors || []).find((v) => v.id === keep.id);
  check(Boolean(edited?.favourite), 'and editing the vendor does not quietly unstar it');
  check(edited?.category === 'Cruise Lines' && edited?.bdm_name === 'Dana Reyes',
    'the manager and the shelf are kept', `${edited?.category} / ${edited?.bdm_name}`);
  check(edited?.account_number === 'AG-4471', 'along with the agency account number');

  // A link in a directory gets clicked without being read.
  await call(advisor, 'PUT', `/api/vendors/${keep.id}`, {
    name: keep.name, portalUrl: 'javascript:alert(1)',
  });
  const afterBadUrl = await call(advisor, 'GET', '/api/vendors');
  check(!(afterBadUrl.data?.vendors || []).find((v) => v.id === keep.id)?.portal_url,
    'a link that is not http is refused rather than stored');

  const junkCategory = await call(advisor, 'PUT', `/api/vendors/${keep.id}`, {
    name: keep.name, category: 'Made up shelf',
  });
  const afterJunk = (await call(advisor, 'GET', '/api/vendors')).data?.vendors
    ?.find((v) => v.id === keep.id);
  check(junkCategory.status === 200 && !afterJunk?.category,
    'an unknown category is dropped rather than creating a new shelf');

  const notMineStar = await call(admin, 'POST', `/api/vendors/${keep.id}/favourite`,
    { favourite: true });
  check(notMineStar.status === 404, 'and one advisor cannot star another advisor\'s vendor',
    `status ${notMineStar.status}`);

  // A supplier list pasted straight out of a partner directory: headings and
  // the names under them, in the order they come off the page.
  const pasted = [
    'Favorite Suppliers', `Azamara ${stamp}`, `Collette ${stamp}`,
    'Cruise Lines', `Azamara ${stamp}`, `Seabourn ${stamp}`,
    'Escorted Tours', `Collette ${stamp}`, `Tauck ${stamp}`,
    'FIT', `Collette ${stamp}`,
  ].join('\n');

  // Importing is an owner's job, so these run as the admin. The advisor is
  // used below to prove the endpoint refuses them.
  const dry = await call(admin, 'POST', '/api/vendors/import', { text: pasted });
  check(dry.data?.add === 4, 'a pasted supplier list is read into vendors',
    `${dry.data?.add} to add`);
  check(dry.data?.preview === true && dry.status === 200,
    'and nothing is written until it is asked for');

  const ran = await call(admin, 'POST', '/api/vendors/import', { text: pasted, commit: true });
  check(ran.data?.added === 4, 'then the import adds them', `${ran.data?.added} added`);

  // The directory answers with at most a capped number of vendors and says
  // when it cut the list. On a book big enough to be truncated the four just
  // imported may not be in the answer at all, which failed this block for
  // reasons that had nothing to do with importing. Ask about them by name.
  const listed = await call(admin, 'GET', `/api/vendors?q=${encodeURIComponent(stamp)}`);
  check(listed.data?.truncated !== true, 'and a search for them is not cut short',
    'the vendor search came back truncated');
  const byName = new Map((listed.data?.vendors || []).map((v) => [v.name, v]));
  check(byName.get(`Seabourn ${stamp}`)?.category === 'Cruise Lines',
    'each filed under the heading it sat beneath');

  // Imported vendors were the one thing this suite created and never removed,
  // and two and a half thousand of them had piled up in the local database.
  for (const v of byName.values()) {
    cleanup(`the imported vendor ${v.name}`,
      () => call(admin, 'DELETE', `/api/vendors/${v.id}`));
  }
  // The favourites block comes first on those pages and carries no category,
  // so the real one arrives on a second sighting. Taking only the first left
  // every starred supplier uncategorised.
  check(byName.get(`Azamara ${stamp}`)?.favourite
    && byName.get(`Azamara ${stamp}`)?.category === 'Cruise Lines',
    'a starred supplier keeps its star and still gets its category',
    `${byName.get(`Azamara ${stamp}`)?.favourite} / ${byName.get(`Azamara ${stamp}`)?.category}`);
  check(byName.get(`Collette ${stamp}`)?.category === 'Escorted Tours',
    'a supplier under several headings is filed under the first');

  // Pasting the same page twice is what somebody does when they are not sure
  // it worked the first time.
  const again = await call(admin, 'POST', '/api/vendors/import', { text: pasted, commit: true });
  check(again.data?.added === 0, 'importing the same list twice adds nothing',
    `${again.data?.added} added`);

  const multi = [
    'Cruise Lines', `Celebrity ${stamp}`,
    'Expedition Experiences & Yacht', `Celebrity ${stamp}`,
  ].join('\n');
  await call(admin, 'POST', '/api/vendors/import', { text: multi, commit: true });
  const shelved = (await call(admin, 'GET', `/api/vendors?q=${encodeURIComponent(stamp)}`))
    .data?.vendors?.find((v) => v.name === `Celebrity ${stamp}`);
  if (shelved) {
    cleanup('the twice-shelved vendor',
      () => call(admin, 'DELETE', `/api/vendors/${shelved.id}`));
  }
  check(JSON.parse(shelved?.categories_json || '[]').length === 2,
    'a pasted name under two headings is shelved under both, not just the first',
    shelved?.categories_json);

  // A hidden button is not a permission. The endpoint has to refuse.
  const notAllowed = await call(advisor, 'POST', '/api/vendors/import', {
    text: 'Cruise Lines\nSomething Line', commit: true,
  });
  check(notAllowed.status === 403, 'an advisor cannot import a supplier list',
    `status ${notAllowed.status}`);

  const junk = await call(admin, 'POST', '/api/vendors/import', { text: '   ' });
  check(junk.status === 400, 'an empty paste is refused', `status ${junk.status}`);

  // A partner directory export: a row per supplier, with everything on it.
  const exported = await call(admin, 'POST', '/api/vendors/import', {
    commit: true,
    rows: [
      {
        name: `Royal Caribbean ${stamp}`, status: 'Preferred', category: 'Cruise Lines, Expedition Experiences & Yacht',
        travelTypes: 'Cruise', budget: 'Moderate', commission: '16% Cruise, 10% Insurance',
        contacts: 'CP Star Desk: 1-877-202-1530\nReservations: 800-327-6700',
        bookingInstructions: 'Use your number &amp; the HO number as secondary',
        registrationInstructions: 'Step one&nbsp;\nStep two',
        bdm: '\nAndrea Loyola - BDM - Southeast Region\n305-468-2389\naloyola@example.com\n',
        login: 'someuser', notes: 'Preferred partner',
      },
      { name: `Aruba Tourism ${stamp}`, category: 'Tourism Boards' },
    ],
  });
  check(exported.data?.added === 1, 'a directory export imports a row per supplier',
    `${exported.data?.added} added`);
  check(exported.data?.skipped === 1, 'and leaves tourism boards out, as asked',
    `${exported.data?.skipped} skipped`);

  // By name, not by scanning the directory: it answers with at most a capped
  // number of vendors, so on a big book the row just imported may not be in
  // the answer at all.
  const rich = (await call(admin, 'GET', `/api/vendors?q=${encodeURIComponent(stamp)}`))
    .data?.vendors?.find((v) => v.name === `Royal Caribbean ${stamp}`);
  if (rich) {
    cleanup('the imported directory row',
      () => call(admin, 'DELETE', `/api/vendors/${rich.id}`));
  }
  check(rich?.category === 'Cruise Lines',
    'the first of several categories is the primary one', rich?.category);
  // Thirty-five of the partner directory's suppliers sit on more than one
  // shelf. Keeping only the first hid them from every category but one.
  check(JSON.parse(rich?.categories_json || '[]').join(', ')
    === 'Cruise Lines, Expedition Experiences & Yacht',
    'and every category it is listed under is kept',
    rich?.categories_json);
  check(rich?.partner_status === 'Preferred' && rich?.budget_category === 'Moderate',
    'standing and price bracket come across');
  const desks = JSON.parse(rich?.phones_json || '[]');
  check(desks.length === 2 && desks[0].label === 'CP Star Desk',
    'each sales desk keeps the name it was listed under', `${desks.length} desk(s)`);
  check(rich?.bdm_name === 'Andrea Loyola' && rich?.bdm_email === 'aloyola@example.com',
    'the manager is picked out of a free text block');
  // These fields were typed into a rich text box and exported as stored.
  check(rich?.booking_instructions === 'Use your number & the HO number as secondary',
    'HTML entities are decoded rather than shown literally', rich?.booking_instructions);
  // clean() collapses every newline into a space, which is right for a name
  // and wrong for a numbered list of registration steps.
  check(rich?.registration_instructions === 'Step one\nStep two',
    'and paragraphs survive being saved', JSON.stringify(rich?.registration_instructions));

  // A vendor typed in by hand, with everything the directory holds.
  const made = await call(advisor, 'POST', '/api/vendors', {
    name: `Windstar ${stamp}`, category: 'Cruise Lines',
    phones: [{ label: 'Reservations', number: '800-258-7245' },
             { label: 'Groups', number: '800-258-7245 x2' }],
    portalUrl: 'https://advisor.example.com', website: 'https://client.example.com',
    bdmName: 'Alex Chen', bdmEmail: 'alex@example.com', bdmPhone: '206-555-0134',
    accountNumber: 'CTT-9931',
    commissionStructure: '16% on cruise fare, 10% on air. Bonus paid quarterly.',
    registrationInstructions: 'Register at the advisor site, then email your CLIA number.',
  });
  check(made.status === 200 && made.data?.id,
    'a vendor can be added by hand, without booking one first', `status ${made.status}`);

  const withNew = await call(advisor, 'GET', '/api/vendors');
  const fresh = (withNew.data?.vendors || []).find((v) => v.id === made.data.id);
  check(Boolean(fresh), 'and appears in the list straight away');
  check(fresh?.commission_structure?.startsWith('16%')
    && fresh?.registration_instructions?.includes('CLIA'),
    'commission structure and registration instructions are kept as written');
  const phones = JSON.parse(fresh?.phones_json || '[]');
  check(phones.length === 2 && phones[0].number === '800-258-7245',
    'several phone numbers survive the round trip', `${phones.length} number(s)`);
  check(fresh?.portal_url && fresh?.website,
    'the advisor site and the client site are two separate links');

  const dupe = await call(advisor, 'POST', '/api/vendors', { name: `windstar ${stamp}` });
  check(dupe.status === 400, 'the same name twice is refused, whatever the casing',
    `status ${dupe.status}`);

  // Deleting the directory entry must not take the trips with it.
  await call(advisor, 'POST', '/api/bookings', {
    clientName: `Delete Check ${stamp}`, supplier: `Windstar ${stamp}`,
    productName: 'Test', status: 'booked', departDate: isoDay(300),
    gross: '2000', commission: '300',
  });
  const gone = await call(advisor, 'DELETE', `/api/vendors/${made.data.id}`);
  check(gone.status === 200, 'a vendor can be deleted', `status ${gone.status}`);
  const kept = await call(advisor, 'GET', '/api/bookings');
  const survivor = (kept.data?.bookings || []).find((b) => b.client_name === `Delete Check ${stamp}`);
  check(Boolean(survivor), 'and its reservations are kept, not deleted with it');
  check(survivor?.supplier === `Windstar ${stamp}` && !survivor?.vendor_id,
    'still naming the supplier they were sold under, with only the link cut',
    `${survivor?.supplier} / ${survivor?.vendor_id}`);

  // Terms turn a departure into a deadline, which is the only reason an
  // imported reservation is any use.
  await call(advisor, 'PUT', `/api/vendors/${keep.id}`, { name: keep.name, finalDays: 90 });
  const dates = await call(advisor, 'GET', '/api/vendors/suggest-dates');
  const forMine = (dates.data?.suggestions || []).filter((sg) => sg.vendor === keep.name);
  check(forMine.length >= 1, 'a vendor with terms suggests a final payment date',
    `${forMine.length} suggestion(s)`);
  const one = forMine[0];
  const expected = new Date(Date.parse(`${one.departDate}T00:00:00Z`) - 90 * 86400000)
    .toISOString().slice(0, 10);
  check(one.suggested === expected, 'worked back from departure by the vendor\'s own terms',
    `${one.suggested} vs ${expected}`);

  // Suggested, never applied. A vendor's standard terms are a good guess, and
  // a date written in by software cannot be told apart afterwards from one an
  // advisor confirmed.
  const stillEmpty = await call(advisor, 'GET', `/api/bookings/${one.id}`);
  check(!stillEmpty.data?.booking?.final_payment_due,
    'and nothing is written until it is applied');

  const notYourVendor = await call(admin, 'PUT', `/api/vendors/${keep.id}`,
    { name: 'Hijacked', finalDays: 1 });
  check(notYourVendor.status === 404, 'an owner cannot rewrite an associate\'s vendor',
    `status ${notYourVendor.status}`);
  }

  // ------------------------------------------------------------- catalog ----
  {
  step('The sailing catalog');

  const lines = await call(advisor, 'GET', '/api/catalog/lines');
  check(lines.status === 200, 'the catalog answers', `status ${lines.status}`);

  if (!lines.data?.ready) {
    skip('the sailing catalog',
      'nothing imported here; set CRUISEFEED_KEY and let the cron run to exercise it');
  } else {
    const line = lines.data.lines[0];
    check(line && line.name, 'with cruise lines that have upcoming sailings', line && line.name);

    const ships = await call(advisor, 'GET', `/api/catalog/ships?line=${encodeURIComponent(line.name)}`);
    check((ships.data?.ships || []).length > 0, 'and ships for a line', `${ships.data?.ships?.length}`);

    const shipName = ships.data.ships[0].name;
    const dates = await call(advisor, 'GET',
      `/api/catalog/dates?ship=${encodeURIComponent(shipName)}&line=${encodeURIComponent(line.name)}`);
    const sailing = (dates.data?.dates || [])[0];
    check(sailing && sailing.depart_date && sailing.return_date,
      'and departures with a return date, which is what a pasted list never has',
      sailing && `${sailing.depart_date} to ${sailing.return_date}`);

    // The reason the catalog is here: a reservation with a departure and no
    // return, exactly as an import leaves it.
    const half = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Catalog Client ${stamp}`, supplier: line.name,
      productName: sailing.ship, departDate: sailing.depart_date, status: 'booked',
    });
    const halfId = half.data?.booking?.id;
    if (halfId) cleanup('the catalog reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${halfId}`));
    check(half.data?.booking && !half.data.booking.return_date,
      'a reservation can be created with no return date');

    const suggested = await call(advisor, 'GET', '/api/catalog/suggest');
    const mine = (suggested.data?.suggestions || []).find((x) => x.id === halfId);
    check(mine && mine.fills.returnDate === sailing.return_date,
      'the catalog offers the return date it knows', mine && JSON.stringify(mine.fills));

    const applied = await call(advisor, 'POST', '/api/catalog/apply', { ids: [halfId] });
    check(applied.data?.changed === 1, 'applying it fills the gap', JSON.stringify(applied.data));
    const filled = await call(advisor, 'GET', `/api/bookings/${halfId}`);
    check(filled.data?.booking?.return_date === sailing.return_date,
      'and the reservation now carries a real return date',
      filled.data?.booking?.return_date);

    // Never overwrite. A date an advisor typed outranks anything a feed says,
    // and a tool that quietly disagrees with its user stops being used.
    await call(advisor, 'POST', `/api/bookings/${halfId}/quick`, { returnDate: isoDay(400) });
    const again = await call(advisor, 'POST', '/api/catalog/apply', { ids: [halfId] });
    const untouched = await call(advisor, 'GET', `/api/bookings/${halfId}`);
    check(untouched.data?.booking?.return_date === isoDay(400),
      'and a date already there is never overwritten',
      `${untouched.data?.booking?.return_date} after ${JSON.stringify(again.data)}`);
  }

  const adminOnly = await call(advisor, 'GET', '/api/admin/catalog');
  check(adminOnly.status === 403 || adminOnly.status === 401,
    'the import status is for owners only', `status ${adminOnly.status}`);
  const asOwner = await call(admin, 'GET', '/api/admin/catalog');
  check(asOwner.status === 200 && typeof asOwner.data?.rows === 'number',
    'who see how many rows are actually stored, not how many were sent',
    JSON.stringify({ rows: asOwner.data?.rows, configured: asOwner.data?.configured }));
  }

  // ----------------------------------------------------------- importing ----
  step('Bringing an existing book across');

  const pasted = [
    'CLIENT\tBOOKING AGENT\tVENDOR\tDEPARTURE DATE\tCONFIRMATION',
    `Montoro, Manuel\tB Beasley\tMargaritaville at Sea (Margaritaville at Sea Beachcomber)\t3/11/27\tIMP1-${stamp}`,
    `Gallo, James\tB Beasley\tCelebrity Cruises - Ocean (Celebrity Ascent)\t9/17/27\tIMP2-${stamp}`,
    `\tB Beasley\tNobody Cruises\t1/1/27\tIMP3-${stamp}`,
    `Bearse, Charlotte\tB Beasley\tVirgin Voyages\tnot a date\tIMP4-${stamp}`,
  ].join('\n');

  const pv = await call(advisor, 'POST', '/api/import/preview', { text: pasted });
  check(pv.status === 200 && pv.data?.skippedHeader === true,
    'a heading row is recognised and not imported as data', pv.data?.skippedHeader);
  check(pv.data?.columns?.[1] === '',
    'a column that means nothing here is ignored rather than guessed at',
    JSON.stringify(pv.data?.columns));

  const first = pv.data.rows[0];
  check(first.clientName === 'Manuel Montoro',
    'surname first is turned around, since every screen afterwards reads it', first.clientName);
  check(first.supplier === 'Margaritaville at Sea' && first.productName === 'Beachcomber',
    'the vendor and the ship are separated, and the vendor is not repeated',
    `${first.supplier} / ${first.productName}`);
  check(first.departDate === '2027-03-11',
    'a two digit year is read as this century, not the last', first.departDate);

  check(pv.data.rows[2].problems.length === 1,
    'a row with no client is flagged rather than dropped in silence',
    JSON.stringify(pv.data.rows[2].problems));
  check(/could not read the date/.test(pv.data.rows[3].problems[0] || ''),
    'and so is a date nobody can parse', pv.data.rows[3].problems[0]);
  check(pv.data.summary.ready === 2 && pv.data.summary.problems === 2,
    'the preview counts what will actually happen', JSON.stringify(pv.data.summary));

  const ran = await call(advisor, 'POST', '/api/import/reservations', { text: pasted });
  check(ran.data?.created === 2 && ran.data?.skipped === 2,
    'the import creates the sound rows and skips the rest', JSON.stringify(ran.data));

  const imported = await call(advisor, 'GET', `/api/bookings?q=IMP1-${stamp}`);
  const madeIt = (imported.data?.bookings || [])[0];
  check(madeIt && madeIt.client_name === 'Manuel Montoro', 'and they are real reservations');
  for (const b of imported.data?.bookings || []) {
    cleanup('an imported reservation', () => call(advisor, 'DELETE', `/api/bookings/${b.id}`));
  }
  const alsoImported = await call(advisor, 'GET', `/api/bookings?q=IMP2-${stamp}`);
  for (const b of alsoImported.data?.bookings || []) {
    cleanup('an imported reservation', () => call(advisor, 'DELETE', `/api/bookings/${b.id}`));
  }

  // Pasting the same list twice is the single likeliest mistake, since the
  // source is paged and it is easy to lose your place.
  const twice = await call(advisor, 'POST', '/api/import/reservations', { text: pasted });
  check(twice.data?.created === 0 && twice.data?.skipped === 4,
    'running the same paste again imports nothing', JSON.stringify(twice.data));

  const clientMade = await call(advisor, 'GET', '/api/clients?q=Manuel%20Montoro');
  check((clientMade.data?.clients || []).some((c) => c.name === 'Manuel Montoro'),
    'and importing creates the client records too');

  // ------------------------------------------------------------- chasing ----
  // Braced, so the names inside belong to this section. Everything above
  // shares one function scope, and adding a section has twice collided with a
  // `const` three hundred lines away. New sections get a block.
  {
  step('Chasing a client about a payment');

  const chaseTrip = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Chase Client ${stamp}`, supplier: 'Cunard', status: 'booked',
    departDate: isoDay(90), gross: '6000', deposit: '600',
    depositDue: isoDay(5), finalPaymentDue: isoDay(45),
  });
  const chaseId = chaseTrip.data?.booking?.id;
  if (chaseId) cleanup('the chase reservation', () => call(advisor, 'DELETE', `/api/bookings/${chaseId}`));
  await call(advisor, 'POST', `/api/bookings/${chaseId}/schedule`, {});
  const chaseRecord = await call(advisor, 'GET', `/api/bookings/${chaseId}/record`);
  const chasePayment = (chaseRecord.data?.payments || []).find((p) => p.kind === 'final' && p.payment_class === 'hard');
  check(chasePayment, 'there is a balance to chase');

  // Without an address the answer is the fix, not a failure: the email goes on
  // the client record, and saying so is more use than "send failed".
  const noEmail = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  check(noEmail.data?.problem && noEmail.data?.clientId,
    'a client with no email is named, with somewhere to go and fix it',
    noEmail.data?.problem);
  const refusedSend = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, {});
  check(refusedSend.status === 400, 'and sending is refused rather than half done',
    `status ${refusedSend.status}`);

  const clients2 = await call(advisor, 'GET', `/api/clients?q=${encodeURIComponent(`Chase Client ${stamp}`)}`);
  const chaseClient = (clients2.data?.clients || [])[0];
  await call(advisor, 'PUT', `/api/clients/${chaseClient.id}`, {
    name: `Chase Client ${stamp}`, email: `chase-${stamp}@example.com`,
  });

  const ready = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  check(ready.data?.to === `chase-${stamp}@example.com` && !ready.data.problem,
    'once an address is on file the preview is ready', ready.data?.to);
  check(ready.data?.details?.hard === true && ready.data.details.amountCents === 540000,
    'and it carries the real balance and says it is a vendor deadline',
    JSON.stringify({ hard: ready.data?.details?.hard, amount: ready.data?.details?.amountCents }));
  check(ready.data?.details?.replyTo === ADVISOR_EMAIL,
    'replies come back to the advisor, not to the software', ready.data?.details?.replyTo);
  check(ready.data?.alreadySent === null, 'and nothing has been sent yet');

  // A send that fails must not record a reminder. An advisor who believes a
  // client was chased when they were not is worse off than one who knows they
  // were not, and this is the case that happens: email misconfigured.
  const attempted = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, {});
  const after = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  if (attempted.status === 200) {
    check(after.data?.alreadySent, 'a sent reminder is remembered', after.data?.alreadySent);
    check(after.data?.sentCount === 1, 'and counted', after.data?.sentCount);
  } else {
    check(after.data?.alreadySent === null,
      'a send that failed records nothing, so nobody thinks a client was chased',
      `send said ${attempted.status}, alreadySent ${after.data?.alreadySent}`);
    console.log('        (email is not configured here, so the send itself cannot be exercised)');
  }

  // Chasing money that has arrived is the kind of message that loses a client.
  const paidOne = (chaseRecord.data?.payments || []).find((p) => p.kind === 'deposit');
  await call(advisor, 'POST', `/api/payments/${paidOne.id}/paid`, {});
  const chasePaid = await call(advisor, 'POST', `/api/payments/${paidOne.id}/remind`, { preview: true });
  check(chasePaid.status === 400, 'a payment already posted cannot be chased',
    `status ${chasePaid.status}`);

  const notYourPayment = await call(admin, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  check(notYourPayment.status === 404, 'and an owner cannot chase on an associate\'s behalf',
    `status ${notYourPayment.status}`);
  }

  // -------------------------------------------------- filling in the gaps ---
  step('Filling in what an import could not carry');

  const bare = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Bare Import ${stamp}`, supplier: 'Carnival', confirmationNumber: `BARE-${stamp}`,
    departDate: isoDay(150), status: 'booked',
  });
  const bareId = bare.data?.booking?.id;
  if (bareId) cleanup('the bare reservation', () => call(advisor, 'DELETE', `/api/bookings/${bareId}`));
  check(bare.data?.booking?.gross_cents === 0 && !bare.data?.booking?.final_payment_due,
    'an imported reservation starts with no cost and no deadline');

  // The whole point of a partial update: touch one field, leave the rest.
  const one = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`, { gross: '4250.00' });
  check(one.data?.booking?.gross_cents === 425000, 'one field can be set on its own',
    one.data?.booking?.gross_cents);
  check(one.data?.booking?.client_name === `Bare Import ${stamp}`
        && one.data.booking.supplier === 'Carnival'
        && one.data.booking.depart_date === isoDay(150),
    'and everything it was not told about is left alone',
    JSON.stringify({ n: one.data?.booking?.client_name, s: one.data?.booking?.supplier }));

  const dated = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { finalPaymentDue: isoDay(60) });
  check(dated.data?.booking?.final_payment_due === isoDay(60)
        && dated.data.booking.gross_cents === 425000,
    'a second field does not undo the first', dated.data?.booking?.final_payment_due);

  // The same rules the full dialog enforces, checked against what would be
  // stored rather than only what was sent.
  const tooMuch = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { commission: '99999.00' });
  check(tooMuch.status === 400,
    'commission above the trip cost is refused even when the cost was not sent',
    `status ${tooMuch.status}`);

  const backwards = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { returnDate: isoDay(140) });
  check(backwards.status === 400, 'and a return before the departure already on file',
    `status ${backwards.status}`);

  const empty = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`, { nonsense: 1 });
  check(empty.status === 400, 'a request that names no known field changes nothing',
    `status ${empty.status}`);

  const notYours = await call(admin, 'POST', `/api/bookings/${bareId}/quick`, { gross: '1.00' });
  check(notYours.status === 404, 'and an owner cannot quick edit an associate\'s reservation',
    `status ${notYours.status}`);

  // ---------------------------------------------------- the client record ---
  step('One client on one screen');

  const who = `Repeat Client ${stamp}`;
  const past1 = await call(advisor, 'POST', '/api/bookings', {
    clientName: who, supplier: 'Carnival', status: 'travelled',
    departDate: isoDay(-400), returnDate: isoDay(-393), gross: '3000', commission: '300',
  });
  const past2 = await call(advisor, 'POST', '/api/bookings', {
    clientName: who, supplier: 'Oceania', status: 'travelled',
    departDate: isoDay(-200), returnDate: isoDay(-190), gross: '5000', commission: '500',
  });
  const dead = await call(advisor, 'POST', '/api/bookings', {
    clientName: who, supplier: 'Oceania', status: 'cancelled',
    departDate: isoDay(-100), gross: '9000', commission: '900',
  });
  const ahead = await call(advisor, 'POST', '/api/bookings', {
    clientName: who, supplier: 'Virgin Voyages', status: 'booked',
    departDate: isoDay(120), returnDate: isoDay(127), gross: '4000', commission: '400',
  });
  for (const r of [past1, past2, dead, ahead]) {
    if (r.data?.booking?.id) cleanup('a client reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
  }

  const clientCredit = await call(advisor, 'POST', '/api/credits',
    { clientName: who, vendor: 'Carnival', amount: '150', expiresOn: isoDay(200) });
  if (clientCredit.data?.credit?.id) cleanup('the client credit', () =>
    call(advisor, 'DELETE', `/api/credits/${clientCredit.data.credit.id}`));

  // A client record appears as a side effect of taking a reservation, so
  // nobody has to keep a list of people before they can do the work.
  const clientList = await call(advisor, 'GET', `/api/clients?q=${encodeURIComponent(who)}`);
  const madeClient = (clientList.data?.clients || []).find((c) => c.name === who);
  check(madeClient, 'booking someone creates their client record', madeClient && madeClient.id);
  check(madeClient && madeClient.trips === 3 && madeClient.lifetime_cents === 1200000,
    'with trips and lifetime value counted on the list too',
    madeClient && `${madeClient.trips} trips, ${madeClient.lifetime_cents}`);

  // Contact details are what turn "worth a call" into a call.
  const detailed = await call(advisor, 'PUT', `/api/clients/${madeClient.id}`, {
    name: who, phone: '+1 555 0142', email: 'repeat@example.com', notes: 'Prefers a balcony.',
  });
  check(detailed.data?.client?.phone === '+1 555 0142', 'a phone number can be recorded',
    detailed.data?.client?.phone);

  const pinnedClient = await call(advisor, 'PUT', `/api/clients/${madeClient.id}`, { pinned: true });
  check(pinnedClient.status === 200, 'and a client can be pinned');
  const onlyPinned = await call(advisor, 'GET', '/api/clients?pinned=1');
  check((onlyPinned.data?.clients || []).some((c) => c.id === madeClient.id),
    'which filters the list');

  const notTheirClient = await call(admin, 'PUT', `/api/clients/${madeClient.id}`, { pinned: false });
  check(notTheirClient.status === 404, 'an owner cannot pin an associate\'s client',
    `status ${notTheirClient.status}`);

  const rec2 = await call(advisor, 'GET', `/api/client?id=${madeClient.id}`);
  const cl = rec2.data?.client;
  check(rec2.status === 200 && cl?.name === who, 'the client record loads', `status ${rec2.status}`);

  // A cancelled trip is not lifetime value. Counting it would flatter every
  // client who ever changed their mind.
  check(cl.lifetimeCents === 1200000 && cl.trips === 3,
    'lifetime value counts booked and travelled, not cancelled',
    `${cl.lifetimeCents} over ${cl.trips} trips`);
  check(cl.commissionCents === 120000, 'and commission with it', cl.commissionCents);
  check(cl.nextDeparture === isoDay(120),
    'the next departure is the soonest one still ahead', cl.nextDeparture);
  check(cl.lastTravelled === isoDay(-190),
    'and last travelled is the most recent one behind', cl.lastTravelled);
  check(cl.creditCents === 15000, 'unused credit is carried on the record', cl.creditCents);
  check(cl.vendors.length === 3, 'along with every vendor they have used', cl.vendors.join(', '));

  const renamed = `Renamed Client ${stamp}`;
  await call(advisor, 'PUT', `/api/clients/${madeClient.id}`, { name: renamed });
  const afterRename = await call(advisor, 'GET', `/api/client?id=${madeClient.id}`);
  check(afterRename.data?.client?.name === renamed && afterRename.data.bookings.length === 4,
    'renaming a client carries their reservations along',
    `${afterRename.data?.client?.name}, ${afterRename.data?.bookings?.length} trips`);
  check((afterRename.data?.bookings || []).every((b) => b.client_name === renamed),
    'and the name on each reservation follows');

  const noSuch = await call(advisor, 'GET', '/api/client?name=Nobody%20At%20All');
  check(noSuch.status === 404, 'a client with no trips is a 404', `status ${noSuch.status}`);

  // Same boundary as everywhere else: an associate must not read the owner's
  // client through a name they can guess.
  const ownerClient = await call(admin, 'POST', '/api/bookings', {
    clientName: `Owner Only ${stamp}`, supplier: 'Cunard', status: 'travelled',
    departDate: isoDay(-30), returnDate: isoDay(-20), gross: '7000', commission: '700',
  });
  if (ownerClient.data?.booking?.id) cleanup('the owner client reservation', () =>
    call(admin, 'DELETE', `/api/bookings/${ownerClient.data.booking.id}`));
  const peek = await call(advisor, 'GET', `/api/client?name=${encodeURIComponent(`Owner Only ${stamp}`)}`);
  check(peek.status === 404, 'and an associate cannot read the owner\'s client by name',
    `status ${peek.status}`);

  // -------------------------------------------------------- commission ------
  step('Commission the agency is owed');

  // Three trips: one home a fortnight, one home four months, one not yet gone.
  // The point of the report is that they are not the same problem.
  const recent = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Comm Recent ${stamp}`, supplier: 'Carnival', status: 'travelled',
    departDate: isoDay(-21), returnDate: isoDay(-14), gross: '4000', commission: '400',
  });
  const stale = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Comm Stale ${stamp}`, supplier: 'Carnival', status: 'travelled',
    departDate: isoDay(-130), returnDate: isoDay(-120), gross: '6000', commission: '600',
  });
  const future = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Comm Future ${stamp}`, supplier: 'Oceania', status: 'booked',
    departDate: isoDay(60), returnDate: isoDay(70), gross: '9000', commission: '900',
  });
  for (const r of [recent, stale, future]) {
    if (r.data?.booking?.id) cleanup('a commission reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
  }

  const comm = await call(advisor, 'GET', '/api/commissions');
  const find = (id) => (comm.data?.rows || []).find((r) => r.id === id);
  check(find(recent.data.booking.id)?.bucket === 'd30',
    'a trip home a fortnight ago is inside normal turnaround',
    find(recent.data.booking.id)?.bucket);
  check(find(stale.data.booking.id)?.bucket === 'older',
    'one home four months ago is over ninety days',
    find(stale.data.booking.id)?.bucket);
  check(find(future.data.booking.id)?.bucket === 'travelling',
    'and one that has not departed is not late at all',
    find(future.data.booking.id)?.bucket);

  // The distinction the whole report rests on: everything eventually due
  // versus what can actually be claimed today.
  check(comm.data.totals.owedCents - comm.data.totals.claimableCents >= 90000,
    'claimable excludes trips that have not happened yet',
    `${comm.data.totals.owedCents} owed, ${comm.data.totals.claimableCents} claimable`);

  const carnival = (comm.data?.byVendor || []).find((v) => v.vendor === 'Carnival');
  check(carnival && carnival.cents >= 100000, 'and it totals by vendor',
    carnival && carnival.cents);

  // Chasing happens one vendor statement at a time, so the update is a batch.
  const marked = await call(advisor, 'POST', '/api/commissions/status', {
    ids: [recent.data.booking.id, stale.data.booking.id], status: 'invoiced',
  });
  check(marked.data?.changed === 2, 'several move to invoiced at once', marked.data?.changed);

  // An owner may read an associate's commission but not declare it paid, and
  // the response says how many actually moved rather than how many were asked
  // for, so a silent no-op is impossible.
  const notTheirs = await call(admin, 'POST', '/api/commissions/status', {
    ids: [recent.data.booking.id], status: 'paid',
  });
  check(notTheirs.data?.changed === 0 && notTheirs.data?.requested === 1,
    'an owner cannot mark an associate\'s commission paid',
    JSON.stringify(notTheirs.data));

  const paidOff = await call(advisor, 'POST', '/api/commissions/status', {
    ids: [stale.data.booking.id], status: 'paid',
  });
  check(paidOff.data?.changed === 1, 'and marking one paid works');
  const after = await call(advisor, 'GET', '/api/commissions');
  check(!(after.data?.rows || []).some((r) => r.id === stale.data.booking.id
    && r.commission_status !== 'paid'), 'after which it stops being owed');
  check(after.data.totals.lateCents < comm.data.totals.lateCents,
    'and the over ninety days figure falls',
    `${after.data.totals.lateCents} from ${comm.data.totals.lateCents}`);

  const badStatus = await call(advisor, 'POST', '/api/commissions/status',
    { ids: [recent.data.booking.id], status: 'nonsense' });
  check(badStatus.status === 400, 'an unknown status is refused rather than defaulted',
    `status ${badStatus.status}`);

  // -------------------------------------------------- travel on the diary --
  step('The calendar knows about the travel');

  const diary = await call(advisor, 'GET', '/api/calendar?days=365');
  const travel = diary.data?.travel || [];
  check(diary.status === 200, 'the calendar answers even with no CRM configured',
    `status ${diary.status}`);
  check(travel.some((e) => e.kind === 'departure'),
    'departures appear on it', `${travel.length} travel entr(ies)`);
  check(travel.some((e) => e.kind === 'payment' && e.amountCents > 0),
    'and so does money due, with the amount');
  check(travel.every((e) => e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date)),
    'each carrying a plain date rather than a timestamp');
  check(travel.every((e) => e.bookingId),
    'and linking back to the reservation it came from');
  // Sorted, because the page renders them in order under day headings and
  // sorting in two places is how the two disagree.
  const dates = travel.map((e) => e.date);
  check(dates.join() === [...dates].sort().join(), 'in date order');

  // ------------------------------------------- reading a real confirmation --
  step('An agent confirmation, as a vendor lays one out');

  // Taken from a real Margaritaville agent copy: two columns on the page, so
  // every line carries two labels and their values.
  const agentCopy = [
    'Angela Simic BOOKING ID: 54408822',
    'Departure Date: Nov 30, 2026 Return Date: Dec 05, 2026',
    'Itinerary: 5-Night Mexico Duo Stateroom Category: Partial View Balcony',
    'Ship: Margaritaville at Sea Islander Stateroom(s): 5235',
    'Departure Port: Port Tampa Bay Total Guests: 2',
    'Total Booking Amount: $ 1,976.80 Remaining Due: $ 0.00',
    'Advisor ID: 247345160 Fare Commission: $80.93',
    'Advisor Phone: 5617779911 Enhancement Commission: $107.70',
  ].join('\n');

  const readConf = await call(advisor, 'POST', '/api/import/confirmation', { text: agentCopy });
  const cf = readConf.data?.fields || {};
  check(readConf.status === 200, 'a two column confirmation is read', `status ${readConf.status}`);
  // The left column used to swallow the right, so only the first label on each
  // line was ever seen.
  check(cf.confirmationNumber === '54408822' && cf.returnDate === '2026-12-05',
    'both columns are read, not just the left one',
    `${cf.confirmationNumber} / ${cf.returnDate}`);
  check(cf.productName === 'Margaritaville at Sea Islander',
    'and a ship name is not cut in half by a label that looks like one', cf.productName);
  check(cf.cabin === '5235' && cf.cabinCategory === 'Partial View Balcony',
    'the cabin number and the category are different facts and both are kept',
    `${cf.cabin} / ${cf.cabinCategory}`);
  check(cf.gross === '1976.80', 'the total comes across', cf.gross);
  // Commission arrives in two parts on this document, which is the split the
  // reservation already holds.
  check(cf.commission === '80.93' && cf.commissionPackage === '107.70',
    'fare commission and enhancement commission are kept apart',
    `${cf.commission} / ${cf.commissionPackage}`);
  check(cf.clientName === 'Angela Simic',
    'and the guest printed at the top with no label at all is the client', cf.clientName);
  check(cf.travellers === 2, 'with the guest count read from a total', `${cf.travellers}`);

  // -------------------------------------------- a group that takes names --
  step('Putting your name down for a group trip');

  const signupGroup = await call(advisor, 'POST', '/api/groups', {
    name: `Parrothead ${stamp}`, groupCode: `ph-${stamp}`, vendor: 'Test Cruise Line',
    productName: 'Allure', destination: 'Caribbean', departDate: isoDay(200),
    returnDate: isoDay(207), cabinsHeld: 20, groupType: 'cruise',
    registrationOpen: true, registrationBlurb: 'Seven nights. Put your name down.',
  });
  const signupGroupId = signupGroup.data?.group?.id;
  check(Boolean(signupGroupId), 'a group can take names on a page of its own');
  cleanup('the group', () => call(advisor, 'DELETE', `/api/groups/${signupGroupId}`));

  // The code is a public web address now, so it has to mean one group across
  // every advisor, not one per book.
  const codeClash = await call(advisor, 'POST', '/api/groups', {
    name: 'Clashing', groupCode: `ph-${stamp}`,
  });
  check(codeClash.status === 400, 'and its code cannot be taken by another group',
    `status ${codeClash.status}`);

  // Codes handed out before uniqueness was enforced can still collide, and the
  // advisor cannot see it because the other group may be somebody else's. The
  // list says which of their own codes are shared so the page can flag them.
  const codeShareCheck = await call(advisor, 'GET', '/api/groups');
  check(Array.isArray(codeShareCheck.data.clashingCodes)
    && !codeShareCheck.data.clashingCodes.includes(`ph-${stamp}`),
    'and the list says which codes are shared, this one with nobody',
    JSON.stringify(codeShareCheck.data.clashingCodes));

  const publicPage = await call(null, 'GET', `/g/ph-${stamp}`);
  check(publicPage.status === 200, 'the page is public, with no session at all',
    `status ${publicPage.status}`);

  const signUp = await call(null, 'POST', `/g/ph-${stamp}`, {
    name: `Jimmy ${stamp}`, email: `jimmy-${stamp}@test.dev`, phone: '555-0180',
    party_size: '4', notes: 'Would like a balcony',
  });
  check(signUp.status === 200, 'somebody can put their name down', `status ${signUp.status}`);

  const noEmail = await call(null, 'POST', `/g/ph-${stamp}`, { name: 'No Email' });
  check(noEmail.status === 400, 'without an email there is no way to answer them',
    `status ${noEmail.status}`);

  // Answered as if it worked, so a bot learns nothing.
  const bot = await call(null, 'POST', `/g/ph-${stamp}`, {
    name: 'Bot', email: 'bot@spam.test', company_website: 'spam.example',
  });
  check(bot.status === 200, 'and a bot is thanked rather than told');

  const withNames = await call(advisor, 'GET', `/api/groups/${signupGroupId}`);
  const signups = withNames.data?.registrations || [];
  check(signups.length === 1, 'one name on the list, not the bot', `${signups.length}`);
  check(signups[0]?.party_size === 4 && signups[0]?.notes === 'Would like a balcony',
    'with what they said about it');

  // The point of the list: it turns into a reservation without retyping.
  const regBooked = await call(advisor, 'POST',
    `/api/groups/registrations/${signups[0].id}/book`);
  check(regBooked.status === 200 && regBooked.data?.bookingId,
    'and one click makes it a reservation in the group', `status ${regBooked.status}`);

  const afterBooking = await call(advisor, 'GET', `/api/groups/${signupGroupId}`);
  check(Boolean(afterBooking.data?.registrations?.[0]?.booking_id),
    'the name is marked as acted on rather than sitting there twice');
  check(afterBooking.data?.group?.cabins_sold === 1, 'and the group counts a cabin sold',
    `${afterBooking.data?.group?.cabins_sold}`);

  const bookedTwice = await call(advisor, 'POST',
    `/api/groups/registrations/${signups[0].id}/book`);
  check(bookedTwice.status === 400, 'booking the same name twice is refused',
    `status ${bookedTwice.status}`);

  // ------------------------------------------------ the mirrored catalog --
  step('Sailings borrowed from CruiseShoppers');

  // The fetch itself is not exercised here: it reaches another site, and a
  // check that fails when somebody else's Worker is slow is a check people
  // learn to ignore. What is checked is that it is an owner's job and that it
  // reports itself.
  const mirrorForbidden = await call(advisor, 'GET', '/api/admin/catalog-mirror');
  check(mirrorForbidden.status === 403, 'an advisor cannot drive the catalog import',
    `status ${mirrorForbidden.status}`);

  const mirror = await call(admin, 'GET', '/api/admin/catalog-mirror');
  check(mirror.status === 200 && mirror.data?.source?.includes('cruiseshoppers'),
    'the owner can see where the catalog comes from', mirror.data?.source);
  check(typeof mirror.data?.sailingsStored === 'number',
    'and how many sailings are actually stored', `${mirror.data?.sailingsStored}`);

  // ------------------------------------------- suggesting who to book for --
  step('The CRM knows them already');

  const suggest = await call(advisor, 'GET', '/api/clients?q=zz');
  check(Array.isArray(suggest.data?.fromCrm),
    'client search offers CRM contacts alongside the local ones',
    JSON.stringify(suggest.data?.fromCrm));

  // One letter matches most of a book, and suggesting all of it is the same
  // as suggesting nothing.
  const oneLetter = await call(advisor, 'GET', '/api/clients?q=a');
  check((oneLetter.data?.fromCrm || []).length === 0,
    'and does not reach for the CRM on a single letter');

  // A CRM contact carried onto a reservation makes a client record that is
  // already joined to the person the agency has been talking to, rather than
  // a second version of them with the same name.
  const linked = await call(advisor, 'POST', '/api/bookings', {
    clientName: `CRM Person ${stamp}`, ghlContactId: `crm-${stamp}`,
    supplier: 'Test Line', productName: 'Test', status: 'quoted',
    departDate: isoDay(200),
  });
  check(linked.data?.booking?.ghl_contact_id === `crm-${stamp}`,
    'a reservation keeps the contact it was made from',
    linked.data?.booking?.ghl_contact_id);
  check(Boolean(linked.data?.booking?.client_id),
    'and the client record it creates is linked to that contact');
  cleanup('the CRM-linked reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${linked.data.booking.id}`));

  // ------------------------------------------------ nothing fails quietly --
  step('A broken panel says so');

  const panelDash = await call(advisor, 'GET', '/api/dashboard');
  check(Array.isArray(panelDash.data?.failed), 'the dashboard reports which panels it could not build',
    JSON.stringify(panelDash.data?.failed));
  check(panelDash.data.failed.length === 0, 'and on a working system that list is empty',
    panelDash.data.failed.join(', '));
  // An empty panel and a panel that could not load look identical on screen,
  // and the empty one reads as "nothing to do today".
  check('tasks' in panelDash.data && 'welcome' in panelDash.data && 'insurance' in panelDash.data,
    'while still building every panel it can');

  // ------------------------------------------- commission in three parts --
  step('Base, package and bonus');

  const splitBooking = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Split ${stamp}`, supplier: 'Test Cruise Line', productName: 'Seven nights',
    status: 'travelled', departDate: isoDay(-60), returnDate: isoDay(-50), gross: '4000',
  });
  const splitId = splitBooking.data?.booking?.id;
  const splitTraveller = await call(advisor, 'POST', `/api/bookings/${splitId}/travellers`,
    { name: `Split ${stamp}`, isLead: true });
  const stId = splitTraveller.data?.id || splitTraveller.data?.traveller?.id;

  const priced = await call(advisor, 'PUT', `/api/bookings/${splitId}/pricing`, {
    cells: [{ kind: 'fare', travellerId: stId, amount: '4000', commissionable: true }],
    commissions: [
      { travellerId: stId, kind: 'base', amount: '600' },
      { travellerId: stId, kind: 'bonus', amount: '150' },
    ],
  });
  check(priced.status === 200, 'commission can be entered as base and bonus',
    `status ${priced.status}`);

  const splitView = await call(advisor, 'GET', '/api/commissions');
  const sr = (splitView.data?.rows || []).find((r) => r.id === splitId);
  check(sr?.commission_cents === 75000, 'the parts add up to the whole',
    `${sr?.commission_cents}`);
  check(sr?.expected_base_cents === 60000 && sr?.expected_bonus_cents === 15000,
    'and each part is kept separately',
    `base ${sr?.expected_base_cents} bonus ${sr?.expected_bonus_cents}`);

  // The case this exists for: a vendor settles the base on its normal
  // turnaround and holds the bonus for a quarter.
  await call(advisor, 'POST', '/api/commissions/receipts', {
    bookingId: splitId, kind: 'base', amount: '600', receivedOn: isoDay(-2),
  });
  const afterBase = await call(advisor, 'GET', '/api/commissions');
  const sr2 = (afterBase.data?.rows || []).find((r) => r.id === splitId);
  check(sr2?.settlement === 'short', 'paying the base alone leaves it short',
    sr2?.settlement);
  check(!sr2?.outstanding_by_kind?.base && sr2?.outstanding_by_kind?.bonus === 15000,
    'and it says which part is still out, not merely that something is',
    JSON.stringify(sr2?.outstanding_by_kind));
  check(afterBase.data?.totals?.owedBonusCents === 15000,
    'a bonus nobody has chased is its own figure',
    `${afterBase.data?.totals?.owedBonusCents}`);

  // Commission entered without saying which part has always meant the base.
  await call(advisor, 'POST', '/api/commissions/receipts', {
    bookingId: splitId, kind: 'bonus', amount: '150', receivedOn: isoDay(-1),
  });
  const afterBonus = await call(advisor, 'GET', '/api/commissions');
  const sr3 = (afterBonus.data?.rows || []).find((r) => r.id === splitId);
  check(sr3?.settlement === 'settled', 'the bonus arriving settles it', sr3?.settlement);

  cleanup('the split reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${splitId}`));

  // ------------------------------------------------- commission reconciled --
  step('What the vendor actually paid');

  // The case the old model could not see. A vendor pays less than the expected
  // commission and stops; before receipts existed the reservation was marked
  // paid and the full figure was counted, so the shortfall was absorbed in
  // silence. Here it has to show as short, with the difference still owed.
  const shortBooking = await call(advisor, 'POST', '/api/bookings', {
    clientName: 'Short Payer', supplier: 'Test Cruise Line', productName: 'Seven nights',
    status: 'travelled', departDate: isoDay(-60), returnDate: isoDay(-50),
    gross: 4000, commission: 600,
  });
  const shortId = shortBooking.data?.booking?.id;
  check(Boolean(shortId), 'a travelled reservation expecting 600 in commission');

  const receipt = await call(advisor, 'POST', '/api/commissions/receipts', {
    bookingId: shortId, amount: 450, receivedOn: isoDay(-3), reference: 'EFT 88213',
  });
  check(receipt.status === 200, 'the vendor pays 450 of it', `status ${receipt.status}`);

  const shortView = await call(advisor, 'GET', '/api/commissions');
  const shortRow = (shortView.data?.rows || []).find((r) => r.id === shortId);
  check(shortRow?.settlement === 'short', 'which reads as paid short, not as paid',
    `settlement ${shortRow?.settlement}`);
  check(shortRow?.variance_cents === -15000, 'with the 150 difference named',
    `variance ${shortRow?.variance_cents}`);
  check(shortRow?.outstanding_cents === 15000, 'and the shortfall still owed',
    `outstanding ${shortRow?.outstanding_cents}`);
  check(shortView.data?.totals?.shortCents >= 15000,
    'and counted in what vendors have underpaid', `${shortView.data?.totals?.shortCents}`);

  // Receipts are money, so a second one tops the reservation up rather than
  // replacing what came before.
  await call(advisor, 'POST', '/api/commissions/receipts', {
    bookingId: shortId, amount: 150, receivedOn: isoDay(-1),
  });
  const settledView = await call(advisor, 'GET', '/api/commissions');
  const settledRow = (settledView.data?.rows || []).find((r) => r.id === shortId);
  check(settledRow?.settlement === 'settled', 'the rest arriving settles it',
    `settlement ${settledRow?.settlement}`);
  check(settledRow?.commission_status === 'paid',
    'and the reservation marks itself paid from the money, not by hand',
    `status ${settledRow?.commission_status}`);

  // A statement is the vendor's own document: its total is entered from the
  // paper, and the lines matched underneath. The two agreeing is the proof.
  const stmt = await call(advisor, 'POST', '/api/commissions/statements', {
    vendorName: 'Test Cruise Line', reference: 'STMT-1', statementDate: isoDay(-2), total: 600,
  });
  const stmtId = stmt.data?.id;
  check(Boolean(stmtId), 'a vendor statement for 600 is filed');

  const unmatched = await call(advisor, 'GET', '/api/commissions/statements');
  const filed = (unmatched.data?.statements || []).find((x) => x.id === stmtId);
  check(filed && filed.reconciled === false && filed.unmatched_cents === 60000,
    'unreconciled until something is matched to it',
    `unmatched ${filed?.unmatched_cents}`);

  const cands = await call(advisor, 'GET', `/api/commissions/statements/${stmtId}/candidates`);
  check(!(cands.data?.candidates || []).some((c) => c.id === shortId),
    'a reservation already settled is not offered as a line',
    `${cands.data?.candidates?.length} candidate(s)`);

  // Somebody else's reservation cannot be given a receipt, whatever the
  // browser sends.
  const receiptNotMine = await call(admin, 'POST', '/api/commissions/receipts', {
    bookingId: shortId, amount: 100,
  });
  check(receiptNotMine.status === 404, 'a receipt cannot be filed against another advisor\'s reservation',
    `status ${receiptNotMine.status}`);

  await call(advisor, 'DELETE', `/api/commissions/statements/${stmtId}`);
  const afterDelete = await call(advisor, 'GET', '/api/commissions');
  const stillPaid = (afterDelete.data?.rows || []).find((r) => r.id === shortId);
  check(stillPaid?.received_cents === 60000,
    'deleting a statement leaves the money it recorded on the books',
    `received ${stillPaid?.received_cents}`);

  // ------------------------------------------------ the reservation record --
  step('One trip on one screen');

  const rec = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check(rec.status === 200 && rec.data?.booking?.id === bookingId,
    'the record loads', `status ${rec.status}`);
  check(Array.isArray(rec.data?.payments) && rec.data.payments.length >= 2,
    'with the schedule on it', `${rec.data?.payments?.length} payment(s)`);
  check(rec.data?.editable === true, 'and the owner of it may change it');

  // The quiet number: what is neither posted nor even scheduled. A trip worth
  // five thousand with a five hundred deposit and nothing else planned has
  // four and a half thousand that nothing will ever chase.
  const m = rec.data?.money || {};
  check(m.paidCents + m.scheduledCents + m.unscheduledCents === rec.data.booking.gross_cents,
    'and the three money figures account for the whole trip',
    `${m.paidCents} + ${m.scheduledCents} + ${m.unscheduledCents} vs ${rec.data.booking.gross_cents}`);

  // Every activity line has been written with the id of the thing it happened
  // to, and the feed could never take you there. Made fresh so it is the
  // newest entry: the feed is capped, and an older one may have scrolled off.
  const feedTrip = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Feed ${stamp}`, supplier: 'Ponant', status: 'quoted', departDate: isoDay(210),
  });
  if (feedTrip.data?.booking?.id) cleanup('the feed reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${feedTrip.data.booking.id}`));

  const feed = await call(advisor, 'GET', '/api/dashboard');
  check((feed.data?.activity || []).some((a) => a.booking_id === feedTrip.data?.booking?.id),
    'an activity line carries the reservation it happened to',
    JSON.stringify((feed.data?.activity || [])[0]));

  const recTask = await call(advisor, 'POST', '/api/tasks',
    { title: `From the record ${stamp}`, bookingId });
  if (recTask.data?.task?.id) cleanup('the record task', () =>
    call(advisor, 'DELETE', `/api/tasks/${recTask.data.task.id}`));
  const withTask = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check((withTask.data?.tasks || []).some((t) => t.id === recTask.data?.task?.id),
    'a task added against the trip shows on its record');

  // An owner may read an associate's trip, and its schedule with it, but the
  // record says plainly that they cannot change it.
  const ownerRec = await call(admin, 'GET', `/api/bookings/${bookingId}/record`);
  check(ownerRec.status === 200 && ownerRec.data?.editable === false,
    'an owner sees the record read only', `status ${ownerRec.status}, editable ${ownerRec.data?.editable}`);
  check((ownerRec.data?.payments || []).length === (rec.data?.payments || []).length,
    'with the same schedule, not an empty one',
    `${ownerRec.data?.payments?.length} vs ${rec.data?.payments?.length}`);

  const strangerRec = await call(admin, 'GET', '/api/bookings/does-not-exist/record');
  check(strangerRec.status === 404, 'and a reservation that is not there is a 404',
    `status ${strangerRec.status}`);

  // ------------------------------------------------ posting a payment ------
  {
  step('Posting a payment: who paid it, and with what');

  const settle = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Settle ${stamp}`, supplier: 'Holland America', status: 'booked',
    departDate: isoDay(240), returnDate: isoDay(252), gross: '1250', commission: '150',
  });
  const settleId = settle.data?.booking?.id;
  if (settleId) cleanup('the settled reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${settleId}`));

  const payer = await call(advisor, 'POST', `/api/bookings/${settleId}/travellers`,
    { name: `Ada Settle ${stamp}`, isLead: true });
  const payerId = payer.data?.id;

  const held = await call(advisor, 'POST', '/api/credits', {
    clientName: `Settle ${stamp}`, vendor: 'Holland America', kind: 'certificate',
    amount: '250', issuedOn: isoDay(-30), expiresOn: isoDay(300),
  });
  const heldId = held.data?.credit?.id;
  if (heldId) cleanup('the held credit', () => call(advisor, 'DELETE', `/api/credits/${heldId}`));

  // Silence is not a claim. Nobody said how this was paid, so nothing is
  // recorded about how it was paid.
  const quiet = await call(advisor, 'POST', '/api/payments', {
    bookingId: settleId, kind: 'deposit', amount: '1000', dueDate: isoDay(10),
  });
  check(quiet.status === 201 && quiet.data?.payment?.payment_type === null,
    'a payment nobody described has no payment type', quiet.data?.payment?.payment_type);

  const posted = await call(advisor, 'POST', `/api/payments/${quiet.data.payment.id}/paid`, {
    paidDate: isoDay(0), paymentType: 'card', paidBy: payerId, cardLast4: '4111 1111 4242',
  });
  check(posted.data?.payment?.payment_type === 'card' && posted.data?.payment?.paid_by === payerId,
    'posting one records how it was paid and by whom',
    `${posted.data?.payment?.payment_type} / ${posted.data?.payment?.paid_by}`);

  // Four digits, never the card. The rest is stripped rather than refused,
  // because an advisor pasting a whole number should not lose the payment.
  check(posted.data?.payment?.card_last4 === '4242',
    'and keeps the last four digits of a card and nothing more',
    posted.data?.payment?.card_last4);

  // A payer has to be on the trip they paid for.
  const stranger = await call(advisor, 'POST', '/api/payments', {
    bookingId: settleId, kind: 'installment', amount: '10', dueDate: isoDay(20),
    paidBy: 'not-a-traveller',
  });
  check(stranger.status === 400, 'a payer who is not on the reservation is refused',
    `status ${stranger.status}`);

  // Spending a credit is a ledger move: it stops being the client's money.
  const spend = await call(advisor, 'POST', '/api/payments', {
    bookingId: settleId, kind: 'installment', amount: '250', dueDate: isoDay(20),
    creditId: heldId,
  });
  const spendId = spend.data?.payment?.id;
  const stillOpen = await call(advisor, 'GET', '/api/credits?state=open');
  check((stillOpen.data?.credits || []).some((c) => c.id === heldId),
    'a credit a future payment intends to use is not spent yet');

  await call(advisor, 'POST', `/api/payments/${spendId}/paid`,
    { paidDate: isoDay(0), paymentType: 'future_cruise_credit' });
  const nowUsed = await call(advisor, 'GET', '/api/credits?state=used');
  const usedRow = (nowUsed.data?.credits || []).find((c) => c.id === heldId);
  check(Boolean(usedRow), 'posting the payment marks the credit used');
  check(usedRow?.booking_id === settleId, 'against the trip it was spent on', usedRow?.booking_id);

  // The same money cannot be spent twice.
  const twice = await call(advisor, 'POST', '/api/payments', {
    bookingId: settleId, kind: 'installment', amount: '250', paidDate: isoDay(0),
    creditId: heldId,
  });
  check(twice.status === 400, 'and the same credit cannot be applied to a second payment',
    `status ${twice.status}`);

  // The Payments page edits dates and amounts and knows nothing about payers.
  // An update from there must not quietly strip what it never carried.
  await call(advisor, 'PUT', `/api/payments/${quiet.data.payment.id}`, {
    bookingId: settleId, kind: 'deposit', amount: '1000',
    dueDate: isoDay(10), paidDate: isoDay(0),
  });
  const kept = await call(advisor, 'GET', `/api/bookings/${settleId}/record`);
  const keptRow = (kept.data?.payments || []).find((x) => x.id === quiet.data.payment.id);
  check(keptRow?.paid_by === payerId && keptRow?.card_last4 === '4242'
    && keptRow?.payment_type === 'card',
    'a partial edit leaves who paid, how, and the card alone',
    `${keptRow?.paid_by} / ${keptRow?.payment_type} / ${keptRow?.card_last4}`);

  check(keptRow?.paid_by_name === `Ada Settle ${stamp}`,
    'the record names the payer rather than showing an id', keptRow?.paid_by_name);
  const creditRow = (kept.data?.payments || []).find((x) => x.id === spendId);
  check(creditRow?.credit_amount_cents === 25000,
    'and shows the credit amount beside the payment it settled',
    creditRow?.credit_amount_cents);
  check((kept.data?.spendableCredits || []).some((c) => c.id === heldId),
    'the reservation offers this client\'s credits');

  // Deleting the payment hands the credit back. A credit left marked used
  // after its payment has gone is money the client owns and cannot see.
  await call(advisor, 'DELETE', `/api/payments/${spendId}`);
  const returned = await call(advisor, 'GET', '/api/credits?state=open');
  check((returned.data?.credits || []).some((c) => c.id === heldId),
    'deleting the payment gives the credit back to the client');
  }

  // ------------------------------------------------- client statement ------
  {
  step('What the client is told, and what they are not');

  const st = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Statement ${stamp}`, supplier: 'Princess Cruises', status: 'booked',
    productName: 'Alaska Inside Passage', confirmationNumber: `STMT-${stamp}`,
    departDate: isoDay(200), returnDate: isoDay(207), commission: '137.91',
    cabin: 'BA 620', cabinCategory: 'Balcony', itinerary: '7 Night Inside Passage',
  });
  const stId = st.data?.booking?.id;
  if (stId) cleanup('the statement reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${stId}`));

  await call(advisor, 'POST', `/api/bookings/${stId}/pricing`,
    { kind: 'fare', amount: '2000', commissionable: true, commission: '137.91' });
  await call(advisor, 'POST', `/api/bookings/${stId}/pricing`, { kind: 'taxes', amount: '318.55' });
  await call(advisor, 'POST', `/api/bookings/${stId}/pricing`,
    { kind: 'discount', label: 'Loyalty discount', amount: '100' });

  await call(advisor, 'POST', `/api/bookings/${stId}/travellers`,
    { name: 'Ruth Marlowe', passportNumber: 'X9Z7Q4471', passportExpiry: isoDay(2000), isLead: true });

  await call(advisor, 'POST', `/api/bookings/${stId}/amenities`,
    { description: 'Onboard credit', amount: '100', source: 'vendor', status: 'confirmed' });
  await call(advisor, 'POST', `/api/bookings/${stId}/amenities`,
    { description: 'Spa pass, still asking', source: 'vendor', status: 'requested' });

  const dep = await call(advisor, 'POST', '/api/payments', {
    bookingId: stId, kind: 'deposit', paymentClass: 'hard', amount: '500',
    dueDate: isoDay(-30), paidDate: isoDay(-30),
  });
  await call(advisor, 'POST', `/api/payments/${dep.data.payment.id}/paid`,
    { paidDate: isoDay(-30), paymentType: 'card', cardLast4: '9137' });
  await call(advisor, 'POST', '/api/payments', {
    bookingId: stId, kind: 'final', paymentClass: 'hard', amount: '1718.55', dueDate: isoDay(120),
  });
  // The advisor's own reminder, a week early, for the same money.
  await call(advisor, 'POST', '/api/payments', {
    bookingId: stId, kind: 'final', paymentClass: 'soft', amount: '1718.55', dueDate: isoDay(113),
  });

  const noAddress = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  check(noAddress.data?.problem && noAddress.data?.clientId,
    'a client with no email is named, with somewhere to go and fix it',
    noAddress.data?.problem);
  const refused = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, {});
  check(refused.status === 400, 'and sending is refused rather than half done',
    `status ${refused.status}`);

  const cl = await call(advisor, 'GET', `/api/clients?q=${encodeURIComponent(`Statement ${stamp}`)}`);
  await call(advisor, 'PUT', `/api/clients/${cl.data.clients[0].id}`,
    { name: `Statement ${stamp}`, email: `ruth-${stamp}@example.com` });

  const prev = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  const sm = prev.data?.statement || {};
  check(prev.status === 200 && prev.data?.to === `ruth-${stamp}@example.com`,
    'once an address is on file the preview is ready', prev.data?.to);

  // 2000 + 318.55 - 100. A discount is stored positive and subtracted, the
  // same way it is on the advisor's screen, so the two cannot drift apart.
  check(sm.tripCents === 221855, 'the total is the breakdown, discount subtracted', sm.tripCents);
  check(sm.paidCents === 50000 && sm.balanceCents === 171855,
    'and the balance is the trip less what has arrived',
    `${sm.paidCents} paid, ${sm.balanceCents} left`);

  // The soft row is the advisor's private reminder for money already listed.
  // A client seeing both reads it as owing the balance twice.
  check(sm.due?.length === 1 && sm.due[0].amountCents === 171855,
    'only the vendor\'s own date is shown, not the advisor\'s reminder',
    JSON.stringify(sm.due));

  check(sm.amenities?.length === 1 && sm.amenities[0].description === 'Onboard credit',
    'what the vendor confirmed is included, what is still being asked for is not',
    JSON.stringify(sm.amenities));
  check(Array.isArray(sm.travellers) && sm.travellers[0] === 'Ruth Marlowe'
    && typeof sm.travellers[0] === 'string',
    'travellers are names, not records', JSON.stringify(sm.travellers));

  // The boundary this module exists for. Everything below is a fact the
  // reservation holds and the client must never receive.
  const asText = JSON.stringify(prev.data);
  check(!asText.includes('137.91') && !/commission/i.test(asText),
    'no commission figure reaches the client, in the data or the words');
  check(!asText.includes('X9Z7Q4471'), 'nor a passport number');
  check(!asText.includes('9137'), 'nor the digits of a card');
  check(!asText.includes(isoDay(113)), 'nor the advisor\'s private reminder date');

  const html = prev.data?.html || '';
  check(html.includes('Ruth Marlowe') && html.includes('2,218.55') && html.includes('1,718.55'),
    'while the trip, the people and the money are all there');
  check(html.includes('Loyalty discount') && !html.includes('Non-commissionable'),
    'in the client\'s words rather than the agency\'s');

  // The client has no account in the portal. Signing an email to them with a
  // link to its login page is the software talking over the advisor.
  check(!/advisor portal/i.test(html) && html.includes(ADVISOR_EMAIL),
    'and it is signed by the advisor, not by the portal');

  // A quote is not a statement. A client who has not booked has paid nothing
  // and owes nothing, and showing them "Received: $0.00" and a balance reads
  // as a demand for a trip they never agreed to.
  const quoted = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Statement ${stamp}`, supplier: 'Princess Cruises', status: 'quoted',
    productName: 'Mexican Riviera', departDate: isoDay(220), returnDate: isoDay(227),
    gross: '3200', deposit: '500', depositDue: isoDay(20),
  });
  const quotedId = quoted.data?.booking?.id;
  if (quotedId) cleanup('the quoted reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${quotedId}`));

  const qp = await call(advisor, 'POST', `/api/bookings/${quotedId}/statement`, { preview: true });
  const qs = qp.data?.statement || {};
  check(qs.mode === 'quote', 'an unbooked trip produces a quote, not a statement', qs.mode);
  check(/^Your quote:/.test(qp.data?.subject || ''), 'and says so in the subject', qp.data?.subject);
  check(qs.posted?.length === 0 && qs.due?.length === 0 && qs.balanceCents === 0,
    'carrying no payment history and no balance, because there is none',
    JSON.stringify({ posted: qs.posted?.length, due: qs.due?.length, bal: qs.balanceCents }));

  const qhtml = qp.data?.html || '';
  check(!/Received, thank you/.test(qhtml) && !/Still to come/.test(qhtml),
    'and none of the wording that only makes sense once they have booked');
  // A quote that stops at a total leaves the client to work out what happens
  // next, and the commonest answer to that is nothing.
  check(/\$500\.00/.test(qhtml) && /holds this/.test(qhtml),
    'while saying what it takes to hold it, and by when');

  // A quote sent and never followed up is the largest quiet leak in travel
  // sales, and nothing here could even tell you one had been sent.
  const unsent = await call(advisor, 'GET', '/api/dashboard');
  const waiting = (unsent.data?.quotes || []).find((q) => q.id === quotedId);
  check(waiting?.state === 'unsent',
    'a quote written and not sent is waiting on the advisor, not the client',
    JSON.stringify({ state: waiting?.state, days: waiting?.quiet_days }));
  check(!(unsent.data?.quotes || []).some((q) => q.id === stId),
    'and a booked trip is not sitting in the quote follow-up list');

  // Previewing is not sending. Nothing is recorded until the email leaves.
  check(qp.data?.alreadySent === null && qp.data?.sentCount === 0,
    'previewing a quote records nothing');

  const sent = await call(advisor, 'POST', `/api/bookings/${quotedId}/statement`, {});
  const after = await call(advisor, 'POST', `/api/bookings/${quotedId}/statement`, { preview: true });
  if (sent.status === 200) {
    check(after.data?.alreadySent && after.data?.sentCount === 1,
      'a sent quote is remembered, and counted',
      JSON.stringify({ at: after.data?.alreadySent, n: after.data?.sentCount }));
    // Seconds, not milliseconds. Every timestamp in this database is seconds,
    // and one millisecond figure would put a quote sent today fifty thousand
    // years in the past and every quote ever written into the overdue list.
    const dash = await call(advisor, 'GET', '/api/dashboard');
    const row = (dash.data?.quotes || []).find((q) => q.id === quotedId);
    check(!row || row.quiet_days === 0,
      'and a quote sent today is not reported as quiet for decades',
      row && row.quiet_days);
  } else {
    check(after.data?.alreadySent === null,
      'a send that failed records nothing, so nothing looks followed up when it was not',
      `send said ${sent.status}, alreadySent ${after.data?.alreadySent}`);
    console.log('        (email is not configured here, so the send itself cannot be exercised)');
  }

  // Nothing goes out about a trip that is off.
  await call(advisor, 'POST', `/api/bookings/${quotedId}/quick`, { status: 'cancelled' });
  const dead = await call(advisor, 'POST', `/api/bookings/${quotedId}/statement`, { preview: true });
  check(dead.status === 400, 'a cancelled reservation sends nothing at all',
    `status ${dead.status}`);

  // An invoice is the document a client files. What makes it that rather than
  // an email they skim is a number and a date they can quote back at you.
  // The header of a client document. Blank until somebody fills it in, and
  // omitted rather than invented when it is blank: several states require a
  // seller of travel registration on an invoice, and a made up one is worse
  // than a missing one.
  const before = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  check(!/ST-/.test(before.data?.html || ''),
    'an unset registration number is absent, not invented');

  await call(advisor, 'PUT', '/api/auth/profile', {
    firstName: 'Smoke', lastName: 'Tester', agencyName: 'Smoke Travel',
    agencyAddress: `120 Harbour Road ${stamp}`, sellerOfTravel: 'FL ST-12345678',
  });
  const withHeader = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  check(/FL ST-12345678/.test(withHeader.data?.html || '')
    && new RegExp(`120 Harbour Road ${stamp}`).test(withHeader.data?.html || ''),
    'once set, both reach the document a client keeps');

  const invPrev = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  check(invPrev.data?.willNumber === true && invPrev.data?.statement?.invoiceNo === null,
    'previewing an invoice says a number is coming rather than burning one',
    JSON.stringify({ will: invPrev.data?.willNumber, no: invPrev.data?.statement?.invoiceNo }));

  // Where the money stands, worked out rather than ticked. CP Maxx asks the
  // advisor which of eight notices applies; every one of them is a fact this
  // already knows, and the day somebody ticks the wrong one a client gets a
  // demand for money they already sent.
  check(/received/i.test(invPrev.data?.statement?.standing || '')
    && /due by/i.test(invPrev.data?.statement?.standing || ''),
    'and states what has been received and what is due, in one line',
    invPrev.data?.statement?.standing);

  const notYours = await call(admin, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  check(notYours.status === 404,
    'and an owner cannot send a statement over an associate\'s name',
    `status ${notYours.status}`);
  }

  // ------------------------------------------------------------ targets -----
  step('Targets, and whether you are on course');

  const year = Number(isoDay(0).slice(0, 4));
  const blank = await call(advisor, 'GET', `/api/goals?year=${year}`);
  check(blank.status === 200 && blank.data?.goals?.set === false,
    'a new advisor has no target set', JSON.stringify(blank.data?.goals?.set));

  const set = await call(advisor, 'PUT', '/api/goals', {
    year, basis: 'purchase', salesGoal: '100000', commissionGoal: '10000', bookingsGoal: 50,
    aim: 'Fewer, better clients.', edge: 'I have sailed the ships I sell.',
  });
  const g = set.data?.goals;
  check(set.status === 200 && g?.sales?.goal === 10000000,
    'a target is stored in cents', g?.sales?.goal);
  cleanup('the target', () => call(advisor, 'PUT', '/api/goals', {
    year, basis: 'purchase', salesGoal: '0', commissionGoal: '0', bookingsGoal: 0, aim: '', edge: '',
  }));

  // Pace is the reason the target is worth showing at all: how much should be
  // done by today. Checked against the elapsed fraction rather than a fixed
  // number, since the answer changes every day this test runs.
  // elapsed is rounded to a tenth of a percent for display, so recomputing
  // from it cannot land on the exact figure. The tolerance is that rounding,
  // not a fudge: half of 0.1% of the goal.
  const expectedPace = Math.round(g.sales.goal * (g.elapsed / 100));
  const tolerance = g.sales.goal * 0.0005 + 1;
  check(Math.abs(g.sales.pace - expectedPace) <= tolerance,
    'pace follows from how much of the year has gone',
    `${g.sales.pace} vs ${expectedPace} at ${g.elapsed}%`);
  check(g.sales.ahead === g.sales.actual - g.sales.pace,
    'and ahead or behind is measured against the pace, not the target',
    `${g.sales.ahead}`);

  const goalReread = await call(advisor, 'GET', `/api/goals?year=${year}`);
  check(goalReread.data?.goals?.aim === 'Fewer, better clients.', 'the wording is kept too',
    goalReread.data?.goals?.aim);

  // The basis is part of the target, not a display option: the same number
  // means different things counted each way.
  const byDeparture = await call(advisor, 'PUT', '/api/goals', {
    year, basis: 'departure', salesGoal: '100000', commissionGoal: '10000', bookingsGoal: 50,
  });
  check(byDeparture.data?.goals?.basis === 'departure', 'the basis is stored with it',
    byDeparture.data?.goals?.basis);
  check(byDeparture.data?.goals?.sales?.actual !== g.sales.actual
        || byDeparture.data.goals.sales.actual === 0,
    'and changing it changes what counts towards the target',
    `${g.sales.actual} by purchase vs ${byDeparture.data?.goals?.sales?.actual} by departure`);

  // A target is personal even for an owner, so the agency scope must not leak
  // into it and ?advisor= must not redirect it at somebody else.
  // Asserted as "not the associate's" rather than "unset": the owner may well
  // have targets of their own, and a test that only passes on a fresh account
  // is a test that gets deleted the first time it is inconvenient.
  const ownerGoals = await call(admin, 'GET', `/api/goals?year=${year}&advisor=${created.id}`);
  check(ownerGoals.data?.goals?.aim !== 'Fewer, better clients.',
    'an owner asking for their targets gets their own, not an advisor\'s',
    ownerGoals.data?.goals?.aim);

  const junkYear = await call(advisor, 'GET', '/api/goals?year=1066');
  check(junkYear.data?.goals?.year === year, 'and an impossible year falls back to this one',
    junkYear.data?.goals?.year);

  // ----------------------------------------------------------- calendar -----
  step('A month of everything with a date on it');

  const monthOf = (iso) => iso.slice(0, 7);
  const cal = await call(advisor, 'GET', `/api/month?month=${monthOf(isoDay(90))}`);
  check(cal.status === 200 && cal.data?.month === monthOf(isoDay(90)),
    'the month asked for is the month returned', cal.data?.month);
  check(cal.data?.from?.endsWith('-01') && cal.data?.to > cal.data?.from,
    'spanning that whole month', `${cal.data?.from} to ${cal.data?.to}`);

  const kinds = new Set((cal.data?.events || []).map((e) => e.kind));
  check(kinds.size > 0, 'with events on it', [...kinds].join(', '));
  check((cal.data?.events || []).every((e) => e.date >= cal.data.from && e.date <= cal.data.to),
    'and nothing outside the month');

  // A month is a bounded window, so a bad one should be corrected rather than
  // handed to the database.
  const junk = await call(advisor, 'GET', '/api/month?month=not-a-month');
  check(junk.status === 200 && /^\d{4}-\d{2}$/.test(junk.data?.month || ''),
    'a nonsense month falls back to this one', junk.data?.month);

  // Same boundary as everywhere else.
  const ownerMonth = await call(admin, 'GET', `/api/month?month=${monthOf(isoDay(210))}`);
  const advisorMonth = await call(advisor, 'GET', `/api/month?month=${monthOf(isoDay(210))}`);
  check(ownerMonth.data.events.length >= advisorMonth.data.events.length,
    'an owner sees at least what the associate sees',
    `${ownerMonth.data.events.length} vs ${advisorMonth.data.events.length}`);

  // ------------------------------------------------- dashboard layout ------
  step('The dashboard remembers how you arranged it');

  const fresh = await call(advisor, 'GET', '/api/prefs/dashboard');
  const panelIds = (fresh.data?.panels || []).map((p) => p.id);
  check(fresh.status === 200 && panelIds.length >= 6,
    'a new advisor gets the default layout', `${panelIds.length} panel(s)`);
  check((fresh.data?.layout?.widgets || []).length === panelIds.length,
    'covering every panel', `${(fresh.data?.layout?.widgets || []).length} in layout`);

  const reordered = [...fresh.data.layout.widgets].reverse();
  reordered[0].hidden = true;
  const saved = await call(advisor, 'PUT', '/api/prefs/dashboard', {
    layout: { widgets: reordered, links: [{ label: 'Vendor portal', href: 'https://example.com' }] },
  });
  check(saved.data?.layout?.widgets?.[0]?.id === reordered[0].id && saved.data.layout.widgets[0].hidden,
    'a reordered layout with a hidden panel saves');

  const reread = await call(advisor, 'GET', '/api/prefs/dashboard');
  check(reread.data?.layout?.widgets?.[0]?.id === reordered[0].id,
    'and comes back the same on the next visit');
  check(reread.data?.layout?.links?.[0]?.href === 'https://example.com',
    'along with their quick links');

  // A layout is user supplied data that is later rendered back into a page,
  // so what the server does with a hostile one matters more than what the
  // form does. The form's checks are a message; these are the guarantee.
  const hostile = await call(advisor, 'PUT', '/api/prefs/dashboard', {
    layout: {
      widgets: [{ id: 'notices' }, { id: 'made-up-panel' }, { id: 'notices' }],
      links: [
        { label: 'x', href: 'javascript:alert(1)' },
        { label: 'y', href: 'data:text/html,hi' },
        { label: 'fine', href: 'https://good.example' },
      ],
    },
  });
  const gotIds = (hostile.data?.layout?.widgets || []).map((w) => w.id);
  check(!gotIds.includes('made-up-panel'), 'an unknown panel id is dropped', gotIds.join(', '));
  check(gotIds.filter((x) => x === 'notices').length === 1, 'a duplicate is collapsed');
  check(gotIds.length === panelIds.length, 'and the missing panels are put back');
  const gotLinks = hostile.data?.layout?.links || [];
  check(gotLinks.length === 1 && gotLinks[0].href === 'https://good.example',
    'only http and https links survive', JSON.stringify(gotLinks));

  const reset = await call(advisor, 'DELETE', '/api/prefs/dashboard');
  check((reset.data?.layout?.widgets || []).length === panelIds.length &&
    !(reset.data.layout.widgets[0] || {}).hidden,
    'and reset puts the default back');

  // ------------------------------------------------ documents to travel ----
  {
  step('Passports that will stop somebody travelling');

  // Departing in 40 days, home in 50. A passport running out 60 days from now
  // is valid on the day they fly and inside the six month rule on the day they
  // land, which is the case an expiry date alone never catches.
  const soon = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Docs Soon ${stamp}`, supplier: 'Silversea', status: 'booked',
    productName: 'Adriatic', departDate: isoDay(40), returnDate: isoDay(50),
  });
  const soonId = soon.data?.booking?.id;
  if (soonId) cleanup('the documents reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${soonId}`));

  await call(advisor, 'POST', `/api/bookings/${soonId}/travellers`,
    { name: `Rune Short ${stamp}`, passportNumber: 'EXP1', passportExpiry: isoDay(60), isLead: true });
  await call(advisor, 'POST', `/api/bookings/${soonId}/travellers`,
    { name: `Vera Valid ${stamp}`, passportNumber: 'OK1', passportExpiry: isoDay(2000) });
  await call(advisor, 'POST', `/api/bookings/${soonId}/travellers`,
    { name: `Nils Nothing ${stamp}` });

  // The same silence, on a trip far enough out that it is not yet a question.
  const later = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Docs Later ${stamp}`, supplier: 'Silversea', status: 'booked',
    departDate: isoDay(300), returnDate: isoDay(310),
  });
  const laterId = later.data?.booking?.id;
  if (laterId) cleanup('the far off reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${laterId}`));
  await call(advisor, 'POST', `/api/bookings/${laterId}/travellers`,
    { name: `Wilma Waiting ${stamp}` });

  // A quote is not a commitment, so nobody needs chasing for a passport yet.
  const quote = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Docs Quote ${stamp}`, supplier: 'Silversea', status: 'quoted',
    departDate: isoDay(45), returnDate: isoDay(52),
  });
  const quoteId = quote.data?.booking?.id;
  if (quoteId) cleanup('the quoted reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${quoteId}`));
  await call(advisor, 'POST', `/api/bookings/${quoteId}/travellers`,
    { name: `Quinn Quoted ${stamp}` });

  const docs = await call(advisor, 'GET', '/api/documents');
  const by = Object.fromEntries((docs.data?.travellers || []).map((r) => [r.name, r]));

  check(docs.status === 200, 'the document watch answers', `status ${docs.status}`);
  check(by[`Rune Short ${stamp}`]?.kind === 'expiring',
    'a passport inside six months of the return date is raised',
    by[`Rune Short ${stamp}`]?.detail);
  check(/six months/.test(by[`Rune Short ${stamp}`]?.detail || ''),
    'and says why, rather than just flagging a date');

  check(!by[`Vera Valid ${stamp}`], 'a passport good for years is left alone');

  // Silence is not evidence that a client holds a valid passport.
  check(by[`Nils Nothing ${stamp}`]?.kind === 'unknown',
    'a traveller with no passport on a trip leaving soon is raised separately',
    by[`Nils Nothing ${stamp}`]?.detail);

  // The same empty field a year out is normal, and raising it would train
  // whoever reads this panel to stop reading it.
  check(!by[`Wilma Waiting ${stamp}`],
    'while the same silence on a trip ten months out is not a problem yet');
  check(!by[`Quinn Quoted ${stamp}`], 'and a quote is not chased for documents');

  check(docs.data?.counts?.expiring >= 1 && docs.data?.counts?.unknown >= 1,
    'the two kinds are counted apart',
    JSON.stringify(docs.data?.counts));

  // An owner watching the agency sees an associate's travellers; the associate
  // sees only their own, the same rule as everything else.
  const ownerDocs = await call(admin, 'GET', '/api/documents');
  check((ownerDocs.data?.travellers || []).some((r) => r.name === `Rune Short ${stamp}`),
    'an owner sees an associate\'s document problems');

  const onDash = await call(advisor, 'GET', '/api/dashboard');
  check((onDash.data?.documents || []).some((r) => r.name === `Rune Short ${stamp}`),
    'and it reaches the dashboard, which is where it will actually be read');
  check((onDash.data?.panels || []).some((p) => p.id === 'documents'),
    'as a panel that can be arranged like any other');
  }

  // -------------------------------------------------------- components -----
  {
  step('One trip, several vendors');

  const trip = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Multi ${stamp}`, supplier: 'Celebrity Cruises', status: 'booked',
    productName: 'Celebrity Ascent', departDate: isoDay(200), returnDate: isoDay(207),
  });
  const tripId = trip.data?.booking?.id;
  if (tripId) cleanup('the multi vendor trip', () => call(advisor, 'DELETE', `/api/bookings/${tripId}`));

  const nameless = await call(advisor, 'POST', `/api/bookings/${tripId}/components`, { kind: 'air' });
  check(nameless.status === 400, 'a component needs a vendor', `status ${nameless.status}`);

  const backwards = await call(advisor, 'POST', `/api/bookings/${tripId}/components`, {
    kind: 'air', supplier: 'Delta', startDate: isoDay(200), endDate: isoDay(190),
  });
  check(backwards.status === 400, 'and cannot end before it starts', `status ${backwards.status}`);

  const air = await call(advisor, 'POST', `/api/bookings/${tripId}/components`, {
    kind: 'air', supplier: `Delta ${stamp}`, productName: 'ATL to FLL, return',
    confirmationNumber: `DL${stamp}`, startDate: isoDay(199), endDate: isoDay(208),
  });
  check(air.status === 201, 'air goes on the trip rather than beside it', `status ${air.status}`);

  const rec = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  const parts = rec.data?.components || [];
  check(parts.length === 1 && parts[0].confirmation_number === `DL${stamp}`,
    'with its own confirmation number', parts[0]?.confirmation_number);

  // Through the same vendor list as everything else, so air booked with a
  // consolidator lands under one spelling in the reports rather than three.
  check(parts[0].vendor_id, 'and its own vendor record');

  // Pricing one vendor must not disturb the other. The grid shows one at a
  // time, so a save that replaced everything would wipe the cruise.
  await call(advisor, 'PUT', `/api/bookings/${tripId}/pricing`, {
    componentId: null,
    cells: [{ kind: 'fare', amount: '2000', commissionable: true }],
    commissions: [{ amount: '320' }],
  });
  await call(advisor, 'PUT', `/api/bookings/${tripId}/pricing`, {
    componentId: air.data.id,
    cells: [{ kind: 'air', amount: '640' }],
  });

  const priced = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  const lines = priced.data?.pricing || [];
  check(lines.some((l) => l.kind === 'fare' && !l.component_id),
    'the cruise keeps its pricing when the air is saved',
    JSON.stringify(lines.map((l) => l.kind)));
  check(lines.some((l) => l.kind === 'air' && l.component_id === air.data.id),
    'and the air is charged against the vendor that provided it');

  // One money model: the trip total does not know components exist.
  check(priced.data?.booking?.gross_cents === 264000,
    'the trip total is everything, whoever it was booked with',
    priced.data?.booking?.gross_cents);
  check(priced.data?.booking?.commission_cents === 32000,
    'and so is the commission', priced.data?.booking?.commission_cents);

  // The money was real. Tidying away a vendor row must not quietly remove a
  // charge from the trip.
  await call(advisor, 'DELETE', `/api/components/${air.data.id}`);
  const after = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  check((after.data?.components || []).length === 0, 'a component can be removed');
  check(after.data?.booking?.gross_cents === 264000,
    'and what it cost stays on the trip rather than vanishing with it',
    after.data?.booking?.gross_cents);
  check((after.data?.pricing || []).some((l) => l.kind === 'air' && !l.component_id),
    'its charges are detached rather than deleted');

  const notYours = await call(admin, 'POST', `/api/bookings/${tripId}/components`,
    { kind: 'air', supplier: 'Intruder' });
  check(notYours.status === 404, 'an owner cannot add a vendor to an associate\'s trip',
    `status ${notYours.status}`);
  }

  // -------------------------------------------- the rate a charge earns ----
  step('Commission worked out from a rate rather than typed');
  {
    const rated = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Rated ${stamp}`, supplier: 'Royal Caribbean', status: 'booked',
      departDate: isoDay(150),
    });
    const ratedId = rated.data?.booking?.id;
    if (ratedId) {
      cleanup('the rated reservation', () => call(advisor, 'DELETE', `/api/bookings/${ratedId}`));
    }

    // Two passengers, each with their own fare. The rate is per charge and the
    // fare is per person, so the commission is twice one passenger's: getting
    // this wrong by counting the whole-booking column as a third passenger is
    // exactly the mistake this pins down.
    const pax1 = await call(advisor, 'POST', `/api/bookings/${ratedId}/travellers`,
      { name: `First ${stamp}`, isLead: true });
    const pax2 = await call(advisor, 'POST', `/api/bookings/${ratedId}/travellers`,
      { name: `Second ${stamp}` });

    const put = await call(advisor, 'PUT', `/api/bookings/${ratedId}/pricing`, {
      cells: [
        { kind: 'fare', travellerId: pax1.data.id, amount: '2000', commissionable: true },
        { kind: 'fare', travellerId: pax2.data.id, amount: '2000', commissionable: true },
        { kind: 'taxes', travellerId: pax1.data.id, amount: '150' },
        { kind: 'taxes', travellerId: pax2.data.id, amount: '150' },
        { kind: 'insurance', travellerId: null, amount: '500', commissionable: true },
      ],
      // Worked out in the page and sent as cash, which is what the vendor
      // actually pays: sixteen per cent of each fare, ten of the insurance.
      commissions: [
        { travellerId: pax1.data.id, amount: '320' },
        { travellerId: pax2.data.id, amount: '320' },
        { travellerId: null, amount: '50' },
      ],
      rates: [{ kind: 'fare', pct: 16 }, { kind: 'insurance', pct: 10 }],
    });
    check(put.status === 200, 'a grid saves with a rate on each earning charge',
      `status ${put.status}`);

    const back = await call(advisor, 'GET', `/api/bookings/${ratedId}/record`);
    const lines = back.data?.pricing || [];
    const fare = lines.find((l) => l.kind === 'fare');
    const ins = lines.find((l) => l.kind === 'insurance');
    const taxes = lines.find((l) => l.kind === 'taxes');

    check(fare?.commission_pct === 16, 'the rate comes back with the charge',
      `${fare?.commission_pct}`);
    check(ins?.commission_pct === 10, 'and a second charge keeps its own rate',
      `${ins?.commission_pct}`);
    // Nought and "not said" are different answers, and a charge that earns
    // nothing was never asked.
    check(taxes?.commission_pct === null,
      'a charge that earns nothing has no rate at all', `${taxes?.commission_pct}`);

    // 16% of two $2,000 fares is $640, plus 10% of $500 insurance is $50.
    check(back.data?.booking?.commission_cents === 69000,
      'the commission counts each passenger, not the cabin once',
      `${back.data?.booking?.commission_cents}`);
    // $4,000 of fare and $500 of insurance. The $300 of taxes earns nothing.
    check(back.data?.priceSummary?.commissionableCents === 450000,
      'over the charges that earn, and not the taxes',
      `${back.data?.priceSummary?.commissionableCents}`);

    // A rate outside nought to a hundred is a typo, not a rate.
    const silly = await call(advisor, 'PUT', `/api/bookings/${ratedId}/pricing`, {
      cells: [{ kind: 'fare', travellerId: null, amount: '2000', commissionable: true }],
      commissions: [],
      rates: [{ kind: 'fare', pct: 1600 }],
    });
    const afterSilly = await call(advisor, 'GET', `/api/bookings/${ratedId}/record`);
    check(silly.status === 200
      && (afterSilly.data?.pricing || []).every((l) => l.commission_pct !== 1600),
      'and a rate of sixteen hundred per cent is dropped rather than stored',
      JSON.stringify((afterSilly.data?.pricing || []).map((l) => l.commission_pct)));
  }

  // ---------------------------------------------------- pricing grid -------
  {
  step('Pricing a cabin per traveller');

  const cabin = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Cabin ${stamp}`, supplier: 'Margaritaville at Sea', status: 'booked',
    departDate: isoDay(180), travellers: 2,
  });
  const cabinId = cabin.data?.booking?.id;
  if (cabinId) cleanup('the priced cabin', () => call(advisor, 'DELETE', `/api/bookings/${cabinId}`));

  const one = await call(advisor, 'POST', `/api/bookings/${cabinId}/travellers`,
    { name: `Manuel ${stamp}`, isLead: true });
  const two = await call(advisor, 'POST', `/api/bookings/${cabinId}/travellers`,
    { name: `Veronica ${stamp}` });

  // Two people in one cabin, priced separately: she takes the drinks package
  // and he does not, which a single column for the reservation cannot say.
  const saved = await call(advisor, 'PUT', `/api/bookings/${cabinId}/pricing`, {
    cells: [
      { kind: 'fare', travellerId: one.data.id, amount: '229', commissionable: true },
      { kind: 'fare', travellerId: two.data.id, amount: '229', commissionable: true },
      { kind: 'taxes', travellerId: one.data.id, amount: '170' },
      { kind: 'taxes', travellerId: two.data.id, amount: '170' },
      { kind: 'beverage', travellerId: two.data.id, amount: '99' },
      { kind: 'transfers', travellerId: null, amount: '60' },
      { kind: 'discount', travellerId: null, amount: '50' },
    ],
    commissions: [
      { travellerId: one.data.id, amount: '36.64' },
      { travellerId: two.data.id, amount: '36.64' },
    ],
  });
  check(saved.status === 200, 'the whole grid saves at once', `status ${saved.status}`);

  const rec = await call(advisor, 'GET', `/api/bookings/${cabinId}/record`);
  const lines = rec.data?.pricing || [];
  const his = lines.filter((l) => l.traveller_id === one.data.id);
  const hers = lines.filter((l) => l.traveller_id === two.data.id);
  const cabinWide = lines.filter((l) => !l.traveller_id);

  check(his.length === 2 && hers.length === 3,
    'each traveller carries their own charges',
    `${his.length} and ${hers.length}`);
  check(hers.some((l) => l.kind === 'beverage') && !his.some((l) => l.kind === 'beverage'),
    'so one of them can have the drinks package and the other not');
  check(cabinWide.length === 2,
    'and what belongs to the cabin rather than to a person is nobody\'s',
    cabinWide.length);

  // 229 + 170 + 229 + 170 + 99 + 60 - 50
  check(rec.data?.booking?.gross_cents === 90700,
    'the trip total adds the columns and subtracts the credits',
    rec.data?.booking?.gross_cents);
  check(rec.data?.booking?.commission_cents === 7328,
    'and the commission is the sum of what each person earns',
    rec.data?.booking?.commission_cents);

  // Commission is carried on the fare line, which is where a vendor pays it.
  const fare = his.find((l) => l.kind === 'fare');
  check(fare?.commission_cents === 3664, 'commission rides on the fare line',
    fare?.commission_cents);

  // A traveller id from somebody else's reservation would price a person who
  // is not on this trip.
  const stranger = await call(advisor, 'PUT', `/api/bookings/${cabinId}/pricing`, {
    cells: [{ kind: 'fare', travellerId: 'not-on-this-trip', amount: '500' }],
  });
  const afterStranger = await call(advisor, 'GET', `/api/bookings/${cabinId}/record`);
  check(stranger.status === 200
    && (afterStranger.data?.pricing || []).every((l) => l.traveller_id === null),
    'a traveller from another reservation falls back to the booking rather than being priced',
    JSON.stringify((afterStranger.data?.pricing || []).map((l) => l.traveller_id)));

  // Saving replaces. A grid that merged would leave lines behind that the
  // screen said were gone.
  check((afterStranger.data?.pricing || []).length === 1,
    'and saving the grid replaces what was there rather than adding to it',
    afterStranger.data?.pricing?.length);

  const notYours = await call(admin, 'PUT', `/api/bookings/${cabinId}/pricing`, { cells: [] });
  check(notYours.status === 404, 'an owner cannot price an associate\'s trip',
    `status ${notYours.status}`);
  }

  // --------------------------------------------------- personal travel -----
  {
  step('An advisor\'s own holiday is not client production');

  const mine = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Me Myself ${stamp}`, supplier: 'Virgin Voyages', status: 'travelled',
    departDate: isoDay(-60), returnDate: isoDay(-50), gross: '3000', commission: '300',
    personal: true,
  });
  const mineId = mine.data?.booking?.id;
  if (mineId) cleanup('my own holiday', () => call(advisor, 'DELETE', `/api/bookings/${mineId}`));

  check(mine.data?.booking?.personal === 1, 'a reservation can be marked as my own travel',
    mine.data?.booking?.personal);

  // The two lists of people to ring. Ringing yourself is not a lead, and
  // welcoming yourself home is not a client touch.
  const dash = await call(advisor, 'GET', '/api/dashboard');
  check(!(dash.data?.welcome || []).some((b) => b.id === mineId),
    'and it is not on the list of clients to ring now they are home');
  check(!(dash.data?.rebook || []).some((r) => r.client_name === `Me Myself ${stamp}`),
    'nor on the list of people worth calling about another trip');

  // The commission is real money whoever travelled.
  const owed = await call(advisor, 'GET', '/api/commissions');
  check((owed.data?.rows || []).some((r) => r.id === mineId),
    'while the commission on it is still owed to the agency');

  // Off and on again, because a checkbox that only works one way is half a
  // checkbox and this one is unticked by default.
  await call(advisor, 'POST', `/api/bookings/${mineId}/quick`, { personal: false });
  const back = await call(advisor, 'GET', `/api/bookings/${mineId}/record`);
  check(back.data?.booking?.personal === 0, 'and it can be turned back off',
    back.data?.booking?.personal);
  }

  // ------------------------------------------------------- documents -------
  {
  step('The paperwork a trip generates');

  const paper = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Paperwork ${stamp}`, supplier: 'Cunard', status: 'booked',
    departDate: isoDay(120),
  });
  const paperId = paper.data?.booking?.id;
  if (paperId) cleanup('the paperwork reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${paperId}`));

  const rec = await call(advisor, 'GET', `/api/bookings/${paperId}/record`);
  check(Array.isArray(rec.data?.documents), 'a reservation carries its documents');

  if (!rec.data?.documentsReady) {
    // The feature ships before the bucket exists, so the useful thing to check
    // is that it says so rather than throwing on undefined.
    const refused = await call(advisor, 'POST', `/api/bookings/${paperId}/documents`, {});
    check(refused.status === 400 && /R2 bucket/i.test(refused.data?.error || ''),
      'and says storage is not set up rather than failing on undefined',
      refused.data?.error);
    skip('document upload and download',
      'no R2 bucket bound here; bind one as DOCS to exercise it');
  } else {
    const body = new FormData();
    body.append('file', new Blob(['Confirmation Number: TEST'], { type: 'text/plain' }), 'conf.txt');
    body.append('category', 'confirmation');
    const up = await fetch(`${BASE}/api/bookings/${paperId}/documents`,
      { method: 'POST', headers: { cookie: advisor.header() }, body });
    const upJson = await up.json().catch(() => ({}));
    check(up.status === 201 && upJson.filename === 'conf.txt', 'a file can be attached',
      `status ${up.status}`);

    const listed = await call(advisor, 'GET', `/api/bookings/${paperId}/record`);
    const doc = (listed.data?.documents || [])[0];
    check(doc && doc.category === 'confirmation' && doc.size_bytes > 0,
      'and comes back on the record with what it is and how big',
      JSON.stringify(doc && { c: doc.category, n: doc.size_bytes }));

    // A file the advisor uploaded is served from the portal's own origin, so
    // an HTML or SVG document rendered inline would run its own script against
    // a signed in session. Downloading it cannot.
    const got = await fetch(`${BASE}/api/documents/${doc.id}`, { headers: { cookie: advisor.header() } });
    check(got.status === 200 && /attachment/.test(got.headers.get('content-disposition') || ''),
      'a document downloads rather than rendering in the page',
      got.headers.get('content-disposition'));
    check(got.headers.get('x-content-type-options') === 'nosniff',
      'and the browser is told not to sniff a type it might render anyway');

    const anon = await fetch(`${BASE}/api/documents/${doc.id}`);
    check(anon.status === 401, 'and nobody without a session gets it', `status ${anon.status}`);

    const dropped = await call(advisor, 'DELETE', `/api/documents/${doc.id}`);
    check(dropped.status === 200, 'a document can be removed');
    const after = await fetch(`${BASE}/api/documents/${doc.id}`, { headers: { cookie: advisor.header() } });
    check(after.status === 404, 'and the file goes with the row, not just the row',
      `status ${after.status}`);
  }
  }

  // ------------------------------------------- reading a confirmation ------
  {
  step('Reading a vendor confirmation instead of retyping it');

  const confirmation = [
    'Thank you for your booking.',
    '',
    `Confirmation Number: HAL${stamp}`,
    'Cruise Line: Holland America Line',
    'Ship: Nieuw Amsterdam',
    `Sailing Date: ${isoDay(300)}`,
    `Disembarkation: ${isoDay(307)}`,
    'Stateroom: VA 8102',
    'Stateroom Category: Verandah',
    'Guest 1: COLE/DEBORAH',
    'Guest 2: COLE/MARTIN',
    'Grand Total: $1,996.00',
    'Deposit: $600.00',
    `Final Payment Due: ${isoDay(200)}`,
    '',
    'Please note your total is due on the date shown above.',
  ].join('\n');

  const read = await call(advisor, 'POST', '/api/import/confirmation', { text: confirmation });
  const f = read.data?.fields || {};
  check(read.status === 200, 'a confirmation can be read', `status ${read.status}`);
  check(f.confirmationNumber === `HAL${stamp}` && f.supplier === 'Holland America Line'
    && f.productName === 'Nieuw Amsterdam',
    'the number, the vendor and the ship come off it',
    JSON.stringify({ c: f.confirmationNumber, s: f.supplier, p: f.productName }));
  check(f.departDate === isoDay(300) && f.returnDate === isoDay(307),
    'and both dates', `${f.departDate} to ${f.returnDate}`);
  check(f.gross === '1996.00' && f.deposit === '600.00',
    'and the money, without the prose about it',
    `${f.gross} / ${f.deposit}`);

  // "your total is due on the date shown above" is a sentence about a total,
  // not a total. Labels are only read at the start of a line for this reason.
  check(f.gross === '1996.00', 'a label inside a sentence is not mistaken for a value');

  // Cruise lines write names in capitals, and a client record that keeps them
  // greets somebody as "Hello DEBORAH COLE" in every email they get.
  check(f.clientName === 'Deborah Cole' && f.travellers === 2,
    'guests are counted and their names put back into normal case',
    `${f.clientName}, ${f.travellers}`);

  // The advisor is confirming what was read, not trusting it.
  check(read.data?.from?.gross === 'Grand Total: $1,996.00',
    'every field says which line it came from', read.data?.from?.gross);

  const nonsense = await call(advisor, 'POST', '/api/import/confirmation',
    { text: 'Dear client, we look forward to welcoming you aboard next spring. Kind regards.' });
  check(nonsense.status === 400,
    'prose with no labelled lines is refused rather than half read',
    `status ${nonsense.status}`);

  const tiny = await call(advisor, 'POST', '/api/import/confirmation', { text: 'hi' });
  check(tiny.status === 400, 'and so is nothing much', `status ${tiny.status}`);

  // A return before a departure is a misread. Dropped, because an advisor is
  // likelier to accept a filled field than to notice a wrong one.
  const backwards = await call(advisor, 'POST', '/api/import/confirmation', {
    text: `Confirmation Number: X1\nSailing Date: ${isoDay(300)}\nReturn Date: ${isoDay(200)}`,
  });
  check(backwards.data?.fields?.returnDate === undefined,
    'a return date before the departure is dropped rather than saved',
    backwards.data?.fields?.returnDate);
  }

  // ------------------------------------------------ cancellation terms -----
  {
  step('What the client loses if they cancel');

  const pen = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Penalty ${stamp}`, supplier: `Cancel Line ${stamp}`, status: 'booked',
    departDate: isoDay(73), returnDate: isoDay(80), gross: '4000', commission: '400',
  });
  const penId = pen.data?.booking?.id;
  if (penId) cleanup('the penalty reservation', () => call(advisor, 'DELETE', `/api/bookings/${penId}`));

  // Nothing recorded is not nothing to pay, and the difference is one a client
  // would react to very differently.
  const bare = await call(advisor, 'GET', `/api/bookings/${penId}/record`);
  check(bare.data?.penalty === null && (bare.data?.penaltyTiers || []).length === 0,
    'with no terms recorded there is no answer, rather than a comfortable zero',
    JSON.stringify(bare.data?.penalty));

  const both = await call(advisor, 'POST', '/api/penalties',
    { bookingId: penId, fromDays: 89, pct: 50, amount: '500' });
  check(both.status === 400, 'a tier is a percentage or an amount, never both',
    `status ${both.status}`);
  const neither = await call(advisor, 'POST', '/api/penalties', { bookingId: penId, fromDays: 89 });
  check(neither.status === 400, 'and never neither', `status ${neither.status}`);
  const twoOwners = await call(advisor, 'POST', '/api/penalties',
    { bookingId: penId, vendorId: 'x', fromDays: 89, pct: 50 });
  check(twoOwners.status === 400, 'a tier belongs to a vendor or a trip, not both',
    `status ${twoOwners.status}`);

  await call(advisor, 'POST', '/api/penalties',
    { bookingId: penId, fromDays: 120, amount: '600', note: 'Deposit forfeit' });
  await call(advisor, 'POST', '/api/penalties', { bookingId: penId, fromDays: 89, pct: 50 });
  await call(advisor, 'POST', '/api/penalties', { bookingId: penId, fromDays: 29, pct: 100 });

  // Departing in 73 days: inside the 89 day tier, not yet inside the 29.
  const priced = await call(advisor, 'GET', `/api/bookings/${penId}/record`);
  const p = priced.data?.penalty || {};
  check((priced.data?.penaltyTiers || []).length === 3, 'the schedule comes back on the record');
  check(p.tier?.fromDays === 89,
    'the tier that applies is the closest one whose window has opened', p.tier?.fromDays);
  check(p.penaltyCents === 200000 && p.refundCents === 200000,
    'half of a four thousand dollar trip, and half back',
    `${p.penaltyCents} lost, ${p.refundCents} back`);
  check(p.penaltyCents + p.refundCents === 400000,
    'and the two always account for the whole trip');

  // The earliest tier starts 120 days out; this trip is further away than any
  // tier covers only if you move it, so check the boundary the other way.
  const far = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Far Off ${stamp}`, supplier: 'Cunard', status: 'booked',
    departDate: isoDay(400), gross: '4000',
  });
  const farId = far.data?.booking?.id;
  if (farId) cleanup('the distant reservation', () => call(advisor, 'DELETE', `/api/bookings/${farId}`));
  await call(advisor, 'POST', '/api/penalties', { bookingId: farId, fromDays: 120, pct: 25 });
  const farRec = await call(advisor, 'GET', `/api/bookings/${farId}/record`);
  check(farRec.data?.penalty?.tier === null && /No tier covers/.test(farRec.data?.penalty?.problem || ''),
    'a cancellation earlier than any tier says so rather than reporting nothing to pay',
    JSON.stringify(farRec.data?.penalty));

  // A vendor's standard terms, copied onto a trip rather than followed live.
  const vl = await call(advisor, 'GET', `/api/vendors?q=${encodeURIComponent(`Cancel Line ${stamp}`)}`);
  const vendor = (vl.data?.vendors || []).find((v) => v.name === `Cancel Line ${stamp}`);
  check(vendor, 'the vendor exists to hang standard terms on');

  await call(advisor, 'POST', '/api/penalties', { vendorId: vendor.id, fromDays: 60, pct: 35 });
  const vendorTiers = await call(advisor, 'GET', `/api/penalties?vendor=${vendor.id}`);
  check((vendorTiers.data?.tiers || []).length === 1, 'a vendor can carry its own schedule');

  const copied = await call(advisor, 'POST', `/api/bookings/${penId}/penalties/apply`, {});
  check(copied.status === 201 && copied.data?.copied === 1,
    'and it can be copied onto a reservation', JSON.stringify(copied.data));

  const afterCopy = await call(advisor, 'GET', `/api/bookings/${penId}/record`);
  check((afterCopy.data?.penaltyTiers || []).length === 1,
    'replacing what was there, because half a schedule read as a whole one is worse than either',
    afterCopy.data?.penaltyTiers?.length);

  // Copied, not followed. A vendor changing their standard terms next year
  // must not rewrite what this client already agreed to.
  const vendorTier = (vendorTiers.data.tiers || [])[0];
  await call(advisor, 'PUT', `/api/penalties/${vendorTier.id}`, { fromDays: 60, pct: 99 });
  const afterVendorChange = await call(advisor, 'GET', `/api/bookings/${penId}/record`);
  check(afterVendorChange.data?.penaltyTiers[0]?.pct === 35,
    'and the trip keeps the terms it was sold on when the vendor later changes theirs',
    afterVendorChange.data?.penaltyTiers[0]?.pct);

  const notYours = await call(admin, 'POST', '/api/penalties',
    { bookingId: penId, fromDays: 10, pct: 100 });
  check(notYours.status === 404, 'an owner cannot write terms onto an associate\'s trip',
    `status ${notYours.status}`);
  }

  // ------------------------------------------------ trips that are over ----
  {
  step('A trip whose return date has passed has been travelled');

  const been = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Been There ${stamp}`, supplier: 'Seabourn', status: 'booked',
    departDate: isoDay(-40), returnDate: isoDay(-30), gross: '4000', commission: '400',
  });
  const beenId = been.data?.booking?.id;
  if (beenId) cleanup('the finished reservation', () => call(advisor, 'DELETE', `/api/bookings/${beenId}`));

  const going = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Going Later ${stamp}`, supplier: 'Seabourn', status: 'booked',
    departDate: isoDay(40), returnDate: isoDay(50), gross: '4000',
  });
  const goingId = going.data?.booking?.id;
  if (goingId) cleanup('the future reservation', () => call(advisor, 'DELETE', `/api/bookings/${goingId}`));

  // A cancelled trip is not a holiday somebody had.
  const off = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Called Off ${stamp}`, supplier: 'Seabourn', status: 'cancelled',
    departDate: isoDay(-40), returnDate: isoDay(-30), gross: '4000',
  });
  const offId = off.data?.booking?.id;
  if (offId) cleanup('the cancelled reservation', () => call(advisor, 'DELETE', `/api/bookings/${offId}`));

  const swept = await call(admin, 'POST', '/api/admin/lifecycle', {});
  check(swept.status === 200 && swept.data?.travelled >= 1,
    'the sweep moves trips that are over', JSON.stringify(swept.data));

  const afterSweep = await call(advisor, 'GET', `/api/bookings/${beenId}/record`);
  check(afterSweep.data?.booking?.status === 'travelled',
    'a booked trip whose return date has passed becomes travelled',
    afterSweep.data?.booking?.status);

  const stillGoing = await call(advisor, 'GET', `/api/bookings/${goingId}/record`);
  check(stillGoing.data?.booking?.status === 'booked',
    'while one that has not left yet is untouched', stillGoing.data?.booking?.status);

  const stillOff = await call(advisor, 'GET', `/api/bookings/${offId}/record`);
  check(stillOff.data?.booking?.status === 'cancelled',
    'and a cancelled trip stays cancelled', stillOff.data?.booking?.status);

  // The number this fixes: it read zero however many holidays had happened.
  const prod = await call(advisor, 'GET', '/api/reports/production?months=12');
  check((prod.data?.stats?.travelled || 0) >= 1,
    'so the travelled count on the reports stops reading zero forever',
    prod.data?.stats?.travelled);

  // Running it twice must not double count or churn rows.
  const again = await call(admin, 'POST', '/api/admin/lifecycle', {});
  check(again.data?.travelled === 0,
    'and a second pass has nothing left to do, rather than churning the same rows',
    JSON.stringify(again.data));

  // Home, and nobody has rung them. The one contact where nothing goes wrong
  // if you skip it, which is exactly why it gets skipped.
  const dash = await call(advisor, 'GET', '/api/dashboard');
  const waiting = (dash.data?.welcome || []).find((b) => b.id === beenId);
  check(waiting, 'a client who is back and unrung is on the list',
    JSON.stringify((dash.data?.welcome || []).map((b) => b.client_name)));
  check(waiting?.back_days >= 29 && waiting?.back_days <= 31,
    'with how long they have been home', waiting?.back_days);

  const rang = await call(advisor, 'POST', `/api/bookings/${beenId}/welcomed`, {});
  check(rang.status === 200 && rang.data?.welcomedAt, 'the call can be recorded');
  // Seconds, like every other timestamp here. Milliseconds would put the call
  // fifty thousand years in the future and read that way on the page.
  check(rang.data.welcomedAt < 4102444800,
    'as a second count, not a millisecond one', rang.data?.welcomedAt);

  const dash2 = await call(advisor, 'GET', '/api/dashboard');
  check(!(dash2.data?.welcome || []).some((b) => b.id === beenId),
    'and they drop off the list rather than being asked about again');

  const rec2 = await call(advisor, 'GET', `/api/bookings/${beenId}/record`);
  check(rec2.data?.booking?.welcomed_at, 'the reservation remembers it too');

  await call(advisor, 'POST', `/api/bookings/${beenId}/welcomed`, { welcomed: false });
  const dash3 = await call(advisor, 'GET', '/api/dashboard');
  check((dash3.data?.welcome || []).some((b) => b.id === beenId),
    'clicking the wrong row can be undone');

  const notAdmin = await call(advisor, 'POST', '/api/admin/lifecycle', {});
  check(notAdmin.status === 403 || notAdmin.status === 404,
    'an advisor cannot run agency wide maintenance', `status ${notAdmin.status}`);
  }

  // -------------------------------------------------- quote options --------
  {
  step('The two or three choices a quote actually offers');

  const opt = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Choices ${stamp}`, supplier: 'Holland America', status: 'quoted',
    productName: 'Alaska Inside Passage', departDate: isoDay(250), returnDate: isoDay(257),
    deposit: '600', depositDue: isoDay(30),
  });
  const optId = opt.data?.booking?.id;
  if (optId) cleanup('the options reservation', () => call(advisor, 'DELETE', `/api/bookings/${optId}`));

  const nameless = await call(advisor, 'POST', `/api/bookings/${optId}/options`, { amount: '1000' });
  check(nameless.status === 400, 'an option needs a name', `status ${nameless.status}`);

  const inside = await call(advisor, 'POST', `/api/bookings/${optId}/options`,
    { label: 'Inside, deck 2', detail: 'no window', amount: '1596' });
  await call(advisor, 'POST', `/api/bookings/${optId}/options`,
    { label: 'Oceanview, deck 5', detail: 'picture window', amount: '1996' });
  const balcony = await call(advisor, 'POST', `/api/bookings/${optId}/options`,
    { label: 'Verandah, deck 8', detail: 'midship', amount: '2596' });
  check(inside.status === 201 && balcony.status === 201, 'options can be added to a quote');

  const rec = await call(advisor, 'GET', `/api/bookings/${optId}/record`);
  check((rec.data?.options || []).length === 3, 'and all three come back on the record',
    rec.data?.options?.length);
  check(rec.data.options[0].amount_cents === 159600,
    'cheapest first, so the client reads up rather than down', rec.data.options[0].amount_cents);

  // The quote shows the choices instead of a breakdown: the client is picking
  // between prices, not auditing one.
  const qp = await call(advisor, 'POST', `/api/bookings/${optId}/statement`, { preview: true });
  const qhtml = qp.data?.html || '';
  check(/Your choices/.test(qhtml) && /Verandah, deck 8/.test(qhtml) && /\$1,596\.00/.test(qhtml),
    'the quote puts all three in front of the client');
  check(/Tell me which one/.test(qhtml),
    'and asks for an answer rather than ending on a number');

  // Choosing is the moment the reservation's price becomes real. A chosen
  // option saying $2,596 and a trip total saying nothing is a reservation that
  // will be wrong on every report it appears in.
  const chose = await call(advisor, 'POST', `/api/options/${balcony.data.id}/choose`, {});
  check(chose.status === 200, 'the advisor can record what the client took');

  const after = await call(advisor, 'GET', `/api/bookings/${optId}/record`);
  check(after.data?.booking?.gross_cents === 259600,
    'and the reservation takes that price', after.data?.booking?.gross_cents);
  check((after.data?.options || []).filter((o) => o.chosen).length === 1,
    'exactly one option is marked taken');
  check((after.data?.options || []).length === 3,
    'and the ones they turned down are kept, because that is worth knowing next time');

  // A quote is not a booking. A client saying "the balcony then" is not a
  // deposit, and moving it to booked would put money into production that
  // nobody has taken.
  check(after.data?.booking?.status === 'quoted',
    'choosing does not book the trip on the client\'s behalf', after.data?.booking?.status);

  const moved = await call(advisor, 'POST', `/api/options/${inside.data.id}/choose`, {});
  const after2 = await call(advisor, 'GET', `/api/bookings/${optId}/record`);
  check((after2.data?.options || []).filter((o) => o.chosen).length === 1
    && after2.data.booking.gross_cents === 159600,
    'changing their mind moves the mark and the price, rather than adding a second',
    JSON.stringify({ chosen: (after2.data?.options || []).filter((o) => o.chosen).map((o) => o.label),
      gross: after2.data?.booking?.gross_cents }));
  check(moved.status === 200, 'and that is one request, not a clear and a set');

  const notYours = await call(admin, 'POST', `/api/bookings/${optId}/options`,
    { label: 'Intruder', amount: '1' });
  check(notYours.status === 404, 'an owner cannot add an option to an associate\'s quote',
    `status ${notYours.status}`);
  }

  // ------------------------------------------------ insurance exposure -----
  {
  step('Trips where nobody asked about insurance');

  const silent = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Uninsured ${stamp}`, supplier: 'Viking', status: 'booked',
    departDate: isoDay(45), returnDate: isoDay(55), gross: '9000',
    finalPaymentDue: isoDay(-5),
  });
  const silentId = silent.data?.booking?.id;
  if (silentId) cleanup('the uninsured reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${silentId}`));

  const asked = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Declined ${stamp}`, supplier: 'Viking', status: 'booked',
    departDate: isoDay(50), gross: '9000', insuranceStatus: 'declined',
  });
  if (asked.data?.booking?.id) cleanup('the declined reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${asked.data.booking.id}`));

  const gone = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Already Went ${stamp}`, supplier: 'Viking', status: 'booked',
    departDate: isoDay(-40), returnDate: isoDay(-30), gross: '9000',
  });
  if (gone.data?.booking?.id) cleanup('the past reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${gone.data.booking.id}`));

  const dash = await call(advisor, 'GET', '/api/dashboard');
  const rows = dash.data?.insurance || [];
  const row = rows.find((b) => b.id === silentId);

  check(row, 'a trip where nobody asked is listed',
    JSON.stringify(rows.map((b) => b.client_name)));
  check(row?.days_to_departure >= 44 && row?.days_to_departure <= 46,
    'with how long there is to do something about it', row?.days_to_departure);

  // A fact about this reservation, not a claim about what an insurer will
  // accept, which varies by policy and is not this software's to assert.
  check(row?.past_final_payment === true,
    'and whether the vendor deadline has already gone', row?.past_final_payment);

  // The whole reason the two are stored apart: "they turned it down" and
  // "nobody raised it" are different positions if something goes wrong.
  check(!rows.some((b) => b.client_name === `Declined ${stamp}`),
    'a trip where they declined is not chased, because that was asked and answered');
  check(!rows.some((b) => b.client_name === `Already Went ${stamp}`),
    'and a trip that has already gone is not on a list of things to do about it');
  }

  // ------------------------------------------------------- birthdays -------
  {
  step('Birthdays, which is what the date of birth was collected for');

  // The month and day of a date some days from now, with a birth year on it.
  // February 29 is stepped over rather than handled: a leap day birthday is a
  // real thing this code skips deliberately, and a test that fails one week in
  // four years is worse than one that does not cover it.
  const birthdayIn = (days, year) => {
    for (const d of [days, days + 1]) {
      const md = isoDay(d).slice(5);
      if (md !== '02-29') return `${year}-${md}`;
    }
    return `${year}-01-01`;
  };

  const bTrip = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Birthday ${stamp}`, supplier: 'Azamara', status: 'travelled',
    departDate: isoDay(-90), returnDate: isoDay(-80),
  });
  const bId = bTrip.data?.booking?.id;
  if (bId) cleanup('the birthday reservation', () => call(advisor, 'DELETE', `/api/bookings/${bId}`));

  const soonBirthday = birthdayIn(5, 1975);
  await call(advisor, 'POST', `/api/bookings/${bId}/travellers`,
    { name: `Cake Soon ${stamp}`, dob: soonBirthday, email: `cake-${stamp}@example.com`, isLead: true });
  await call(advisor, 'POST', `/api/bookings/${bId}/travellers`,
    { name: `Cake Later ${stamp}`, dob: birthdayIn(200, 1980) });
  // Yesterday's birthday rolls to next year, which is not "in the next month".
  await call(advisor, 'POST', `/api/bookings/${bId}/travellers`,
    { name: `Cake Passed ${stamp}`, dob: birthdayIn(-1, 1990) });
  await call(advisor, 'POST', `/api/bookings/${bId}/travellers`,
    { name: `No Date ${stamp}` });

  // The same person on a second trip, because four sailings is four traveller
  // rows and one birthday.
  const bTrip2 = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Birthday ${stamp}`, supplier: 'Azamara', status: 'booked',
    departDate: isoDay(120), returnDate: isoDay(130),
  });
  const bId2 = bTrip2.data?.booking?.id;
  if (bId2) cleanup('the second birthday reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${bId2}`));
  await call(advisor, 'POST', `/api/bookings/${bId2}/travellers`,
    { name: `Cake Soon ${stamp}`, dob: soonBirthday });

  const dash = await call(advisor, 'GET', '/api/dashboard');
  const cakes = (dash.data?.birthdays || []).filter((r) => r.name.endsWith(stamp));
  const soon = cakes.find((r) => r.name === `Cake Soon ${stamp}`);

  check(soon, 'a birthday in the next few days is listed', JSON.stringify(cakes.map((c) => c.name)));
  check(soon?.in_days >= 4 && soon?.in_days <= 7,
    'with how many days away it is', soon?.in_days);
  check(soon?.turning === Number(soon?.on?.slice(0, 4)) - 1975,
    'and the age they are turning, worked from the year on file', soon?.turning);

  check(cakes.filter((r) => r.name === `Cake Soon ${stamp}`).length === 1,
    'somebody who has sailed twice appears once, not twice');
  check(!cakes.some((r) => r.name === `Cake Later ${stamp}`),
    'a birthday half a year out is not in the next month');
  check(!cakes.some((r) => r.name === `Cake Passed ${stamp}`),
    'and one that has just gone rolls to next year rather than reading as due');
  check(!cakes.some((r) => r.name === `No Date ${stamp}`),
    'a traveller with no date of birth is not guessed at');
  }

  // -------------------------------------------------- commission split -----
  // Deliberately last but one: it changes what this advisor is recorded as
  // keeping, and every earlier check reads those same figures. Cleared again
  // at the end of the section.
  {
  step('Splitting a commission between the advisor and the agency');

  // 333.33 at half is 16,666.5 cents. The point of the figure: SQLite rounds
  // it in the reports and JavaScript rounds it on the record, and the two must
  // land on the same cent or the screens disagree about somebody's pay.
  const half = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Split ${stamp}`, supplier: 'Celebrity Cruises', status: 'booked',
    departDate: isoDay(60), returnDate: isoDay(67), gross: '4000', commission: '333.33',
  });
  const halfId = half.data?.booking?.id;
  if (halfId) cleanup('the split reservation', () => call(advisor, 'DELETE', `/api/bookings/${halfId}`));

  const noDeal = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(noDeal.data?.split?.pct === 100 && noDeal.data?.split?.advisorCents === 33333,
    'with no agreement an advisor keeps what they billed',
    JSON.stringify(noDeal.data?.split));

  // An associate who could set their own share could pay themselves.
  const selfServe = await call(advisor, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: 90 });
  check(selfServe.status === 403 || selfServe.status === 404,
    'an advisor cannot set their own share', `status ${selfServe.status}`);

  const nonsense = await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: 140 });
  check(nonsense.status === 400, 'and a share over 100% is refused', `status ${nonsense.status}`);

  const agreed = await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: 50 });
  check(agreed.status === 200 && agreed.data?.user?.defaultSplitPct === 50,
    'the owner sets a standing agreement', agreed.data?.user?.defaultSplitPct);

  const onDeal = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  const sp = onDeal.data?.split || {};
  check(sp.pct === 50 && sp.overridden === false,
    'which every trip follows without being touched',
    JSON.stringify({ pct: sp.pct, overridden: sp.overridden }));
  check(sp.advisorCents + sp.agencyCents === 33333,
    'and the two halves add back up to the commission exactly',
    `${sp.advisorCents} + ${sp.agencyCents}`);
  check(sp.advisorCents === 16667, 'rounding the odd cent to the advisor', sp.advisorCents);

  // The same figure, computed by SQLite rather than JavaScript.
  const comm = await call(advisor, 'GET', '/api/commissions');
  const commRow = (comm.data?.rows || []).find((r) => r.id === halfId);
  check(commRow?.advisor_cents === sp.advisorCents,
    'the report and the record agree to the cent',
    `${commRow?.advisor_cents} vs ${sp.advisorCents}`);
  check(comm.data?.anySplit === true, 'and the page knows there is a split to show');

  // A trip can carry its own figure, and blank puts it back on the agreement.
  await call(advisor, 'POST', `/api/bookings/${halfId}/quick`, { advisorSplitPct: 80 });
  const over = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(over.data?.split?.pct === 80 && over.data?.split?.overridden === true,
    'one trip can be given its own share', JSON.stringify(over.data?.split));
  await call(advisor, 'POST', `/api/bookings/${halfId}/quick`, { advisorSplitPct: '' });
  const back = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(back.data?.split?.pct === 50 && back.data?.split?.overridden === false,
    'and clearing it puts the trip back on the agreement, not on nothing',
    JSON.stringify(back.data?.split));

  // Nought is a real arrangement and must not be read as "no agreement".
  await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`, { defaultSplitPct: 0 });
  const houseAccount = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(houseAccount.data?.split?.pct === 0 && houseAccount.data?.split?.advisorCents === 0,
    'an advisor on nought keeps nothing, which is not the same as no agreement',
    JSON.stringify(houseAccount.data?.split));

  const cleared = await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: '' });
  check(cleared.data?.user?.defaultSplitPct === null,
    'and blank clears the agreement rather than setting it to nought',
    cleared.data?.user?.defaultSplitPct);
  const afterClear = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(afterClear.data?.split?.pct === 100,
    'which puts them back on keeping all of it', afterClear.data?.split?.pct);

  // An owner reading the combined report sees both sides of the same money.
  await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`, { defaultSplitPct: 50 });
  const rep = await call(admin, 'GET', '/api/reports/production?months=12');
  const line = (rep.data?.byAdvisor || []).find((r) => r.user_id === advisorId);
  if (line) {
    check(line.advisor_share_cents + line.agency_share_cents === line.commission_cents,
      'the combined report splits the same total, never more than it',
      `${line.advisor_share_cents} + ${line.agency_share_cents} vs ${line.commission_cents}`);
    check(line.advisor_share_cents < line.commission_cents,
      'and an associate on a split is not credited with the agency\'s half',
      `${line.advisor_share_cents} of ${line.commission_cents}`);
  } else {
    check(false, 'the combined report lists the associate');
  }

  await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`, { defaultSplitPct: '' });
  }

  // ---------------------------------------------------------------- tidy --
  step('Clean up');
  await runCleanups();

  // Both of these assert an absence, so they have to prove the request worked
  // first. An error body has no payments in it either.
  const gone = await call(advisor, 'GET', '/api/payments?state=all');
  check(gone.status === 200 && Array.isArray(gone.data?.payments) &&
    !gone.data.payments.some((p) => p.booking_id === bookingId),
    'deleting a reservation takes its payments with it', `status ${gone.status}`);
  const formsLeft = await call(advisor, 'GET', '/api/myforms');
  check(formsLeft.status === 200 && Array.isArray(formsLeft.data?.forms) &&
    !formsLeft.data.forms.some((f) => f.id === form.id),
    'and nothing the test created is left behind', `status ${formsLeft.status}`);
}

const started = Date.now();
main()
  .catch((e) => {
    failures += 1;
    console.log(e instanceof Bail ? `\n${e.message}` : `\nSmoke test threw: ${e && e.stack || e}`);
  })
  .finally(async () => {
    // Whatever happened above, do not leave test data in the database. The
    // suspended advisor is deliberate: suspending is the closest thing this
    // portal has to deleting an account, and an active one would keep working.
    await runCleanups();
    // Last, because it ends the advisor's session. Suspending is the closest
    // thing this portal has to deleting an account, and leaving it active
    // would keep a stale login working.
    if (advisorId) {
      await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/status`, { status: 'suspended' })
        .catch(() => {});
    }
    console.log(
      `\n${failures ? `${failures} of ${checks} checks failed.` : `All ${checks} checks passed.`}` +
      (skips.length ? ` ${skips.length} section${skips.length === 1 ? '' : 's'} skipped: ${
        skips.join(', ')}.` : '') +
      ` (${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
    process.exit(failures ? 1 : 0);
  });
