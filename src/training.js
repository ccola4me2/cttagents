// The whole portal, in the order somebody would learn it.
//
// The first version of this was nine lessons covering the path to a first
// booking. That is the right thing for a first morning and the wrong thing
// for everything after it: it walked past Group space, Proposals out, Lists,
// Emails, Who to call, Automations and twenty other screens, so an advisor
// who finished it still did not know what the portal could do. Most of the
// portal was being paid for and not used.
//
// So this is the whole surface, grouped the way the navigation is grouped,
// because the order somebody learns in should match the order they will later
// look things up in. Your first week still comes first and still builds one
// real reservation. After that each section covers its screens: what it is,
// when you would use it, and the thing people get wrong.
//
// Every lesson names a section of the manual and a page to do the work on,
// and scripts/check-training.mjs checks both against the real files, so a
// renamed section or a moved page fails the build rather than leaving a new
// advisor on a page that does not exist.
//
// Still not a test. Nothing is scored and nothing is timed. The ticks exist
// so somebody can stop on Tuesday and pick up on Thursday, and so an owner
// can tell a stuck advisor from a busy one.
//
// The rules that are not discoverable by clicking live on the cheat sheet at
// /app/cheatsheet rather than here: the ninety day trap, how a split is
// resolved, which figures exclude what. A lesson can send somebody there, but
// a rule somebody needs while on the phone should not be four clicks inside a
// course.

import { json, clean, uid, now, readJson } from './util.js';
import { requireUser, requireAdmin } from './auth.js';

export const SECTIONS = [
  { key: 'first', title: 'Your first week', blurb: 'Enough to take a booking and get paid for it. Do these in order.' },
  { key: 'reservation', title: 'Reservations and money', blurb: 'The trip itself, the deadlines on it, and what the vendor owes.' },
  { key: 'client', title: 'Clients and prospects', blurb: 'The people, from the first enquiry to the family who books every year.' },
  { key: 'day', title: 'The day\'s work', blurb: 'What you open every morning, and the places you look things up.' },
  { key: 'market', title: 'Finding the next booking', blurb: 'The parts that bring work in rather than process work you already have.' },
  { key: 'report', title: 'Knowing where you stand', blurb: 'Your numbers, your targets and your own account.' },
];

