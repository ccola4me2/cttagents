// What the scheduled handler did, so a job that stopped working says so.
//
// Every job on the cron is wrapped in a catch, which is right: one throwing
// job must not stop the other eleven. The cost is that a job which has been
// failing since March looks exactly like a job with nothing to do. Nobody
// reads a Worker's console, and the first sign would be a client who was
// never chased about a final payment.
//
// So each pass leaves a mark. The pair is what matters: when the job last ran
// at all, and when it last ran without throwing. Those two being far apart is
// the failure the console was swallowing.

import { now } from './util.js';

/**
 * Run one job, record what happened, and never let the recording break it.
 *
 * The catch around the write is not defensive habit. This runs on every tick
 * against a table that will not exist until somebody applies the migration by
 * hand, which on this project is a real interval, and a Worker whose reminders
 * stop going out because its bookkeeping table is missing would be a poor
 * trade for knowing when they stopped.
 */
export async function runJob(env, name, fn) {
  const started = Date.now();
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 300);
    console.error(name, e);
  }
  const ms = Date.now() - started;
  const at = now();

  try {
    await env.DB.prepare(
      `INSERT INTO cron_jobs (name, last_run_at, last_ok_at, last_error, last_ms, runs, failures)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         -- Kept when this pass threw, so "last worked" survives the failures
         -- that came after it. Overwriting it would hide exactly the gap this
         -- table exists to show.
         last_ok_at = CASE WHEN excluded.last_error IS NULL
                           THEN excluded.last_run_at ELSE cron_jobs.last_ok_at END,
         last_error = excluded.last_error,
         last_ms = excluded.last_ms,
         runs = cron_jobs.runs + 1,
         failures = cron_jobs.failures + excluded.failures`
    ).bind(name, at, error ? null : at, error, ms, error ? 1 : 0).run();
  } catch (e) {
    console.error('cronlog', name, e);
  }

  return { name, ok: !error, ms };
}

/**
 * Every job, worst first.
 *
 * Ordered by whether it is currently failing rather than by name, because the
 * list is read when something is wrong and the answer should be at the top.
 */
export async function jobHealth(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT name, last_run_at, last_ok_at, last_error, last_ms, runs, failures
         FROM cron_jobs
        ORDER BY last_error IS NULL, name`
    ).all();
    return { jobs: results || [], ok: true };
  } catch (e) {
    // Almost always the migration not being applied yet, which is a thing to
    // say rather than an empty card that reads as "nothing has ever run".
    return { jobs: [], ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}
