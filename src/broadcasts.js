// One message to a list of people, sent once.
//
// The piece that makes the previous two worth having. Lists say who to write
// to and the suppression list says who not to; this is the writing.
//
// Three decisions run through the file.
//
// The recipients are frozen when send is pressed. A list is a question
// re-asked every time it is opened, which is right for "who should I write
// to" and wrong for "who got Tuesday's email". Freezing also makes the send
// resumable: a Worker invocation lasts seconds, four hundred emails do not,
// and the cron drains the queue a batch at a time without sending anybody
// twice.
//
// Suppression is checked at send time rather than at freeze time. A send that
// takes an hour will overlap somebody unsubscribing during it, and the whole
// point of the list is that the last word wins.
//
// It is marketing, always. Every message carries the unsubscribe footer and
// the agency's postal address, with no switch to turn that off, because the
// one thing nobody should be able to do from a screen like this is send four
// hundred people a newsletter with no way out of it.

import {
  json, badRequest, notFound, clean, cleanText, uid, now, readJson, PermanentError,
} from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { resolveSegment, buildWhere } from './segments.js';
import { isSuppressed, unsubscribeToken, marketingFooter, normalise } from './suppression.js';
import { sendAutomationEmail } from './email.js';

// How many go out per cron tick, and how far apart.
//
// Resend rate limits at two requests a second. Firing forty as fast as the
// Worker can issue them is roughly five times that, so most of them come back
// 429 and the send reports itself as a disaster. The gap below keeps it under
// the limit on purpose, which makes a pass take about fifteen seconds of
// waiting and almost no CPU.
//
// Twenty-five every five minutes is three hundred an hour. That is slower than
// a mail service would do it and faster than any list a travel advisor
// actually holds needs. The alternative is Resend's batch endpoint, which
// sends a hundred in one request and rejects all hundred if one address in it
// is malformed; per-person sending costs more requests and gives every person
// their own outcome, which is what the results table is for.
const PER_PASS = 25;
const GAP_MS = 600;

// A transient failure is retried on later passes. Without a ceiling, a Resend
// outage becomes a row retried every five minutes for the rest of the year.
const MAX_ATTEMPTS = 5;

// Merge fields, and deliberately few. Every one of these is a column that is
// either filled in or obviously blank on the client record, so a message can
// be checked by looking at it. A token that silently renders empty is how
// somebody emails four hundred people "Hi ,".
const TOKENS = {
  // What they are actually called. "Goes by" is on the client record for
  // precisely this, and a mailing that opens "Hello Barbara" to somebody
  // everybody calls Barb reads as a mailing rather than as a note.
  first_name: (r) => String(r.nickname || '').trim() || firstName(r.name),
  name: (r) => r.name || '',
};

function firstName(full) {
  return String(full || '').trim().split(/\s+/)[0] || '';
}

/**
 * Fill the merge fields, and say what is left unfilled.
 *
 * Returns the text and the tokens that had nothing behind them, so the preview
 * can show the gap rather than the send discovering it.
 */
export function merge(body, row) {
  const blanks = new Set();
  const text = String(body || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const fn = TOKENS[key.toLowerCase()];
    if (!fn) return whole;
    const value = fn(row);
    if (!value) blanks.add(key.toLowerCase());
    return value;
  });
  return { text, blanks: [...blanks] };
}

/**
 * The agency behind an advisor, for the footer and the suppression list.
 *
 * The address still falls through from the agency record to the advisor's own
 * settings even though the footer no longer prints it, because putting the
 * address back should be a one-line change in marketingFooter rather than a
 * rebuild of how it is found.
 */
async function agencyFor(env, user) {
  const ownAddress = user.agency_address || null;
  const mine = {
    id: user.agency_id || null,
    name: user.agency_name || null,
    address: ownAddress,
  };
  if (!user.agency_id) return mine;

  try {
    const row = await env.DB.prepare(
      'SELECT id, name, address FROM agencies WHERE id = ? LIMIT 1'
    ).bind(user.agency_id).first();
    if (!row) return mine;
    return {
      id: row.id,
      name: row.name || user.agency_name || null,
      address: row.address || ownAddress,
    };
  } catch (e) {
    console.error('agencyFor', e);
    return mine;
  }
}

function appUrl(env) {
  return (env.APP_URL || 'https://cttagents.com').replace(/\/$/, '');
}