export const LESSONS = [
  {
    key: 'what-this-is',
    section: 'first',
    title: 'What this portal is, and what it is not',
    why: 'It records and chases the money. It never takes it: the client always pays the supplier directly. Knowing that first stops half the questions people ask in week one.',
    manual: 'what',
    page: '/app/manual#boards',
    doing: 'Read the first two sections, then look at the two boards and work out which one somebody you are talking to belongs on.',
  },
  {
    key: 'first-client',
    section: 'first',
    title: 'Put your first client on the book',
    why: 'Everything hangs off a client record: the trip, the paperwork, what they are owed, what they can see. A reservation typed without one makes a second half-empty record.',
    manual: 'clients',
    page: '/app/clients',
    doing: 'Add one real person, with their email address. The address is what the portal matches on later, so it is the field worth getting right.',
  },
  {
    key: 'first-reservation',
    section: 'first',
    title: 'Take your first reservation',
    why: 'This is the job. Everything else in the portal is either leading up to a reservation or following one.',
    manual: 'reservations',
    page: '/app/new',
    doing: 'Take a real one, or a rehearsal you delete afterwards. Pick the client you just added rather than typing the name again.',
  },
  {
    key: 'first-pricing',
    section: 'first',
    title: 'Price it: one line per thing',
    why: 'Fare, taxes, gratuities and extras are separate lines because they are commissioned differently. Typing one lump sum is the single most common way a commission comes out wrong.',
    manual: 'reservations',
    page: '/app/reservations',
    doing: 'Put the real lines on the reservation you just took. Two travellers means two fare lines; the client sees them added up, not doubled.',
  },
  {
    key: 'first-quote',
    section: 'first',
    title: 'Send it, and let them answer',
    why: 'The client gets a page of their own with the costs on it and a yes or no. Their answer comes back to you by email. Nothing is booked and nothing is paid by their pressing yes.',
    manual: 'clientpages',
    page: '/app/reservations',
    doing: 'Send the quote, then open the client link yourself and read it as they will. If they write a note on the page it arrives by email and on the reservation; answer from the reservation page and the reply appears under their note and is emailed to them.',
  },
  {
    key: 'first-schedule',
    section: 'first',
    title: 'Build the payment schedule',
    why: 'Reminders are built from the schedule, not from the final payment date. A reservation with no lines on it has nothing to chase, and an empty schedule is the one thing nothing can catch.',
    manual: 'money',
    page: '/app/complete',
    doing: 'Press Build schedule on your reservation. Then read the ninety day rule on the cheat sheet before you price anything sailing soon.',
  },
  {
    key: 'reservations',
    section: 'reservation',
    title: 'Reservations',
    why: 'Trips, vendor deadlines and commission in one list. This is the page you will have open most.',
    manual: 'reservations',
    page: '/app/reservations',
    doing: 'Open one and walk every panel: travellers, pricing, payments, documents, the client\'s own page.',
  },
  {
    key: 'trips',
    section: 'reservation',
    title: 'One holiday, several reservations',
    why: 'A trip to Spain can be nine reservations: flights, hotels, a train, tours. The client should get one link with the whole itinerary in date order, not nine pages to open.',
    manual: 'clientpages',
    page: '/app/reservations',
    doing: 'Tick two or three reservations that are one holiday on the list and press Put together as one trip. Write a welcome and a Good to know note, then use See what they see before you share the link. Quotes cannot go in a trip, and a reservation is in one trip at a time.',
  },
  {
    key: 'gaps',
    section: 'reservation',
    title: 'Fill in the gaps',
    why: 'Reservations missing the numbers and dates everything else depends on. An empty payment schedule is invisible everywhere else in the portal and shows up here.',
    manual: 'money',
    page: '/app/complete',
    doing: 'Open it and clear anything listed. If it is empty, that is the answer.',
  },
  {
    key: 'proposals',
    section: 'reservation',
    title: 'Proposals out',
    why: 'Everything quoted and unanswered, grouped by who it is waiting on. A quote nobody chases is the commonest way a booking is lost.',
    manual: 'selling',
    page: '/app/proposals',
    doing: 'Look at what is waiting on you rather than on the client, and clear that side first.',
  },
  {
    key: 'groups',
    section: 'reservation',
    title: 'Group space',
    why: 'A vendor is holding cabins for you and there is a date they take them back. This tracks how many are sold and how long you have. It can start from the cruise line\'s own proposal: upload the PDF and the details fill in for you to check.',
    manual: 'reservations',
    page: '/app/groups',
    doing: 'Start a group by uploading a proposal or contract, and read what it says it filled in and what it left blank. Margaritaville, Norwegian and Celebrity are read in full; any other line only where the document labels a detail clearly. Nothing saves until you press the button. If you run no groups yet, know it exists for when you do.',
  },
  {
    key: 'payments-due',
    section: 'reservation',
    title: 'Payments Due',
    why: 'Every client deadline across every reservation, late at the top. Miss a vendor date and the reservation cancels, so this is the page with real consequences.',
    manual: 'money',
    page: '/app/payments',
    doing: 'Check what is late. Read on the cheat sheet why a line can say past due when the money is in.',
  },
  {
    key: 'commission-owed',
    section: 'reservation',
    title: 'Commission owed',
    why: 'What vendors owe the agency, what they have actually paid, and how long they have owed it, aged in bands.',
    manual: 'commission',
    page: '/app/commissions',
    doing: 'Look at anything over ninety days. That band is money that may quietly never arrive.',
  },
  {
    key: 'imports',
    section: 'reservation',
    title: 'Bringing your book across',
    why: 'An existing book of business and an existing client list can both be pasted in rather than typed one at a time.',
    manual: 'reservations',
    page: '/app/import',
    doing: 'Only if you are new and have a book elsewhere. Otherwise just know both pages exist.',
  },
  {
    key: 'leads',
    section: 'client',
    title: 'Leads',
    why: 'People who got in touch and have not booked. Drag a card to move it along. A lead with a next step date chases you every morning until it is dealt with.',
    manual: 'clients',
    page: '/app/leads',
    doing: 'Put a next step and a date on one lead and let tomorrow\'s email remind you.',
  },
  {
    key: 'clients-deep',
    section: 'client',
    title: 'Clients, and finding the ones you cannot see',
    why: 'The page defaults to people who have booked, so a prospect you know is in there can look missing. Search finds them, or switch the filter to Everyone.',
    manual: 'clients',
    page: '/app/clients',
    doing: 'Switch the filter to Everyone once, so you know where it is when somebody seems to be missing.',
  },
  {
    key: 'households',
    section: 'client',
    title: 'Households',
    why: 'People who live together, so a family books as a family and gets one page rather than four.',
    manual: 'clients',
    page: '/app/households',
    doing: 'Put one real family together and look at what their page becomes.',
  },
  {
    key: 'pipeline',
    section: 'client',
    title: 'Sales opportunities',
    why: 'Where every live reservation stands, as a board. The same reservations as the list, arranged by what has to happen next.',
    manual: 'boards',
    page: '/app/pipeline',
    doing: 'Compare it with the Reservations list and work out which view suits how you think.',
  },
  {
    key: 'segments',
    section: 'client',
    title: 'Lists',
    why: 'Who to write to, worked out from what they have booked rather than typed by hand. A list built from a rule stays right as the book changes.',
    manual: 'selling',
    page: '/app/segments',
    doing: 'Build one list, for instance everyone who has sailed with a line you are running a deal on.',
  },
  {
    key: 'broadcasts',
    section: 'client',
    title: 'Emails',
    why: 'One message to a list, sent once. This is where a list becomes a thing people receive.',
    manual: 'selling',
    page: '/app/broadcasts',
    doing: 'Send one to a list of yourself only, and read what arrives before you ever send to clients.',
  },
  {
    key: 'credits',
    section: 'client',
    title: 'Client credits',
    why: 'Money your clients already hold with a vendor, and the date it stops being worth anything. A credit nobody spends is a client who lost money with you.',
    manual: 'money',
    page: '/app/credits',
    doing: 'Check for anything expiring. The portal flags credits lapsing within ninety days.',
  },
  {
    key: 'hotlists',
    section: 'client',
    title: 'Who to call',
    why: 'Five reasons to pick up the phone, drawn from what the portal already knows: gone quiet, a credit running out, a birthday, a trip just home.',
    manual: 'selling',
    page: '/app/hotlists',
    doing: 'Open it on a Monday and ring one person from it.',
  },
  {
    key: 'dashboard',
    section: 'day',
    title: 'The dashboard',
    why: 'A birds eye view you can rearrange. What is on it is your choice, so it is worth setting up once rather than scrolling past it every morning.',
    manual: 'daily',
    page: '/app/',
    doing: 'Press Customise and move the panels into the order you actually read.',
  },
  {
    key: 'calendar',
    section: 'day',
    title: 'Calendar',
    why: 'Your appointments and everything else that lands on a day: departures, deadlines, tasks. It syncs with Google and Outlook.',
    manual: 'daily',
    page: '/app/calendar',
    doing: 'Put one appointment on it and see it appear in tomorrow morning\'s email.',
  },
  {
    key: 'tasks',
    section: 'day',
    title: 'To do',
    why: 'Your working list. Anything with a date on it chases you rather than waiting to be found, and one email each morning says what is due and what is late.',
    manual: 'daily',
    page: '/app/tasks',
    doing: 'Put a dated task on the reservation you took and let the morning email chase it.',
  },
  {
    key: 'chat',
    section: 'day',
    title: 'Chat',
    why: 'Everyone who works here, and no client ever sees any of it. A message reaches you as a card if the portal is open, as a notification on your phone or computer if you have turned that on, and in the morning email if you have not read it. A discussion on a reservation only shows in your list once somebody has written in it.',
    manual: 'chat',
    page: '/app/chat',
    doing: 'Say hello, and put your name to a question you already have.',
  },
  {
    key: 'vendors',
    section: 'day',
    title: 'Vendors',
    why: 'Who you sell, who to ring there, and how to sign up. A supplier directory you open between other things. The contacts and rates are shared with the agency; the trips and totals listed under a supplier are only your own.',
    manual: 'reservations',
    page: '/app/vendors',
    doing: 'Look up a line you sell and check the contact is one you would actually use.',
  },
  {
    key: 'cruise-search',
    section: 'day',
    title: 'Cruise search',
    why: 'Every sailing in the catalog, searched the way a cruise is actually chosen.',
    manual: 'selling',
    page: '/app/cruise-search',
    doing: 'Search a week you are being asked about and see what comes back.',
  },
  {
    key: 'reviews',
    section: 'market',
    title: 'Reviews',
    why: 'What clients said when they got home, and who they sent you. Referrals are the cheapest business there is and this is where they are recorded.',
    manual: 'selling',
    page: '/app/reviews',
    doing: 'Read how a request goes out, so you know what your client receives.',
  },
  {
    key: 'specials',
    section: 'market',
    title: 'Specials',
    why: 'The deals you are running, when each one dies, and a page to send people to.',
    manual: 'selling',
    page: '/app/specials',
    doing: 'Look at one and follow the public link it gives you.',
  },
  {
    key: 'forms',
    section: 'market',
    title: 'Lead forms',
    why: 'Your own forms, hosted on your domain. A form submission arrives as a lead rather than as an email you have to retype.',
    manual: 'selling',
    page: '/app/formbuilder',
    doing: 'Look at a form and submit it yourself once, then find yourself on the lead board.',
  },
  {
    key: 'qr',
    section: 'market',
    title: 'QR codes',
    why: 'A square somebody can point a phone at, for anything you hand out: a card, a flyer, a stand at a show.',
    manual: 'selling',
    page: '/app/qr',
    doing: 'Make one for a form and scan it with your own phone.',
  },
  {
    key: 'automations',
    section: 'market',
    title: 'Automations',
    why: 'When something happens, do these things, on its own. This is the part that works while you are asleep, and the part worth setting up slowly.',
    manual: 'selling',
    page: '/app/automations',
    doing: 'Read an existing one end to end before you build your own.',
  },
  {
    key: 'production',
    section: 'report',
    title: 'Production',
    why: 'Volume and commission by departure date, by month, by vendor and by advisor, this year against the same days last year.',
    manual: 'money',
    page: '/app/reports',
    doing: 'Check your own year. Remember cancelled and no commission reservations are excluded on purpose.',
  },
  {
    key: 'targets',
    section: 'report',
    title: 'Targets',
    why: 'What you set out to do this year and whether you are on course for it today, which is the half a number on its own never tells you.',
    manual: 'money',
    page: '/app/goals',
    doing: 'Set one target, even a rough one. The pace mark is the useful part.',
  },
  {
    key: 'account',
    section: 'report',
    title: 'Your account and what you pay',
    why: 'Your details, your password, your notification choices, and what you pay the agency for access to the portal.',
    manual: 'money',
    page: '/app/settings',
    doing: 'Check your notification email is one you read, and turn the morning list on or off deliberately.',
  },
];

