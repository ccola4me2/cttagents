/**
 * Smoke test: drive the flows that have never run in production.
 *
 * The contract checker asks whether a page reads fields the API returns. It
 * says nothing about whether a sequence of requests does the right thing, and
 * three of this portal's paths had never been executed end to end at all:
 *
 *   admin creates an advisor -> invite link -> password -> first sign in
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
// Kept so the run can end by saying what broke. "10 of 735 checks failed" is
// true and useless: finding the ten meant scrolling nine hundred lines, and in
// CI it meant scrolling them in a viewer that only holds a slice at a time.
const failed = [];
/**
 * Also shouted at GitHub, when this is running there.
 *
 * An Actions log is only readable by somebody signed in with access to the
 * repository, and the thing that most often needs to read it is whatever is
 * trying to work out why the push went red. Annotations are not: they hang off
 * the run and the check-runs API hands them to anybody who can see a public
 * repository. So every failure says itself twice, once for a person reading
 * the log and once where it can be read without one.
 *
 * A workflow command has to be one line, so the newlines are escaped the way
 * Actions asks for rather than being lost.
 */
/**
 * The shape of the run, not a failure.
 *
 * A suite that quietly shrinks is a suite reporting a number that means
 * something different from run to run, and a section that skipped is invisible
 * from outside the log. This puts the count and the skips where they can be
 * read without one.
 */
function summarise(text) {
  if (!process.env.CI) return;
  console.log(`::notice title=Smoke::${String(text).replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
}

function annotate(label, detail) {
  if (!process.env.CI) return;
  const one = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=Smoke::${one(label)}${detail === undefined ? '' : ` -- ${one(detail)}`}`);
}