const shape = (b) => ({
  id: b.id,
  name: b.name,
  subject: b.subject,
  body: b.body,
  segmentId: b.segment_id,
  rules: safeRules(b.rules_json),
  status: b.status,
  total: b.total,
  sent: b.sent_count,
  failed: b.failed_count,
  skipped: b.skipped_count,
  createdAt: b.created_at,
  startedAt: b.started_at,
  finishedAt: b.finished_at,
});

function safeRules(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// The advisor's side
// ---------------------------------------------------------------------------

export async function handleListBroadcasts(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const scoped = db.scopeWhere(db.selfScope(user), 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT id, name, subject, body, segment_id, rules_json, status, total,
            sent_count, failed_count, skipped_count, created_at, started_at, finished_at
       FROM broadcasts WHERE ${scoped.sql} ORDER BY created_at DESC LIMIT 100`
  ).bind(...scoped.binds).all();
  return json({ broadcasts: (results || []).map(shape) });
}

export async function handleGetBroadcast(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await one(env, user, id);
  if (!row) return notFound('No such message.');

  // Who it went to, and what happened to each. The record of a send is the
  // part somebody comes back to weeks later, so it is kept per person rather
  // than as a tally.
  const { results } = await env.DB.prepare(
    `SELECT client_id, name, email, status, detail, sent_at FROM broadcast_recipients
      WHERE broadcast_id = ? AND user_id = ? ORDER BY status, name LIMIT 1000`
  ).bind(id, row.user_id).all();

  // Said on the page rather than left as a send that never moves. An advisor
  // watching "0 of 40 handled" has no way to tell a slow queue from a Worker
  // with no mail key on it.
  return json({
    broadcast: shape(row),
    recipients: results || [],
    emailConfigured: Boolean(env.RESEND_API_KEY),
  });
}

async function one(env, user, id) {
  const scoped = db.scopeWhere(db.selfScope(user), 'user_id');
  return env.DB.prepare(
    `SELECT id, user_id, agency_id, name, subject, body, segment_id, rules_json, status,
            total, sent_count, failed_count, skipped_count, created_at, started_at, finished_at
       FROM broadcasts WHERE id = ? AND ${scoped.sql} LIMIT 1`
  ).bind(id, ...scoped.binds).first();
}

/** The rules behind a message: its own, or the saved list it points at. */
async function rulesFor(env, user, { segmentId, rules }) {
  if (segmentId) {
    const scoped = db.scopeWhere(db.selfScope(user), 'user_id');
    const row = await env.DB.prepare(
      `SELECT rules_json FROM segments WHERE id = ? AND ${scoped.sql} LIMIT 1`
    ).bind(segmentId, ...scoped.binds).first();
    if (!row) return null;
    return safeRules(row.rules_json);
  }
  return Array.isArray(rules) ? rules.slice(0, 10) : [];
}

export async function handleSaveBroadcast(request, env, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = id ? await db.writerFor(env, user, 'broadcasts', id) : user;
  if (!owner) return notFound('That message is not here.');

  const body = await readJson(request);
  const name = clean(body.name, 80);
  const subject = clean(body.subject, 160);
  const text = cleanText(body.body, 8000);
  if (!name) return badRequest('Give the message a name, so you can find it again.');
  if (!subject) return badRequest('A subject line, please: it is most of whether this gets read.');
  if (!text) return badRequest('The message is empty.');

  const segmentId = clean(body.segmentId, 40) || null;
  const rules = await rulesFor(env, owner, { segmentId, rules: body.rules });
  if (rules === null) return badRequest('That list is not yours.');
  if (!buildWhere(rules).length) {
    // Same refusal the saved lists make, at the same point: when it is named,
    // not when it is sent.
    return badRequest('Pick a list, or add a rule. Without one this is your whole book.');
  }

  const ts = now();
  if (id) {
    const existing = await one(env, owner, id);
    if (!existing) return notFound('No such message.');
    // A sent message is a record of something that happened. Editing the
    // subject afterwards would make the record say something the recipients
    // never read.
    if (existing.status !== 'draft') return badRequest('This has already been sent, so it cannot be changed. Copy it instead.');
    await env.DB.prepare(
      `UPDATE broadcasts SET name = ?, subject = ?, body = ?, segment_id = ?, rules_json = ?,
              updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(name, subject, text, segmentId, JSON.stringify(rules), ts, id, owner.id).run();
    return json({ ok: true, id });
  }

  const agency = await agencyFor(env, owner);
  const newId = uid();
  await env.DB.prepare(
    `INSERT INTO broadcasts (id, user_id, agency_id, name, subject, body, segment_id,
            rules_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  ).bind(newId, owner.id, agency.id, name, subject, text, segmentId,
         JSON.stringify(rules), ts, ts).run();
  return json({ ok: true, id: newId }, 201);
}

export async function handleDeleteBroadcast(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'broadcasts', id);
  if (!owner) return notFound('That message is not here.');
  // A draft, or a send that was stopped before anything went out. A message
  // that reached even one person is the record of that, and removing it would
  // make the portal quietly disagree with somebody's inbox. A send cancelled
  // two seconds after it was started by mistake is not a record of anything,
  // and being stuck with it forever is its own small bug.
  const res = await env.DB.prepare(
    `DELETE FROM broadcasts WHERE id = ? AND user_id = ?
       AND (status = 'draft' OR (status = 'cancelled' AND sent_count = 0))`
  ).bind(id, owner.id).run();
  if (!res.meta || !res.meta.changes) {
    return badRequest('This went out to somebody, so it stays as the record of that.');
  }
  await env.DB.prepare(
    'DELETE FROM broadcast_recipients WHERE broadcast_id = ? AND user_id = ?'
  ).bind(id, owner.id).run();
  return json({ ok: true });
}

/**
 * What this would do, before it does it.
 *
 * Counts the people, counts the ones already unsubscribed, and renders the
 * message against the first of them so the merge fields can be read rather
 * than trusted.
 */
export async function handlePreviewBroadcast(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const rules = await rulesFor(env, user, { segmentId: clean(body.segmentId, 40) || null, rules: body.rules });
  if (rules === null) return badRequest('That list is not yours.');

  const agency = await agencyFor(env, user);
  const out = await resolveSegment(env, db.selfScope(user), rules,
    { limit: 5, agencyId: agency.id });

  const sample = out.people[0] || { name: 'Sample Client', email: 'client@example.com' };
  const rendered = merge(body.body || '', sample);
  const subject = merge(body.subject || '', sample);

  return json({
    total: out.total,
    everybody: out.rulesUsed === 0,
    sample: { name: sample.name, email: sample.email },
    subject: subject.text,
    body: rendered.text,
    // Named rather than counted: "birthday is blank for 3" is actionable and
    // "3 blanks" is not.
    blanks: [...new Set([...rendered.blanks, ...subject.blanks])],
    // How many of them have opted out. Null when it could not be worked out,
    // which the page says rather than rendering a confident zero.
    optedOut: out.optedOut,
    footer: marketingFooter({
      agencyName: agency.name,
      unsubscribeUrl: `${appUrl(env)}/u/preview`,
    }),
  });
}

/** Send it to yourself first. The only way to know what it looks like. */
export async function handleTestBroadcast(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'broadcasts', id);
  if (!owner) return notFound('That message is not here.');
  const row = await one(env, owner, id);
  if (!row) return notFound('No such message.');

  const agency = await agencyFor(env, owner);
  const me = { name: `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || 'You' };
  const to = owner.notify_email || owner.email;

  await sendAutomationEmail(env, to, `[Test] ${merge(row.subject, me).text}`,
    merge(row.body, me).text, {
      // The same From and reply-to a real one carries, or the test is a test
      // of something else.
      fromName: me.name === 'You' ? null : me.name,
      replyTo: to,
      footer: marketingFooter({
        agencyName: agency.name,
        unsubscribeUrl: `${appUrl(env)}/u/${await unsubscribeToken(env, agency.id, to)}`,
      }),
    });

  return json({ ok: true, to });
}

/**
 * Freeze the list and queue the send.
 *
 * The recipients are written as rows here and nothing is emailed: the cron
 * does the sending. That is what makes a send of any size survive a Worker
 * that is cut off mid-flight, and it means this request answers immediately
 * with a number the advisor can watch come down.
 */
export async function handleSendBroadcast(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'broadcasts', id);
  if (!owner) return notFound('That message is not here.');
  const row = await one(env, owner, id);
  if (!row) return notFound('No such message.');
  if (row.status !== 'draft') return badRequest('This has already been sent.');

  const rules = safeRules(row.rules_json);
  if (!buildWhere(rules).length) return badRequest('This message has no list behind it.');

  // Deliberately the advisor's own book rather than whatever scope they are
  // viewing. An owner looking at "all advisors" is reading somebody else's
  // clients, and a marketing email from the wrong person is worse than a
  // report from the wrong person.
  const out = await resolveSegment(env, db.selfScope(owner), rules, { limit: 2000 });
  if (!out.people.length) return badRequest('Nobody is on this list right now.');

  const ts = now();
  const seen = new Set();
  const rows = [];
  for (const p of out.people) {
    const email = normalise(p.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    rows.push(env.DB.prepare(
      `INSERT OR IGNORE INTO broadcast_recipients (id, broadcast_id, user_id, client_id, email, name, status)
       VALUES (?, ?, ?, ?, ?, ?, 'queued')`
    ).bind(uid(), id, owner.id, p.id, email, p.name || null));
  }
  if (!rows.length) return badRequest('Nobody on this list has an email address.');
  await env.DB.batch(rows);

  await env.DB.prepare(
    `UPDATE broadcasts SET status = 'sending', total = ?, started_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(rows.length, ts, ts, id, owner.id).run();

  // The resolver caps at two thousand, so a book bigger than that would
  // otherwise queue two thousand people while the confirmation said the real
  // number. Said out loud instead: the count that matters is what was queued,
  // and anyone left out is still on the list for a second send.
  return json({ ok: true, queued: rows.length, matched: out.total });
}

/** Stop a send that is part way through. The ones already gone have gone. */
export async function handleCancelBroadcast(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Whose record this is: see db.writerFor.
  const owner = await db.writerFor(env, user, 'broadcasts', id);
  if (!owner) return notFound('That message is not here.');
  const res = await env.DB.prepare(
    `UPDATE broadcasts SET status = 'cancelled', finished_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'sending'`
  ).bind(now(), now(), id, owner.id).run();
  if (!res.meta || !res.meta.changes) return badRequest('That message is not sending.');
  await env.DB.prepare(
    `UPDATE broadcast_recipients SET status = 'skipped', detail = 'send cancelled'
      WHERE broadcast_id = ? AND user_id = ? AND status = 'queued'`
  ).bind(id, owner.id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The cron's side
// ---------------------------------------------------------------------------

/**
 * Send the next batch of whatever is queued.
 *
 * Runs as nobody, across every advisor, which is the same shape as the task
 * digest: the scope lives in the rows, each of which was written by one
 * advisor's own scoped query, not in this pass. A no-op when nothing is
 * sending, so it costs one query on almost every tick.
 */
export async function sendQueuedBroadcasts(env, { perPass = PER_PASS } = {}) {
  // Asked before anything is claimed, and this is not a detail.
  //
  // With no key, sendAutomationEmail throws a PermanentError on the first
  // recipient and on every one after it, which this loop would faithfully
  // record as four hundred addresses that do not work. Those rows cannot be
  // retried; the send would have to be built again from nothing, and the
  // results table would be a page of lies about real people.
  //
  // A missing key is a thing to fix on the settings page. The queue waits.
  if (!env.RESEND_API_KEY) return { sent: 0, waiting: 'email is not configured' };

  const live = await env.DB.prepare(
    `SELECT id, user_id, agency_id, subject, body FROM broadcasts
      WHERE status = 'sending' ORDER BY started_at LIMIT 1`
  ).first();
  if (!live) return { sent: 0 };

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.email, r.attempts, r.name, c.nickname
       FROM broadcast_recipients r
       -- The owner is named on the join as well as implied by it. The
       -- client_id was written by one advisor's own scoped query when they
       -- pressed send, so this could only ever reach their client; saying so
       -- means the statement is safe read on its own rather than safe because
       -- of something that happened an hour earlier in another function.
       LEFT JOIN clients c ON c.id = r.client_id AND c.user_id = r.user_id
      WHERE r.broadcast_id = ? AND r.status = 'queued'
      ORDER BY r.attempts, r.id LIMIT ?`
  ).bind(live.id, perPass).all();

  const agency = live.agency_id
    ? await env.DB.prepare('SELECT id, name, address FROM agencies WHERE id = ? LIMIT 1')
        .bind(live.agency_id).first()
    : null;

  // Who it is from. Once per pass, not once per recipient.
  //
  // The address stays the verified one, because Resend will not send from a
  // domain it has not verified and fails silently when asked to. The display
  // name and the reply-to are the advisor's, which is the difference between
  // a system notification and a message from the person the client booked
  // with. A reply to a marketing email is the entire reason it was sent, and
  // until now every one of them would have gone to noreply@.
  const sender = await env.DB.prepare(
    'SELECT first_name, last_name, email, notify_email FROM users WHERE id = ? LIMIT 1'
  ).bind(live.user_id).first().catch(() => null);
  const fromName = sender
    ? `${sender.first_name || ''} ${sender.last_name || ''}`.trim() || null
    : null;
  const replyTo = sender ? (sender.notify_email || sender.email) : null;

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let first = true;

  for (const r of results || []) {
    // Paced, not fired. Two a second is Resend's limit and this stays under
    // it; the wait is idle, so it costs time rather than anything billable.
    if (!first) await new Promise((resolve) => setTimeout(resolve, GAP_MS));
    first = false;

    // Checked now, not when the list was frozen. Somebody who unsubscribed
    // during the send is off it.
    if (await isSuppressed(env, live.agency_id, r.email)) {
      await mark(env, r.id, 'skipped', 'unsubscribed', r.attempts || 0);
      skipped += 1;
      continue;
    }

    try {
      await sendAutomationEmail(env, r.email, merge(live.subject, r).text,
        merge(live.body, r).text, {
          fromName,
          replyTo,
          footer: marketingFooter({
            agencyName: agency?.name || null,
            unsubscribeUrl: `${appUrl(env)}/u/${await unsubscribeToken(env, live.agency_id, r.email)}`,
          }),
        });
      await mark(env, r.id, 'sent', null, (r.attempts || 0) + 1);
      sent += 1;
    } catch (e) {
      const why = String(e.message || e).slice(0, 200);
      const attempts = (r.attempts || 0) + 1;

      // A rate limit or a Resend outage is "come back in a moment", and
      // writing it down as "this address does not work" is how a whole send
      // reports itself as a disaster. Those rows stay queued and the next pass
      // takes them, up to a ceiling so an outage does not become a row retried
      // forever.
      //
      // An address Resend will not accept, or an unset key, will fail exactly
      // the same way on the fifth attempt as the first. Those are recorded
      // against the person and the pass carries on: one bad address must not
      // stop the other twenty-four.
      const worthRetrying = !(e instanceof PermanentError) && attempts < MAX_ATTEMPTS;
      if (worthRetrying) {
        await retryLater(env, r.id, attempts, why);
      } else {
        await mark(env, r.id, 'failed', why, attempts);
        failed += 1;
      }
    }
  }

  await env.DB.prepare(
    `UPDATE broadcasts SET sent_count = sent_count + ?, failed_count = failed_count + ?,
            skipped_count = skipped_count + ?, updated_at = ? WHERE id = ?`
  ).bind(sent, failed, skipped, now(), live.id).run();

  // Finished when nothing is left queued, which is asked rather than inferred
  // from the counts: a row inserted by a retry would make the arithmetic lie.
  const left = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM broadcast_recipients
      WHERE broadcast_id = ? AND status = 'queued'`
  ).bind(live.id).first();
  if (!left?.n) {
    await env.DB.prepare(
      `UPDATE broadcasts SET status = 'sent', finished_at = ?, updated_at = ? WHERE id = ?`
    ).bind(now(), now(), live.id).run();
  }

  return { sent, failed, skipped, remaining: left?.n || 0 };
}

function mark(env, id, status, detail, attempts = 0) {
  return env.DB.prepare(
    `UPDATE broadcast_recipients SET status = ?, detail = ?, attempts = ?, sent_at = ?
      WHERE id = ?`
  ).bind(status, detail, attempts, now(), id).run();
}

/** Left queued on purpose, with the count that decides when to stop trying. */
function retryLater(env, id, attempts, detail) {
  return env.DB.prepare(
    `UPDATE broadcast_recipients SET attempts = ?, detail = ? WHERE id = ?`
  ).bind(attempts, `waiting to try again: ${detail}`, id).run();
}