const KEYS = new Set(LESSONS.map((l) => l.key));

/**
 * Where one advisor has got to.
 *
 * Their own rows only, always. An advisor's progress is theirs, and the owner
 * board is a separate read with a separate gate rather than this one widened
 * by a parameter.
 */
async function progressFor(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT lesson, completed_at FROM training_progress WHERE user_id = ?'
  ).bind(userId).all().catch(() => ({ results: [] }));
  const done = new Map((results || []).map((r) => [r.lesson, r.completed_at]));
  return LESSONS.map((l) => ({ ...l, done: done.has(l.key), completedAt: done.get(l.key) || null }));
}

/** GET /api/training */
export async function handleTraining(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const lessons = await progressFor(env, user.id);
  const finished = lessons.filter((l) => l.done).length;
  return json({
    lessons,
    // Counted per section as well as overall, because thirty-five ticks in one
    // bar says nothing about whether somebody has finished the part they were
    // working on.
    sections: SECTIONS.map((s) => {
      const mine = lessons.filter((l) => l.section === s.key);
      return { ...s, total: mine.length, finished: mine.filter((l) => l.done).length };
    }),
    finished,
    total: lessons.length,
    next: lessons.find((l) => !l.done)?.key || null,
  });
}

/**
 * POST /api/training
 *
 * Marks one lesson finished, or unfinished. Unticking matters: somebody who
 * ticked the wrong row and cannot undo it learns that the list lies, and a
 * list that lies is not worth keeping.
 */
