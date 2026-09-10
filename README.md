# CTT Agent Portal

An authenticated CRM portal for the travel advisors of Cruises Tours &
Travel, at **cttagents.com**.

GoHighLevel stays the system of record for contacts, opportunities, notes and
calendars. The portal is a travel-shaped interface on top of it, plus the one
thing GHL cannot model cleanly: bookings with suppliers, confirmation numbers,
sail dates, payment deadlines and commission.

Cloudflare Worker + static assets + D1, no build step, deployed from GitHub
`main` via Cloudflare Workers Builds. Same shape as the cruiseshoppers repo.

---

## What is in it

| Area | Source of truth | Notes |
| --- | --- | --- |
| Leads and contacts | GoHighLevel | Live read and write, with a full record page |
| Conversations | GoHighLevel | SMS and email threads, send and reply from the portal |
| Pipeline and opportunities | GoHighLevel | Board grouped by the pipeline's own stages, drag to move |
| Calendar and appointments | GoHighLevel | Agenda across all active calendars, booking included |
| Reservations | D1 | Vendor, confirmation, dates, cabin, travellers and their documents |
| Pricing | D1 | Broken into parts, because only some of what a client pays earns commission |
| Payments | D1 | The vendor's deadline and the advisor's own reminder a week before it |
| Quotes and statements | D1 | Previewed, then sent; a quote offers choices, a statement does not |
| Commission | D1 | What is owed, by age and vendor, split between advisor and agency |
| Invoices | GoHighLevel | Reconciled against what reservations expect |
| Dashboard and reports | Both | Booking numbers from D1, live pipeline value from GHL |
| Advisor accounts | D1 | Email and password, admin approves before access |

If GoHighLevel is not connected, the leads and pipeline pages say so plainly and
the rest of the portal keeps working. That is deliberate: booking and commission
tracking has value on its own.

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | Public | Sign-in landing |
| `/login`, `/signup` | Public | Sign in, request access |
| `/forgot-password`, `/reset-password` | Public | Password reset |
| `/pending` | Public | Shown while an account awaits approval |
| `/app/` | Advisor | Dashboard: numbers, payments due, activity |
| `/app/inbox` | Advisor | Messages: SMS and email threads, with a composer |
| `/app/leads` | Advisor | CRM contacts, live from the upstream account |
| `/app/contact` | Advisor | One contact: details, notes, tasks, deals |
| `/app/pipeline` | Advisor | Sales opportunities: board, drag between stages, create deals |
| `/app/calendar` | Advisor | Upcoming appointments, book new ones |
| `/app/tasks` | Advisor | The advisor's own working list |
| `/app/groups` | Advisor | Group space: held cabins and option dates |
| `/app/credits` | Advisor | Vendor credits a client holds, and when they lapse |
| `/app/goals` | Advisor | Annual targets and whether you are on pace |
| `/app/commissions` | Advisor | Commission owed, aged from the return date |
| `/app/reservations` | Advisor | Reservation CRUD, vendor deadlines, commission |
| `/app/reservation` | Advisor | One trip: schedule, tasks, credits, group |
| `/app/clients` | Advisor | Everyone who has booked or holds a credit |
| `/app/vendors` | Advisor | Who you sell, their spelling and their terms |
| `/app/import` | Advisor | Paste an existing book of business in |
| `/app/complete` | Advisor | Reservations missing costs or deadlines, edited in place |
| `/app/client` | Advisor | One client: trips, lifetime value, credits |
| `/app/billing` | Advisor | Invoices, transactions, reconciliation against reservations |
| `/app/reports` | Advisor | Production by departure month |
| `/app/settings` | Advisor | Profile, password, CRM binding |
| `/admin/` | Admin | Approve, suspend and bind advisors |

---

## Local development

Requires Node 18+ only for Wrangler. Nothing is compiled.

```bash
npm install
npx wrangler d1 migrations apply cttagents --local
npx wrangler dev --local
```

Then open http://127.0.0.1:8787.

### Creating the first admin

Signup always creates a `pending` advisor, so the first admin has to be promoted
by hand. Sign up through the UI, then:

```bash
npx wrangler d1 execute cttagents --local --command "UPDATE users SET role='admin', status='active' WHERE email='you@example.com';"
```

Drop `--local` and use `--remote` to do the same against production. After that,
every other account is approved from `/admin/`.

---

## Checks

Plain JavaScript, no build step, no types. Four checks stand in for what a
compiler would have said, and each exists because of a bug that shipped.

```bash
npm run check:columns             # offline: column lists, and scope
npx wrangler dev --local          # in one terminal, for the two below
npm run check:contracts           # page syntax, then page contracts
npm run check:smoke               # the whole portal, end to end
```

All four run on every push to `main`, against a Worker started from this
repo's own `wrangler.toml` and a D1 built from the migrations in that commit.
See `.github/workflows/checks.yml`.

**Column lists.** Every read names its columns in a shared constant. A
migration adds a column, the constant is not updated, the write succeeds and
the read comes back undefined. Nothing throws; the field is simply always
empty. `check-columns` builds the schema from the migrations and compares.

**Scope.** A read may widen to the whole agency when an owner asks. A write
never may. The failure is not a wrong scope but a missing one, which returns
everybody's rows and looks normal when you test on one account. `check-scope`
requires a user predicate on every statement touching an advisor's tables, and
requires writes to name `user_id` outright rather than borrow a read's scope.
It found a real one: the automation sweep was firing one advisor's automations
against every advisor's payments.

**Page syntax.** A function declaration inside an object literal took the whole
dashboard down and passed every other check, because the smoke test only talks
to the API and the contract check reads field names out of the page without
caring whether the file parses. Every page script is now parsed first.

**Page contracts.** Nothing catches a page reading a field the API stopped
returning. A rename moved `collectedCents` to `postedCents`, the follow-up edit
to the page silently failed to apply, and two figures on Payments rendered as
zero. The checker signs in, fetches the endpoint behind each page, and compares
every field the page reads against what came back. A page whose response has no
rows is reported as unverifiable rather than passed or failed, because an empty
table and a misspelled field look identical and guessing is what makes a
checker not worth running.

**Smoke test.** Three of this portal's paths were only ever exercised by a real
person doing a real thing weeks apart:

- signup, pending, admin approval, first sign in
- a hosted form submission arriving as a lead
- an automation firing from that submission and running

It drives those end to end in about a second, along with reservations, the
soft/hard schedule, pricing, payments and credits, quotes and statements, the
commission split, and the scope rules between an owner and an associate. It
cleans up after itself, including when it bails early, and names any section it
had to skip so the count means the same thing wherever it is read.

## The dashboard

Panels can be reordered and switched off per advisor, and the arrangement is
stored server side so it follows them between a laptop and a phone. Reordering
works by drag and by arrow buttons: drag alone would leave the dashboard
unarrangeable for anyone not using a mouse.

The panel catalogue lives in `src/prefs.js`, on the server, because a saved
layout is user supplied data that gets rendered back into a page. Unknown ids
are dropped rather than stored, duplicates collapse, and panels added in a
later release are appended to everyone's layout on read, so a new panel
appears without anybody having to reset their dashboard.

Quick links accept `http` and `https` only. A saved `javascript:` URL would be
stored once and then clicked by its author on every later visit.

## The sailing catalog

A local copy of the CruiseFeed catalog, imported into D1 and read from there.
The import loop is lifted from the CruiseShoppers portal, which has run it over
about 75,000 rows; keeping the proven shape rather than writing a second one
matters, because the awkward parts are not obvious. In particular `dedupe=true`
is required for a bulk import: without it the API returns each sailing once per
source, which inflates the near-term rows so much that paging by offset covers
a fortnight of calendar and then stops.

It needs the `CRUISEFEED_KEY` secret on the Worker. The cron calls it every
five minutes and it does nothing at all once the current monthly snapshot is
fully imported, so it costs about one request a day.

Three things it buys:

- A reservation can be built by picking a real sailing, so the vendor and ship
  are spelled the way the vendor spells them. One row per vendor in a report
  rather than three.
- Real return dates. A pasted book of business carries a departure and no
  return, because no back office puts one in a list.
