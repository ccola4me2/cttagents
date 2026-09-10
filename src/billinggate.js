// May this account still change things?
//
// A leaf, and deliberately, for the same reason brand.js is one: the answer is
// needed inside requireUser, and requireUser is imported by the module that
// owns the billing handlers. Putting this with those handlers made a cycle,
// and a cycle here is not a style point -- whichever module the bundler
// reaches second gets a binding still in its temporal dead zone, and every
// request throws.
//
// So the rule lives here and imports nothing.

import { now } from './util.js';

/** Stripe states in which an advisor is paid up. */
export const GOOD = new Set(['active', 'trialing']);
/** States where Stripe is still retrying, so the grace period applies. */
export const TRYING = new Set(['past_due', 'unpaid', 'incomplete']);

export function graceDays(env) {
  const n = Number(env.BILLING_GRACE_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

/**
 * Whether the fee is enforced at all.
 *
 * Off until the agency says otherwise. Turning it on drops every advisor who
 * has not paid into read-only the moment it deploys, and that should be a
 * decision made on a chosen day rather than a side effect of shipping.
 */
export function required(env) {
  return String(env.BILLING_REQUIRED || '') === '1';
}

/**
 * Read-only rather than locked out, deliberately. The clients and reservations
 * in an advisor's book are the agency's records too, and a trip in progress
 * does not stop being somebody's holiday because a card expired. They keep
 * reading; they stop writing.
 */
export function writeState(env, user, billing) {
  // The agency owner is not paying themselves for access. Read from the row
  // rather than through isAdmin() so this module can import nothing.
  if (user && user.role === 'admin') return { mayWrite: true, reason: 'admin' };
  if (!required(env)) return { mayWrite: true, reason: 'not-required' };

  const status = (billing && billing.status) || 'none';
  if (GOOD.has(status)) return { mayWrite: true, reason: status };

  const ts = now();
  if (TRYING.has(status)) {
    const until = (billing && billing.grace_until) || 0;
    if (until > ts) return { mayWrite: true, reason: 'grace', graceUntil: until };
    return { mayWrite: false, reason: 'past_due', graceUntil: until };
  }
  // Cancelled, but paid to the end of the period they bought.
  if (status === 'canceled' && (billing && billing.current_period_end || 0) > ts) {
    return { mayWrite: true, reason: 'canceled-until-period-end',
      graceUntil: billing.current_period_end };
  }
  return { mayWrite: false, reason: status === 'none' ? 'never-started' : status };
}

/**
 * Paths that must keep working when somebody cannot write.
 *
 * Otherwise the gate locks the door and swallows the key: an advisor in
 * read-only could not pay, could not sign out, and could not change a password
 * they had just been told to reset.
 */
const EXEMPT = [
  '/api/billing/',
  '/api/stripe/',
  '/api/auth/logout',
  '/api/auth/password',
  '/api/auth/forgot',
  '/api/auth/reset',
];

export function exemptFromGate(path) {
  return EXEMPT.some((p) => path.startsWith(p));
}