export async function handleTrainingDone(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const lesson = clean(body.lesson, 40);
  if (!KEYS.has(lesson)) return json({ error: 'No such lesson.' }, 400);

  if (body.done === false) {
    await env.DB.prepare('DELETE FROM training_progress WHERE user_id = ? AND lesson = ?')
      .bind(user.id, lesson).run();
  } else {
    // Upsert rather than read-then-write: two taps on a phone are one finish.
    await env.DB.prepare(
      `INSERT INTO training_progress (id, user_id, lesson, completed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, lesson) DO NOTHING`
    ).bind(uid(), user.id, lesson, now()).run();
  }

  const lessons = await progressFor(env, user.id);
  return json({ ok: true, finished: lessons.filter((l) => l.done).length, total: lessons.length });
}

/**
 * GET /api/admin/training
 *
 * Who has got where, for whoever runs the agency. Fenced on agency_id and
 * written out longhand rather than through a scope helper, because a predicate
 * assembled somewhere else is one scripts/check-scope.mjs cannot read, and
 * this is a read across every advisor in the building.
 *
 * No commission figures and nothing about anybody's clients: this answers one
 * question, which is how far through the course somebody is.
 */
export async function handleTrainingBoard(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.status, u.created_at,
            (SELECT COUNT(*) FROM training_progress t WHERE t.user_id = u.id) AS finished,
            (SELECT MAX(t.completed_at) FROM training_progress t WHERE t.user_id = u.id) AS last_at
       FROM users u
      WHERE u.agency_id = ?
      ORDER BY u.created_at DESC
      LIMIT 200`
  ).bind(user.agency_id).all().catch(() => ({ results: [] }));

  return json({
    total: LESSONS.length,
    advisors: (results || []).map((r) => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email,
      email: r.email,
      status: r.status,
      finished: r.finished || 0,
      lastAt: r.last_at || null,
    })),
  });
}