- Filling those gaps afterwards, matched on ship and departure date.

The fill is offered, never applied on its own, and never overwrites a value
that is already there. The match is a strong guess rather than a fact, and a
date written in by software is indistinguishable afterwards from one an
advisor confirmed.

## Who sees what

Two kinds of account use the portal.

**An agency owner is an admin.** They see every advisor's reservations,
payments and production, and every screen that can span more than one advisor
carries a picker to narrow it down. Reports break down per advisor. An
independent advisor working alone is also an admin, where "everyone" happens to
be just them, so one code path covers both without a setting to get wrong.

**An advisor associate sees their own records and nothing else.** No picker is
offered, and `?advisor=` in the query string is ignored for them: the scope is
derived from the signed in user, never from the request.

Seeing is not editing. An owner can open an associate's reservation but cannot
write to it. Reads use the visibility scope; every write uses `selfScope`, and
keeping those two lookups separate is what stops them quietly becoming one
permission. The smoke test asserts each of these from both sides.

## Deploying

No Node or CLI required. Everything below is done in the Cloudflare dashboard,
the same way the other Worker sites are run.

1. **Create the database.** Storage & Databases > D1 > Create database, named
   `cttagents`. Its id is already in `wrangler.toml`.
2. **Create the tables.** Open the database, go to the **Console** tab, paste
   the whole of `migrations/0001_init.sql`, and run it. Every later migration in
   that folder is applied the same way, in filename order.
3. **Connect the Worker.** Workers & Pages > Create > Import a repository, and
   pick this repo. Workers Builds reads `wrangler.toml` and wires up the D1
   binding and static assets automatically. Pushes to `main` redeploy.
4. **Add the secrets** under the Worker's Settings > Variables and Secrets. See
   the table below.
5. **Make the first admin.** Visit `/signup` on the deployed URL and sign up.
   That creates a `pending` account which cannot sign in. Then run this in the
   D1 Console tab:

   ```sql
   UPDATE users SET role='admin', status='active' WHERE email='you@example.com';
   ```

   Every account after that is approved from `/admin/` with a button.
6. **Point the domain** at the Worker under Settings > Domains & Routes.

If you do have Node locally, the same steps are available as
`npx wrangler d1 create cttagents`, `npx wrangler d1 migrations apply cttagents --remote`,
and `npx wrangler secret put GHL_API_TOKEN`.

### A secret set in the dashboard needs a deploy

This Worker is deployed by Workers Builds from git, so adding or changing a
secret in the dashboard does **not** reach the running Worker on its own. The
Variables and Secrets page has no Deploy button, because deployment comes from
`main`. Push any commit, or hit Retry build on the latest deployment, and the
new secret takes effect with it.

`GET /api/admin/health` lists every binding and variable the Worker can
actually see, which is the quickest way to tell "not deployed yet" apart from
"saved in the wrong place".

### Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `GHL_API_TOKEN` | For everything CRM | GoHighLevel Private Integration Token. Create it at Settings > Private Integrations on the CTT sub-account, with contacts read/write, opportunities read/write and calendars read. Without it those two pages show a setup notice; everything else works. |
| `RESEND_API_KEY` | For email | Approval, welcome and password-reset emails. Without it sends are skipped and logged, and nothing fails. |

Non-secret config lives in `[vars]` in `wrangler.toml`, including
`GHL_DEFAULT_LOCATION_ID`, the CTT sub-account `JxDfISzvUbtcobLNDHl3`. The
token that reaches it is a secret and is set separately; see "First deploy".

---

## GoHighLevel tenancy

Every advisor resolves to a location id: their own `ghl_location_id` in D1 when
set, otherwise `GHL_DEFAULT_LOCATION_ID`. That supports both models without a
code change.

- **One shared sub-account.** Leave `ghl_location_id` null on every advisor.
  Everyone works in the CTT sub-account. Set each advisor's `ghl_user_id`
  from `/admin/` so records can be attributed to them.
- **A sub-account per advisor.** Bind each advisor to their own location id from
  `/admin/`. This needs an agency-level token that can reach all of them.

