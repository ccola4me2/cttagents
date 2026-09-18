// Chat, for the people who work here.
//
// Advisors and the agency, inside the portal, and nobody else. There is no
// route by which a client reaches any of this, and that absence is the point:
// a thread hanging off a reservation is somewhere an advisor can write "the
// deposit is wobbling" or "I quoted this wrong" next to the booking it is
// about. Those sentences are only writable because nobody outside can read
// them.
//
// Three kinds of room, one table:
//
//   channel  a named room, open to the whole agency
//   dm       two people
//   record   hangs off a booking or a client
//
// The record thread is the reason to build this rather than use Slack. Slack
// cannot put the conversation next to the work, so the conversation happens in
// text messages and is gone by the time somebody else covers the file.
//
// Deliberately slow. Everyone here is part-time and nobody sits in it all day,
// so there are no typing indicators, no presence dots and no expectation of a
// fast reply. Attention is asked for by name, and a mention rides the alert
// rails that already exist: the bell, push, and the morning digest.

import { json, badRequest, notFound, forbidden, clean, cleanText, oneOf, uid, now, readJson }
  from './util.js';
import { requireUser, borrowedSeat } from './auth.js';
import * as db from './db.js';

export const KINDS = ['channel', 'dm', 'record'];
export const SUBJECTS = ['booking', 'client'];

/** How much anybody can say in one go. Long enough for a paragraph. */
const MAX_BODY = 4000;

/**
 * Who else works here.
 *
 * Every advisor, not only admins. advisorOptions answers a similar question
 * for the scope picker and refuses anybody who is not an admin, which is right
 * for a picker that chooses whose books to look at and wrong here: you cannot
 * message a colleague whose name you are not allowed to see.
 */
