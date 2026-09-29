/**
 * The morning email goes once.
 *
 * remindTasks runs on every cron tick, which is every five minutes. It was
 * once a day only because everything it could say came from a task and every
 * task was stamped as it was said, so the next tick found nothing. Three
 * later additions carry no stamp on purpose, because a lead still to ring, a
 * meeting today and somebody asking for you in chat should keep appearing
 * until they are dealt with rather than being mentioned once. Each was right
 * and each quietly removed the accident the once-a-day property rested on,
 * and an advisor with one meeting in the diary got the same email every five
 * minutes from the hour until midnight.
 *
 * Nothing caught it because nothing ran this function at all. The digest is
 * not reachable over HTTP, so smoke.mjs cannot drive it; it needs a clock and
 * a database rather than a server. Hence a checker of its own: a fake D1, a
 * counted fetch, and a morning's worth of ticks.
 */
import { remindTasks } from '../src/taskmail.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::digest: ${label}: ${detail}`);
};
const is = (label, got, want) => (got === want ? ok(label) : bad(label, `got ${got}, wanted ${want}`));

const DAY = '2026-03-10';
const nextDay = '2026-03-11';
const at = (day, hhmm) => Math.floor(new Date(`${day}T${hhmm}:00Z`).getTime() / 1000);

/**
 * Enough of D1 to run the digest. Matched on a phrase unique to each
 * statement rather than parsed, because the point is to exercise taskmail's
 * decisions, not to reimplement SQLite.
 */
function fakeDb({ tasks = [], leads = [], appts = [], mentions = [], user = {} }) {
  const owner = {
    email: 'samantha@example.com', first_name: 'Samantha',
    notify_email: null, task_digest: 1, task_digest_sent_at: null, ...user,
  };
  const rows = tasks.map((t) => ({ ...t }));
  const db = {
    owner,
    prepare(sql) {
      let binds = [];
      return {
        bind(...b) { binds = b; return this; },
        async all() {
          if (sql.includes('FROM tasks t')) {
            const [today] = binds;
            return { results: rows.filter((t) => !t.done_at && t.due_date
              && ((t.due_date === today && !t.reminded_at)
               || (t.due_date < today && !t.overdue_reminded_at))) };
          }
          if (sql.includes('lead_next_step_on')) return { results: leads };
          if (sql.includes('FROM appointments a')) return { results: appts };
          if (sql.includes('FROM messages m')) return { results: mentions };
          return { results: [] };
        },
        async first() {
          return sql.includes('FROM users WHERE id') ? { ...owner } : null;
        },
        async run() {
          if (sql.includes('UPDATE users SET task_digest_sent_at')) {
            owner.task_digest_sent_at = binds[0];
          }
          if (sql.includes('UPDATE tasks SET')) {
            const col = sql.includes('overdue_reminded_at') ? 'overdue_reminded_at' : 'reminded_at';
            const [stampAt, ...ids] = binds;
            for (const r of rows) if (ids.includes(r.id)) r[col] = stampAt;
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  return db;
}

/** A morning of ticks, five minutes apart, counting what actually left. */
async function morning(fixture, { day = DAY, from = '12:00', ticks = 24 } = {}) {
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body).subject);
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  };
  const env = {
    RESEND_API_KEY: 'test', APP_URL: 'https://example.test',
    MAIL_FROM: 'Test <noreply@example.test>', DB: fixture,
  };
  const base = at(day, from);
  for (let i = 0; i < ticks; i++) await remindTasks(env, { at: base + i * 300 });
  return sent;
}

console.log('\nThe morning digest');

// The exact shape Samantha hit: nothing due, one meeting in the diary.
{
  const db = fakeDb({ appts: [{ id: 'ap1', user_id: 'u1', title: 'Call the Hendersons',
    on_date: DAY, start_time: '10:00', client_name: 'Henderson' }] });
  is('an appointment sends one email across a morning, not twenty-four',
    (await morning(db)).length, 1);
}

// The other two unstamped sources, each on its own.
{
  const db = fakeDb({ leads: [{ id: 'c1', user_id: 'u1', client_name: 'Ruiz',
    lead_next_step: 'Ring about the deposit', lead_next_step_on: DAY }] });
  is('an overdue lead sends one email across a morning', (await morning(db)).length, 1);
}
{
  const db = fakeDb({ mentions: [{ id: 'm1', user_id: 'u1', body: 'can you look at this',
    channel_id: 'ch1', kind: 'dm', first_name: 'Dee' }] });
  is('an unread mention sends one email across a morning', (await morning(db)).length, 1);
}

// Everything at once, which is a normal Tuesday.
{
  const db = fakeDb({
    tasks: [{ id: 't1', user_id: 'u1', title: 'Chase the balance', due_date: DAY }],
    leads: [{ id: 'c1', user_id: 'u1', client_name: 'Ruiz', lead_next_step_on: DAY }],
    appts: [{ id: 'ap1', user_id: 'u1', title: 'Zoom', on_date: DAY }],
  });
  is('tasks, a lead and a meeting together still send one', (await morning(db)).length, 1);
}

// Tomorrow is a new morning; the stamp must not be a permanent off switch.
{
  const db = fakeDb({ appts: [{ id: 'ap1', user_id: 'u1', title: 'Zoom', on_date: DAY }] });
  await morning(db);
  const second = await morning(db, { day: nextDay });
  is('the next morning sends again', second.length, 1);
}

// Before the hour, nothing at all.
{
  const db = fakeDb({ appts: [{ id: 'ap1', user_id: 'u1', title: 'Zoom', on_date: DAY }] });
  is('nothing goes out before the hour', (await morning(db, { from: '06:00', ticks: 12 })).length, 0);
}

// Off means off.
{
  const db = fakeDb({ user: { task_digest: 0 },
    appts: [{ id: 'ap1', user_id: 'u1', title: 'Zoom', on_date: DAY }] });
  is('an advisor who turned it off gets none', (await morning(db)).length, 0);
}

// A bouncing address must not be retried every five minutes until midnight.
{
  const db = fakeDb({ appts: [{ id: 'ap1', user_id: 'u1', title: 'Zoom', on_date: DAY }] });
  let tries = 0;
  globalThis.fetch = async () => { tries += 1; throw new Error('bounced'); };
  const env = { RESEND_API_KEY: 'test', APP_URL: 'https://example.test', DB: db };
  const base = at(DAY, '12:00');
  for (let i = 0; i < 24; i++) await remindTasks(env, { at: base + i * 300 });
  is('a send that throws is tried once, not on every tick', tries, 1);
}

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) { console.log(`${failures} failed`); process.exit(1); }
