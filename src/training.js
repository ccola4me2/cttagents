// A first week, in the order it actually happens.
//
// The manual says how everything works and is the right shape for looking
// something up. It is the wrong shape for somebody who joined this morning:
// five hundred lines, eleven topics, no indication which three matter before
// you can take a booking. New advisors were learning this by being told, one
// conversation at a time, which works and does not scale past a few people.
//
// So this is the manual re-cut as a path. Nine lessons, each pointing at the
// part of the manual that explains it and at the page where it is actually
// done, because reading about taking a reservation and taking one are
// different acts and only the second one sticks.
//
// Not a test. Nothing is scored, nothing is timed, and a lesson is finished
// when the advisor says it is. The record exists so that somebody can stop on
// Tuesday and pick up on Thursday, and so the owner can tell the difference
// between an advisor who is stuck and one who is simply busy. Treating it as a
// mark out of nine would change what people do with it, and what they would do
// is tick all nine on the first morning.
//
// Order is the content here. Everything before "Send it" builds one real
// reservation; everything after it is the work that follows a yes.

import { json, clean, uid, now, readJson } from './util.js';
import { requireUser, requireAdmin } from './auth.js';

/**
 * The course.
 *
 * `manual` is an anchor on /app/manual and `page` is where the doing happens.
 * Both are checked against the real files by scripts/check-training.mjs, so a
 * renamed section or a deleted page fails the build rather than leaving a new
 * advisor on a page that does not exist.
 *
 * `doing` is the part that makes this training rather than reading. Every
 * lesson that can be practised on a real record says so in the imperative, and
 * the ones that cannot say what to look at instead.
 */
export const LESSONS = [
  {
    key: 'start',
    title: 'What this portal is, and what it is not',
    why: 'It records and chases the money. It never takes it: the client always pays the '
      + 'supplier directly. Knowing that first stops half the questions people ask in week one.',
    manual: 'what',
    page: '/app/manual#boards',
    doing: 'Read the first two sections, then look at the two boards and work out which one '
      + 'somebody you are talking to belongs on.',
  },
  {
    key: 'client',
    title: 'Put your first client on the book',
    why: 'Everything hangs off a client record: the trip, the paperwork, what they are owed, '
      + 'what they can see. A reservation typed without one makes a second half-empty record.',
    manual: 'clients',
    page: '/app/clients',
    doing: 'Add one real person, with their email address. The address is what the portal '
      + 'matches on later, so it is the field worth getting right.',
  },
  {
    key: 'reservation',
    title: 'Take your first reservation',
    why: 'This is the job. Everything else in the portal is either leading up to a reservation '
      + 'or following one.',
    manual: 'reservations',
    page: '/app/new',
    doing: 'Take a real one, or a rehearsal you delete afterwards. Pick the client you just '
      + 'added rather than typing the name again.',
  },
  {
    key: 'pricing',
    title: 'Price it: one line per thing',
    why: 'Fare, taxes, gratuities and extras are separate lines because they are commissioned '
      + 'differently. Typing one lump sum is the single most common way a commission comes out wrong.',
    manual: 'reservations',
    page: '/app/reservations',
    doing: 'Put the real lines on the reservation you just took. Two travellers means two fare '
      + 'lines; the client sees them added up, not doubled.',
  },
  {
    key: 'quote',
    title: 'Send it, and let them answer',
    why: 'The client gets a page of their own with the costs on it and a yes or no. Their answer '
      + 'comes back to you by email. Nothing is booked and nothing is paid by their pressing yes.',
    manual: 'clientpages',
    page: '/app/reservations',
    doing: 'Send the quote, then open the client link yourself and read it as they will. '
      + 'Send it to your own address first if you would rather rehearse.',
  },
  {
    key: 'money',
    title: 'Deposits, the balance, and the ninety day trap',
    why: 'Inside ninety days of sailing there is usually no deposit at all: the whole fare is '
      + 'due. A balance worked out as total minus deposit is wrong in exactly that case, and it '
      + 'is the error that costs a client their cabin.',
    manual: 'money',
    page: '/app/payments',
    doing: 'Read this one before you need it. Then look at the payment dates on a live '
      + 'reservation and check they match what the supplier actually said.',
  },
  {
    key: 'commission',
    title: 'What you keep',
    why: 'Your split is agreed with the agency and stamped onto each reservation when it is '
      + 'taken, so changing the standing rate later never rewrites what you have already earned.',
    manual: 'commission',
    page: '/app/commissions',
    doing: 'Look at your own figures. You see yours and nobody else sees them, which is worth '
      + 'knowing before you wonder whether to ask.',
  },
  {
    key: 'daily',
    title: 'The day’s work',
    why: 'Anything with a date on it chases you rather than waiting to be found. One email each '
      + 'morning says what is due today and what is late. One, not one per task.',
    manual: 'daily',
    page: '/app/tasks',
    doing: 'Put a task on the reservation you took, with a date on it, and let tomorrow morning '
      + 'remind you about it.',
  },
  {
    key: 'chat',
    title: 'Asking for help',
    why: 'Nobody is expected to know the ninety day rule in their first month. Asking in the '
      + 'portal keeps the answer where the next person can find it.',
    manual: 'chat',
    page: '/app/chat',
    doing: 'Say hello, and put your name to a question you already have. Somebody typing your '
      + 'name in reaches you by email too.',
  },
];

const KEYS = new Set(LESSONS.map((l) => l.key));

/**
 * Where one advisor has got to.
 *
 * Their own rows only, always. An advisor's progress is theirs, and the owner
 * board below is a separate read with a separate gate rather than this one
 * widened by a parameter.
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
    finished,
    total: lessons.length,
    // The next unfinished one, so the page can say where to pick up rather
    // than making somebody scan nine cards for the first unticked box.
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