export async function peopleIn(env, user) {
  if (!user.agency_id) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, first_name, last_name, email, role
       FROM users
      WHERE agency_id = ? AND status = 'active'
      ORDER BY first_name, last_name`
  ).bind(user.agency_id).all().catch(() => ({ results: [] }));
  return (results || []).map((u) => ({
    id: u.id,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
    first: u.first_name || '',
    role: u.role,
  }));
}

/** Two ids, sorted and joined, so one pair is one conversation either way round. */
function dmKey(a, b) {
  return [a, b].sort().join(':');
}

function shapeChannel(r, unread = 0) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name || '',
    topic: r.topic || '',
    subjectKind: r.subject_kind || null,
    subjectId: r.subject_id || null,
    adminOnly: Boolean(r.post_admin_only),
    muted: Boolean(r.muted),
    unread,
    lastMessageAt: r.last_message_at || null,
    archived: Boolean(r.archived_at),
  };
}

function shapeMessage(r, meId) {
  let mentions = [];
  try { mentions = JSON.parse(r.mentions || '[]') || []; } catch { mentions = []; }
  return {
    id: r.id,
    channelId: r.channel_id,
    userId: r.user_id,
    author: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Someone',
    mine: r.user_id === meId,
    // A removed message keeps its place and loses its words. A reply that
    // answers it still reads, and an owner sees that something was taken out
    // rather than finding a gap they cannot account for.
    body: r.deleted_at ? '' : r.body,
    deleted: Boolean(r.deleted_at),
    mentionsMe: mentions.includes(meId),
    createdAt: r.created_at,
    editedAt: r.edited_at || null,
  };
}

const MSG_SELECT = `SELECT m.*, u.first_name, u.last_name, u.email
                      FROM messages m
                      LEFT JOIN users u ON u.id = m.user_id`;

/**
 * The record a thread hangs off, if this person may see it.
 *
 * Through the ordinary visibility scope, so a thread is readable by exactly
 * the people who can already read the thing it is about: an advisor's own
 * bookings, an owner's whole agency. Without this an id would be a key, and
 * guessing one would open somebody else's conversation about their client.
 */
async function reachableSubject(env, user, kind, id) {
  if (!SUBJECTS.includes(kind) || !id) return null;
  const scope = db.visibilityScope(env, user);
  if (kind === 'client') {
    const row = await db.getClient(env, scope, { id });
    return row ? { name: row.name, ownerId: row.user_id || user.id } : null;
  }
  const where = db.scopeWhere(scope, 'b.user_id');
  const row = await env.DB.prepare(
    `SELECT b.id, b.user_id, b.product_name FROM bookings b
      WHERE b.id = ? AND ${where.sql}`
  ).bind(id, ...where.binds).first();
  return row ? { name: row.product_name || 'Reservation', ownerId: row.user_id } : null;
}

/**
 * A member row, made on first sight rather than when the room was created.
 *
 * Named rooms are open to the whole agency, so membership is not permission.
 * It is where the read mark lives, and a row created the moment somebody first
 * opens a room is what stops an advisor who joined in June being shown four
 * hundred unread messages from March.
 */
async function ensureMember(env, channelId, userId, readFrom = now()) {
  await env.DB.prepare(
    `INSERT INTO channel_members (channel_id, user_id, joined_at, last_read_at, muted)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(channel_id, user_id) DO NOTHING`
  ).bind(channelId, userId, now(), readFrom).run();
}

/**
 * A new room, of whatever kind.
 *
 * One statement for all three, naming every column, because three inserts that
 * each mention the columns they happen to care about is how a table ends up
 * with two writes that disagree about its shape. The unused ones are written
 * as null on purpose: a direct message has no name and a named room has no
 * subject, and saying so once is clearer than three statements that each leave
 * out something different.
 */
async function newChannel(env, fields) {
  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO channels
       (id, agency_id, kind, name, topic, dm_key, subject_kind, subject_id,
        post_admin_only, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, fields.agencyId || null, fields.kind, fields.name || null, fields.topic || null,
         fields.dmKey || null, fields.subjectKind || null, fields.subjectId || null,
         fields.adminOnly ? 1 : 0, fields.createdBy, ts, ts).run();
  return env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
}

/**
 * The room, if this person may read it, with their membership attached.
 *
 * One function rather than a check at each caller, because the three kinds
 * fence differently and the one that gets forgotten is the one that matters.
 */
async function reachableChannel(env, user, id) {
  const row = await env.DB.prepare(
    `SELECT c.*, m.muted, m.last_read_at, m.user_id AS member_id
       FROM channels c
       LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
      WHERE c.id = ?`
  ).bind(user.id, id).first();
  if (!row) return null;

  if (row.kind === 'dm') {
    // Never while acting as somebody. An owner sitting in an advisor's seat
    // can see their bookings, their clients and their diary, all of which are
    // the agency's work. A private message between two colleagues is not, and
    // the promise that it stays private is worth more than the convenience.
    if (borrowedSeat(user)) return null;
    return row.member_id ? row : null;
  }

  if (row.kind === 'record') {
    const subject = await reachableSubject(env, user, row.subject_kind, row.subject_id);
    return subject ? row : null;
  }

  return row.agency_id && row.agency_id === user.agency_id ? row : null;
}

/** Unread for one person in one room: later than their mark, not their own. */
function unreadClause(alias) {
  return `(SELECT COUNT(*) FROM messages x
            WHERE x.channel_id = ${alias}.id
              AND x.deleted_at IS NULL
              AND x.user_id != ?
              AND x.created_at > COALESCE(mem.last_read_at, 0))`;
}

/**
 * Every room this person can open, with how much of it they have not read.
 *
 * Named rooms come from the agency, direct messages from membership, and
 * record threads from membership as well: a thread on a booking is listed once
 * somebody has opened it, and until then it lives on the booking where it
 * belongs rather than cluttering a list of rooms.
 */
export async function handleChat(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const open = user.agency_id
    ? await env.DB.prepare(
      `SELECT c.*, mem.muted, ${unreadClause('c')} AS unread
         FROM channels c
         LEFT JOIN channel_members mem ON mem.channel_id = c.id AND mem.user_id = ?
        WHERE c.kind = 'channel' AND c.agency_id = ? AND c.archived_at IS NULL
        ORDER BY c.name COLLATE NOCASE`
    ).bind(user.id, user.id, user.agency_id).all().catch(() => ({ results: [] }))
    : { results: [] };

  // Direct messages and opened record threads, both by membership. Hidden
  // entirely while acting as somebody, for the reason in reachableChannel.
  const mine = borrowedSeat(user) ? { results: [] } : await env.DB.prepare(
    `SELECT c.*, mem.muted, ${unreadClause('c')} AS unread
       FROM channels c
       JOIN channel_members mem ON mem.channel_id = c.id AND mem.user_id = ?
      WHERE c.kind IN ('dm', 'record') AND c.archived_at IS NULL
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
      LIMIT 100`
  ).bind(user.id, user.id).all().catch(() => ({ results: [] }));

  const people = await peopleIn(env, user);
  const byId = new Map(people.map((p) => [p.id, p.name]));
  const named = namesForDms((mine.results || []).filter((r) => r.kind === 'dm'), user, byId);

  return json({
    me: { id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' ') },
    // An agency is what a room hangs off. Without one there is nobody for a
    // room to be open to, and saying so beats an empty page that looks broken.
    agency: Boolean(user.agency_id),
    acting: borrowedSeat(user),
    isAdmin: user.role === 'admin' && !borrowedSeat(user),
    channels: (open.results || []).map((r) => shapeChannel(r, r.unread || 0)),
    conversations: (mine.results || []).map((r) => ({
      ...shapeChannel(r, r.unread || 0),
      name: r.kind === 'dm' ? (named.get(r.id) || 'Direct message') : (r.name || 'Thread'),
      href: r.kind === 'record' ? subjectHref(r) : null,
    })),
    people: people.filter((p) => p.id !== user.id),
  });
}

/** Where a record thread's subject lives, so the list can link back to it. */
function subjectHref(r) {
  if (r.subject_kind === 'booking') return `/app/reservation?id=${encodeURIComponent(r.subject_id)}`;
  if (r.subject_kind === 'client') return `/app/client?id=${encodeURIComponent(r.subject_id)}`;
  return null;
}

/**
 * The other person in each direct message, by channel id.
 *
 * Named at read time, because there is nobody to name when the row is written:
 * the name of a conversation between two people is different for each of them.
 */
function namesForDms(rows, user, byId) {
  const out = new Map();
  for (const r of rows) {
    const pair = String(r.dm_key || '').split(':');
    const other = pair.find((id) => id && id !== user.id);
    out.set(r.id, (other && byId.get(other)) || 'Direct message');
  }
  return out;
}

/**
 * Who was named, as ids, worked out when the message is written.
 *
 * At read time the answer would change as people come and go, and who was
 * meant does not. Ambiguity is resolved by refusing to guess: two people
 * called Sam means "@Sam" names nobody, because naming the wrong one is worse
 * than naming neither, and the writer can see it did not take.
 */
export function findMentions(body, people, memberIds, authorId) {
  const text = String(body || '');
  const hits = new Set();

  if (/(^|\s)@here\b/i.test(text)) {
    // Expanded now rather than kept as a token, so "everyone" keeps meaning
    // whoever was in the room when it was said.
    for (const id of memberIds) if (id !== authorId) hits.add(id);
  }

  const said = text.match(/@[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?/gu) || [];
  for (const raw of said) {
    const words = raw.slice(1).trim().toLowerCase();
    if (words === 'here') continue;
    const full = people.filter((p) => p.name.toLowerCase() === words);
    const first = people.filter((p) => (p.first || '').toLowerCase() === words.split(/\s+/)[0]);
    const match = full.length === 1 ? full : first;
    if (match.length === 1 && match[0].id !== authorId) hits.add(match[0].id);
  }
  return [...hits];
}

/**
 * May this person say something here.
 *
 * Acting as somebody is refused outright rather than posted under the real
 * name. Every other screen in this portal deliberately attributes work to the
 * advisor being acted as, and a message is the one record that must not work
 * that way. Rather than hold two opposite rules in one place, this holds
 * neither and asks the owner to take their own seat back first.
 */
export function mayPost(user, channel) {
  if (borrowedSeat(user)) {
    return {
      ok: false,
      why: 'Stop working as an advisor before posting. A message is signed by whoever typed it.',
    };
  }
  if (channel.archived_at) return { ok: false, why: 'This conversation is closed.' };
  if (channel.post_admin_only && user.role !== 'admin') {
    return { ok: false, why: 'Only the agency posts here.' };
  }
  return { ok: true, why: '' };
}

/**
 * A page of a room, oldest first.
 *
 * Opening a room asks for no `after` and wants the LAST two hundred messages,
 * so that read walks backwards and turns round. Written the other way it would
 * hand somebody the first two hundred things ever said in the room and a
 * scrollbar that never reaches today, which is wrong in exactly the rooms that
 * have been used most.
 */
async function recent(env, channelId, after) {
  if (after) {
    const { results } = await env.DB.prepare(
      `${MSG_SELECT}
        WHERE m.channel_id = ? AND m.created_at > ?
        ORDER BY m.created_at ASC
        LIMIT 200`
    ).bind(channelId, after).all().catch(() => ({ results: [] }));
    return results || [];
  }
  const { results } = await env.DB.prepare(
    `${MSG_SELECT} WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT 200`
  ).bind(channelId).all().catch(() => ({ results: [] }));
  return (results || []).reverse();
}

export async function handleChannelMessages(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const channelId = clean(url.searchParams.get('channel'), 64);
  if (!channelId) return badRequest('Which conversation?');

  const channel = await reachableChannel(env, user, channelId);
  if (!channel) return notFound('That conversation is not one of yours.');

  const after = Number(url.searchParams.get('after') || 0) || 0;
  const rows = await recent(env, channelId, after);

  const allowed = mayPost(user, channel);
  return json({
    channel: shapeChannel(channel, 0),
    messages: rows.map((r) => shapeMessage(r, user.id)),
    mayPost: allowed.ok,
    // Why not, in the words the composer shows in place of itself.
    refusal: allowed.why,
    // Only when the room is opened, not on every poll. Who works here does not
    // change between one five second tick and the next, and this is a second
    // query against the users table every time it is sent.
    ...(after ? {} : { people: await peopleIn(env, user) }),
    now: now(),
  });
}

export async function handlePostMessage(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const channelId = clean(body.channelId, 64);
  const text = cleanText(body.body, MAX_BODY);
  if (!channelId) return badRequest('Which conversation?');
  if (!text) return badRequest('Nothing to say yet.');

  const channel = await reachableChannel(env, user, channelId);
  if (!channel) return notFound('That conversation is not one of yours.');
  const allowed = mayPost(user, channel);
  if (!allowed.ok) return forbidden(allowed.why);

  await ensureMember(env, channelId, user.id);

  const { results } = await env.DB.prepare(
    'SELECT user_id FROM channel_members WHERE channel_id = ?'
  ).bind(channelId).all().catch(() => ({ results: [] }));
  const memberIds = (results || []).map((r) => r.user_id);
  const mentions = findMentions(text, await peopleIn(env, user), memberIds, user.id);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO messages (id, channel_id, user_id, body, mentions, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, channelId, user.id, text, JSON.stringify(mentions), ts).run();

  // Written down rather than worked out: the room list sorts on this several
  // times a minute, per person, and a max over messages per room is a join
  // this portal would pay for all day.
  await env.DB.prepare('UPDATE channels SET last_message_at = ?, updated_at = ? WHERE id = ?')
    .bind(ts, ts, channelId).run();
  await env.DB.prepare(
    'UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?'
  ).bind(ts, channelId, user.id).run();

  const row = await env.DB.prepare(`${MSG_SELECT} WHERE m.id = ?`).bind(id).first();
  return json({ ok: true, message: shapeMessage(row, user.id) }, 201);
}

export async function handleEditMessage(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return forbidden('Stop working as an advisor before changing messages.');

  const text = cleanText((await readJson(request)).body, MAX_BODY);
  if (!text) return badRequest('Nothing to say yet.');

  const row = await env.DB.prepare(
    'SELECT * FROM messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, user.id).first();
  if (!row) return notFound('That message is not yours to change.');

  const channel = await reachableChannel(env, user, row.channel_id);
  if (!channel) return notFound('That conversation is not one of yours.');

  const members = await env.DB.prepare(
    'SELECT user_id FROM channel_members WHERE channel_id = ?'
  ).bind(row.channel_id).all().catch(() => ({ results: [] }));
  const mentions = findMentions(text, await peopleIn(env, user),
    (members.results || []).map((r) => r.user_id), user.id);

  await env.DB.prepare('UPDATE messages SET body = ?, mentions = ?, edited_at = ? WHERE id = ?')
    .bind(text, JSON.stringify(mentions), now(), id).run();

  const after = await env.DB.prepare(`${MSG_SELECT} WHERE m.id = ?`).bind(id).first();
  return json({ ok: true, message: shapeMessage(after, user.id) });
}

/**
 * Taking a message back.
 *
 * The writer always may. An agency admin may as well, in their own agency and
 * never in somebody's direct messages, because somebody has to be able to
 * remove a message that should not have been sent and the writer is not always
 * the person who notices. Both leave the row where it was, marked with who
 * removed it.
 */
export async function handleDeleteMessage(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return forbidden('Stop working as an advisor before changing messages.');

  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  if (!row) return notFound('Message not found.');
  const channel = await reachableChannel(env, user, row.channel_id);
  if (!channel) return notFound('That conversation is not one of yours.');

  const mine = row.user_id === user.id;
  const moderating = user.role === 'admin'
    && channel.kind !== 'dm' && channel.agency_id === user.agency_id;
  if (!mine && !moderating) return forbidden('That message is not yours to remove.');

  await env.DB.prepare('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?')
    .bind(now(), user.id, id).run();
  return json({ ok: true });
}

export async function handleMarkRead(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return json({ ok: true });

  const channelId = clean((await readJson(request)).channelId, 64);
  if (!channelId) return badRequest('Which conversation?');
  const channel = await reachableChannel(env, user, channelId);
  if (!channel) return notFound('That conversation is not one of yours.');

  await ensureMember(env, channelId, user.id, 0);
  await env.DB.prepare(
    'UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?'
  ).bind(now(), channelId, user.id).run();
  return json({ ok: true });
}

export async function handleCreateChannel(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return forbidden('Stop working as an advisor before making a room.');
  if (!user.agency_id) return forbidden('A room belongs to an agency, and this account is in none.');

  const body = await readJson(request);
  const name = clean(body.name, 60);
  if (!name) return badRequest('What is the room called?');
  const adminOnly = Boolean(body.adminOnly) && user.role === 'admin';

  const existing = await env.DB.prepare(
    `SELECT id FROM channels
      WHERE agency_id = ? AND kind = 'channel' AND archived_at IS NULL
        AND name = ? COLLATE NOCASE`
  ).bind(user.agency_id, name).first();
  if (existing) return badRequest('There is already a room called that.');

  const row = await newChannel(env, {
    agencyId: user.agency_id,
    kind: 'channel',
    name,
    topic: clean(body.topic, 200),
    adminOnly,
    createdBy: user.id,
  });
  await ensureMember(env, row.id, user.id, 0);
  return json({ ok: true, channel: shapeChannel(row, 0) }, 201);
}

/**
 * A conversation with one colleague, made on first use.
 *
 * Keyed on the pair rather than found by comparing member lists, so the second
 * person to open it lands in the first one's conversation instead of starting
 * a parallel one neither of them can see the other half of.
 */
export async function handleOpenDm(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return forbidden('Stop working as an advisor before opening a message.');
  if (!user.agency_id) return forbidden('This account is in no agency, so there is nobody to write to.');

  const other = clean((await readJson(request)).userId, 64);
  if (!other || other === user.id) return badRequest('Who with?');

  // Their agency or nobody. The id of a user in another agency is not a key to
  // a conversation with them.
  const them = await env.DB.prepare(
    "SELECT id FROM users WHERE id = ? AND agency_id = ? AND status = 'active'"
  ).bind(other, user.agency_id).first();
  if (!them) return notFound('Nobody here by that name.');

  const key = dmKey(user.id, other);
  let row = await env.DB.prepare('SELECT * FROM channels WHERE dm_key = ?').bind(key).first();
  if (!row) {
    row = await newChannel(env, {
      agencyId: user.agency_id, kind: 'dm', dmKey: key, createdBy: user.id,
    });
  }
  // Both sides, now. A conversation nobody has answered yet still has to
  // appear for the person being written to.
  await ensureMember(env, row.id, user.id, 0);
  await ensureMember(env, row.id, other, 0);

  return json({ ok: true, channel: shapeChannel(row, 0) });
}

/**
 * The thread on a record, made the first time somebody opens the card.
 *
 * Made on read rather than on write, because the card is on the page whether
 * anybody has said anything or not. A room that only existed once somebody
 * spoke would mean the first message takes two round trips down a different
 * path from every message after it, which is the path that never gets tested.
 */
export async function handleRecordThread(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const kind = oneOf(url.searchParams.get('kind'), SUBJECTS);
  const subjectId = clean(url.searchParams.get('id'), 64);
  if (!kind || !subjectId) return badRequest('Which record?');

  const subject = await reachableSubject(env, user, kind, subjectId);
  if (!subject) return notFound('That record is not one of yours.');

  let row = await env.DB.prepare(
    'SELECT * FROM channels WHERE subject_kind = ? AND subject_id = ?'
  ).bind(kind, subjectId).first();

  if (!row) {
    // The agency of whoever owns the record, not of whoever opened it. An
    // owner opening an advisor's booking must not re-home the thread.
    const owner = await env.DB.prepare('SELECT agency_id FROM users WHERE id = ?')
      .bind(subject.ownerId).first();
    row = await newChannel(env, {
      agencyId: (owner && owner.agency_id) || user.agency_id,
      kind: 'record',
      name: subject.name,
      subjectKind: kind,
      subjectId,
      createdBy: user.id,
    });
  }

  if (!borrowedSeat(user)) await ensureMember(env, row.id, user.id, 0);

  const rows = await recent(env, row.id, 0);

  const allowed = mayPost(user, row);
  return json({
    channel: shapeChannel(row, 0),
    messages: rows.map((r) => shapeMessage(r, user.id)),
    mayPost: allowed.ok,
    refusal: allowed.why,
    people: await peopleIn(env, user),
    now: now(),
  });
}

/**
 * How much is waiting, for the badge in the sidebar.
 *
 * One query rather than the room list, because every page in the portal asks
 * this and only the chat page needs the rooms themselves.
 */
export async function handleChatUnread(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (borrowedSeat(user)) return json({ unread: 0 });

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM messages m
       JOIN channel_members mem ON mem.channel_id = m.channel_id AND mem.user_id = ?
       JOIN channels c ON c.id = m.channel_id
      WHERE m.user_id != ? AND m.deleted_at IS NULL
        AND m.created_at > mem.last_read_at
        AND mem.muted = 0 AND c.archived_at IS NULL`
  ).bind(user.id, user.id).first().catch(() => null);

  return json({ unread: (row && row.n) || 0 });
}