function fail(label, detail) {
  checks++; failures++;
  failed.push(detail === undefined ? label : `${label}  (${detail})`);
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
  annotate(label, detail);
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

/**
 * Make an advisor the way the portal actually makes them: an admin creates the
 * account, and the one-time link that comes back is what gives it a password.
 *
 * Returns the created user, or null if either half failed, so a caller that
 * needs a working sign-in can say so rather than failing later on a 401 that
 * looks like a permissions bug.
 */
async function makeAdvisor(admin, email, password, extra = {}) {
  const made = await call(admin, 'POST', '/api/admin/advisors', {
    email, firstName: 'Smoke', lastName: 'Made', ...extra,
  });
  const url = made.data?.invite?.url;
  if (made.status !== 200 || !url) return null;
  const token = new URL(url).searchParams.get('token');
  const set = await call(null, 'POST', '/api/auth/reset', { token, password });
  return set.status === 200 ? made.data.user : null;
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

  // ------------------------------------------------ the admin adds an advisor --
  step('The agency creates an advisor, who sets their own password');
  // Nobody signs themselves up any more. The account exists because an admin
  // typed the address, and the invite is the only thing that can give it a
  // password.
  const invited = await call(admin, 'POST', '/api/admin/advisors', {
    email: ADVISOR_EMAIL, firstName: 'Smoke', lastName: 'Tester',
  });
  if (!check(invited.status === 200 && invited.data?.invite?.url,
    'the admin creates the account and gets a link back', JSON.stringify(invited.data))) {
    throw new Bail('No advisor to work with.');
  }
  // Deliberately not registered with the other cleanups: suspending the
  // advisor kills their session, and the checks after cleanup are made as the
  // advisor. Registered here it ran first and those checks then passed against
  // 401 bodies, which is worse than not running them.
  advisorId = invited.data.user.id;
  const adminId = (await call(admin, 'GET', '/api/auth/me')).data?.user?.id;

  const list = await call(admin, 'GET', '/api/admin/advisors');
  const created = (list.data?.users || []).find((a) => a.email === ADVISOR_EMAIL);
  check(Boolean(created), 'and they show up in the advisor list');
  check(created?.status === 'active', 'active from the start, since nobody asked to join', created?.status);

  const advisor = jar();
  const noPassword = await call(advisor, 'POST', '/api/auth/login',
    { email: ADVISOR_EMAIL, password: ADVISOR_PASSWORD });
  check(noPassword.status === 401,
    'but cannot be signed into until the invite is used', `status ${noPassword.status}`);

  const inviteToken = new URL(invited.data.invite.url).searchParams.get('token');
  check(Boolean(inviteToken), 'the link carries a token');

  const chose = await call(null, 'POST', '/api/auth/reset',
    { token: inviteToken, password: ADVISOR_PASSWORD });
  check(chose.status === 200, 'the advisor chooses a password', `status ${chose.status}`);

  const reused = await call(null, 'POST', '/api/auth/reset',
    { token: inviteToken, password: `${ADVISOR_PASSWORD}-again` });
  check(reused.status === 400, 'and the link cannot be used twice', `status ${reused.status}`);

  const signedIn = await call(advisor, 'POST', '/api/auth/login',
    { email: ADVISOR_EMAIL, password: ADVISOR_PASSWORD });
  check(signedIn.status === 200, 'the advisor can now sign in', `status ${signedIn.status}`);
  const me = await call(advisor, 'GET', '/api/auth/me');
  check(me.data?.user?.email === ADVISOR_EMAIL, 'and the session is theirs', me.data?.user?.email);
  check(me.data?.user?.agencyName === 'Cruises Tours & Travel',
    'and carries the agency name from the agency, not a form',
    me.data?.user?.agencyName);

  // ------------------------------------------------------ what it costs to join --
  step('The fee an advisor pays the agency');
  {
    const m = await call(advisor, 'GET', '/api/billing/membership');
    check(m.status === 200, 'an advisor can read their membership', `status ${m.status}`);
    check(m.data?.status === 'none', 'which starts at nothing', m.data?.status);
    // Stripe is not configured in CI and must not be needed to answer this.
    check(m.data?.configured === false, 'and says so when Stripe is not connected');
    check(m.data?.mayWrite === true,
      'nobody is restricted while the fee is not being enforced', String(m.data?.mayWrite));

    const q = m.data?.quote;
    if (check(Boolean(q), 'and quotes what joining today would cost')) {
      // The agreement, checked rather than assumed: $70 that never prorates,
      // plus insurance for the whole months left before 1 October.
      check(q.programCents === 7000, 'the programme half is $70 flat', q.programCents);
      check(q.monthsOfCover >= 1 && q.monthsOfCover <= 12,
        'cover runs between one month and a full year', q.monthsOfCover);
      check(q.eoCents === Math.round((18000 * q.monthsOfCover) / 12),
        'the insurance half is prorated by whole months', q.eoCents);
      check(q.annualDueCents === q.programCents + q.eoCents,
        'and the two add up to what is charged', q.annualDueCents);
      check(q.monthsOfCover === 12 ? q.annualDueCents === 25000 : q.annualDueCents < 25000,
        'a full year is the whole $250 and anything less is less');
      check(q.monthlyCents === 2995, 'the monthly fee is $29.95', q.monthlyCents);

      // The clocks. Both must land on midnight UTC on the first of a month.
      const nm = new Date(q.nextMonthlyAt * 1000);
      check(nm.getUTCDate() === 1 && nm.getUTCHours() === 0,
        'the monthly bills on the 1st', nm.toISOString());
      check(nm.getTime() > Date.now(), 'and that 1st is still ahead');
      const na = new Date(q.nextAnnualAt * 1000);
      check(na.getUTCDate() === 1 && na.getUTCMonth() === 9,
        'the annual renews on 1 October', na.toISOString());
      check(na.getTime() > Date.now(), 'and that October is still ahead');
    }

    // Paying is refused rather than half-done when Stripe is not connected.
    const pay = await call(advisor, 'POST', '/api/billing/checkout', {});
    check(pay.status >= 400, 'checkout refuses while Stripe is not connected',
      `status ${pay.status}`);

    // The webhook is the one unauthenticated endpoint here, so it must not
    // believe anybody who simply posts to it.
    const forged = await call(null, 'POST', '/api/stripe/webhook',
      { type: 'customer.subscription.updated', data: { object: { customer: 'cus_forged' } } });
    check(forged.status >= 400, 'and an unsigned webhook is refused',
      `status ${forged.status}`);
  }

  // ------------------------------------------------ the admin works as them --
  step('The agency works inside an advisor\'s account');
  {
    const started = await call(admin, 'POST', `/api/admin/act/${advisorId}`, {});
    check(started.status === 200, 'an admin can work as an advisor', `status ${started.status}`);

    const asThem = await call(admin, 'GET', '/api/auth/me');
    check(asThem.data?.user?.email === ADVISOR_EMAIL,
      'and the portal answers as that advisor', asThem.data?.user?.email);
    check(asThem.data?.actingAs?.admin?.email === ADMIN_EMAIL,
      'while still knowing who is really behind it',
      asThem.data?.actingAs?.admin?.email);

    // The reason for the whole feature: a booking entered by the office
    // belongs to the advisor, not to whoever typed it.
    const theirs = await call(admin, 'POST', '/api/bookings', {
      clientName: `Phoned In ${stamp}`, supplier: 'Carnival', productType: 'cruise',
      departDate: isoDay(200), gross: '1000', status: 'booked',
    });
    const theirBooking = theirs.data?.booking?.id;
    check(theirs.status === 201 && theirBooking,
      'a reservation entered this way is created', `status ${theirs.status}`);

    // Admin screens are shut while acting, so nothing can be done under an
    // identity that reads as somebody else.
    const shut = await call(admin, 'GET', '/api/admin/advisors');
    check(shut.status === 403, 'the admin screens are closed until you stop',
      `status ${shut.status}`);

    const stopped = await call(admin, 'DELETE', '/api/admin/act', {});
    check(stopped.status === 200, 'and stopping puts them back', `status ${stopped.status}`);
    const backAgain = await call(admin, 'GET', '/api/auth/me');
    check(backAgain.data?.user?.email === ADMIN_EMAIL,
      'as themselves', backAgain.data?.user?.email);
    check(!backAgain.data?.actingAs, 'with nothing left switched on');
    const openAgain = await call(admin, 'GET', '/api/admin/advisors');
    check(openAgain.status === 200, 'and the admin screens work again',
      `status ${openAgain.status}`);

    // The advisor sees the booking the office made for them.
    const list = await call(advisor, 'GET', '/api/bookings');
    check((list.data?.bookings || []).some((b) => b.id === theirBooking),
      'and the reservation belongs to the advisor, not the admin');
    if (theirBooking) {
      cleanup('the phoned-in reservation',
        () => call(advisor, 'DELETE', `/api/bookings/${theirBooking}`));
    }

    const adminSelf = await call(admin, 'POST', `/api/admin/act/${adminId}`, {});
    check(adminSelf.status >= 400, 'nobody works as themselves',
      `status ${adminSelf.status}`);

    // And an advisor cannot use any of it.
    const advisorTries = await call(advisor, 'POST', `/api/admin/act/${adminId}`, {});
    check(advisorTries.status === 403, 'and an advisor cannot work as anybody',
      `status ${advisorTries.status}`);

    // A second owner of the same agency. This is the case the check above once
    // claimed to cover and did not: it asked to work as the caller's own
    // account, which is a different refusal with a different message, so there
    // was never a second owner here for it to try.
    const mateEmail = `co-owner-${stamp}@test.dev`;
    const mate = await makeAdvisor(admin, mateEmail, 'co-owner-test-12345',
      { firstName: 'Co', lastName: 'Owner' });
    check(Boolean(mate), 'the agency takes on a second owner');
    const everyone = await call(admin, 'GET', '/api/admin/advisors');
    const mateUser = (everyone.data?.users || []).find((u) => u.email === mateEmail);
    await call(admin, 'PUT', `/api/admin/advisors/${mateUser.id}/agency`,
      { agencyId: 'agency-house', platformOwner: false, role: 'admin' });
    cleanup('the second owner', () => call(admin, 'PUT',
      `/api/admin/advisors/${mateUser.id}/status`, { status: 'suspended' }));

    const asMate = await call(admin, 'POST', `/api/admin/act/${mateUser.id}`, {});
    check(asMate.status === 200, 'an owner can work as another owner in their agency',
      `status ${asMate.status}`);

    // The thing that makes it safe, checked rather than argued: the admin
    // screens are shut for the whole of it, whoever is being worked as. So
    // sitting in a fellow owner's seat is a lateral move into their advisor
    // side, not a way to borrow anything.
    const stillShut = await call(admin, 'GET', '/api/admin/advisors');
    check(stillShut.status === 403,
      'and the admin screens stay shut even in another owner\'s seat',
      `status ${stillShut.status}`);
    const splitShut = await call(admin, 'PUT', `/api/admin/bookings/${theirBooking}/split`,
      { advisorSplitPct: 100 });
    check(splitShut.status === 403, 'so a commission split cannot be set from there',
      `status ${splitShut.status}`);

    await call(admin, 'DELETE', '/api/admin/act', {});

    // The one account that is never a seat to sit in. It reaches every agency
    // on the portal, so working as it would be borrowing the platform itself.
    const mateJar = jar();
    await call(mateJar, 'POST', '/api/auth/login',
      { email: mateEmail, password: 'co-owner-test-12345' });
    const reachPlatform = await call(mateJar, 'POST', `/api/admin/act/${adminId}`, {});
    check(reachPlatform.status === 403, 'but nobody can work as whoever runs the portal',
      `status ${reachPlatform.status}`);
  }

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

  // The schedule arrives with the reservation.
  //
  // This used to press Build and assert on what the button returned. Taking a
  // reservation with a cost and both dates now builds it on save, so by the
  // time anybody presses Build there is nothing left to create, and the button
  // answering "nothing to do" was the new behaviour working rather than a
  // failure. Asserted on the schedule itself, from wherever it came.
  check(res.data?.scheduled === 2,
    'a reservation with a cost and dates arrives with its schedule', `${res.data?.scheduled}`);

  const rows = (await call(advisor, 'GET', `/api/bookings/${bookingId}/record`))
    .data?.payments || [];

  const deposit = rows.find((p) => p.kind === 'deposit');
  const hardFinal = rows.find((p) => p.kind === 'final' && p.payment_class === 'hard');
  const softFinal = rows.find((p) => p.kind === 'final' && p.payment_class === 'soft');

  check(deposit?.payment_class === 'hard' && deposit?.amount_cents === 50000,
    'a hard deposit for the deposit amount', JSON.stringify(deposit));
  check(hardFinal?.amount_cents === 450000 && hardFinal?.due_date === isoDay(60),
    'a hard balance on the vendor date, net of the deposit', JSON.stringify(hardFinal));
  // Ten days, not the seven this used to assert. The number lives in
  // SOFT_DAYS in payments.js; this is the check that it still reaches the row.
  check(softFinal?.amount_cents === 450000 && softFinal?.due_date === isoDay(50),
    'a soft reminder ten days earlier', JSON.stringify(softFinal));

  // Every row it wrote is a copy of a date on the reservation, so every row
  // follows when that date moves. See 0077_schedule_follows.sql.
  check([deposit, hardFinal, softFinal].every((p) => Number(p?.from_booking) === 1),
    'and each one is marked as following the reservation');

  const again = await call(advisor, 'POST', `/api/bookings/${bookingId}/schedule`, {});
  check((again.data?.created || []).length === 0,
    'pressing Build after it has built itself does nothing',
    JSON.stringify(again.data?.created));

  // The schedule follows the reservation. Move the vendor's date and the
  // unpaid rows that came from it move too, the chase date keeping its ten
  // days in front. This is the half that used to drift.
  const moveTo = isoDay(75);
  const moved = await call(advisor, 'POST', `/api/bookings/${bookingId}/quick`,
    { finalPaymentDue: moveTo });
  check((moved.data?.moved || []).length === 2,
    'moving the vendor date moves the balance and the chase date with it',
    JSON.stringify(moved.data?.moved));

  const rowsAfterMove = (await call(advisor, 'GET', `/api/bookings/${bookingId}/record`))
    .data?.payments || [];
  const movedHard = rowsAfterMove.find((p) => p.kind === 'final' && p.payment_class === 'hard');
  const movedSoft = rowsAfterMove.find((p) => p.kind === 'final' && p.payment_class === 'soft');
  check(movedHard?.due_date === moveTo,
    'the balance is on the new vendor date', movedHard?.due_date);
  check(movedSoft?.due_date === isoDay(65),
    'and the chase date is ten days in front of it', movedSoft?.due_date);
  check(rowsAfterMove.find((p) => p.kind === 'deposit')?.due_date === isoDay(5),
    'while the deposit, which nobody moved, stays where it was');

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

  // ----------------------------------------------------- a client, first --
  step('A client the agency has met but not booked');
  {
    const nm = `Walk In ${stamp}`;
    // Everything in one go, because somebody adding a client with the passport
    // in front of them should not have to save and reopen to type the rest.
    const made = await call(advisor, 'POST', '/api/clients', {
      name: nm, email: `walkin-${stamp}@test.dev`, phone: '555-0100',
      passportNumber: 'P9998887', passportExpiry: '2031-01-01', city: 'Tampa',
      loyalty: [{ line: 'Carnival', number: 'VIFP42' }],
    });
    check(made.data?.client?.passport_number === 'P9998887',
      'and carries the passport typed with them', made.data?.client?.passport_number);
    check(made.data?.client?.city === 'Tampa', 'and the address');
    check(made.status === 201 && made.data?.client?.id,
      'a client can be added before there is a reservation', `status ${made.status}`);
    check(made.data?.existing === false, 'and is new');
    const cid = made.data?.client?.id;

    const listed = await call(advisor, 'GET', `/api/clients?q=${encodeURIComponent(nm)}`);
    check((listed.data?.clients || []).some((c) => c.id === cid),
      'and shows up on the client list');

    // The same name again is the same person, not a second copy of them, and
    // it fills in what was blank rather than blanking what was there.
    const again = await call(advisor, 'POST', '/api/clients',
      { name: nm, notes: 'Met at the Tampa show' });
    check(again.data?.client?.id === cid, 'adding the same name finds them again');
    check(again.data?.existing === true, 'and says so');
    check(again.data?.client?.email === `walkin-${stamp}@test.dev`,
      'without wiping what was already known', again.data?.client?.email);
    check(again.data?.client?.notes === 'Met at the Tampa show',
      'while filling in what was not');

    // What a vendor asks for, kept on the person so a reservation is built
    // from the record rather than typed again off the documents.
    const detail = await call(advisor, 'PUT', `/api/clients/${cid}`, {
      name: nm,
      legalFirst: 'Robert', legalMiddle: 'James', legalLast: 'Whitfield',
      gender: 'M', citizenship: 'United States',
      passportNumber: 'X1234567', passportCountry: 'United States',
      passportIssued: '2020-05-01', passportExpiry: '2030-05-01',
      address1: '14 Bayshore Blvd', city: 'Tampa', state: 'FL',
      postcode: '33606', country: 'United States',
      knownTraveler: 'TT1234567',
      loyalty: [{ line: 'Royal Caribbean', number: '123456789' },
                { line: 'Princess', number: '987654321' }],
    });
    check(detail.status === 200, 'a client carries what a vendor asks for',
      `status ${detail.status}`);
    const got = detail.data?.client || {};
    check(got.passport_number === 'X1234567', 'the passport is on the person', got.passport_number);
    check(got.passport_expiry === '2030-05-01', 'with the date it runs out', got.passport_expiry);
    check(got.legal_last === 'Whitfield', 'and the name the document spells', got.legal_last);
    check(got.city === 'Tampa', 'and somewhere to post things', got.city);
    let loy = [];
    try { loy = JSON.parse(got.loyalty_json || '[]'); } catch { loy = []; }
    check(loy.length === 2 && loy[0].number === '123456789',
      'past-guest numbers are a list, not one column', JSON.stringify(loy));

    // A household, and the reason it exists: booking one member offers the
    // others with their documents already on them.
    const mate = await call(advisor, 'POST', '/api/clients',
      { name: `Walk In Two ${stamp}`, email: `walkin2-${stamp}@test.dev` });
    const mateId = mate.data?.client?.id;
    const house = await call(advisor, 'POST', '/api/households',
      { clientIds: [cid, mateId], name: `The Walk Ins ${stamp}`, address: '14 Bayshore Blvd' });
    check(house.status === 201 && house.data?.id, 'two clients make a household',
      `status ${house.status}`);
    const hid = house.data?.id;

    const one = await call(advisor, 'GET', `/api/households/${hid}`);
    check(one.status === 200 && (one.data?.members || []).length === 2,
      'and the household reads back with both of them',
      (one.data?.members || []).length);

    const offer = await call(advisor, 'GET', `/api/households/travellers?client=${cid}`);
    const other = (offer.data?.travellers || [])[0];
    check(Boolean(other) && other.clientId === mateId,
      'booking one offers the other as a traveller', other && other.clientId);
    // The one from earlier has a passport; this is the whole point of holding
    // it on the person.
    const backAtYou = await call(advisor, 'GET', `/api/households/travellers?client=${mateId}`);
    const first = (backAtYou.data?.travellers || [])[0];
    check(first?.passportNumber === 'X1234567',
      'with their passport already on them, not typed again', first?.passportNumber);
    check(first?.legalName === 'Robert James Whitfield',
      'and the name the document spells', first?.legalName);

    await call(advisor, 'DELETE', `/api/households/${hid}`);

    const noName = await call(advisor, 'POST', '/api/clients', { email: 'x@y.dev' });
    check(noName.status === 400, 'a client without a name is refused',
      `status ${noName.status}`);

    // A reservation in that name must find them rather than making another.
    const trip = await call(advisor, 'POST', '/api/bookings', {
      clientName: nm, supplier: 'Carnival', productType: 'cruise',
      departDate: isoDay(150), gross: '2000', status: 'booked',
    });
    check(trip.data?.booking?.client_id === cid,
      'and a reservation in their name joins the record that exists',
      trip.data?.booking?.client_id);
    if (trip.data?.booking?.id) {
      await call(advisor, 'DELETE', `/api/bookings/${trip.data.booking.id}`);
    }
  }

  // ------------------------------------------------------- part payments --
  step('A payment that arrives in two pieces');
  {
    const made = await call(advisor, 'POST', '/api/payments', {
      bookingId, kind: 'installment', amount: '1000', dueDate: isoDay(30),
    });
    const payId = made.data?.payment?.id;
    if (check(made.status === 201 && payId, 'a payment is scheduled', `status ${made.status}`)) {
      const part = await call(advisor, 'POST', `/api/payments/${payId}/paid`,
        { amount: '400', paidDate: isoDay(0) });
      check(part.status === 200, 'part of it is received', `status ${part.status}`);
      check(part.data?.payment?.amount_cents === 40000,
        'the line becomes what actually arrived', part.data?.payment?.amount_cents);
      check(part.data?.remainder?.amount_cents === 60000,
        'and the balance becomes its own line', part.data?.remainder?.amount_cents);
      check(part.data?.remainder?.due_date === made.data.payment.due_date,
        'still due on the same date', part.data?.remainder?.due_date);
      check(!part.data?.remainder?.paid_date, 'and still owed');

      // The two halves are the whole, which is the point of splitting rather
      // than overwriting.
      check((part.data.payment.amount_cents + part.data.remainder.amount_cents) === 100000,
        'the pieces add back up to what was due');

      const restId = part.data?.remainder?.id;
      const rest = await call(advisor, 'POST', `/api/payments/${restId}/paid`, {});
      check(rest.status === 200 && !rest.data?.remainder,
        'posting the balance with no amount clears it in full',
        JSON.stringify(rest.data?.remainder));
      // Removed here rather than at the end of the run. A later check adds the
      // trip's paid, scheduled and unscheduled figures up and expects the
      // reservation's own total; two payments of this suite's making left
      // lying about make that sum $6,000 on a $5,000 trip. A test that leaves
      // the thing it borrowed exactly as it found it is the only kind that
      // does not break something further down.
      await call(advisor, 'DELETE', `/api/payments/${restId}`);
      await call(advisor, 'DELETE', `/api/payments/${payId}`);
    }

    // The reminder and the deadline are one obligation shown twice, so paying
    // one has to move the other. On a trip of its own, because posting
    // payments changes totals the shared reservation is checked against.
    const twin = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Twin ${stamp}`, supplier: 'Carnival', productType: 'cruise',
      departDate: isoDay(120), gross: '4000', deposit: '1000',
      depositDue: isoDay(10), finalPaymentDue: isoDay(60), status: 'booked',
    });
    const twinId = twin.data?.booking?.id;
    if (check(Boolean(twinId), 'a trip of its own for the reminder checks')) {
      await call(advisor, 'POST', `/api/bookings/${twinId}/schedule`, {});
      const sched = await call(advisor, 'GET', `/api/bookings/${twinId}/record`);
      const finals = (sched.data?.payments || []).filter((x) => x.kind === 'final');
      const soft = finals.find((x) => x.payment_class === 'soft');
      const hard = finals.find((x) => x.payment_class === 'hard');
      check(Boolean(soft && hard), 'a final balance is a deadline and a reminder');
      check(soft?.amount_cents === hard?.amount_cents,
        'both for the same money', `${soft?.amount_cents} vs ${hard?.amount_cents}`);

      // Half of it, posted against the reminder, which is what somebody
      // clicking the nearest row actually does.
      const paid = await call(advisor, 'POST', `/api/payments/${soft.id}/paid`,
        { amount: '1500', paidDate: isoDay(0) });
      check(paid.status === 200, 'part of it is posted against the reminder',
        `status ${paid.status}`);

      const after = await call(advisor, 'GET', `/api/bookings/${twinId}/record`);
      const now = (after.data?.payments || []).filter((x) => x.kind === 'final');
      const hardLeft = now.filter((x) => x.payment_class === 'hard' && !x.paid_date)
        .reduce((n, x) => n + x.amount_cents, 0);
      const hardPaid = now.filter((x) => x.payment_class === 'hard' && x.paid_date)
        .reduce((n, x) => n + x.amount_cents, 0);
      // The money lands on the deadline, not the reminder, or no total sees it.
      check(hardPaid === 150000, 'the money lands against the vendor deadline', hardPaid);
      check(hardLeft === 150000, 'and the deadline asks for what is left', hardLeft);

      const softLeft = now.filter((x) => x.payment_class === 'soft' && !x.paid_date)
        .reduce((n, x) => n + x.amount_cents, 0);
      check(softLeft === hardLeft,
        'the reminder now chases the same figure, not the original one', softLeft);

      // Paying the rest leaves nothing to be reminded about.
      const restRow = now.find((x) => x.payment_class === 'hard' && !x.paid_date);
      await call(advisor, 'POST', `/api/payments/${restRow.id}/paid`, {});
      const done = await call(advisor, 'GET', `/api/bookings/${twinId}/record`);
      const stillSoft = (done.data?.payments || [])
        .filter((x) => x.kind === 'final' && x.payment_class === 'soft' && !x.paid_date);
      check(stillSoft.length === 0,
        'and once it is settled the reminder goes away', String(stillSoft.length));

      await call(advisor, 'DELETE', `/api/bookings/${twinId}`);
    }

    // A trip that never earns is not a trip owing money.
    const noComm = await call(advisor, 'POST', `/api/bookings/${bookingId}/quick`,
      { commissionStatus: 'none' });
    check(noComm.status === 200, 'a reservation can be marked as earning no commission',
      `status ${noComm.status}`);
    const back = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
    check(back.data?.booking?.commission_status === 'none',
      'and it stays that way', back.data?.booking?.commission_status);
    await call(advisor, 'POST', `/api/bookings/${bookingId}/quick`,
      { commissionStatus: 'pending' });
  }

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

  // An owner may correct an associate's reservation, and the row stays the
  // associate's. Both halves are the rule: the first is what the owner asked
  // for, the second is the thing that must not quietly come with it, because a
  // correction that moved the trip onto the owner's book would move the
  // production and the commission with it.
  const ownerRead = await call(admin, 'GET', `/api/bookings/${theirBookingId}`);
  check(ownerRead.status === 200, 'an owner can open an associate\'s reservation', `status ${ownerRead.status}`);

  // The page reads the record endpoint, not this one, and it is the record
  // that decides whether a button is drawn. Asking the wrong endpoint is how
  // you get a green check on a screen with no buttons on it.
  const ownerPage = await call(admin, 'GET', `/api/bookings/${theirBookingId}/record`);
  check(ownerPage.data?.editable === true, 'and the page offers them the buttons',
    `editable ${ownerPage.data?.editable}`);
  check(typeof ownerPage.data?.onBehalfOf === 'string' && ownerPage.data.onBehalfOf.length > 0,
    'and says whose reservation they are working on', String(ownerPage.data?.onBehalfOf));

  // status goes with it. This endpoint saves the whole record, and a status
  // left out is not a status left alone: oneOf falls back to the first allowed
  // value, which is 'quoted', so correcting a name would demote a booked trip
  // to a quote and put it on a dashboard list three thousand lines below here.
  const ownerWrite = await call(admin, 'PUT', `/api/bookings/${theirBookingId}`,
    { clientName: `Corrected By Owner ${stamp}`, supplier: 'Cunard',
      productType: 'cruise', status: 'booked' });
  check(ownerWrite.status === 200, 'and can correct it', `status ${ownerWrite.status}`);

  const stillTheirs = await call(advisor, 'GET', `/api/bookings/${theirBookingId}`);
  check(stillTheirs.data?.booking?.client_name === `Corrected By Owner ${stamp}`,
    'the correction lands', stillTheirs.data?.booking?.client_name);
  check(stillTheirs.data?.booking?.user_id === created.id,
    'and the reservation is still the associate\'s', String(stillTheirs.data?.booking?.user_id));
  const theirPage = await call(advisor, 'GET', `/api/bookings/${theirBookingId}/record`);
  check(theirPage.data?.editable === true && theirPage.data?.onBehalfOf === null,
    'who can still edit their own, with nothing to announce about it',
    `editable ${theirPage.data?.editable}, onBehalfOf ${theirPage.data?.onBehalfOf}`);

  // The other direction is still shut. An associate reading is refused, so an
  // associate writing never gets the chance.
  const peerWrite = await call(advisor, 'PUT', `/api/bookings/${ownerBookingId}`,
    { clientName: 'Should not apply', supplier: 'Cunard',
      productType: 'cruise', status: 'booked' });
  check(peerWrite.status === 404, 'an associate cannot write to the owner\'s reservation',
    `status ${peerWrite.status}`);

  // And the name goes back, because a check further down searches for this
  // reservation by the name it was created with. A test that changes a fixture
  // other tests read has to put it back, or it fails them instead of itself.
  const putBack = await call(advisor, 'PUT', `/api/bookings/${theirBookingId}`,
    { clientName: `Associate Client ${stamp}`, supplier: 'Cunard',
      productType: 'cruise', status: 'booked' });
  check(putBack.status === 200, 'and the associate can set their own client name back',
    `status ${putBack.status}`);

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

  // ------------------------------------------------- sent to one person --
  //
  // The open link matches whoever answers it to the book by name, which is the
  // best a public page can do. Sending it is the other way: the invite knows
  // who it went to, so the answers land on that record and the forms list can
  // say afterwards whether they filled it in.
  step('A form sent to a client on the book');

  // Its own form, not the one above. That one has an automation on it, and a
  // second submission here would be counted by the check that asserts the
  // automation ran exactly once.
  const sendFormRes = await call(advisor, 'POST', '/api/myforms', {
    name: `Smoke sendable ${stamp}`,
    fields: [
      { label: 'Full name', type: 'text', required: true },
      { label: 'Email', type: 'email', required: true },
      { label: 'Where to?', type: 'text' },
    ],
  });
  const sendable = sendFormRes.data?.form;
  check(sendFormRes.status === 201 && sendable?.id, 'a form to send',
    `status ${sendFormRes.status}`);
  if (sendable?.id) {
    cleanup('the sendable form', () => call(advisor, 'DELETE', `/api/myforms/${sendable.id}`));
  }

  const invitee = await call(advisor, 'POST', '/api/clients', {
    name: `Invited Person ${stamp}`, email: `invited-${stamp}@test.dev`,
  });
  const inviteeId = invitee.data?.client?.id;
  check(inviteeId, 'a client to send it to', `status ${invitee.status}`);

  const inviteSent = await call(advisor, 'POST', `/api/myforms/${sendable.id}/send`, {
    clientId: inviteeId, note: 'Lovely speaking with you this morning.',
  });
  check(inviteSent.status === 201 && inviteSent.data?.inviteId, 'the form is sent',
    `status ${inviteSent.status} ${JSON.stringify(inviteSent.data)}`);
  // The link comes back whether or not the email went out, because email does
  // nothing until Resend is configured and an advisor with no way to hand the
  // thing over would rightly call that broken.
  check(String(inviteSent.data?.href || '').includes(`?i=${inviteSent.data?.inviteId}`),
    'and comes back with their own link to paste', inviteSent.data?.href);
  check(inviteSent.data?.to === `invited-${stamp}@test.dev`,
    'addressed off the client record, not out of the request', inviteSent.data?.to);
  const inviteId = inviteSent.data?.inviteId;

  // An address in the body is ignored when a client is named. Otherwise the
  // send box is a way to post somebody else's questions to anybody.
  const hijack = await call(advisor, 'POST', `/api/myforms/${sendable.id}/send`, {
    clientId: inviteeId, email: 'somebody-else@test.dev',
  });
  check(hijack.data?.to === `invited-${stamp}@test.dev`,
    'a typed address cannot redirect a named client\'s invite', hijack.data?.to);

  const notOnMyBook = await call(advisor, 'POST', `/api/myforms/${sendable.id}/send`, {
    clientId: 'no-such-client',
  });
  check(notOnMyBook.status === 404, 'and a client who is not yours is not one to send to',
    `status ${notOnMyBook.status}`);

  if (inviteId) {
    const invitedPage = await fetch(`${BASE}/f/${sendable.slug}?i=${inviteId}`);
    const invitedHtml = await invitedPage.text();
    check(invitedPage.status === 200, 'their link opens the form', `status ${invitedPage.status}`);
    // Asking somebody their own name on a form you sent to them by name reads
    // as though nobody is paying attention.
    check(invitedHtml.includes(`invited-${stamp}@test.dev`)
      && invitedHtml.includes(`value="Invited Person ${stamp}"`),
      'with what the advisor already knows filled in');
    check(invitedHtml.includes(`value="${inviteId}"`),
      'and carries the invite through to the submission');

    const afterOpen = await call(advisor, 'GET', `/api/myforms/${sendable.id}/invites`);
    const inviteRow = (afterOpen.data?.invites || []).find((i) => i.id === inviteId);
    check(inviteRow && inviteRow.openedAt, 'the advisor can see they opened it',
      JSON.stringify(inviteRow));
    check(inviteRow && inviteRow.name === `Invited Person ${stamp}` && !inviteRow.submittedAt,
      'and that nothing has come back yet', JSON.stringify(inviteRow));

    const invitedSubmit = await call(null, 'POST', `/api/public/forms/${sendable.slug}`, {
      invite: inviteId,
      full_name: `Invited Person ${stamp}`,
      email: `invited-${stamp}@test.dev`, where_to: 'Seville',
    });
    check(invitedSubmit.status === 200 || invitedSubmit.status === 201,
      'they answer it', `status ${invitedSubmit.status}`);

    const afterSubmit = await call(advisor, 'GET', `/api/myforms/${sendable.id}/invites`);
    const inviteDone = (afterSubmit.data?.invites || []).find((i) => i.id === inviteId);
    check(inviteDone && inviteDone.submittedAt, 'and the advisor can see it came back',
      JSON.stringify(inviteDone));

    // The point of the whole thing. Robert Smith answering a form sent to Bob
    // Smith is one person, and the open link, matching to the book by name,
    // cannot know that. The invite can.
    const onForm = await call(advisor, 'GET', `/api/myforms/${sendable.id}`);
    const landed = (onForm.data?.submissions || [])
      .find((s) => s.email === `invited-${stamp}@test.dev`);
    check(landed && landed.contactId === inviteeId,
      'the answers land on the record it was sent to',
      JSON.stringify(landed && { email: landed.email, contactId: landed.contactId }));

    // A wrong token behaves like the open link rather than refusing. The form
    // still works, which is the failure everybody would prefer.
    const badToken = await fetch(`${BASE}/f/${sendable.slug}?i=not-a-real-invite`);
    check(badToken.status === 200, 'a wrong token falls back to the open form',
      `status ${badToken.status}`);
  }

  // Somebody nobody has met yet. The point of doing this at send time rather
  // than at submit time is the half who never answer: an address in a sent log
  // is not something anybody rings, and a lead is.
  const strangerName = `Stranger ${stamp}`;
  const toStranger = await call(advisor, 'POST', `/api/myforms/${sendable.id}/send`, {
    name: strangerName, email: `stranger-${stamp}@test.dev`,
  });
  check(toStranger.status === 201, 'a form can go to somebody not on the book',
    `status ${toStranger.status} ${JSON.stringify(toStranger.data)}`);

  const book = await call(advisor, 'GET',
    `/api/clients?mine=1&q=${encodeURIComponent(strangerName)}`);
  const madeLead = (book.data?.clients || []).find((c) => c.name === strangerName);
  check(madeLead, 'and puts them on the book', `${(book.data?.clients || []).length} match(es)`);
  check(madeLead && madeLead.lead_stage === 'new',
    'as somebody to chase, not just an address in a log', madeLead && madeLead.lead_stage);
  // A client has one origin and the portal does not know what conversation led
  // to this. A guessed channel is worse than a blank one: it reads as an answer.
  check(madeLead && !madeLead.source_kind,
    'with the channel left for the advisor to say', madeLead && madeLead.source_kind);

  const sendNoName = await call(advisor, 'POST', `/api/myforms/${sendable.id}/send`, {
    email: `nameless-${stamp}@test.dev`,
  });
  check(sendNoName.status === 400, 'an address with no name is refused, since a lead needs one',
    `status ${sendNoName.status}`);

  // A client with nothing on file can be given an address, which is not the
  // same as redirecting one who has it.
  const sendBlankClient = await call(advisor, 'POST', '/api/clients',
    { name: `No Address ${stamp}` });
  const sendBlankId = sendBlankClient.data?.client?.id;
  if (sendBlankId) {
    const sendFilled = await call(advisor, 'POST', `/api/myforms/${sendable.id}/send`, {
      clientId: sendBlankId, email: `filled-${stamp}@test.dev`,
    });
    check(sendFilled.data?.to === `filled-${stamp}@test.dev`,
      'a client with no address on file can be given one', sendFilled.data?.to);
    const afterFill = await call(advisor, 'GET',
      `/api/clients?mine=1&q=${encodeURIComponent(`No Address ${stamp}`)}`);
    const sendKeptRow = (afterFill.data?.clients || []).find((c) => c.id === sendBlankId);
    check(sendKeptRow && sendKeptRow.email === `filled-${stamp}@test.dev`,
      'and it is kept, so nobody types it twice', sendKeptRow && sendKeptRow.email);
  }


  // -------------------------------------------- a lead that is due ----
  //
  // lead_next_step_on was read by the lead board and by nothing else, so a
  // follow-up date was invisible unless you went and looked at the board,
  // which is the thing a due date exists to save you from.
  step('A lead with a follow-up date is something due');

  const dueLead = await call(advisor, 'POST', '/api/leads', {
    name: `Due Lead ${stamp}`, email: `duelead-${stamp}@test.dev`,
    stage: 'in_conversation', nextStep: 'Ring about the Alaska cabins',
    nextStepOn: isoDay(-3),
  });
  check(dueLead.status === 200 || dueLead.status === 201, 'a lead with an overdue next step',
    `status ${dueLead.status} ${JSON.stringify(dueLead.data)}`);

  const todo = await call(advisor, 'GET',
    `/api/tasks?state=open&advisor=${encodeURIComponent(advisorId)}`);
  const onTodo = (todo.data?.leads || []).find((l) => l.client_name === `Due Lead ${stamp}`);
  check(onTodo, 'turns up beside the tasks that are due',
    `${(todo.data?.leads || []).length} lead(s) due`);
  // Shaped like a task on purpose: the drawer buckets by due_date, the badge
  // counts late and today, and the digest renders title and client. A lead
  // arriving in that shape needs none of them changed.
  check(onTodo && onTodo.title === 'Ring about the Alaska cabins'
    && onTodo.due_date === isoDay(-3),
    'carrying the step and the date it was due', JSON.stringify(onTodo));
  check(onTodo && String(onTodo.id).startsWith('lead:'),
    'under an id nothing can tick or pin as though it were a task', onTodo && onTodo.id);

  // A lead with no next step is not overdue, it is unplanned, and belongs on
  // the board rather than in a list of things due today.
  const noStep = await call(advisor, 'POST', '/api/leads', {
    name: `Unplanned Lead ${stamp}`, stage: 'new',
  });
  check(noStep.status === 200 || noStep.status === 201, 'and a lead with no next step');
  const todoAgain = await call(advisor, 'GET',
    `/api/tasks?state=open&advisor=${encodeURIComponent(advisorId)}`);
  check(!(todoAgain.data?.leads || []).some((l) => l.client_name === `Unplanned Lead ${stamp}`),
    'is not counted as due, because nothing was planned for it');

  // --------------------------------------------- the diary and the month --
  step('An appointment goes in the diary');

  const apptDay = isoDay(2);
  const apptMade = await call(advisor, 'POST', '/api/appointments', {
    title: `Planning call ${stamp}`, onDate: apptDay, startTime: '14:00', endTime: '15:00',
    clientId, kind: 'call', location: 'Zoom', notes: 'Alaska cabins',
  });
  const apptId = apptMade.data?.appointment?.id;
  check(apptMade.status === 201 && apptId, 'an appointment is made',
    `status ${apptMade.status} ${JSON.stringify(apptMade.data)}`);
  if (apptId) {
    cleanup('the appointment', () => call(advisor, 'DELETE', `/api/appointments/${apptId}`));
  }
  check(apptMade.data?.appointment?.clientName === 'Smoke Client',
    'against the person it is with, by name rather than an id',
    apptMade.data?.appointment?.clientName);

  // An id is not a permission. Pointing one at a client who is not yours would
  // otherwise be a way to find out whether their id is real.
  const notMine2 = await call(advisor, 'POST', '/api/appointments', {
    title: 'Somebody else\'s client', onDate: apptDay, startTime: '09:00',
    clientId: 'no-such-client',
  });
  check(notMine2.status === 404, 'a client who is not yours is not one to book with',
    `status ${notMine2.status}`);

  // A typo rather than a preference: an hour that runs backwards draws as a
  // negative box on the grid.
  const apptBackwards = await call(advisor, 'POST', '/api/appointments', {
    title: 'Backwards', onDate: apptDay, startTime: '15:00', endTime: '14:00',
  });
  check(apptBackwards.status === 400, 'and an end before its start is refused',
    `status ${apptBackwards.status}`);

  // An hour blocked out with nobody is still an hour that is not free.
  const apptAlone = await call(advisor, 'POST', '/api/appointments', {
    title: `Write proposals ${stamp}`, onDate: apptDay, startTime: '08:00',
  });
  check(apptAlone.status === 201, 'an hour with nobody in it is still an appointment',
    `status ${apptAlone.status}`);
  if (apptAlone.data?.appointment?.id) {
    cleanup('the blocked hour',
      () => call(advisor, 'DELETE', `/api/appointments/${apptAlone.data.appointment.id}`));
  }

  const diary = await call(advisor, 'GET', `/api/appointments?from=${apptDay}&to=${apptDay}`);
  const onDay = diary.data?.appointments || [];
  check(onDay.length >= 2, 'the day reads back', `${onDay.length} in the diary`);
  check(onDay[0] && onDay[0].startTime === '08:00',
    'earliest first, because a diary is read down the day', onDay[0] && onDay[0].startTime);

  step('The calendar gathers what lands on a day');

  const month = await call(advisor, 'GET',
    `/api/calendar?from=${isoDay(-1)}&to=${isoDay(40)}`);
  const evs = month.data?.events || [];
  const apptOnGrid = evs.filter((e) => e.kind === 'appointment' && e.id === apptId);
  check(apptOnGrid.length === 1, 'the appointment is on it', `${evs.length} event(s) in the window`);
  check(apptOnGrid[0] && apptOnGrid[0].time === '14:00' && apptOnGrid[0].who === 'Smoke Client',
    'with its time and who it is with', JSON.stringify(apptOnGrid[0]));

  // Five different things, each owned by a different screen, on one grid.
  const apptKinds = new Set(evs.map((e) => e.kind));
  check(apptKinds.has('appointment') && apptKinds.has('departure'),
    'alongside the trips that depart in the window', [...apptKinds].join(', '));
  // Read only: every one of these carries a way back to the screen that owns
  // it, because acting on it happens there.
  check(evs.every((e) => e.href), 'and every one of them leads somewhere');

  // The window is clamped rather than obeyed. A request for five years would
  // otherwise be five years of five queries.
  const greedy = await call(advisor, 'GET', `/api/calendar?from=${isoDay(0)}&to=${isoDay(900)}`);
  check(greedy.data?.truncated === true, 'a greedy range is cut and says so',
    JSON.stringify({ to: greedy.data?.to, truncated: greedy.data?.truncated }));

  if (apptId) {
    const todo2 = await call(advisor, 'GET',
      `/api/tasks?state=open&advisor=${encodeURIComponent(advisorId)}`);
    const apptDue = (todo2.data?.appointments || []).find((a) => a.appointment_id === apptId);
    check(apptDue, 'and the appointment is something due, beside the tasks',
      `${(todo2.data?.appointments || []).length} apptDue`);
    check(apptDue && String(apptDue.id).startsWith('appt:'),
      'under an id nothing can tick as though it were a task', apptDue && apptDue.id);

    // Cancelled is not the same as never booked, so the row stays and stops
    // being something due.
    await call(advisor, 'PUT', `/api/appointments/${apptId}`, { cancelled: true });
    const todo3 = await call(advisor, 'GET',
      `/api/tasks?state=open&advisor=${encodeURIComponent(advisorId)}`);
    check(!(todo3.data?.appointments || []).some((a) => a.appointment_id === apptId),
      'a cancelled hour stops being due');
    const apptStill = await call(advisor, 'GET', `/api/appointments?from=${apptDay}&to=${apptDay}`);
    check((apptStill.data?.appointments || []).some((a) => a.id === apptId && a.cancelledAt),
      'but is still in the diary, marked, because cancelling is a thing that happened');
  }

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
  // Headings are not questions. They carry a key because every field does, and
  // there is no answer behind one to arrive under the wrong name, so holding
  // them to the catalogue would mean an entry for the words "Tell us about you".
  const templateKeys = templates.flatMap((t) => t.fields
    .filter((f) => f.type !== 'heading').map((f) => f.key));
  const strays = [...new Set(templateKeys)].filter((k) => !catKeys.has(k));
  check(strays.every((k) => ['wedding_date', 'sailing', 'sailed_before', 'best_time'].includes(k)),
    'and the templates draw their questions from it', `outside it: ${strays.join(', ')}`);

  // ------------------------------------------------- an advisor's own -------
  // The built-in ten cover what everybody meets. What they cannot cover is the
  // form one advisor sends every week, in their wording and their order.
  const savedTpl = await call(advisor, 'POST', '/api/form-templates', {
    name: `My evening sheet ${stamp}`,
    blurb: 'What I actually ask',
    headline: 'Thanks for coming tonight',
    submitLabel: 'Send it',
    fields: [
      { label: 'Your name', key: 'full_name', type: 'text', required: true },
      { label: 'Email', key: 'email', type: 'email', required: true },
      { label: 'Which sailing', key: 'sailing', type: 'text' },
    ],
  });
  const tplId = savedTpl.data?.id;
  if (tplId) cleanup('the advisor form template',
    () => call(advisor, 'DELETE', `/api/form-templates/${tplId}`));
  check(savedTpl.status === 201 && tplId, 'an advisor can keep a form of their own as a template',
    JSON.stringify(savedTpl.data).slice(0, 120));

  const tplNoFields = await call(advisor, 'POST', '/api/form-templates', { name: 'Nothing' });
  check(tplNoFields.status === 400, 'a template with no questions is refused',
    `status ${tplNoFields.status}`);

  const withMine = await call(advisor, 'GET', '/api/myforms');
  const mineList = withMine.data?.myTemplates || [];
  const mineOne = mineList.find((t) => t.id === tplId);
  check(Boolean(mineOne), 'and it arrives with the form list, so the picker needs one request');
  check(mineOne?.key === `mine:${tplId}`,
    'namespaced away from the built-in keys, which share the one dropdown',
    mineOne?.key);
  check(mineOne?.headline === 'Thanks for coming tonight' && mineOne?.submitLabel === 'Send it',
    'carrying the wording, which is the part worth keeping');
  check((withMine.data?.templates || []).every((t) => !t.mine),
    'and the built-in ones are not marked as anybody’s own');

  // A template is a starting point, not a parent.
  const fromTpl = await call(advisor, 'POST', '/api/myforms', {
    name: `Built from a template ${stamp}`,
    headline: mineOne?.headline,
    fields: mineOne?.fields || [],
  });
  if (fromTpl.data?.form?.id) cleanup('the form built from a template',
    () => call(advisor, 'DELETE', `/api/myforms/${fromTpl.data.form.id}`));
  check(fromTpl.status === 201 && (fromTpl.data?.form?.fields || []).length === 3,
    'a form built from one keeps its questions', JSON.stringify(fromTpl.data?.form?.fields?.length));

  // Somebody else's templates are not yours, even though the forms themselves
  // are shared across everybody at one location.
  const theirTpls = await call(admin, 'GET', '/api/form-templates');
  check(!(theirTpls.data?.templates || []).some((t) => t.id === tplId),
    'another advisor does not see it, though they share the forms themselves');
  const theirEdit = await call(admin, 'PUT', `/api/form-templates/${tplId}`,
    { name: 'Stolen', fields: [{ label: 'Email', key: 'email', type: 'email' }] });
  check(theirEdit.status === 404, 'nor can they edit it', `status ${theirEdit.status}`);

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

  const ownerEdit = await call(admin, 'PUT', `/api/groups/${groupId}`,
    { name: `Renamed By Owner ${stamp}` });
  check(ownerEdit.status === 200, 'an owner can rename an associate\'s group',
    `status ${ownerEdit.status}`);
  const groupAfter = await call(advisor, 'GET', `/api/groups/${groupId}`);
  check(groupAfter.data?.group?.name === `Renamed By Owner ${stamp}`,
    'and the associate sees the new name on their own group',
    groupAfter.data?.group?.name);

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

  // An owner may correct an associate's reservation and may tick off a task
  // hanging on one, because that is the work on the trip. This task hangs on
  // nothing: it is somebody's own list, and that stays their own.
  const notMine = await call(admin, 'PUT', `/api/tasks/${taskId}`, { done: false });
  check(notMine.status === 404, 'an owner cannot tick off an associate\'s own to-do',
    `status ${notMine.status}`);
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

    const byOwner = await call(admin, 'POST', `/api/bookings/${bookingId}/share`, { on: true });
    check(byOwner.status === 200, 'an owner can share an associate\'s trip for them',
      `status ${byOwner.status}`);
    await call(advisor, 'POST', `/api/bookings/${bookingId}/share`, { on: false });
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
    // own buffer ahead of it. Only the first is the client's business.
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
      check(posted.status === 200,
        'and an owner can post an associate\'s payment as paid',
        `status ${posted.status}`);
      check(posted.data?.payment?.user_id === advisorId,
        'with the payment still on the associate\'s book',
        String(posted.data?.payment?.user_id));
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


  // ----------------------------------------------------- who to call next ---
  step('The call lists, and ticking a name off one');
  {
    // Every list here reads a query that already fed a dashboard panel, so the
    // risk is not that a query is wrong: it is that composing five of them
    // silently drops one, or that a name ticked off comes straight back.
    const anAgo = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Quiet Client ${stamp}`, supplier: 'Princess',
      departDate: isoDay(-400), returnDate: isoDay(-393),
      gross: '4000', commission: '400', status: 'travelled',
    });
    const quietBooking = anAgo.data?.booking?.id;
    const quietClient = anAgo.data?.booking?.client_id;
    if (quietBooking) cleanup('the quiet reservation', () => call(advisor, 'DELETE', `/api/bookings/${quietBooking}`));

    const justBack = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Home Client ${stamp}`, supplier: 'Celebrity',
      departDate: isoDay(-14), returnDate: isoDay(-7),
      gross: '3000', commission: '300', status: 'travelled',
    });
    const homeBooking = justBack.data?.booking?.id;
    if (homeBooking) cleanup('the welcome home reservation', () => call(advisor, 'DELETE', `/api/bookings/${homeBooking}`));

    // A birthday and an anniversary inside the month the lists look over,
    // written on the client record rather than a passport so both sources are
    // covered: the traveller half is the dashboard's and already worked.
    const soon = isoDay(10);
    if (quietClient) {
      await call(advisor, 'PUT', `/api/clients/${quietClient}`, {
        name: `Quiet Client ${stamp}`, phone: '555-0100',
        birthday: `1974-${soon.slice(5)}`, anniversary: `2001-${soon.slice(5)}`,
      });
      // Nothing deletes a client, so the dates come off instead. Without this
      // every run leaves another permanent name on the birthday list of
      // whichever database it ran against.
      cleanup('the fixture birthday', () => call(advisor, 'PUT', `/api/clients/${quietClient}`,
        { name: `Quiet Client ${stamp}`, birthday: '', anniversary: '' }));
    }

    const credit = await call(advisor, 'POST', '/api/credits', {
      clientName: `Quiet Client ${stamp}`, vendor: 'Princess', kind: 'credit',
      amount: '250', expiresOn: isoDay(45),
    });
    const creditId = credit.data?.credit?.id;
    if (creditId) cleanup('the lapsing credit', () => call(advisor, 'DELETE', `/api/credits/${creditId}`));

    const hot = await call(advisor, 'GET', '/api/hotlists?quiet=9');
    const listOf = (k) => (hot.data?.lists || []).find((l) => l.key === k)?.rows || [];
    const named = (k, name) => listOf(k).some((r) => r.name === name);

    check(hot.status === 200 && (hot.data?.lists || []).length === 5,
      'all five call lists come back', `status ${hot.status}`);
    check(named('quiet', `Quiet Client ${stamp}`),
      'a client home over a year with nothing booked is on Gone quiet');
    check(named('home', `Home Client ${stamp}`),
      'a client home last week is on Just home');
    check(named('birthdays', `Quiet Client ${stamp}`),
      'a birthday ten days out is on Birthdays');
    check(named('anniversaries', `Quiet Client ${stamp}`),
      'and the anniversary on the same record is on Anniversaries');
    check(listOf('lapsing').some((r) => r.subjectId === creditId),
      'a credit expiring in six weeks is on Money lapsing');

    // The one that decides whether the page is worth opening twice.
    const quietRow = listOf('quiet').find((r) => r.name === `Quiet Client ${stamp}`);
    const tick = await call(advisor, 'POST', '/api/hotlists/done',
      { list: 'quiet', subjectId: quietRow?.subjectId });
    check(tick.status === 200, 'a name can be ticked off', `status ${tick.status}`);

    const after = await call(advisor, 'GET', '/api/hotlists?quiet=9');
    const goneFromQuiet = !(after.data?.lists || []).find((l) => l.key === 'quiet')
      ?.rows.some((r) => r.name === `Quiet Client ${stamp}`);
    check(goneFromQuiet, 'and does not come back on the next read');
    check((after.data?.lists || []).find((l) => l.key === 'birthdays')
      ?.rows.some((r) => r.name === `Quiet Client ${stamp}`),
      'but is still on the other lists: ticking off a rebooking call is not '
      + 'saying you sent a birthday card');

    const back = await call(advisor, 'POST', '/api/hotlists/undo',
      { list: 'quiet', subjectId: quietRow?.subjectId });
    const undone = await call(advisor, 'GET', '/api/hotlists?quiet=9');
    check(back.status === 200 && (undone.data?.lists || []).find((l) => l.key === 'quiet')
      ?.rows.some((r) => r.name === `Quiet Client ${stamp}`),
      'undo puts it straight back');

    // The welcome home list writes to the reservation rather than to a private
    // snooze, so the reservation should be able to see it happened.
    const rang = await call(advisor, 'POST', `/api/bookings/${homeBooking}/welcomed`, { welcomed: true });
    const record = await call(advisor, 'GET', `/api/bookings/${homeBooking}/record`);
    check(rang.status === 200 && record.data?.booking?.welcomed_at,
      'ringing somebody after their trip is recorded on the reservation, not just hidden');
    const afterRang = await call(advisor, 'GET', '/api/hotlists?quiet=9');
    check(!(afterRang.data?.lists || []).find((l) => l.key === 'home')
      ?.rows.some((r) => r.subjectId === homeBooking),
      'and takes them off Just home');

    // A window that asks for people quiet two years is not the same question,
    // and a client home fourteen months ago should fall out of it.
    const twoYears = await call(advisor, 'GET', '/api/hotlists?quiet=24');
    check(!(twoYears.data?.lists || []).find((l) => l.key === 'quiet')
      ?.rows.some((r) => r.name === `Quiet Client ${stamp}`),
      'the quiet-for window is real: at two years they drop off');

    // Snoozing is per list, and the endpoint should say so rather than
    // writing a row that nothing will ever read.
    const wrong = await call(advisor, 'POST', '/api/hotlists/done',
      { list: 'home', subjectId: homeBooking });
    check(wrong.status === 400, 'and the welcome home list refuses to be snoozed',
      `status ${wrong.status}`);
  }




  // ------------------------------------------------- two agencies at once --
  // The point of the whole exercise. Until now the data was fenced by
  // sub-account and the people were not fenced at all: an owner saw every
  // advisor on the portal and could suspend or re-split any of them. Two
  // agencies is the only way to find out whether that is still true.
  step('A second agency, and the fence between them');
  {
    const made = await call(admin, 'POST', '/api/agencies', {
      name: `Rival Travel ${stamp}`, tagline: 'Somewhere else entirely',
      brandColor: '#7a2f5f', joinOpen: true,
    });
    const rivalId = made.data?.agency?.id;
    const rivalSlug = made.data?.agency?.slug;
    check(made.status === 201 && rivalId && rivalSlug,
      'the portal owner opens a second agency', `status ${made.status}`);
    check(/^rival-travel/.test(rivalSlug || ''),
      'with a join link named after it', rivalSlug);

    // Colour is interpolated into a style attribute on pages strangers read.
    const badColour = await call(admin, 'POST', '/api/agencies',
      { name: `Bad ${stamp}`, brandColor: 'red; } body { display:none' });
    check(badColour.status === 400, 'and a brand colour that is not a colour is refused',
      `status ${badColour.status}`);
    const badLogo = await call(admin, 'POST', '/api/agencies',
      { name: `Bad2 ${stamp}`, logoUrl: 'http://insecure.test/logo.png' });
    check(badLogo.status === 400, 'as is a logo served over http', `status ${badLogo.status}`);

    // Somebody joins the new agency. There is no public door any more, so the
    // portal owner makes the account and moves it across.
    const rivalEmail = `rival-${stamp}@test.dev`;
    // Created and given a password the only way there is: the invite. Creating
    // the row alone leaves an account nobody can sign into, which is the point
    // of the flow and was briefly the reason ten checks below it failed.
    const joined = await makeAdvisor(admin, rivalEmail, 'rival-test-12345',
      { firstName: 'Rival', lastName: 'Owner' });
    check(Boolean(joined),
      'the portal owner creates an account for the other agency');

    // Make them the owner of that agency.
    const all = await call(admin, 'GET', '/api/admin/advisors');
    const rivalUser = (all.data?.users || []).find((u) => u.email === rivalEmail);
    check(Boolean(rivalUser), 'the portal owner sees advisors from every agency');
    check(all.data?.platformOwner === true, 'and knows they run the portal');

    // The owner of their agency, and not of the portal. This is the account
    // the fence is actually about: an associate is stopped by requireAdmin
    // long before any of it, so testing with one would prove nothing.
    const promoted = await call(admin, 'PUT', `/api/admin/advisors/${rivalUser.id}/agency`,
      { agencyId: rivalId, platformOwner: false, role: 'admin' });
    check(promoted.status === 200 && promoted.data?.user?.role === 'admin',
      'and can be made the owner of that agency', JSON.stringify(promoted.data?.user?.role));

    const rival = jar();
    const rivalIn = await call(rival, 'POST', '/api/auth/login',
      { email: rivalEmail, password: 'rival-test-12345' });
    check(rivalIn.status === 200, 'the new advisor signs in', `status ${rivalIn.status}`);
    const rivalMe = await call(rival, 'GET', '/api/auth/me');
    check(rivalMe.data?.user?.agencyId === rivalId,
      'into the agency they were moved to, not whichever came first',
      rivalMe.data?.user?.agencyId);
    check(rivalMe.data?.user?.platformOwner === false,
      'and without the keys to the portal');

    // The fence, from the other side. Everything below is what used to leak.
    const theirList = await call(rival, 'GET', '/api/admin/advisors');
    const names = (theirList.data?.users || []).map((u) => u.email);
    check(theirList.status === 200 && !names.includes(ADVISOR_EMAIL)
      && !names.includes(ADMIN_EMAIL),
      'an agency owner reads their own advisor list and nobody else\'s',
      names.join(', ') || '(empty)');
    check(theirList.data?.platformOwner === false,
      'and is not handed the portal\'s own controls');

    const theirAgencies = await call(rival, 'GET', '/api/agencies');
    check(theirAgencies.status === 200 && (theirAgencies.data?.agencies || []).length === 1
      && theirAgencies.data.agencies[0].id === rivalId,
      'and sees their own agency, not the portal\'s client list',
      (theirAgencies.data?.agencies || []).map((a) => a.name).join(', '));

    const notMine = await call(rival, 'PUT', '/api/agencies/agency-house', { name: 'Hijacked' });
    check(notMine.status === 403, 'and cannot rebrand somebody else\'s agency',
      `status ${notMine.status}`);

    const notTheirs = await call(rival, 'POST', '/api/agencies', { name: `Sneaky ${stamp}` });
    check(notTheirs.status === 403, 'nor open one of their own', `status ${notTheirs.status}`);

    const houseOwner = await call(admin, 'GET', '/api/agencies');
    check((houseOwner.data?.agencies || []).length >= 2,
      'the portal owner sees every agency', (houseOwner.data?.agencies || []).length);

    // Reaching for somebody in another agency answers the same as reaching for
    // somebody who does not exist.
    const reach = await call(rival, 'PUT', `/api/admin/advisors/${advisorId}/status`,
      { status: 'suspended' });
    check(reach.status === 403 || reach.status === 404,
      'and one agency cannot suspend another agency\'s advisor', `status ${reach.status}`);

    const reachSplit = await call(rival, 'PUT', `/api/admin/advisors/${advisorId}/split`,
      { defaultSplitPct: 5 });
    check(reachSplit.status === 403 || reachSplit.status === 404,
      'nor change their commission split', `status ${reachSplit.status}`);

    const stillThere = await call(admin, 'GET', '/api/admin/advisors');
    const smokeStill = (stillThere.data?.users || []).find((u) => u.email === ADVISOR_EMAIL);
    check(smokeStill?.status === 'active',
      'and the advisor they reached for is untouched', smokeStill?.status);

    // There is no public join link left to close, so nothing to check here.
    // Access is a decision the agency makes one account at a time.

    // An owner may correct a reservation in their own agency. This is the
    // other side of that: the widening is by agency, so an owner of a
    // different agency is exactly as far away as they were before it existed.
    // Checked while the smoke advisor is still in the house agency and the
    // rival is not, which is the only moment in the suite where both are true.
    const reachRead = await call(rival, 'GET', `/api/bookings/${theirBookingId}`);
    check(reachRead.status === 404,
      'another agency\'s owner cannot even open a reservation here',
      `status ${reachRead.status}`);
    const reachWrite = await call(rival, 'PUT', `/api/bookings/${theirBookingId}`,
      { clientName: 'Hijacked', supplier: 'Cunard',
        productType: 'cruise', status: 'booked' });
    check(reachWrite.status === 404, 'nor correct one', `status ${reachWrite.status}`);
    const reachQuick = await call(rival, 'POST', `/api/bookings/${theirBookingId}/quick`,
      { gross: '1.00' });
    check(reachQuick.status === 404, 'nor change a figure on one', `status ${reachQuick.status}`);
    const reachPay = await call(rival, 'POST', '/api/payments',
      { bookingId: theirBookingId, kind: 'deposit', amount: '1.00', dueDate: isoDay(5) });
    check(reachPay.status === 404, 'nor put money on one', `status ${reachPay.status}`);
    const reachTraveller = await call(rival, 'POST', `/api/bookings/${theirBookingId}/travellers`,
      { name: 'Intruder' });
    check(reachTraveller.status === 404, 'nor add somebody to one',
      `status ${reachTraveller.status}`);

    // Put the smoke advisor back where the rest of the suite expects them.
    await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/agency`,
      { agencyId: 'agency-house', platformOwner: false });
    cleanup('the rival advisor', () => call(admin, 'PUT',
      `/api/admin/advisors/${rivalUser.id}/status`, { status: 'suspended' }));
  }

  // -------------------------------------------------- deals and their page --


  step('A special, its public page, and the enquiry it pulls');
  {
    const made = await call(advisor, 'POST', '/api/specials', {
      headline: `7 nights Western Caribbean ${stamp}`,
      vendor: 'Carnival Cruise Line', productType: 'cruise', ship: 'Jubilee',
      destination: 'Western Caribbean', departDate: isoDay(150), returnDate: isoDay(157),
      nights: 7, price: '799', priceBasis: 'per person',
      startsOn: isoDay(-2), endsOn: isoDay(20),
      blurb: 'Balcony for the price of an ocean view.\n\nDrinks included.',
      inclusions: 'Gratuities and the drinks package.',
      terms: 'New bookings only. Taxes extra.',
    });
    const dealId = made.data?.special?.id;
    const code = made.data?.special?.code;
    if (dealId) cleanup('the special', () => call(advisor, 'DELETE', `/api/specials/${dealId}`));
    check(made.status === 201 && dealId && code, 'a deal is recorded', `status ${made.status}`);
    check(/^7-nights-western-caribbean/.test(code || ''),
      'and gets a readable address of its own, not a uuid', code);

    // Unpublished means no page. A half written deal with a live URL is the
    // thing the switch exists to prevent.
    const draft = await call(null, 'GET', `/s/${code}`);
    check(draft.status === 404, 'a draft has no public page', `status ${draft.status}`);

    const published = await call(advisor, 'PUT', `/api/specials/${dealId}`, {
      headline: `7 nights Western Caribbean ${stamp}`,
      vendor: 'Carnival Cruise Line', productType: 'cruise', ship: 'Jubilee',
      destination: 'Western Caribbean', departDate: isoDay(150), returnDate: isoDay(157),
      nights: 7, price: '799', priceBasis: 'per person',
      startsOn: isoDay(-2), endsOn: isoDay(20),
      blurb: 'Balcony for the price of an ocean view.', published: true,
    });
    check(published.status === 200 && published.data?.special?.published === 1,
      'switching the page on publishes it');

    const live = await call(null, 'GET', `/s/${code}`);
    check(live.status === 200 && live.raw.includes('Western Caribbean'),
      'and the page is then served to anybody, signed in or not', `status ${live.status}`);
    check(live.raw.includes('$799'), 'with the price on it');
    check(!live.raw.includes(ADVISOR_EMAIL),
      'and nothing on it that belongs to the advisor rather than the deal');

    // The enquiry is the whole point: it has to arrive attached to the deal.
    const asked = await call(null, 'POST', `/s/${code}`, {
      name: `Deal Asker ${stamp}`, email: `asker-${stamp}@test.dev`,
      phone: '555-0199', party_size: 2, notes: 'Two of us, balcony please.',
    });
    check(asked.status === 200 && asked.data?.ok, 'a stranger can ask about it',
      JSON.stringify(asked.data));

    const spam = await call(null, 'POST', `/s/${code}`, {
      name: 'Robot', email: 'robot@test.dev', company_website: 'http://spam.test',
    });
    const afterSpam = await call(advisor, 'GET', `/api/specials/${dealId}`);
    check(spam.status === 200 && (afterSpam.data?.leads || []).length === 1,
      'and the honeypot swallows a bot without telling it so');

    const lead = (afterSpam.data?.leads || [])[0];
    check(lead?.name === `Deal Asker ${stamp}` && lead.party_size === 2,
      'the enquiry lands against the deal, not in a general pile',
      JSON.stringify(lead));
    check(afterSpam.data?.special?.headline.includes('Western Caribbean'),
      'and the deal page can read it back');

    // Turning it into a reservation should carry the deal across, and the
    // contact details with it: an enquiry that becomes a booking for somebody
    // with no phone number has lost the only useful thing it had.
    const booked = await call(advisor, 'POST', `/api/specials/enquiries/${lead.id}/book`);
    const newBooking = booked.data?.bookingId;
    if (newBooking) cleanup('the reservation from the deal',
      () => call(advisor, 'DELETE', `/api/bookings/${newBooking}`));
    check(booked.status === 201 && newBooking, 'an enquiry becomes a reservation',
      `status ${booked.status}`);

    const rec = await call(advisor, 'GET', `/api/bookings/${newBooking}/record`);
    check(rec.data?.booking?.supplier === 'Carnival Cruise Line'
      && rec.data?.booking?.depart_date === isoDay(150),
      'carrying the vendor and the sailing date from the deal',
      JSON.stringify({ s: rec.data?.booking?.supplier, d: rec.data?.booking?.depart_date }));
    check(rec.data?.client?.phone === '555-0199' || rec.data?.booking?.client_id,
      'and the client it created knows how to be reached');

    const twice = await call(advisor, 'POST', `/api/specials/enquiries/${lead.id}/book`);
    check(twice.status === 400, 'booking the same enquiry twice is refused',
      `status ${twice.status}`);

    // An offer that has closed still takes names. Telling somebody who clicked
    // a link that the page does not exist reads like a broken business.
    await call(advisor, 'PUT', `/api/specials/${dealId}`, {
      headline: `7 nights Western Caribbean ${stamp}`, vendor: 'Carnival Cruise Line',
      endsOn: isoDay(-1), published: true,
    });
    const closed = await call(null, 'GET', `/s/${code}`);
    check(closed.status === 200 && closed.raw.includes('offer has closed'),
      'a finished deal says so rather than 404ing', `status ${closed.status}`);
    const late = await call(null, 'POST', `/s/${code}`, {
      name: `Late Asker ${stamp}`, email: `late-${stamp}@test.dev`,
    });
    check(late.status === 200, 'and still takes the name');

    // Which list it falls into is the whole basis of the calendar above it.
    const liveList = await call(advisor, 'GET', '/api/specials?state=live');
    const goneList = await call(advisor, 'GET', '/api/specials?state=expired');
    check(!(liveList.data?.specials || []).some((s) => s.id === dealId)
      && (goneList.data?.specials || []).some((s) => s.id === dealId),
      'and it moves from running to finished on its own');

    // Deleting takes the enquiries with it, and says how many.
    const gone = await call(advisor, 'DELETE', `/api/specials/${dealId}`);
    check(gone.status === 200 && gone.data?.enquiriesRemoved === 2,
      'deleting a deal says how many names went with it',
      JSON.stringify(gone.data));
    // And that the names actually went. Counting them and reporting the count
    // proves nothing about whether anything was removed: the first draft
    // relied on ON DELETE CASCADE, which is a setting on the database rather
    // than a fact about the code, and this check would have passed either way.
    const orphans = await call(advisor, 'GET', `/api/specials/${dealId}`);
    check(orphans.status === 404, 'and the deal is really gone', `status ${orphans.status}`);
    // Probed by deleting the lead by its own id, which is the one route to it
    // that does not join through the deal. Booking it looks like the obvious
    // check and is worthless: that query joins to specials, so it answers 404
    // whether the row went or is still sitting there orphaned.
    const stillThere = await call(advisor, 'DELETE',
      `/api/specials/enquiries/${lead.id}`);
    check(stillThere.status === 404,
      'along with its enquiries, rather than orphaned pointing at nothing',
      `status ${stillThere.status}`);
  }

  // -------------------------------------------------- the Monday email -----
  step('The weekly call list');
  {
    // It goes to advisors, not clients, and only to whoever pressed it unless
    // asked otherwise, so running it here is safe even against a live key.
    const notAllowed = await call(advisor, 'POST', '/api/admin/call-lists', {});
    check(notAllowed.status === 403 || notAllowed.status === 404,
      'an advisor cannot fire the weekly send', `status ${notAllowed.status}`);

    const me = await call(admin, 'GET', '/api/auth/me');
    check(me.data?.user?.weeklyCallList === true,
      'the weekly list is on unless somebody turns it off');

    const ran = await call(admin, 'POST', '/api/admin/call-lists', {});
    check(ran.status === 200 && ran.data?.considered === 1,
      'and pressing it considers only whoever pressed it, not the whole agency',
      JSON.stringify(ran.data));

    // A profile save that never heard of the switch must leave it alone. This
    // is the one that would go wrong quietly: the switch defaults to on, so
    // reading a missing field as false turns it off for everybody who saves
    // their name from a page that predates it.
    const profile = me.data?.user || {};
    const blind = await call(admin, 'PUT', '/api/auth/profile', {
      firstName: profile.firstName || 'Local', lastName: profile.lastName || 'Admin',
    });
    check(blind.data?.user?.weeklyCallList === true,
      'a profile save that does not mention it leaves it switched on',
      JSON.stringify(blind.data?.user?.weeklyCallList));

    // Off means off, all the way through to who the pass looks at.
    const off = await call(admin, 'PUT', '/api/auth/profile', {
      firstName: profile.firstName || 'Local', lastName: profile.lastName || 'Admin',
      weeklyCallList: false,
    });
    check(off.data?.user?.weeklyCallList === false, 'it can be switched off');
    const quiet = await call(admin, 'POST', '/api/admin/call-lists', {});
    check(quiet.data?.considered === 0,
      'and an advisor who switched it off is not written to',
      JSON.stringify(quiet.data));

    const on = await call(admin, 'PUT', '/api/auth/profile', {
      firstName: profile.firstName || 'Local', lastName: profile.lastName || 'Admin',
      weeklyCallList: true,
    });
    check(on.data?.user?.weeklyCallList === true, 'and switched back on again');
  }




  // ------------------------------------------------ the trip day by day ----
  // A reservation says what was sold. The itinerary says what happens, which
  // is the half the client opens the page for.
  step('An itinerary, day by day');
  {
    const trip = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Itinerary ${stamp}`, supplier: 'Princess',
      departDate: isoDay(60), returnDate: isoDay(67), gross: '4200', status: 'booked',
    });
    const tripId = trip.data?.booking?.id;
    if (tripId) cleanup('the itinerary reservation',
      () => call(advisor, 'DELETE', `/api/bookings/${tripId}`));

    const empty = await call(advisor, 'GET', `/api/bookings/${tripId}/itinerary`);
    check(empty.data?.dayCount === 8,
      'the days come from the reservation rather than being typed again',
      `${empty.data?.dayCount}`);
    check((empty.data?.days || []).length === 8 && empty.data.days.every((d) => !d.items.length),
      'and every day is there before anything is on it');

    const made = await call(advisor, 'POST', `/api/bookings/${tripId}/itinerary`, {
      dayNumber: 3, startTime: '8:00 am', endTime: '17:00', kind: 'activity',
      title: 'Snorkelling at Palancar Reef', location: 'Cozumel',
      detail: 'Meet the guide at the pier.', confirmation: 'CZ-88412',
    });
    check(made.status === 201, 'an item can be put on a day', `status ${made.status}`);

    const loaded = await call(advisor, 'GET', `/api/bookings/${tripId}/itinerary`);
    const day3 = (loaded.data?.days || []).find((d) => d.dayNumber === 3);
    check(day3?.items?.length === 1, 'and lands on that day', JSON.stringify(day3?.items?.length));
    check(day3?.items?.[0]?.start_time === '08:00',
      'with 8:00 am read as 08:00, so the day sorts by time and not by typing',
      day3?.items?.[0]?.start_time);
    check(day3?.date === isoDay(62),
      'the date worked out from departure rather than stored beside it', day3?.date);

    const badTime = await call(advisor, 'POST', `/api/bookings/${tripId}/itinerary`, {
      dayNumber: 1, title: 'Nonsense', startTime: 'after lunch',
    });
    check(badTime.status === 400, 'a time nobody can read is refused rather than dropped',
      `status ${badTime.status}`);

    const httpPic = await call(advisor, 'POST', `/api/bookings/${tripId}/itinerary`, {
      dayNumber: 1, title: 'Insecure picture', imageUrl: 'http://example.com/a.jpg',
    });
    check(httpPic.status === 400,
      'and a picture over plain http is refused, since the client page is https',
      `status ${httpPic.status}`);

    const anytime = await call(advisor, 'POST', `/api/bookings/${tripId}/itinerary`, {
      kind: 'note', title: 'Travel insurance', detail: 'Policy AGL-7741.',
    });
    check(anytime.status === 201, 'something true of the whole trip needs no day');
    const withNote = await call(advisor, 'GET', `/api/bookings/${tripId}/itinerary`);
    check((withNote.data?.anytime || []).length === 1
      && withNote.data.days.every((d) => d.items.every((i) => i.title !== 'Travel insurance')),
      'and is kept apart rather than dumped on day one');

    // The gate. A half written itinerary is worse than none.
    const shared = await call(advisor, 'POST', `/api/bookings/${tripId}/share`, { shared: true });
    const code = shared.data?.code;
    // Asserted rather than assumed. Reading the wrong field leaves this
    // undefined, /t/undefined is a 404, and both checks below would then be
    // testing a missing page instead of the gate.
    check(Boolean(code), 'the trip page has a code to test against', JSON.stringify(shared.data));
    const off = await fetch(`${BASE}/t/${code}`).then((r) => r.text());
    check(!/Your itinerary/.test(off) && !/Palancar/.test(off),
      'the client sees nothing until the advisor says it is ready');

    await call(advisor, 'POST', `/api/bookings/${tripId}/itinerary-shared`, { shared: true });
    const on = await fetch(`${BASE}/t/${code}`).then((r) => r.text());
    check(/Your itinerary/.test(on) && /Palancar/.test(on),
      'and sees it once they do');
    check(/Nothing planned/.test(on),
      'with the empty days saying so, because a gap in a numbered list is a question');

    // An associate's trip is not theirs to plan; the agency's owner may.
    const theirs = await call(admin, 'POST', `/api/bookings/${tripId}/itinerary`, {
      dayNumber: 1, title: `Added By Owner ${stamp}`,
    });
    check(theirs.status === 200 || theirs.status === 201,
      'the agency owner can add to it', `status ${theirs.status}`);
  }

  // ----------------------------------------------- the page on paper ------
  // Half the clients who get a trip page print it or save it as a PDF before
  // they travel, and the version that came out carried a note box, a Send it
  // button and no way to ring anybody.
  step('The trip page as something to keep');
  {
    const t = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Printable ${stamp}`, supplier: 'Princess',
      departDate: isoDay(300), returnDate: isoDay(307), gross: '4200', status: 'booked',
    });
    const pid = t.data?.booking?.id;
    if (pid) cleanup('the printable reservation',
      () => call(advisor, 'DELETE', `/api/bookings/${pid}`));

    await call(advisor, 'POST', `/api/bookings/${pid}/itinerary`, {
      dayNumber: 3, kind: 'activity', title: 'Snorkelling',
      location: 'Cozumel, Mexico',
    });
    await call(advisor, 'POST', `/api/bookings/${pid}/itinerary-shared`, { shared: true });
    const code = (await call(advisor, 'POST', `/api/bookings/${pid}/share`, { shared: true }))
      .data?.code;
    const html = await fetch(`${BASE}/t/${code}`).then((r) => r.text());

    check(/id="print-it"/.test(html), 'the page offers to print itself');
    check(/@media print/.test(html), 'and carries rules for what that should look like');
    check(/form#say,#say[^}]*display:none/.test(html.replace(/\s+/g, ''))
      || /#say,\.obtn/.test(html.replace(/\s+/g, '')),
      'with the note box left off the paper version');
    // Who to ring, rather than the markup that used to carry it. This asserted
    // class="printonly", a block in the footer repeating the advisor, the
    // agency, the email and the phone that the Questions card above already
    // prints, so it went on passing while a printed proposal named the advisor
    // twice and the agency three times. The fact is what matters: the contact
    // line is there, and nothing in the print rules takes it off the paper.
    check(html.includes(ADVISOR_EMAIL) && /class="contact"/.test(html),
      'and the advisor named on it, since a printed itinerary with nobody to ring gets binbotted'
        .replace('binbotted', 'binned'),
      html.includes(ADVISOR_EMAIL) ? 'no contact line' : 'the advisor email is not on the page');
    check(!/\.contact[^}]*display:none/.test(html.replace(/\s+/g, '')),
      'and the paper version keeps it');
    check(html.includes(`/t/${code}`) && /data-url=/.test(html),
      'carrying the address of the live page, so paper can find its way back to it');

    // A place on an itinerary line is worth being able to find.
    check(/maps\/search\/\?api=1&amp;query=Cozumel%2C%20Mexico/.test(html),
      'a place on the itinerary opens in whatever maps app the reader uses',
      html.match(/maps\/search[^"]*/)?.[0]);
    check(/class="itin-map"[^>]*rel="noopener noreferrer"/.test(html)
      || /rel="noopener noreferrer"[^>]*class="itin-map"/.test(html)
      || /itin-map[\s\S]{0,120}noopener/.test(html),
      'as a link out, not an embedded map needing a key and somebody else\'s script');

    await call(advisor, 'DELETE', `/api/bookings/${pid}`);
  }

  // ------------------------------------------- the client answers back -----
  // The options existed and the page showed them read only, under "tell your
  // advisor below". So the client typed their pick into a message box and
  // somebody transcribed it, which is a proposal stopping one step short of
  // the only thing a proposal is for.
  step('A client chooses from the proposal');
  {
    const q = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Proposal ${stamp}`, supplier: 'Princess',
      departDate: isoDay(200), returnDate: isoDay(207), status: 'quoted',
    });
    const qid = q.data?.booking?.id;
    if (qid) cleanup('the proposal reservation',
      () => call(advisor, 'DELETE', `/api/bookings/${qid}`));

    const badPic = await call(advisor, 'POST', `/api/bookings/${qid}/options`, {
      label: 'Insecure', amount: '100', imageUrl: 'http://example.com/a.jpg',
    });
    check(badPic.status === 400,
      'a picture over plain http is refused, since the page it loads on is https',
      `status ${badPic.status}`);

    await call(advisor, 'POST', `/api/bookings/${qid}/options`, {
      label: 'Inside', amount: '2196.00', inclusions: 'Wi-Fi for one\nGratuities',
      imageUrl: 'https://example.com/inside.jpg',
    });
    await call(advisor, 'POST', `/api/bookings/${qid}/options`, {
      label: 'Balcony', amount: '2996.00', inclusions: 'Drinks package\n$100 credit',
    });
    const rec = await call(advisor, 'GET', `/api/bookings/${qid}/record`);
    const balcony = (rec.data?.options || []).find((o) => o.label === 'Balcony');
    check((rec.data?.options || []).length === 2 && balcony,
      'two options sit on the quote', `${(rec.data?.options || []).length}`);
    check((rec.data.options.find((o) => o.label === 'Inside') || {}).inclusions
      === 'Wi-Fi for one\nGratuities',
      'each carrying what is included, which is the part they compare');

    const code = (await call(advisor, 'POST', `/api/bookings/${qid}/share`, { shared: true }))
      .data?.code;
    check(Boolean(code), 'the trip page has a code to answer on', JSON.stringify(code));

    // Shut until the advisor opens it.
    const shut = await fetch(`${BASE}/t/${code}/choose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: balcony.id }),
    });
    check(shut.status === 400,
      'a quote still being written cannot be answered', `status ${shut.status}`);

    await call(advisor, 'POST', `/api/bookings/${qid}/options-open`, { open: true });
    const page = await fetch(`${BASE}/t/${code}`).then((r) => r.text());
    check(/Choose your trip/.test(page) && /Choose this one/.test(page),
      'once open the page asks rather than tells');
    check(/Nothing is booked and nothing is paid by choosing/.test(page),
      'and says plainly that choosing is not paying');

    const picked = await fetch(`${BASE}/t/${code}/choose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: balcony.id }),
    }).then((r) => r.json());
    check(picked.ok === true && picked.chosen === balcony.id,
      'the client picks one with no account and no session', JSON.stringify(picked).slice(0, 90));

    const after = await call(advisor, 'GET', `/api/bookings/${qid}/record`);
    const chosen = (after.data?.options || []).filter((o) => o.chosen);
    check(chosen.length === 1 && chosen[0].id === balcony.id,
      'exactly one is marked, not two');
    check(chosen[0].chosen_by === 'client' && chosen[0].chosen_at,
      'stamped as theirs and when, because that is different from the advisor ticking it',
      `${chosen[0].chosen_by}`);
    // The whole point of keeping money out of it.
    check(!after.data.booking.gross_cents,
      'and the reservation price is untouched: choosing is a decision, not a payment',
      `${after.data.booking.gross_cents}`);

    const said = await call(advisor, 'GET', `/api/bookings/${qid}/messages`);
    check((said.data?.messages || []).some((m) => /Chose "Balcony"/.test(m.body)),
      'the choice lands in the conversation too, so it is all in one place');

    // Changing their mind moves the mark rather than adding a second.
    const inside = (after.data.options).find((o) => o.label === 'Inside');
    await fetch(`${BASE}/t/${code}/choose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: inside.id }),
    });
    const moved = await call(advisor, 'GET', `/api/bookings/${qid}/record`);
    check((moved.data.options || []).filter((o) => o.chosen).length === 1
      && (moved.data.options.find((o) => o.chosen) || {}).id === inside.id,
      'changing their mind moves the mark rather than adding a second');

    const nonsense = await fetch(`${BASE}/t/${code}/choose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'not-an-option' }),
    });
    check(nonsense.status === 400, 'an option that is not on this quote is refused',
      `status ${nonsense.status}`);

    const bot = await fetch(`${BASE}/t/${code}/choose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: balcony.id, company_website: 'spam.example' }),
    }).then((r) => r.json());
    const afterBot = await call(advisor, 'GET', `/api/bookings/${qid}/record`);
    check(bot.ok === true
      && (afterBot.data.options.find((o) => o.chosen) || {}).id === inside.id,
      'a bot is thanked and changes nothing, so it learns which it was from neither');

    await call(advisor, 'POST', `/api/bookings/${qid}/options-open`, { open: false });
    const closed = await fetch(`${BASE}/t/${code}`).then((r) => r.text());
    check(/What was offered/.test(closed) && !/data-choose=/.test(closed),
      'closing it puts the page back to showing rather than asking');

    // Removed here rather than left to the final sweep. The dashboard's quote
    // panel shows twelve, and an extra quote left lying about for the rest of
    // the run pushes somebody else's fixture off the end of it.
    await call(advisor, 'DELETE', `/api/bookings/${qid}`);
  }

  // ---------------------------------------------- written once, reused -----
  // The builder without this is a retyping exercise, which is where a tool
  // like it gets abandoned: doing the job twice is slower than the email.
  step('An itinerary piece kept and reused');
  {
    const t1 = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Library A ${stamp}`, supplier: 'Princess',
      departDate: isoDay(80), returnDate: isoDay(87), gross: '3000', status: 'booked',
    });
    const b1 = t1.data?.booking?.id;
    if (b1) cleanup('the library source trip',
      () => call(advisor, 'DELETE', `/api/bookings/${b1}`));

    await call(advisor, 'POST', `/api/bookings/${b1}/itinerary`, {
      dayNumber: 3, startTime: '08:00', kind: 'activity',
      title: 'Snorkelling at Palancar Reef', location: 'Cozumel',
      detail: 'Meet the guide at the pier at 7:45.', confirmation: 'CZ-1',
    });
    const src = (await call(advisor, 'GET', `/api/bookings/${b1}/itinerary`)).data.items[0];

    const kept = await call(advisor, 'POST', '/api/itinerary-library', {
      fromItem: src.id, name: `Cozumel: Palancar ${stamp}`,
    });
    const pieceId = kept.data?.id;
    if (pieceId) cleanup('the library piece',
      () => call(advisor, 'DELETE', `/api/itinerary-library/${pieceId}`));
    check(kept.status === 201 && pieceId,
      'an item written on a trip can be kept for the next one', `status ${kept.status}`);

    const listed = (await call(advisor, 'GET', '/api/itinerary-library')).data.pieces || [];
    const mine = listed.find((p) => p.id === pieceId);
    check(mine?.title === 'Snorkelling at Palancar Reef' && mine?.location === 'Cozumel',
      'carrying the wording and the place, which is the part worth keeping');
    check(mine?.start_time === '08:00', 'and the time, so it lands where it belongs');

    // The whole design rests on this: a piece is a starting point, not a parent.
    const t2 = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Library B ${stamp}`, supplier: 'Princess',
      departDate: isoDay(120), returnDate: isoDay(127), gross: '3000', status: 'booked',
    });
    const b2 = t2.data?.booking?.id;
    if (b2) cleanup('the library target trip',
      () => call(advisor, 'DELETE', `/api/bookings/${b2}`));

    const used = await call(advisor, 'POST', `/api/bookings/${b2}/itinerary/from-library`,
      { pieceId, dayNumber: 2 });
    check(used.status === 201, 'and dropped onto another trip', `status ${used.status}`);

    const onB2 = (await call(advisor, 'GET', `/api/bookings/${b2}/itinerary`)).data;
    const copied = (onB2.days.find((d) => d.dayNumber === 2)?.items || [])[0];
    check(copied?.title === 'Snorkelling at Palancar Reef', 'landing on the day asked for');
    check(copied?.confirmation === null,
      'without the confirmation number, which belonged to the other client',
      JSON.stringify(copied?.confirmation));

    // Copied, not linked.
    await call(advisor, 'PUT', `/api/itinerary-library/${pieceId}`, {
      name: `Cozumel: Palancar ${stamp}`, title: 'Snorkelling, rewritten later',
    });
    const after = (await call(advisor, 'GET', `/api/bookings/${b2}/itinerary`)).data;
    const still = (after.days.find((d) => d.dayNumber === 2)?.items || [])[0];
    check(still?.title === 'Snorkelling at Palancar Reef',
      'rewriting the library later does not rewrite a trip already built from it',
      still?.title);

    const counted = ((await call(advisor, 'GET', '/api/itinerary-library')).data.pieces || [])
      .find((p) => p.id === pieceId);
    check(counted?.used_count === 1,
      'and a use is counted, so the ones reached for rise up a long list',
      `${counted?.used_count}`);

    // Shared across the agency like the supplier directory, and no further.
    const colleague = (await call(admin, 'GET', '/api/itinerary-library')).data.pieces || [];
    check(colleague.some((p) => p.id === pieceId),
      'a colleague in the same agency has it too, since it is what the agency knows');

    // The fence itself is proved in the supplier section, which drives a real
    // second agency through the same agencyScope helper this list uses. What
    // is worth checking here is that a piece nobody can reach is a 404 rather
    // than a blank item quietly added to somebody's trip.
    const ghost = await call(advisor, 'POST', `/api/bookings/${b2}/itinerary/from-library`,
      { pieceId: 'no-such-piece' });
    check(ghost.status === 404, 'a piece that is not there cannot be used',
      `status ${ghost.status}`);
    const afterGhost = (await call(advisor, 'GET', `/api/bookings/${b2}/itinerary`)).data;
    check(afterGhost.items.length === 1,
      'and nothing is added to the trip when it fails', `${afterGhost.items.length}`);

    const noTitle = await call(advisor, 'POST', '/api/itinerary-library', { name: 'Nameless' });
    check(noTitle.status === 400, 'a piece with nothing to say is refused',
      `status ${noTitle.status}`);
  }

  // ------------------------------------------------ people in one house -----
  // A client record is one person and stays one. A household is the fact that
  // two of those rows are married, which the portal had no way to know, so the
  // second name on a leisure booking was typed from memory every time.
  step('Two clients who live together');
  {
    const one = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Ada Fair${stamp}`, supplier: 'Princess',
      departDate: isoDay(140), gross: '4000', status: 'booked',
    });
    const two = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Bram Fair${stamp}`, supplier: 'Princess',
      departDate: isoDay(141), gross: '1000', status: 'booked',
    });
    const aId = one.data?.booking?.client_id;
    const bId = two.data?.booking?.client_id;
    if (one.data?.booking?.id) cleanup('the household reservation A',
      () => call(advisor, 'DELETE', `/api/bookings/${one.data.booking.id}`));
    if (two.data?.booking?.id) cleanup('the household reservation B',
      () => call(advisor, 'DELETE', `/api/bookings/${two.data.booking.id}`));

    const alone = await call(advisor, 'POST', '/api/households', { clientIds: [aId] });
    check(alone.status === 400, 'one person is not a household', `status ${alone.status}`);

    const made = await call(advisor, 'POST', '/api/households', { clientIds: [aId, bId] });
    const houseId = made.data?.id;
    if (houseId) cleanup('the household',
      () => call(advisor, 'DELETE', `/api/households/${houseId}`));
    check(made.status === 201 && houseId && made.data?.members === 2,
      'two of them can be made one', JSON.stringify(made.data));
    check(made.data?.name === `The Fair${stamp} household`,
      'named from the surname they share', made.data?.name);

    // Two surnames under one roof, which is the commoner case than anybody
    // building this feature expects.
    const mixedA = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Cara Vance${stamp}`, supplier: 'Princess',
      departDate: isoDay(142), gross: '1000', status: 'booked',
    });
    const mixedB = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Dan Ridley${stamp}`, supplier: 'Princess',
      departDate: isoDay(143), gross: '1000', status: 'booked',
    });
    for (const r of [mixedA, mixedB]) {
      if (r.data?.booking?.id) cleanup('a mixed household reservation',
        () => call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
    }
    const mixed = await call(advisor, 'POST', '/api/households',
      { clientIds: [mixedA.data?.booking?.client_id, mixedB.data?.booking?.client_id] });
    if (mixed.data?.id) cleanup('the mixed household',
      () => call(advisor, 'DELETE', `/api/households/${mixed.data.id}`));
    check(mixed.data?.name === `Vance${stamp} & Ridley${stamp}`,
      'two surnames are both kept rather than one being invented for them',
      mixed.data?.name);

    // Somebody else's client must not be draggable into your house.
    const theirs = await call(admin, 'POST', '/api/households', { clientIds: [aId, bId] });
    check(theirs.status === 400,
      'and another advisor cannot make a household of your clients',
      `status ${theirs.status}`);

    const rec = await call(advisor, 'GET', `/api/client?id=${aId}`);
    const h = rec.data?.household;
    check(Boolean(h) && h.members.length === 2,
      'the client record knows who else lives there', JSON.stringify(h && h.members.length));
    check(h?.lifetimeCents === 500000,
      'and what the house is worth together, not just this one',
      `${h?.lifetimeCents}`);

    // The address is typed once, on the house.
    await call(advisor, 'PUT', `/api/households/${houseId}`, {
      name: 'The Fixtures', address: '12 Harbour Row', phone: '409-555-0100',
    });
    const named = await call(advisor, 'GET', `/api/client?id=${bId}`);
    check(named.data?.household?.name === 'The Fixtures'
      && named.data?.household?.address === '12 Harbour Row',
      'and both of them read the same address', named.data?.household?.address);

    // The payoff: writing a reservation for one offers the other.
    const offer = await call(advisor, 'GET',
      `/api/households/travellers?client=${aId}`);
    check(offer.data?.travellers?.length === 1
      && offer.data.travellers[0].name === `Bram Fair${stamp}`,
      'booking one of them offers the rest of the house as travellers',
      JSON.stringify(offer.data?.travellers));
    check(!offer.data.travellers.some((t) => t.clientId === aId),
      'and never the person already on the booking');

    const byName = await call(advisor, 'GET',
      `/api/households/travellers?name=${encodeURIComponent(`Ada Fair${stamp}`)}`);
    check(byName.data?.travellers?.length === 1,
      'by name too, which is all the new reservation form has while it is typed');

    const lonely = await call(advisor, 'GET',
      `/api/households/travellers?name=${encodeURIComponent(`Priced ${stamp}`)}`);
    check(lonely.status === 200 && lonely.data?.household === null
      && (lonely.data?.travellers || []).length === 0,
      'somebody in no household offers nobody, rather than failing');

    // Moving out leaves them with everything they had, and one person left
    // behind is not a household.
    const out = await call(advisor, 'DELETE', `/api/households/${houseId}/members/${bId}`);
    check(out.status === 200 && out.data?.dissolved === true,
      'moving one out of a pair dissolves the household', JSON.stringify(out.data));
    const after = await call(advisor, 'GET', `/api/client?id=${aId}`);
    check(after.data?.household === null && after.data?.client?.trips === 1,
      'and the one left keeps their own trips', JSON.stringify(after.data?.client?.trips));
  }

  // --------------------------------------- the agency's way of working -----
  // Templates used to be one advisor's, so somebody joining booked their first
  // cruise and nothing happened. They work from memory and work differently,
  // which is the difference between an agency and a group of people sharing a
  // login page. The agency's now, with room for an advisor's own on top.
  step('The tasks that follow every trip belong to the agency');
  {
    const shared = await call(admin, 'POST', '/api/task-templates', {
      title: `Confirm the group rate ${stamp}`, kind: 'call',
      anchor: 'depart_date', offsetDays: -30, shared: true,
    });
    const sharedId = (shared.data?.templates || []).find(
      (t) => t.title === `Confirm the group rate ${stamp}`)?.id;
    check(shared.status === 201 && sharedId,
      'the agency owner writes a template for everybody', `status ${shared.status}`);
    if (sharedId) {
      cleanup('the shared template',
        () => call(admin, 'DELETE', `/api/task-templates/${sharedId}`));
    }

    // The whole point: an advisor who wrote nothing has it.
    const theirs = await call(advisor, 'GET', '/api/task-templates');
    const seen = (theirs.data?.templates || []).find((t) => t.id === sharedId);
    check(Boolean(seen) && seen.shared === 1,
      'and an advisor who wrote nothing has it, marked as the agency\'s');
    check(theirs.data?.canShare === false,
      'while an associate is not offered the tick at all');

    // And it actually fires, which is the only thing that matters.
    const fresh = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Agency Process ${stamp}`, supplier: 'Princess',
      departDate: isoDay(120), status: 'booked',
    });
    const freshId = fresh.data?.booking?.id;
    if (freshId) cleanup('the agency process reservation',
      () => call(advisor, 'DELETE', `/api/bookings/${freshId}`));
    const madeTasks = await call(advisor, 'GET', `/api/tasks?booking=${freshId}`);
    const fromShared = (madeTasks.data?.tasks || [])
      .find((t) => t.title === `Confirm the group rate ${stamp}`);
    check(Boolean(fromShared),
      'and a new reservation runs the agency\'s process, not an empty list',
      (madeTasks.data?.tasks || []).map((t) => t.title).join(' / ') || '(none)');
    check(fromShared?.due_date === isoDay(90),
      'on the date the template asked for', fromShared?.due_date);

    // An associate must not be able to change how their colleagues work.
    const edit = await call(advisor, 'PUT', `/api/task-templates/${sharedId}`,
      { title: 'Rewritten', anchor: 'depart_date', offsetDays: -30 });
    check(edit.status === 400, 'an associate cannot rewrite the agency\'s template',
      `status ${edit.status}`);
    const drop = await call(advisor, 'DELETE', `/api/task-templates/${sharedId}`);
    check(drop.status === 400, 'nor remove it', `status ${drop.status}`);
    const askShare = await call(advisor, 'POST', '/api/task-templates', {
      title: `Sneaky ${stamp}`, anchor: 'depart_date', offsetDays: -1, shared: true,
    });
    check(askShare.status === 400,
      'nor write one for everybody by asking nicely', `status ${askShare.status}`);

    // Their own stay their own, in both directions.
    const mine = await call(advisor, 'POST', '/api/task-templates', {
      title: `My own habit ${stamp}`, anchor: 'depart_date', offsetDays: -2,
    });
    const mineId = (mine.data?.templates || []).find(
      (t) => t.title === `My own habit ${stamp}`)?.id;
    check(mine.status === 201 && mineId, 'an advisor can still keep a template of their own');
    if (mineId) {
      cleanup('the personal template',
        () => call(advisor, 'DELETE', `/api/task-templates/${mineId}`));
    }
    const ownerSees = await call(admin, 'GET', '/api/task-templates');
    check(!(ownerSees.data?.templates || []).some((t) => t.id === mineId),
      'and it is not pushed onto anybody else, the owner included');

    const stillShared = await call(admin, 'GET', '/api/task-templates');
    check((stillShared.data?.templates || []).find((t) => t.id === sharedId)?.title
      === `Confirm the group rate ${stamp}`,
      'and the agency template survived being reached for');
  }

  // ------------------------------------------- one directory per agency -----
  // The supplier directory used to belong to whoever typed it in, so a new
  // joiner opened an empty screen while the rates and the desk contacts sat on
  // somebody else's copy. It is the agency's now, which is a widening, and a
  // widening is only safe if it stops at the agency.
  step('The vendor directory is the agency\'s, not one advisor\'s');
  {
    // A second advisor in the same agency as the smoke advisor.
    const mateEmail = `mate-${stamp}@test.dev`;
    const mateUser = await makeAdvisor(admin, mateEmail, 'mate-test-12345',
      { firstName: 'Same', lastName: 'Agency' });
    check(Boolean(mateUser), 'a colleague can be added to the same agency');
    await call(admin, 'PUT', `/api/admin/advisors/${mateUser.id}/agency`,
      { agencyId: 'agency-house', platformOwner: false, role: 'advisor' });
    cleanup('the colleague', () => call(admin, 'PUT',
      `/api/admin/advisors/${mateUser.id}/status`, { status: 'suspended' }));

    const mate = jar();
    await call(mate, 'POST', '/api/auth/login', { email: mateEmail, password: 'mate-test-12345' });

    // The smoke advisor records a supplier with the detail worth sharing.
    const made = await call(advisor, 'POST', '/api/vendors', {
      name: `Halcyon Lines ${stamp}`, category: 'Cruise Lines', commissionPct: '16',
      bdmName: 'Dana Reid', bdmPhone: '555-0143', phone: '555-0100',
    });
    const vendorId = made.data?.id;
    check(made.status === 200 || made.status === 201, 'one advisor records a supplier',
      `status ${made.status}`);

    // The whole point: their colleague sees it without doing anything. Searched
    // rather than scanned, because the directory is capped and a book with two
    // thousand suppliers in it would fail this on the cap rather than on the
    // sharing, which is a test that reports the wrong thing.
    const mateSees = await call(mate, 'GET',
      `/api/vendors?q=${encodeURIComponent(`Halcyon Lines ${stamp}`)}`);
    const seen = (mateSees.data?.vendors || []).find((v) => v.id === vendorId);
    check(Boolean(seen), 'and a colleague in the same agency sees it straight away',
      (mateSees.data?.vendors || []).length + ' matched the search');
    check(seen?.commission_pct === 16 && seen?.bdm_name === 'Dana Reid',
      'with the rate and the desk contact on it, which is the part worth sharing',
      JSON.stringify({ pct: seen?.commission_pct, bdm: seen?.bdm_name }));

    const detail = await call(mate, 'GET', `/api/vendors/${vendorId}`);
    check(detail.status === 200 && detail.data?.canEdit === true,
      'and may edit it, because the directory is shared rather than lent',
      `status ${detail.status} canEdit ${detail.data?.canEdit}`);

    // Typing the same supplier again should be refused rather than making the
    // second copy this whole change exists to stop.
    const again = await call(mate, 'POST', '/api/vendors', { name: `halcyon lines ${stamp}` });
    check(again.status === 400,
      'and typing it a second time is refused however it is capitalised',
      `status ${again.status}`);

    // A reservation naming the supplier links to the existing record instead
    // of quietly making an eighth Carnival.
    const booked = await call(mate, 'POST', '/api/bookings', {
      clientName: `Shared Vendor Client ${stamp}`, supplier: `Halcyon Lines ${stamp}`,
      departDate: isoDay(90), gross: '2000', status: 'booked',
    });
    const sharedBooking = booked.data?.booking?.id;
    if (sharedBooking) cleanup('the shared vendor reservation',
      () => call(advisor, 'DELETE', `/api/bookings/${sharedBooking}`));
    check(booked.data?.booking?.vendor_id === vendorId,
      'and a colleague booking that supplier links to the same record, not a new one',
      `${booked.data?.booking?.vendor_id} vs ${vendorId}`);

    // The trips on the vendor page are the agency's, not the record author's.
    const withTrips = await call(advisor, 'GET', `/api/vendors/${vendorId}`);
    check((withTrips.data?.bookings || []).some((b) => b.id === sharedBooking),
      'the supplier page shows what the agency has sold, not only your own');

    // And the fence still holds. The rival agency from the section above must
    // see none of this.
    const rivalEmail2 = `vfence-${stamp}@test.dev`;
    const rivalAgency = await call(admin, 'POST', '/api/agencies',
      { name: `Fence Test ${stamp}` });
    const fenceId = rivalAgency.data?.agency?.id;
    const fenceUser = await makeAdvisor(admin, rivalEmail2, 'fence-test-12345',
      { firstName: 'Other', lastName: 'Agency' });
    check(Boolean(fenceUser), 'and an advisor for the other agency');
    // Created in the admin's agency, then moved, because there is no public
    // link to join a particular agency any more.
    await call(admin, 'PUT', `/api/admin/advisors/${fenceUser.id}/agency`,
      { agencyId: fenceId, platformOwner: false, role: 'advisor' });
    cleanup('the other agency advisor', () => call(admin, 'PUT',
      `/api/admin/advisors/${fenceUser.id}/status`, { status: 'suspended' }));

    const outsider = jar();
    await call(outsider, 'POST', '/api/auth/login',
      { email: rivalEmail2, password: 'fence-test-12345' });

    const theirs = await call(outsider, 'GET',
      `/api/vendors?q=${encodeURIComponent(`Halcyon Lines ${stamp}`)}`);
    check((theirs.data?.vendors || []).length === 0,
      'another agency sees none of it, which is what makes the sharing safe',
      (theirs.data?.vendors || []).length + ' matched the search');

    const reach = await call(outsider, 'GET', `/api/vendors/${vendorId}`);
    check(reach.status === 404, 'and cannot open it by id either', `status ${reach.status}`);

    const rename = await call(outsider, 'PUT', `/api/vendors/${vendorId}`,
      { name: 'Hijacked', category: 'Cruise Lines' });
    const stillNamed = await call(advisor, 'GET', `/api/vendors/${vendorId}`);
    check(stillNamed.data?.vendor?.name === `Halcyon Lines ${stamp}`,
      'nor rename it from outside the agency',
      `${rename.status} then ${stillNamed.data?.vendor?.name}`);

    void fenceId;
    cleanup('the shared vendor', () => call(advisor, 'DELETE', `/api/vendors/${vendorId}`));
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
    clientName: `Corrected By Owner ${stamp}`, amount: '1',
  });
  check(ownerCredit.status === 200, 'an owner can correct an associate\'s credit',
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

  // Searched, not scanned. The directory is the whole agency's now, so an
  // associate sees a book of thousands rather than the handful they typed in,
  // and the list is capped.
  const vl = await call(advisor, 'GET',
    `/api/vendors?q=${encodeURIComponent(`Petrel Line ${stamp}`)}`);
  const kestrel = (vl.data?.vendors || []).find((v) => v.name === `Petrel Line ${stamp}`);
  if (!check(Boolean(kestrel), 'the vendor behind a reservation is findable',
    `${(vl.data?.vendors || []).length} matched`)) {
    throw new Bail('No vendor to price against.');
  }
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

  // The owner may add to an associate's reservation, and what they add belongs
  // to the associate. A traveller filed under the owner would be invisible to
  // the advisor whose trip it is, which is worse than not being able to add it.
  const byOwner = await call(admin, 'POST', `/api/bookings/${tripId}/travellers`,
    { name: `Added By Owner ${stamp}` });
  check(byOwner.status === 201, 'an owner can add a traveller to an associate\'s reservation',
    `status ${byOwner.status}`);
  const rec7 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  check((rec7.data?.travellers || []).some((t) => t.name === `Added By Owner ${stamp}`),
    'and the associate sees it on their own reservation',
    (rec7.data?.travellers || []).map((t) => t.name).join(', '));
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

  // Every duplicate offered has to be mergeable. That used to mean every vendor
  // in the group belonged to the caller, because a merge could only move your
  // own. The directory is the agency's now and so is the merge, so the rule is
  // the agency rather than the advisor: a group spanning two people is the
  // case most worth catching, since that is how one supplier ends up entered
  // twice in the first place.
  const known = new Set((vlist.data?.vendors || []).map((v) => v.id));
  const everyGroupIsReachable = (vlist.data?.stats?.possibleDuplicates || [])
    .every((g) => g.every((v) => known.has(v.id)));
  check(everyGroupIsReachable,
    'and every vendor in a duplicate group is one this advisor can actually merge');

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

  // A supplier-list refresh must not take an advisor's notes with it. Every
  // other field in that statement is what the partner list says about a
  // supplier and is worth refreshing; notes are the one field on the record
  // that somebody typed, and the import was overwriting them with whatever
  // the file carried, or blanking them when it carried nothing.
  //
  // Driven as the owner, because importing a directory writes several hundred
  // rows and is admin only.
  {
    const supplier = `Refresh ${stamp}`;
    const row = { name: supplier, category: 'Cruise Lines', status: 'Preferred' };
    const made = await call(admin, 'POST', '/api/vendors/import', { commit: true, rows: [row] });

    const find = async () => {
      const list = await call(admin, 'GET', '/api/vendors');
      return (list.data?.vendors || []).find((v) => v.name === supplier);
    };
    const imported = made.status === 200 ? await find() : null;

    if (!imported) {
      skip('the supplier refresh',
        `the import answered ${made.status} and left no row to check`);
    } else {
      cleanup('the refreshed supplier', () => call(admin, 'DELETE', `/api/vendors/${imported.id}`));

      const typed = 'Ring Maria, not the desk.';
      await call(admin, 'PUT', `/api/vendors/${imported.id}`,
        { name: supplier, category: 'Cruise Lines', notes: typed });
      await call(admin, 'POST', '/api/vendors/import', { commit: true, rows: [row] });

      const after = await find();
      check(after && after.notes === typed,
        'a supplier list refresh leaves the notes somebody typed alone',
        after && JSON.stringify(after.notes));
      check(after && after.partner_status === 'Preferred',
        'and still refreshes what the partner list is the record for',
        after && after.partner_status);
    }
  }

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

  // The star is on the shared record now, so a colleague may set it. What must
  // not happen is somebody outside the agency doing so, and that is checked in
  // the directory section against a real outsider rather than here.
  const notMineStar = await call(admin, 'POST', `/api/vendors/${keep.id}/favourite`,
    { favourite: true });
  check(notMineStar.status === 200, 'and a colleague can star a shared vendor',
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

  // Searched rather than scanned. The directory is the whole agency's now, so
  // this list is as long as the agency is old and the cap is reached long
  // before a name typed a second ago.
  const withNew = await call(advisor, 'GET',
    `/api/vendors?q=${encodeURIComponent(`Windstar ${stamp}`)}`);
  const fresh = (withNew.data?.vendors || []).find((v) => v.id === made.data.id);
  check(Boolean(fresh), 'and is found by a search straight away',
    `${(withNew.data?.vendors || []).length} matched`);
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

  // Groups and credits stay personal; the supplier directory does not. An
  // owner correcting a commission rate is fixing the agency's copy, which is
  // the only copy there is.
  const sharedVendor = await call(admin, 'PUT', `/api/vendors/${keep.id}`,
    { name: keep.name, commissionPct: 12 });
  check(sharedVendor.status === 200, 'an owner may correct the agency\'s vendor record',
    `status ${sharedVendor.status}`);
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

  // Correcting a row, and taking one off.
  //
  // On a payment of its own. The first version of this reached for the final
  // balance already on this reservation, corrected it and then deleted it,
  // which is fine until you notice that four checks below chase that same row.
  // A test that changes a fixture its neighbours read has to bring its own.
  //
  // The edit dialog shows an amount, a date and how it was paid. It does not
  // show which kind of row this is, whether it is the vendor's deadline or an
  // advisor's reminder, when it falls due, or the note saying where it came
  // from. This endpoint writes every column, so all four have to survive a
  // save that never mentions them: the same rule a reservation save broke for
  // ten days, here where breaking it would move a vendor deadline.
  const spare = await call(advisor, 'POST', '/api/payments', {
    bookingId: chaseId, kind: 'installment', paymentClass: 'hard',
    amount: '300.00', dueDate: isoDay(20), notes: `Part payment ${stamp}`,
  });
  const spareId = spare.data?.payment?.id;
  check(spare.status === 201 && spareId, 'a part payment goes on the schedule',
    `status ${spare.status}`);

  if (spareId) {
    const edited = await call(advisor, 'PUT', `/api/payments/${spareId}`, {
      bookingId: chaseId, amount: '250.00', paidDate: isoDay(0),
    });
    check(edited.status === 200, 'and can be corrected', `status ${edited.status}`);

    const afterEdit = await call(advisor, 'GET', `/api/bookings/${chaseId}/record`);
    const fixed = (afterEdit.data?.payments || []).find((x) => x.id === spareId);
    check(fixed && fixed.amount_cents === 25000,
      'the amount that was sent is the amount that lands', String(fixed && fixed.amount_cents));
    check(fixed && fixed.kind === 'installment' && fixed.payment_class === 'hard',
      'and what kind of row it is survives a form that never asked',
      `${fixed && fixed.kind}/${fixed && fixed.payment_class}`);
    check(fixed && fixed.due_date === isoDay(20),
      'as does the date the vendor wants it by', String(fixed && fixed.due_date));
    check(fixed && fixed.notes === `Part payment ${stamp}`,
      'as does the note saying where the row came from', String(fixed && fixed.notes));

    // And off again. Two payments of the same amount are a normal way to pay a
    // trip off, so nothing can guess which one was a mistake; this is how the
    // person who knows removes it.
    const gone = await call(advisor, 'DELETE', `/api/payments/${spareId}`);
    check(gone.status === 200, 'and a payment can be taken off the schedule',
      `status ${gone.status}`);
    const without = await call(advisor, 'GET', `/api/bookings/${chaseId}/record`);
    check(!(without.data?.payments || []).some((x) => x.id === spareId),
      'after which it is not on the reservation any more');
  }

  // Chasing money that has arrived is the kind of message that loses a client.
  const paidOne = (chaseRecord.data?.payments || []).find((p) => p.kind === 'deposit');
  await call(advisor, 'POST', `/api/payments/${paidOne.id}/paid`, {});
  const chasePaid = await call(advisor, 'POST', `/api/payments/${paidOne.id}/remind`, { preview: true });
  check(chasePaid.status === 400, 'a payment already posted cannot be chased',
    `status ${chasePaid.status}`);

  // An owner chasing for an associate is the Saturday case this exists for.
  // The message still goes out over the associate's name and reply-to, because
  // it is their client who will answer it.
  const byOwner = await call(admin, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  check(byOwner.status === 200, 'an owner can chase on an associate\'s behalf',
    `status ${byOwner.status}`);
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

  // A full save leaves alone every field the request did not mention.
  //
  // This is the endpoint the reservation form posts to, and it writes the whole
  // record. While the form carried every field that was harmless. Money moved
  // under the pricing on 5 September and the form stopped carrying a trip total
  // or a commission, so from then on saving a confirmation number wrote zero
  // over both. The traveller count, the commission status and the group link
  // were never on that form at all. It ran ten days before anybody noticed,
  // because nothing on screen shows a figure going missing: it just reads as a
  // reservation somebody has not finished entering.
  const wasBooked = await call(advisor, 'GET', `/api/bookings/${bareId}`);
  const had = wasBooked.data?.booking || {};
  const quietSave = await call(advisor, 'PUT', `/api/bookings/${bareId}`,
    { clientName: had.client_name, supplier: 'Cunard' });
  check(quietSave.status === 200, 'a full save that names only two fields is accepted',
    `status ${quietSave.status}`);

  const kept = quietSave.data?.booking || {};
  check(kept.status === had.status, 'and leaves the status exactly as it found it',
    `${had.status} -> ${kept.status}`);
  check(kept.gross_cents === had.gross_cents,
    'the trip total survives a save that never mentions it',
    `${had.gross_cents} -> ${kept.gross_cents}`);
  check(kept.commission_cents === had.commission_cents,
    'and so does the commission', `${had.commission_cents} -> ${kept.commission_cents}`);
  check(kept.travellers === had.travellers,
    'and the traveller count', `${had.travellers} -> ${kept.travellers}`);
  check(kept.commission_status === had.commission_status,
    'and where the commission had got to',
    `${had.commission_status} -> ${kept.commission_status}`);
  check(kept.depart_date === had.depart_date && kept.final_payment_due === had.final_payment_due,
    'and the dates nobody touched',
    `${had.depart_date}/${had.final_payment_due} -> ${kept.depart_date}/${kept.final_payment_due}`);

  // Present and empty still clears. Absent is silence; empty is somebody
  // actually emptying the box, and every field on the form posts even when
  // blank, so the two have to stay different.
  const cleared = await call(advisor, 'PUT', `/api/bookings/${bareId}`,
    { clientName: had.client_name, supplier: 'Cunard', confirmationNumber: '' });
  check(!cleared.data?.booking?.confirmation_number,
    'while a field sent empty is still cleared',
    String(cleared.data?.booking?.confirmation_number));

  const saidQuoted = await call(advisor, 'PUT', `/api/bookings/${bareId}`,
    { clientName: wasBooked.data?.booking?.client_name, supplier: 'Cunard', status: 'quoted' });
  check(saidQuoted.data?.booking?.status === 'quoted',
    'while a save that does name one still sets it', saidQuoted.data?.booking?.status);
  await call(advisor, 'PUT', `/api/bookings/${bareId}`,
    { clientName: wasBooked.data?.booking?.client_name, supplier: 'Cunard',
      status: wasBooked.data?.booking?.status });

  // Where there is a breakdown, the headline follows it, and a headline that
  // has driftEmptied is put right the next time the record is driftOpened.
  //
  // Taken from a real one. A hotel in Madrid was driftPriced through the grid, then
  // something else wrote zero over gross_cents and commission_cents, and the
  // reservation showed no money at all above a breakdown that added up
  // perfectly. Nothing would have repaired it: the sync only runs when
  // somebody saves the grid, and nobody had a reason to.
  const driftId = (await call(advisor, 'POST', '/api/bookings', {
    clientName: `Drift ${stamp}`, supplier: 'Expedia', productType: 'hotel',
    status: 'booked', departDate: isoDay(60), gross: '100.00', commission: '10.00',
  })).data?.booking?.id;
  if (driftId) cleanup('the driftEmptied reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${driftId}`));

  await call(advisor, 'PUT', `/api/bookings/${driftId}/pricing`, {
    cells: [{ kind: 'fare', amount: '463.71', commissionable: true },
            { kind: 'taxes', amount: '46.37', commissionable: false }],
    commissions: [{ kind: 'base', amount: '45.91' }],
  });
  const driftPriced = await call(advisor, 'GET', `/api/bookings/${driftId}`);
  check(driftPriced.data?.booking?.gross_cents === 51008,
    'the grid sets the headline when it is saved', String(driftPriced.data?.booking?.gross_cents));

  // Drift it the way the whole-record save used to: the grid keeps its lines,
  // the two columns go to nothing.
  await call(advisor, 'POST', `/api/bookings/${driftId}/quick`,
    { gross: '0', commission: '0' });
  const driftEmptied = await call(advisor, 'GET', `/api/bookings/${driftId}`);
  check(driftEmptied.data?.booking?.gross_cents === 0,
    'and a reservation can still end up with its headline emptied',
    String(driftEmptied.data?.booking?.gross_cents));

  const driftOpened = await call(advisor, 'GET', `/api/bookings/${driftId}/record`);
  check(driftOpened.data?.booking?.gross_cents === 51008
        && driftOpened.data?.booking?.commission_cents === 4591,
    'opening the record puts the headline back from the breakdown',
    `${driftOpened.data?.booking?.gross_cents} / ${driftOpened.data?.booking?.commission_cents}`);

  const driftStored = await call(advisor, 'GET', `/api/bookings/${driftId}`);
  check(driftStored.data?.booking?.gross_cents === 51008,
    'and it is written, not only shown', String(driftStored.data?.booking?.gross_cents));

  // A reservation with no breakdown keeps whatever was typed. The grid is only
  // the arithmetic where there is a grid; everywhere else the typed figure is
  // the only figure there is, and repairing from an empty breakdown would
  // zero every hotel somebody entered as a single number.
  const typedId = (await call(advisor, 'POST', '/api/bookings', {
    clientName: `Typed ${stamp}`, supplier: 'Expedia', productType: 'hotel',
    status: 'booked', departDate: isoDay(60), gross: '875.00', commission: '87.50',
  })).data?.booking?.id;
  if (typedId) cleanup('the typed reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${typedId}`));
  const typedRecord = await call(advisor, 'GET', `/api/bookings/${typedId}/record`);
  check(typedRecord.data?.booking?.gross_cents === 87500,
    'a reservation with no breakdown keeps the figure that was typed',
    String(typedRecord.data?.booking?.gross_cents));

  const byOwner = await call(admin, 'POST', `/api/bookings/${bareId}/quick`, { gross: '4300.00' });
  check(byOwner.status === 200, 'and an owner can quick edit an associate\'s reservation',
    `status ${byOwner.status}`);
  const afterOwner = await call(advisor, 'GET', `/api/bookings/${bareId}`);
  check(afterOwner.data?.booking?.gross_cents === 430000,
    'the correction lands on the associate\'s record', String(afterOwner.data?.booking?.gross_cents));

  // A year that cannot be right is refused rather than stored.
  //
  // A browser date field turns a mistyped "206" into "0206-09-09", which is
  // four digits and used to be all the check asked for. One reservation went
  // in departing the ninth of September, 206: it sorted above everything,
  // counted as eighteen hundred years overdue, and printed as "Sep 9, 206",
  // where it reads as the screen being broken rather than the data being wrong.
  const hadDate = (await call(advisor, 'GET', `/api/bookings/${bareId}`))
    .data?.booking?.depart_date;
  const mistyped = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { departDate: '0206-09-09' });
  const afterMistype = await call(advisor, 'GET', `/api/bookings/${bareId}`);
  check(afterMistype.data?.booking?.depart_date !== '0206-09-09',
    'a year of 206 does not become a departure date',
    `${mistyped.status} -> ${afterMistype.data?.booking?.depart_date}`);

  // And the refusal leaves what was there. Refusing the value and then writing
  // nothing over the good one turns a wrong date into a missing one, which is
  // harder to spot and impossible to correct from what is left. That happened
  // to a real reservation between one deploy and the next.
  const fullSave = await call(advisor, 'PUT', `/api/bookings/${bareId}`, {
    clientName: `Bare ${stamp}`, supplier: 'Cunard', productType: 'cruise',
    status: 'booked', departDate: '0206-09-09',
  });
  check(fullSave.status === 400, 'a full save carrying it is refused outright',
    `status ${fullSave.status}`);
  check(/date/i.test(fullSave.data?.error || ''), 'and says which field to look at',
    String(fullSave.data?.error));
  const survived = await call(advisor, 'GET', `/api/bookings/${bareId}`);
  check(survived.data?.booking?.depart_date === hadDate,
    'leaving the date that was already on file alone',
    `${hadDate} -> ${survived.data?.booking?.depart_date}`);

  // And a day that never existed. The shape test took both of these happily,
  // and a Date built from either rolls quietly into a different day.
  await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { departDate: '2027-02-30' });
  const afterNoSuchDay = await call(advisor, 'GET', `/api/bookings/${bareId}`);
  check(afterNoSuchDay.data?.booking?.depart_date !== '2027-02-30',
    'nor does the thirtieth of February',
    String(afterNoSuchDay.data?.booking?.depart_date));

  // The dates people actually type still go through, including the leap day
  // and a date of birth from before anybody reading this was working.
  const realLeap = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { departDate: '2028-02-29' });
  check(realLeap.data?.booking?.depart_date === '2028-02-29',
    'while a real leap day is stored', String(realLeap.data?.booking?.depart_date));

  const born = await call(advisor, 'POST', `/api/bookings/${bareId}/travellers`,
    { name: `Born Long Ago ${stamp}`, dob: '1940-03-11' });
  check(born.status === 201, 'and a passport holder born in 1940 is still a person',
    `status ${born.status}`);

  // A form longer than a stand at a bridal show.
  //
  // The planning interview runs to forty questions in three parts and leans on
  // the small line under each one for most of its meaning. All three of those
  // were things the builder could not carry: it capped a form at forty fields,
  // had no way to say "this is a heading", and dropped anything a field held
  // that the editing screen did not show.
  {
  step('A long form keeps its parts');

  const longFields = [
    { label: 'Your name', key: 'full_name', type: 'text', required: true },
    { label: 'Email', key: 'email', type: 'email', required: true },
    { label: 'Tell us about you', key: 'part_one', type: 'heading',
      hint: 'The part that decides the rest.', required: true },
    { label: 'Where are you from?', key: 'from_where', type: 'text',
      hint: 'Hometown, school, college.' },
    { label: 'What sort of trip?', key: 'trip_type', type: 'select',
      options: ['Ocean cruise', 'River cruise', 'Not sure yet'] },
  ];
  for (let i = 0; i < 45; i += 1) {
    longFields.push({ label: `Filler question ${i}`, key: `filler_${i}`, type: 'text' });
  }

  const madeForm = await call(advisor, 'POST', '/api/myforms', {
    name: `Interview ${stamp}`, headline: 'Let us plan this properly',
    description: 'A few questions.', fields: longFields, active: true,
  });
  const formId = madeForm.data?.form?.id;
  if (formId) cleanup('the long form', () => call(advisor, 'DELETE', `/api/myforms/${formId}`));
  check(madeForm.status === 201 && formId, 'a fifty question form is accepted',
    `status ${madeForm.status}`);

  const built = await call(advisor, 'GET', `/api/myforms/${formId}`);
  const kept = built.data?.form?.fields || [];
  check(kept.length === longFields.length,
    'and keeps every question rather than stopping at forty',
    `${longFields.length} sent, ${kept.length} kept`);

  const heading = kept.find((f) => f.key === 'part_one');
  check(heading && heading.type === 'heading', 'a heading stays a heading',
    String(heading && heading.type));
  check(heading && heading.required === false,
    'and cannot be made required, because there is nothing to answer',
    String(heading && heading.required));
  check(kept.find((f) => f.key === 'from_where')?.hint === 'Hometown, school, college.',
    'the line under a question survives the trip through the builder',
    String(kept.find((f) => f.key === 'from_where')?.hint));

  // The public page draws it, and draws the heading as a heading rather than
  // as a box asking somebody to type "Tell us about you".
  const slug = built.data?.form?.slug;
  const page = await call(null, 'GET', `/f/${slug}`);
  check(page.status === 200, 'the form has a page', `status ${page.status}`);
  const html = page.raw || '';
  check(html.includes('form-section') && html.includes('Tell us about you'),
    'with the heading drawn as a heading');
  check(html.includes('Hometown, school, college.'), 'and the hints on it');

  // A submission ignores the heading rather than refusing over it.
  const sent = await call(null, 'POST', `/api/public/forms/${slug}`, {
    full_name: `Form Client ${stamp}`, email: `form-${stamp}@example.com`,
    from_where: 'Tampa', trip_type: 'River cruise',
  });
  check(sent.status === 201 || sent.status === 200, 'and it can be filled in',
    `status ${sent.status}`);
  }

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
  check(notTheirClient.status === 200, 'an owner can unpin an associate\'s client',
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

  // An owner may declare an associate's commission paid, and the response says
  // how many actually moved rather than how many were asked for, so a silent
  // no-op is impossible either way.
  //
  // The receipt matters as much as the label. If the status widened and the
  // money did not, the trip would read as paid with nothing received against
  // it, and that is the hardest kind of wrong number to find months later.
  const notTheirs = await call(admin, 'POST', '/api/commissions/status', {
    ids: [recent.data.booking.id], status: 'paid',
  });
  check(notTheirs.data?.changed === 1 && notTheirs.data?.requested === 1,
    'an owner can mark an associate\'s commission paid',
    JSON.stringify(notTheirs.data));
  check(notTheirs.data?.recorded === 1,
    'and the money is recorded as received, not just the label moved',
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
    JSON.stringify(panelDash.data.failed));
  // Entries are objects carrying the reason, not bare names. A panel that
  // broke because a migration has not been run should say which one, the way
  // every other page in the portal does; the dashboard used to log that to a
  // console nobody reading the screen can see.
  check(panelDash.data.failed.every((f) => f && typeof f === 'object' && typeof f.name === 'string'),
    'and a failure names the panel and, where it can be worked out, the reason',
    JSON.stringify(panelDash.data.failed));
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

  // An owner may file a cheque that covers an associate's trip. It has to land
  // on the associate's book: filed under the owner it would come off the
  // associate's statement and leave the trip reading as never paid.
  const receiptNotMine = await call(admin, 'POST', '/api/commissions/receipts', {
    bookingId: shortId, amount: 100,
  });
  check(receiptNotMine.status === 200,
    'an owner can file a receipt against an associate\'s reservation',
    `status ${receiptNotMine.status}`);
  const theirReceipts = await call(advisor, 'GET', `/api/commissions/receipts?bookingId=${shortId}`);
  check((theirReceipts.data?.receipts || []).some((r) => r.amount_cents === 10000),
    'and the associate sees it against their own trip',
    JSON.stringify((theirReceipts.data?.receipts || []).map((r) => r.amount_cents)));

  // And taken off again, by the associate, which is the other half of the same
  // rule and leaves the totals below reading what they were written to read.
  const unfiled = await call(advisor, 'DELETE',
    `/api/commissions/receipts/${receiptNotMine.data?.id}`);
  check(unfiled.status === 200, 'and can take one off that the owner put on',
    `status ${unfiled.status}`);

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

  // An owner may read an associate's trip, and its schedule with it, and may
  // change it. The record says whose it is while they do, which is the part
  // that has to be there now that the buttons are.
  const ownerRec = await call(admin, 'GET', `/api/bookings/${bookingId}/record`);
  check(ownerRec.status === 200 && ownerRec.data?.editable === true,
    'an owner sees the record as something they can change',
    `status ${ownerRec.status}, editable ${ownerRec.data?.editable}`);
  check(typeof ownerRec.data?.onBehalfOf === 'string' && ownerRec.data.onBehalfOf.length > 0,
    'and is told whose reservation it is', String(ownerRec.data?.onBehalfOf));
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

  // Over the associate's name and reply-to, whoever pressed the button: it is
  // their client who answers it.
  const notYours = await call(admin, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  check(notYours.status === 200,
    'and an owner can send a statement for an associate',
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
    { kind: 'air', supplier: `Added By Owner ${stamp}` });
  check(notYours.status === 201, 'an owner can add a vendor to an associate\'s trip',
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
  check(notYours.status === 200, 'an owner can price an associate\'s trip',
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
  check(notYours.status === 201, 'an owner can write terms onto an associate\'s trip',
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
    { label: `Added By Owner ${stamp}`, amount: '1' });
  check(notYours.status === 201, 'an owner can add an option to an associate\'s quote',
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

  // ------------------------------------------------------- lists and email -
  // Three features that only work as one: a list decides who, the suppression
  // list decides who not, and a broadcast does the writing. None of it had
  // ever run outside my own head.
  //
  // The sending itself is not driven here. It happens on the cron and needs a
  // Resend key, which CI has no business holding; what is driven is everything
  // up to and including the queue, which is where all the decisions are.
  {
  step('Who to write to, and writing to them');

  const listed = `Listed ${stamp}`;
  const quiet = `Quiet ${stamp}`;

  const sailing = await call(advisor, 'POST', '/api/bookings', {
    clientName: listed, supplier: 'Princess Cruises', status: 'booked',
    departDate: isoDay(20), returnDate: isoDay(27), gross: '5000', commission: '500',
  });
  if (sailing.data?.booking?.id) cleanup('the listed reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${sailing.data.booking.id}`));

  // Somebody who travelled and has nothing ahead of them, so every rule below
  // has a person it must leave out as well as one it must find. A list that
  // returns everybody looks exactly like a list that works.
  const lapsed = await call(advisor, 'POST', '/api/bookings', {
    clientName: quiet, supplier: 'Holland America', status: 'travelled',
    departDate: isoDay(-200), returnDate: isoDay(-190), gross: '3000', commission: '300',
  });
  if (lapsed.data?.booking?.id) cleanup('the lapsed reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${lapsed.data.booking.id}`));

  // A list is for writing to, so only clients with an address are on one.
  // Recorded here rather than assumed, because a booking does not ask for it.
  const idFor = async (name) => {
    const res = await call(advisor, 'GET', `/api/clients?q=${encodeURIComponent(name)}`);
    return (res.data?.clients || []).find((c) => c.name === name)?.id;
  };
  const listedId = await idFor(listed);
  const quietId = await idFor(quiet);
  if (listedId) {
    await call(advisor, 'PUT', `/api/clients/${listedId}`,
      { name: listed, email: `listed-${stamp}@example.com` });
  }
  if (quietId) {
    await call(advisor, 'PUT', `/api/clients/${quietId}`,
      { name: quiet, email: `quiet-${stamp}@example.com` });
  }
  check(listedId && quietId, 'two clients to build a list out of',
    `${listedId ? 'one' : 'no'} sailing, ${quietId ? 'one' : 'no'} lapsed`);

  const rules = await call(advisor, 'GET', '/api/segments/rules');
  const ruleKeys = (rules.data?.rules || []).map((r) => r.key);
  check(rules.status === 200 && ruleKeys.includes('sailing_within')
    && ruleKeys.includes('nothing_booked'),
    'the rules a list can be built from come from the server', ruleKeys.join(', '));

  // No rules is the whole book, and it says so rather than showing a number
  // that looks like a segment.
  const everybody = await call(advisor, 'POST', '/api/segments/preview', { rules: [] });
  check(everybody.data?.everybody === true,
    'no rules is announced as everybody, not shown as a count',
    JSON.stringify(everybody.data?.everybody));

  const soon = await call(advisor, 'POST', '/api/segments/preview',
    { rules: [{ key: 'sailing_within', n: 60 }] });
  const soonNames = (soon.data?.people || []).map((p) => p.name);
  check(soon.data?.everybody === false && soonNames.includes(listed),
    'a rule about sailing soon finds the person sailing soon', soonNames.join(', '));
  check(!soonNames.includes(quiet),
    'and leaves out the one with nothing booked', soonNames.join(', '));

  // The opposite rule, so a pass is not just "the query returned everybody".
  const idle = await call(advisor, 'POST', '/api/segments/preview',
    { rules: [{ key: 'nothing_booked' }] });
  const idleNames = (idle.data?.people || []).map((p) => p.name);
  check(idleNames.includes(quiet) && !idleNames.includes(listed),
    'and the rule for nobody booked finds the other one', idleNames.join(', '));

  // The numbers the page puts above a button.
  check(typeof soon.data?.total === 'number' && soon.data.optedOut === 0,
    'a list says how many match and how many have opted out',
    `${soon.data?.total} matching, ${soon.data?.optedOut} opted out`);

  // The other nine rules. Two were driven above and the rest had never been
  // executed anywhere, which for a feature whose whole job is deciding who
  // gets an email is the wrong nine to leave to inspection.
  //
  // One person per rule, each of whom should be found by theirs and left out
  // of the others. A rule that returns everybody looks exactly like a rule
  // that works, so every check names somebody who must not be in the answer.
  {
    const cast = {};
    const make = async (key, booking) => {
      const res = await call(advisor, 'POST', '/api/bookings',
        { clientName: `${key} ${stamp}`, ...booking });
      if (res.data?.booking?.id) cleanup(`the ${key} reservation`,
        () => call(advisor, 'DELETE', `/api/bookings/${res.data.booking.id}`));
      const found = await call(advisor, 'GET',
        `/api/clients?q=${encodeURIComponent(`${key} ${stamp}`)}`);
      cast[key] = (found.data?.clients || []).find((c) => c.name === `${key} ${stamp}`)?.id;
      return cast[key];
    };

    await make('Home', { supplier: 'Cunard', status: 'travelled',
      departDate: isoDay(-20), returnDate: isoDay(-5) });
    await make('Quote', { supplier: 'Cunard', status: 'quoted', departDate: isoDay(100) });
    await make('Sailed', { supplier: 'Carnival Smoke Line', status: 'travelled',
      departDate: isoDay(-300), returnDate: isoDay(-293) });
    await make('Docs', { supplier: 'Cunard', status: 'booked',
      departDate: isoDay(500), returnDate: isoDay(510) });
    await make('Where', { supplier: 'Cunard', status: 'booked',
      departDate: isoDay(500), returnDate: isoDay(510) });

    // The detail each rule reads. A birthday is matched on day and month, so
    // the year on the record is deliberately not this one.
    const details = {
      Home: { email: `home-${stamp}@example.com` },
      Quote: { email: `quote-${stamp}@example.com` },
      Sailed: { email: `sailed-${stamp}@example.com` },
      Docs: { email: `docs-${stamp}@example.com`, passportExpiry: isoDay(100),
        birthday: `1971-${isoDay(10).slice(5)}`, anniversary: `1996-${isoDay(10).slice(5)}` },
      Where: { email: `where-${stamp}@example.com`, state: 'Nowhereshire',
        source: `SmokeReferral${stamp}` },
    };
    for (const [key, body] of Object.entries(details)) {
      if (cast[key]) {
        await call(advisor, 'PUT', `/api/clients/${cast[key]}`,
          { name: `${key} ${stamp}`, ...body });
      }
    }

    const credit = await call(advisor, 'POST', '/api/credits', {
      clientName: `Docs ${stamp}`, vendor: 'Cunard', amount: '250', expiresOn: isoDay(30),
    });
    if (credit.data?.credit?.id) cleanup('the rules credit',
      () => call(advisor, 'DELETE', `/api/credits/${credit.data.credit.id}`));

    const namesFor = async (rules) => {
      const res = await call(advisor, 'POST', '/api/segments/preview', { rules });
      return (res.data?.people || []).map((x) => x.name);
    };
    const rule = async (label, rules, present, absent) => {
      const names = await namesFor(rules);
      check(names.includes(`${present} ${stamp}`) && !names.includes(`${absent} ${stamp}`),
        label, `found ${names.length}: ${names.slice(0, 6).join(', ')}`);
    };

    await rule('home in the last N days finds who is just back',
      [{ key: 'home_within', n: 30 }], 'Home', 'Quote');
    await rule('quoted and never booked finds the price that went quiet',
      [{ key: 'quoted_not_booked' }], 'Quote', 'Home');
    await rule('sailed with a supplier matches on the name as written',
      [{ key: 'sailed_with', text: 'Carnival' }], 'Sailed', 'Quote');
    await rule('a credit about to expire finds who is holding it',
      [{ key: 'credit_expiring', n: 90 }], 'Docs', 'Quote');
    await rule('a passport about to expire finds whose it is',
      [{ key: 'passport_expiring', n: 180 }], 'Docs', 'Quote');
    await rule('a birthday is matched on the day and month, not the year',
      [{ key: 'birthday_within', n: 30 }], 'Docs', 'Quote');
    await rule('an anniversary the same way',
      [{ key: 'anniversary_within', n: 30 }], 'Docs', 'Quote');
    await rule('where somebody came from',
      [{ key: 'source_is', text: `SmokeReferral${stamp}` }], 'Where', 'Quote');
    await rule('where somebody lives',
      [{ key: 'in_state', text: 'Nowhereshire' }], 'Where', 'Quote');

    // Rules combine with AND, which is what "and" means when somebody says
    // "everyone with a passport running out who came from a referral".
    const both = await namesFor([{ key: 'passport_expiring', n: 180 },
      { key: 'in_state', text: 'Nowhereshire' }]);
    check(!both.includes(`Docs ${stamp}`) && !both.includes(`Where ${stamp}`),
      'two rules narrow rather than widen', `found ${both.length}`);
  }

  const emptyRules = await call(advisor, 'POST', '/api/segments',
    { name: `Everyone ${stamp}`, rules: [] });
  check(emptyRules.status === 400,
    'a list with no rules is refused when it is named, not when it is used',
    `status ${emptyRules.status}`);

  const saved = await call(advisor, 'POST', '/api/segments',
    { name: `Sailing soon ${stamp}`, rules: [{ key: 'sailing_within', n: 60 }] });
  const segmentId = saved.data?.id;
  check(saved.status === 201 && segmentId, 'a list can be saved by name', `status ${saved.status}`);
  if (segmentId) cleanup('the saved list', () =>
    call(advisor, 'DELETE', `/api/segments/${segmentId}`));

  const mine = await call(advisor, 'GET', '/api/segments');
  const back = (mine.data?.segments || []).find((x) => x.id === segmentId);
  check(back && back.rules.length === 1 && back.rules[0].key === 'sailing_within',
    'and comes back as the rules rather than as the people',
    back && JSON.stringify(back.rules));

  // The Lists page is a view, so an owner looking at "all advisors" sees the
  // agency there, and says so. A message is not a view: it goes out as one
  // person, so who it reaches is that person's own book whatever the picker
  // says. The two would quietly become one permission if the send borrowed
  // the viewing scope, and an owner would email an associate's clients as
  // themselves.
  const ownersSend = await call(admin, 'POST', '/api/broadcasts/preview',
    { rules: [{ key: 'sailing_within', n: 60 }] });
  check(ownersSend.status === 200 && ownersSend.data?.sample?.name !== listed,
    'a message an owner sends reaches their own book, not the agency\'s',
    JSON.stringify(ownersSend.data?.sample));

  // --- the message itself

  const noList = await call(advisor, 'POST', '/api/broadcasts',
    { name: `No list ${stamp}`, subject: 'Hello', body: 'Hello', rules: [] });
  check(noList.status === 400, 'a message with no list behind it is refused',
    `status ${noList.status}`);

  const draft = await call(advisor, 'POST', '/api/broadcasts', {
    name: `Autumn ${stamp}`, subject: 'A word before you sail, {{first_name}}',
    body: 'Hello {{first_name}}, one thing before you go.', segmentId,
  });
  const castId = draft.data?.id;
  check(draft.status === 201 && castId, 'a message can be saved as a draft',
    `status ${draft.status}`);
  if (castId) cleanup('the draft message', () => call(advisor, 'DELETE', `/api/broadcasts/${castId}`));

  const preview = await call(advisor, 'POST', '/api/broadcasts/preview', {
    segmentId, subject: 'A word before you sail, {{first_name}}',
    body: 'Hello {{first_name}}, one thing before you go.',
  });
  // Compared against the sample the server actually chose rather than against
  // a name guessed here: by this point in the suite the advisor has a book,
  // and whoever sorts first is not for this section to predict.
  const sampleFirst = String(preview.data?.sample?.name || '').split(' ')[0];
  check(preview.status === 200
    && preview.data?.body === `Hello ${sampleFirst}, one thing before you go.`,
    'the preview fills the merge fields in against a real client',
    preview.data?.body);
  check((preview.data?.footer || '').includes('Unsubscribe'),
    'and carries the way out that makes it lawful to send', preview.data?.footer);

  // The name a client actually goes by, which is what the field is for. A
  // mailing that opens "Hello Barbara" to somebody everybody calls Barb reads
  // as a mailing rather than as a note from their advisor.
  if (listedId) {
    // The round trip first. These two were settable when a client was created
    // and silently dropped by the edit, which is the quiet failure: the write
    // succeeded, the column was never in the statement, and the value came
    // back unchanged with nothing thrown.
    const named = await call(advisor, 'PUT', `/api/clients/${listedId}`, {
      name: listed, email: `listed-${stamp}@example.com`,
      nickname: 'Nick', source: 'Referral',
    });
    check(named.data?.client?.nickname === 'Nick' && named.data?.client?.source === 'Referral',
      'what a client goes by, and where they came from, survive an edit',
      JSON.stringify({ nickname: named.data?.client?.nickname, source: named.data?.client?.source }));

    const nicked = await call(advisor, 'POST', '/api/broadcasts/preview',
      { segmentId, subject: 'Hi', body: 'Hello {{first_name}}.' });
    check(nicked.data?.sample?.name !== listed || nicked.data?.body === 'Hello Nick.',
      'the greeting uses what they go by when one is recorded',
      `${nicked.data?.sample?.name}: ${nicked.data?.body}`);
  }

  const blanks = await call(advisor, 'POST', '/api/broadcasts/preview',
    { segmentId, subject: 'Hi', body: 'Hello {{nickname_that_does_not_exist}}.' });
  check((blanks.data?.body || '').includes('{{nickname_that_does_not_exist}}'),
    'a token nothing knows about is left alone rather than blanked',
    blanks.data?.body);

  // --- somebody opts out

  const optOut = `listed-${stamp}@example.com`;
  const suppressed = await call(advisor, 'POST', '/api/suppressions', { email: optOut });
  check(suppressed.status === 200, 'an advisor can record that somebody asked to stop',
    `status ${suppressed.status}`);
  cleanup('the opt out', () => call(advisor, 'POST', '/api/suppressions/restore', { email: optOut }));

  const optedList = await call(advisor, 'GET', '/api/suppressions');
  check((optedList.data?.suppressions || []).some((x) => x.email === optOut),
    'and see them on the list afterwards',
    (optedList.data?.suppressions || []).length + ' on the list');

  const after = await call(advisor, 'POST', '/api/segments/preview',
    { rules: [{ key: 'sailing_within', n: 60 }] });
  check(after.data?.optedOut === (soon.data?.optedOut || 0) + 1,
    'the list then counts one more of them as opted out',
    `${soon.data?.optedOut} then ${after.data?.optedOut}`);
  check(after.data?.total === soon.data?.total,
    'while still counting them as matching, because they do',
    `${after.data?.total} vs ${soon.data?.total}`);

  // --- sending

  const send = await call(advisor, 'POST', `/api/broadcasts/${castId}/send`);
  check(send.status === 200 && send.data?.queued >= 1,
    'sending freezes the people it is going to', JSON.stringify(send.data));

  const frozen = await call(advisor, 'GET', `/api/broadcasts/${castId}`);
  check(frozen.data?.broadcast?.status === 'sending'
    && (frozen.data?.recipients || []).length === send.data?.queued,
    'and writes one row per person, all of them waiting',
    `${(frozen.data?.recipients || []).length} rows, status ${frozen.data?.broadcast?.status}`);
  check((frozen.data?.recipients || []).every((r) => r.status === 'queued'),
    'nothing is marked sent before the cron has sent it',
    (frozen.data?.recipients || []).map((r) => r.status).join(', '));

  // And it shows on the client's own record, which is where somebody about to
  // ring them looks. Marketing that lives only on the marketing screen may as
  // well not have happened as far as a phone call is concerned.
  if (listedId) {
    const record = await call(advisor, 'GET', `/api/client?id=${listedId}`);
    check((record.data?.emails || []).some((m) => m.name === `Autumn ${stamp}`),
      'a client record shows the marketing they have been sent',
      JSON.stringify((record.data?.emails || []).map((m) => m.name)));
  }

  const edited = await call(advisor, 'PUT', `/api/broadcasts/${castId}`, {
    name: `Autumn ${stamp}`, subject: 'Something else entirely', body: 'Changed.', segmentId,
  });
  check(edited.status === 400,
    'a message that has gone out cannot be edited afterwards', `status ${edited.status}`);

  // --- the cron, which is the half that actually sends
  //
  // wrangler dev --test-scheduled exposes this. Without it the scheduled
  // handler is the one part of the Worker nothing here ever executes, and the
  // drain loop had never run anywhere at all.
  //
  // CI holds no Resend key, on purpose, so what is under test is the guard in
  // front of the loop rather than the sending. That guard matters more than it
  // sounds: without it the first recipient throws "email is not configured",
  // so does every one after, and the pass writes four hundred real people down
  // as addresses that do not work. Those rows cannot be retried.
  const cron = await call(null, 'GET', '/__scheduled');
  if (cron.status !== 200) {
    skip('the cron', 'wrangler is not exposing /__scheduled, so the drain was not run');
  } else {
    // The scheduled handler defers its work, so give it a moment to land.
    await new Promise((r) => setTimeout(r, 1500));
    const afterCron = await call(advisor, 'GET', `/api/broadcasts/${castId}`);
    check(afterCron.data?.emailConfigured === false,
      'the portal knows whether it can send at all',
      `${afterCron.data?.emailConfigured}`);
    check((afterCron.data?.recipients || []).every((r) => r.status === 'queued'),
      'with no mail key the queue waits rather than marking everybody failed',
      (afterCron.data?.recipients || []).map((r) => `${r.status}:${r.detail || ''}`).join(', '));
    check(afterCron.data?.broadcast?.status === 'sending',
      'and the send is still a send, not a finished one that reached nobody',
      afterCron.data?.broadcast?.status);


    // And the pass wrote down what it did. Each cron job is wrapped in a catch
    // so one cannot stop the others, which means a job failing since March
    // looks exactly like a job with nothing to do. These rows are the only
    // place that difference exists.
    const health = await call(admin, 'GET', '/api/admin/health');
    const jobs = health.data?.jobs;
    const byName = new Map((jobs?.jobs || []).map((x) => [x.name, x]));
    check(jobs?.ok === true && byName.size > 0,
      'the cron writes down what each job did',
      jobs?.error || `${byName.size} jobs recorded`);
    for (const name of ['broadcasts', 'task reminders', 'payment reminders',
      'mark trips travelled', 'purge sessions']) {
      check(byName.has(name), `and ${name} is one of them`,
        [...byName.keys()].join(', '));
    }
    // This one returned early rather than throwing, so it has a good run to
    // its name. A job that only ever appears as "ran" is the failure case.
    check(byName.get('broadcasts')?.last_ok_at,
      'a job that did its work without throwing records that it worked',
      JSON.stringify(byName.get('broadcasts')));
  }

  const stop = await call(advisor, 'POST', `/api/broadcasts/${castId}/cancel`);
  check(stop.status === 200, 'a send in flight can be stopped', `status ${stop.status}`);

  const stopped = await call(advisor, 'GET', `/api/broadcasts/${castId}`);
  check(stopped.data?.broadcast?.status === 'cancelled'
    && (stopped.data?.recipients || []).every((r) => r.status === 'skipped'),
    'and everyone still waiting is left alone',
    (stopped.data?.recipients || []).map((r) => r.status).join(', '));

  // --- the link in the footer

  const bogus = await call(null, 'GET', '/u/not-a-real-token');
  check(bogus.status === 404 && /not one of ours/i.test(bogus.raw || ''),
    'an unsubscribe link nobody signed is refused', `status ${bogus.status}`);
  }

  // A notice on the dashboard exists to be acted on, so the button on it has
  // to land somewhere that can do something about what it just said. Two did
  // not: the email one sent an owner to their own Settings page, where a
  // Worker secret has never been and never will be, and the missing-deadline
  // one sent them to the full reservation list to find the trips it had just
  // counted for them.
  {
  step('A notice points at the screen that fixes it');

  const seen = await call(advisor, 'GET', '/api/dashboard');
  const notices = seen.data?.notices || [];
  check(Array.isArray(notices), 'the dashboard carries its notices', typeof notices);

  // Every notice's link is a real page. check-wiring asks this of the pages;
  // these live in the API and no page hard-codes them.
  const pages = await call(advisor, 'GET', '/app/complete');
  check(pages.status === 200, 'and Fill in the gaps is one of them', `status ${pages.status}`);

  const bad = notices.filter((n) => n.href && !n.href.startsWith('/'));
  check(!bad.length, 'no notice points off the portal', JSON.stringify(bad.map((n) => n.href)));
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

  // ...nor through the back door. The standing agreement was admin-only from
  // the start, but the per-trip override that outranks it was reachable by
  // any advisor on their own reservation, one booking at a time.
  // Every door, not just the obvious one. The quick endpoint no longer knows
  // the field, creating a booking with a share attached is ignored, and
  // saving the page cannot clear one an owner set.
  await call(advisor, 'POST', `/api/bookings/${bookingId}/quick`, { advisorSplitPct: 100 });
  const afterQuick = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check(afterQuick.data?.split && afterQuick.data.split.overridden === false,
    'an advisor cannot write their own figure over a reservation',
    JSON.stringify(afterQuick.data?.split));

  const smuggled = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Smuggle ${stamp}`, supplier: 'Carnival', productType: 'cruise',
    departDate: isoDay(210), gross: '1000', commission: '100', advisorSplitPct: 100,
  });
  const smuggledId = smuggled.data?.booking?.id;
  check(smuggled.data?.booking?.advisor_split_pct === null,
    'nor file a new one with a share already attached',
    String(smuggled.data?.booking?.advisor_split_pct));
  if (smuggledId) {
    cleanup('the smuggled reservation',
      () => call(advisor, 'DELETE', `/api/bookings/${smuggledId}`));
  }

  const selfLead = await call(advisor, 'POST', `/api/bookings/${bookingId}/quick`,
    { leadSource: 'company' });
  const afterLead = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check(afterLead.data?.split?.leadSource === 'personal',
    'nor move a trip onto the other agreement',
    JSON.stringify(afterLead.data?.split));

  // Two agreements, which is what the advisor contract actually says: 90% of
  // what they generate, 80% of what the agency hands them.
  const twoRates = await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: 90, leadSplitPct: 80 });
  check(twoRates.status === 200 && twoRates.data?.user?.defaultSplitPct === 90
    && twoRates.data?.user?.leadSplitPct === 80,
    'an owner sets both rates', JSON.stringify(twoRates.data?.user));

  const own = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check(own.data?.split?.pct === 90,
    'a booking the advisor generated follows the higher rate', own.data?.split?.pct);

  const moved = await call(admin, 'PUT', `/api/admin/bookings/${bookingId}/split`,
    { leadSource: 'company' });
  check(moved.status === 200, 'the owner marks one as a company lead',
    `status ${moved.status}`);

  const asLead = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check(asLead.data?.split?.pct === 80,
    'and it follows the lower one without touching the reservation',
    asLead.data?.split?.pct);
  check(asLead.data?.split?.leadSource === 'company',
    'which the reservation says out loud', asLead.data?.split?.leadSource);

  // Put it back, since the checks after this one assume the plain case.
  await call(admin, 'PUT', `/api/admin/bookings/${bookingId}/split`, { leadSource: 'personal' });
  await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: null, leadSplitPct: null });

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

  // ------------------------------------------- no commission pays nobody ----
  // "No commission" used to mean the advisor was not paid and the agency
  // still was, which is not what the words say. A courtesy booking earns
  // nobody anything, so every total has to read zero and not just the one on
  // the advisor's half.
  const beforeNil = await call(advisor, 'GET', '/api/commissions');
  const beforeRow = (beforeNil.data?.rows || []).find((r) => r.id === halfId);
  const agencyWas = beforeRow?.agency_cents;
  check(agencyWas > 0, 'a normal trip leaves the agency a share', agencyWas);

  // Through /quick, which touches only the field it was given. A full PUT
  // would send the reservation back with everything else missing.
  const nilled = await call(advisor, 'POST', `/api/bookings/${halfId}/quick`,
    { commissionStatus: 'none' });
  check(nilled.status === 200, 'a trip is marked no commission', `status ${nilled.status}`);

  const nilRec = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(nilRec.data?.split?.earns === false,
    'the reservation says it earns nothing', JSON.stringify(nilRec.data?.split?.earns));
  check(nilRec.data?.split?.advisorCents === 0 && nilRec.data?.split?.agencyCents === 0,
    'and neither the advisor nor the agency is owed a cent',
    `${nilRec.data?.split?.advisorCents} / ${nilRec.data?.split?.agencyCents}`);
  // The figure itself stays on the record: a commission that was waived is
  // worth being able to see afterwards.
  check(nilRec.data?.booking?.commission_cents === 33333,
    'while the figure that was waived is still on the reservation',
    nilRec.data?.booking?.commission_cents);

  const nilList = await call(advisor, 'GET', '/api/commissions');
  check(!(nilList.data?.rows || []).some((r) => r.id === halfId),
    'it drops off the list of what there is to chase');
  const nilFiltered = await call(advisor, 'GET', '/api/commissions?status=none');
  check((nilFiltered.data?.rows || []).some((r) => r.id === halfId),
    'but is still findable by asking for that status, so a mistake can be undone');

  // Put it back, because the checks after this one assume it earns.
  await call(advisor, 'POST', `/api/bookings/${halfId}/quick`, { commissionStatus: 'pending' });
  const restored = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(restored.data?.split?.advisorCents === sp.advisorCents,
    'and unmarking it restores the share exactly', restored.data?.split?.advisorCents);

  // A trip can carry its own figure, and blank puts it back on the agreement.
  // Through the admin endpoint: the advisor cannot set what they are paid.
  await call(admin, 'PUT', `/api/admin/bookings/${halfId}/split`, { advisorSplitPct: 80 });
  const over = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(over.data?.split?.pct === 80 && over.data?.split?.overridden === true,
    'one trip can be given its own share', JSON.stringify(over.data?.split));
  await call(admin, 'PUT', `/api/admin/bookings/${halfId}/split`, { advisorSplitPct: '' });
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
  // ------------------------------------------------- TC and bonus money -----
  // A tour conductor credit is the advisor's in full. A casino deal is not,
  // because running casino rates through the agency uses its licence. The two
  // are the same money in the same box, and the only thing telling them apart
  // is which row it was typed into, so this is worth pinning down.
  {
    const tc = await call(advisor, 'POST', '/api/bookings', {
      clientName: `TC ${stamp}`, supplier: 'Carnival Cruise Line', status: 'booked',
      departDate: isoDay(80), returnDate: isoDay(87), gross: '2000',
    });
    const tcId = tc.data?.booking?.id;
    if (tcId) cleanup('the TC reservation', () => call(advisor, 'DELETE', `/api/bookings/${tcId}`));
    const rider = await call(advisor, 'POST', `/api/bookings/${tcId}/travellers`, { name: 'Ann Rider' });
    const riderId = rider.data?.id || rider.data?.traveller?.id;

    // $1,000 fare earning $200 base, plus a $300 TC credit and a $100 casino
    // bonus. On a 50% agreement the advisor should keep half of the $300 that
    // splits and all $300 of the TC: 150 + 300 = $450 of the $600 total.
    await call(advisor, 'PUT', `/api/bookings/${tcId}/pricing`, {
      cells: [{ kind: 'fare', travellerId: riderId, amount: '1000', commissionable: true }],
      commissions: [
        { travellerId: riderId, kind: 'base', amount: '200' },
        { travellerId: riderId, kind: 'bonus', amount: '300' },
        { travellerId: riderId, kind: 'bonus_shared', amount: '100' },
      ],
    });

    const rec = await call(advisor, 'GET', `/api/bookings/${tcId}/record`);
    const sp2 = rec.data?.split || {};
    check(rec.data?.booking?.commission_cents === 60000,
      'the three parts add up to one commission on the reservation',
      rec.data?.booking?.commission_cents);
    check(sp2.unsplitCents === 30000,
      'the TC credit is the part the agency has no share of',
      `${sp2.unsplitCents}`);
    check(sp2.advisorCents === 45000,
      'so on a half share the advisor keeps all the TC and half of the rest',
      `${sp2.advisorCents}`);
    check(sp2.advisorCents + sp2.agencyCents === 60000,
      'and the two sides still add back up to the commission exactly',
      `${sp2.advisorCents} + ${sp2.agencyCents}`);

    // The same figure worked out by SQLite instead of JavaScript. This is the
    // pair that would drift apart unnoticed, because they are read on
    // different screens by different people.
    const commTc = await call(advisor, 'GET', '/api/commissions');
    const tcRow = (commTc.data?.rows || []).find((r) => r.id === tcId);
    check(tcRow?.advisor_cents === sp2.advisorCents,
      'the commission report agrees with the reservation to the cent',
      `${tcRow?.advisor_cents} vs ${sp2.advisorCents}`);
    check(tcRow?.expected_bonus_cents === 40000,
      'and both bonus kinds are chased as one lot of bonus money',
      `${tcRow?.expected_bonus_cents}`);

    // The casino row on its own must behave like ordinary commission.
    const casinoOnly = await call(advisor, 'PUT', `/api/bookings/${tcId}/pricing`, {
      cells: [{ kind: 'fare', travellerId: riderId, amount: '1000', commissionable: true }],
      commissions: [{ travellerId: riderId, kind: 'bonus_shared', amount: '400' }],
    });
    const casinoRec = await call(advisor, 'GET', `/api/bookings/${tcId}/record`);
    check(casinoOnly.status === 200 && casinoRec.data?.split?.unsplitCents === 0
      && casinoRec.data?.split?.advisorCents === 20000,
      'a casino bonus on its own splits like anything else',
      JSON.stringify(casinoRec.data?.split));

    // A reservation with no breakdown has nowhere to say any of this, and must
    // keep splitting the whole commission as it always did.
    const plain = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
    check(plain.data?.split?.unsplitCents === 0,
      'a reservation with no pricing breakdown has no exempt part');
  }

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

  // A trip a client can keep on their phone. No app store, no login, no
  // install: a manifest on the page they already have a link to.
  {
  step('The trip a client keeps on their home screen');

  const kept = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Keeper ${stamp}`, supplier: 'Cunard', status: 'booked',
    productName: 'Transatlantic', departDate: isoDay(60), returnDate: isoDay(67),
  });
  const keptId = kept.data?.booking?.id;
  if (keptId) cleanup('the kept reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${keptId}`));

  const shared = await call(advisor, 'POST', `/api/bookings/${keptId}/share`, {});
  const shareCode = shared.data?.code || shared.data?.shareCode
    || (shared.data?.url || '').split('/t/')[1];

  if (!shareCode) {
    skip('the trip manifest', `sharing answered ${shared.status}`);
  } else {
    const page = await call(null, 'GET', `/t/${shareCode}`);
    check(page.status === 200 && page.raw.includes(`/t/${shareCode}/app.webmanifest`),
      'the trip page offers itself to the phone', `status ${page.status}`);

    const mf = await call(null, 'GET', `/t/${shareCode}/app.webmanifest`);
    check(mf.status === 200 && mf.data, 'the manifest is served without a session',
      `status ${mf.status}`);
    check(mf.data?.start_url === `/t/${shareCode}` && mf.data?.scope === `/t/${shareCode}`,
      'and opens that trip rather than the portal',
      JSON.stringify({ start: mf.data?.start_url, scope: mf.data?.scope }));
    check(mf.data?.display === 'standalone' && (mf.data?.icons || []).length === 1,
      'with one icon at the size the file actually is',
      JSON.stringify(mf.data?.icons));

    // A manifest is fetched without the session the page was opened with, so
    // it must carry nothing the share code does not already entitle somebody
    // to. A price or a client name in it would be a leak with no way in.
    const said = JSON.stringify(mf.data).toLowerCase();
    check(!said.includes('keeper') && !/\$|cents|balance/.test(said),
      'and says nothing the page does not', said.slice(0, 160));

    const missing = await call(null, 'GET', '/t/not-a-real-code/app.webmanifest');
    check(missing.status === 404, 'a manifest for a trip nobody shared is refused',
      `status ${missing.status}`);
  }
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
    // A throw ends the run without any check having failed, so nothing else
    // would say what happened where it can be read.
    annotate(e instanceof Bail ? 'Bailed out' : 'Threw', e && (e.stack || e.message) || String(e));
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
    if (failed.length) {
      console.log(`\nWhat failed:\n${failed.map((f) => `  - ${f}`).join('\n')}`);
    }
    summarise(`${checks} checks, ${failures} failed`
      + (skips.length ? `, skipped: ${skips.join('; ')}` : ', nothing skipped'));
    console.log(
      `\n${failures ? `${failures} of ${checks} checks failed.` : `All ${checks} checks passed.`}` +
      (skips.length ? ` ${skips.length} section${skips.length === 1 ? '' : 's'} skipped: ${
        skips.join(', ')}.` : '') +
      ` (${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
    process.exit(failures ? 1 : 0);
  });