`src/ghl.js` is the only file that talks to GoHighLevel, and it normalizes every
response, so the rest of the portal never depends on GHL's field naming. It also
retries rate limits and 5xx with backoff, because a single transient failure was
otherwise surfacing to advisors as a scope problem.

### Checking the token

`GET /api/admin/health?probe=1` (admin only) pings one cheap read per GHL area
and reports which the token can reach. A Private Integration Token has a fixed
scope set chosen at creation, and a missing scope returns 403 rather than an
empty result, so this is the fastest way to tell a permissions problem from an
empty CRM. It reports presence only, never values. `?probe=email` asks Resend whether the
key is accepted and the sending domain verified, and `POST /api/admin/test-email`
sends for real and returns Resend's actual response.

### Email deliverability

Sending needs more than a verified domain. Yahoo and Gmail both require a DMARC
record, and a domain with SPF and DKIM but no DMARC gets silently dropped rather
than bounced, which looks identical to a broken app. `_dmarc.cttagents.com`
carries `v=DMARC1; p=none; rua=...`. If mail stops arriving, check that record
before suspecting the portal.

The portal needs contacts, opportunities, conversations, conversation messages,
calendars, custom fields, tags and users.

---

## Layout

```
src/
  worker.js     Router, auth gate on /app and /admin, static asset serving, cron
  auth.js       Signup, sign in, sessions, password reset, requireUser/requireAdmin
  db.js         Every D1 query, and the scope helpers everything else uses
  util.js       JSON responses, cookies, PBKDF2, validation, money and dates
  email.js      Resend templates and the send that knows what is worth retrying

  A reservation
  bookings.js   Reservation CRUD, the record page payload, partial updates
  pricing.js    What the client pays, in parts, and which parts earn commission
  options.js    The two or three choices a quote offers, and which was taken
  travellers.js The people on a trip, their documents, and the amenities granted
  payments.js   The schedule, chasing, posting, and the credit ledger behind it
  statement.js  What the client is told: a quote, or a statement, never both
  split.js      How a commission divides between the advisor and the agency
  credits.js    Credits a client holds with a vendor, and when they lapse
  groups.js     Blocks of cabins and the option date that releases them

  The book
  clients.js    One client across their trips
  vendors.js    One spelling per vendor, and the terms they trade on
  commissions.js  What is owed, by age and by vendor
  goals.js      A target and whether you are on course for it
  tasks.js      The working list
  reports.js    Dashboard, production, and the notices worth acting on
  prefs.js      Which dashboard panels an advisor sees, and in what order
  search.js     One box across clients, reservations and vendors
  importer.js   Pasting an existing book in, and filling the gaps afterwards
  catalog.js    The CruiseFeed sailing catalog, imported in resumable steps
  catalogapi.js Filling a reservation's blanks from that catalog

  GoHighLevel
  ghl.js        API client and response normalizers
  crm.js        The local mirror the pages read
  sync.js       Keeping that mirror current
  leads.js, conversations.js, calendar.js, pipeline.js, billing.js
                Contacts, threads, appointments, opportunities, invoices
  forms.js, formbuilder.js, publicform.js
                Hosted forms and the submissions that become leads
  automations.js  Triggers, steps, runs, and the retry ladder
  library.js, marketing.js  Assets and campaigns
  admin.js      Approve, suspend, bind and split advisors; health; maintenance

public/
  css/app.css   Whole design system, hand written
  js/app.js     API wrapper, formatting, app shell
  app/          Advisor pages
  admin/        Admin pages
migrations/     D1 schema
```

## Security notes

- Passwords are PBKDF2-SHA256, 100k iterations, per-user salt.
- The session cookie holds a random token; D1 stores only its SHA-256, so a
  database read cannot mint a session.
- Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`.
- Signup never reveals whether an address is already registered, and password
  reset always answers the same way.
- Changing a password or suspending an account deletes that user's sessions
  immediately rather than waiting for expiry.
- `run_worker_first = true` is what makes the page gate real. Without it
  Cloudflare would serve `/app/*.html` directly and skip the session check.

## Brand

Navy `#12315e` with a teal `#1a8fa3` accent, both sampled from the Cruises Tours
& Travel logo. Tokens are at the top of `public/css/app.css`.

The teal ramp is `--teal-600` through `--teal-50`. The old `--coral-*` names are
kept as aliases pointing at the same values, because upstream still owns most of
that file and renaming a token used in sixty places would turn every future
cherry-pick into a conflict. New rules should use `--teal-*`.

`public/logo-mark.png` is the circular ship-and-globe emblem, cropped from the
agency's horizontal logo and padded square. It is the only logo file here, and
it is raster; if the original vector artwork turns up, replacing it is a
drop-in.

The full horizontal lockup is deliberately **not** committed, because there is
nowhere it currently fits. Both slots that would take it want something else:

- `agencies.logo_url` renders into a 36x36 square on the client-facing share
  and form pages, which would squash a wide lockup.
- The email header at `src/email.js` does allow a wide logo, but it sits on a
  panel filled with the agency's brand colour, and the lockup is navy on
  transparent, so it would disappear into it.

Either needs a knockout (white) variant of the lockup. Add one and the email
header will use it as-is.

---

## Relationship to Trip Vara

This repository is a fork of `ccola4me2/trip-vara-website`, which runs the same
portal for a different agency. The full history came across, and upstream is
wired up as a remote:

```
git remote -v
upstream  https://github.com/ccola4me2/trip-vara-website.git
```

The intent is to **track upstream and cherry-pick**, not to drift. A fix or a
feature built on Trip Vara can come over as:

```
git fetch upstream
git log --oneline main..upstream/main
git cherry-pick <sha>
```

Because the two trees are identical apart from branding, most commits apply
cleanly. Conflicts, when they happen, are almost always one of the known
branding edits:

| What differs | Where |
| --- | --- |
| Product name, "CTT Tools", titles, footers | `public/**`, `src/email.js`, `src/ghl.js` |
| Palette hexes and the `--teal-*` ramp | `public/css/app.css`, `src/email.js`, `src/share.js`, `src/publicform.js`, `src/statement.js` |
| Logo files and their references | `public/logo-*.png`, `<link rel="icon">` lines |
| Worker name, D1 name, R2 bucket, vars | `wrangler.toml`, `package.json`, `.github/workflows/checks.yml` |
| House agency row | `migrations/0050_agencies.sql`, `scripts/seed-admin.mjs` |

Resolve in favour of CTT's branding and take upstream's logic.

---

## First deploy

Nothing here is wired to a live Cloudflare resource yet. In order:

1. **D1.** Create a database named `cttagents` (dashboard > Storage & Databases
   > D1) and paste its id into `database_id` in `wrangler.toml`. The committed
   placeholder is invalid on purpose so a premature deploy fails loudly rather
   than binding to the wrong book.
2. **R2.** Create a bucket named `cttagents-docs`. A binding that points at a
   bucket which does not exist fails `wrangler deploy` outright.
3. **Migrations.** Apply `migrations/0001` through `0053` in order. These are
   applied by hand through the D1 console here, so "committed" and "applied" are
   separate facts. `GET /api/admin/health` compares the live database against
   `src/schema-expected.js` and names any file still outstanding.
4. **Worker.** Connect the repo in Workers Builds so `main` deploys itself, then
   attach `cttagents.com`.
5. **GoHighLevel.** The sub-account id is already in `GHL_DEFAULT_LOCATION_ID`.
   What is left is `GHL_API_TOKEN`: create a Private Integration Token on that
   sub-account (Settings > Private Integrations) with contacts read/write,
   opportunities read/write and calendars read, and set it as a secret. Until
   then every CRM screen says "CTT Tools is not connected yet" and the rest of
   the portal works.
6. **Email.** Verify a sending domain in Resend, set `RESEND_API_KEY`, and
   correct `MAIL_FROM`. Add a `_dmarc` record: Gmail and Yahoo drop mail
   silently without one even when SPF and DKIM pass.

Cloudflare secrets set in the dashboard do **not** reach a Workers-Builds Worker
until the next deploy. Push a commit after adding one.
