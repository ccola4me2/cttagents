// The fee an advisor pays the agency for access to this portal.
//
// Not the money on a reservation. A client's payment goes to the supplier and
// the agency never holds it; this is the agency's own subscription revenue,
// which is ordinary billing. The two never meet on screen.
//
// Stripe owns the money and hosts both screens: Checkout takes the card, the
// Billing Portal changes it and cancels. This file creates those sessions,
// keeps a local copy of the subscription status, and answers one question for
// the gate in worker.js: may this advisor still write?

import { json, badRequest, now } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import * as stripe from './stripe.js';
import { TRYING, graceDays, required, writeState } from './billinggate.js';
import { joiningToday, nextOctoberFirst } from './fees.js';

/** The membership page: what they are on, and what to do about it. */
export async function handleMembership(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const billing = await db.getBilling(env, user.id);
  const state = writeState(env, user, billing);
  return json({
    configured: stripe.isConfigured(env),
    required: required(env),
    graceDays: graceDays(env),
    status: billing?.status || 'none',
    currentPeriodEnd: billing?.current_period_end || null,
    graceUntil: billing?.grace_until || null,
    mayWrite: state.mayWrite,
    reason: state.reason,
    // Nothing to manage until there is a customer at Stripe to manage.
    hasCustomer: Boolean(billing?.stripe_customer_id),
    annual: {
      status: billing?.annual_status || null,
      renewsAt: billing?.annual_period_end || null,
    },
    // What today would cost, so somebody can read the figure before agreeing
    // to it rather than meeting it on a Stripe page.
    quote: billing?.subscription_id ? null : joiningToday(new Date()),
  });
}

function portalUrl(env, request) {
  try {
    return `${new URL(request.url).origin}/app/membership`;
  } catch {
    return `${String(env.APP_URL || '').replace(/\/$/, '')}/app/membership`;
  }
}

/** Take me to Stripe to pay. */
export async function handleCheckout(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!stripe.isConfigured(env)) return badRequest('Payments are not set up yet.');

  const billing = await db.getBilling(env, user.id);
  const customer = await stripe.ensureCustomer(env, user, billing?.stripe_customer_id);
  // Saved before the session, so a customer created at Stripe is never
  // orphaned by the user closing the tab.
  await db.saveBilling(env, user.id, {
    stripeCustomerId: customer.id,
    subscriptionId: billing?.subscription_id,
    status: billing?.status || 'none',
    currentPeriodEnd: billing?.current_period_end,
    graceUntil: billing?.grace_until,
  });

  const quote = joiningToday(new Date());
  const session = await stripe.checkoutSession(env, {
    customerId: customer.id,
    returnUrl: portalUrl(env, request),
    monthlyAnchor: quote.nextMonthlyAt,
    // Only on the way in. Somebody restarting a lapsed membership has already
    // paid this year's programme fee, and charging it twice because they
    // changed a card would be a bill nobody could explain.
    annualDueCents: billing?.annual_subscription_id ? 0 : quote.annualDueCents,
    annualLabel: `Annual Program Fee (${quote.monthsOfCover} months cover to 1 October)`,
  });
  await db.logActivity(env, user.id, 'billing.checkout',
    `Opened checkout: $${(quote.annualDueCents / 100).toFixed(2)} annual due`);
  return json({ ok: true, url: session.url });
}

/** Take me to Stripe to change my card or cancel. */
export async function handlePortal(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!stripe.isConfigured(env)) return badRequest('Payments are not set up yet.');

  const billing = await db.getBilling(env, user.id);
  if (!billing?.stripe_customer_id) return badRequest('There is nothing to manage yet.');

  const session = await stripe.portalSession(env, {
    customerId: billing.stripe_customer_id,
    returnUrl: portalUrl(env, request),
  });
  return json({ ok: true, url: session.url });
}

/**
 * Stripe telling us what happened.
 *
 * Unauthenticated by necessity and trusted only because of the signature, so
 * the body is read raw and verified before anything looks at it. An
 * unverified webhook is an endpoint that lets a stranger mark themselves paid.
 */
export async function handleStripeWebhook(request, env) {
  let event;
  try {
    const raw = await request.text();
    event = await stripe.verifyWebhook(env, raw, request.headers.get('stripe-signature'));
  } catch (e) {
    return json({ error: e.message || 'Could not verify that.' }, e.status || 400);
  }

  const object = event?.data?.object || {};
  const customerId = typeof object.customer === 'string' ? object.customer : object.id;
  if (!customerId) return json({ ok: true, ignored: 'no customer' });

  const row = await db.getBillingByCustomer(env, customerId);
  // A customer this portal does not know is not an error: the Stripe account
  // may bill other things. Answer 200 or Stripe retries it forever.
  if (!row) return json({ ok: true, ignored: 'unknown customer' });

  const ts = now();
  let fields = null;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = object.subscription
        ? await stripe.getSubscription(env, object.subscription).catch(() => null)
        : (object.object === 'subscription' ? object : null);
      if (!sub) break;
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
      fields = {
        subscriptionId: sub.id,
        status,
        currentPeriodEnd: sub.current_period_end || null,
        // The clock starts when Stripe first reports trouble and is cleared
        // the moment it is paid, so a card fixed on day two does not leave a
        // stale deadline behind.
        graceUntil: TRYING.has(status)
          ? (row.grace_until && row.status === status
            ? row.grace_until
            : ts + graceDays(env) * 86400)
          : null,
      };
      break;
    }
    case 'invoice.payment_failed':
      fields = {
        subscriptionId: row.subscription_id,
        status: 'past_due',
        currentPeriodEnd: row.current_period_end,
        graceUntil: row.grace_until || ts + graceDays(env) * 86400,
      };
      break;
    case 'invoice.payment_succeeded':
      fields = {
        subscriptionId: row.subscription_id,
        status: 'active',
        currentPeriodEnd: object.lines?.data?.[0]?.period?.end || row.current_period_end,
        graceUntil: null,
      };
      break;
    default:
      return json({ ok: true, ignored: event.type });
  }

  if (!fields) return json({ ok: true, ignored: event.type });

  // The recurring $250 starts only once the first payment has actually
  // cleared, and only once. Created here rather than at checkout because
  // until Stripe confirms, there is no card to bill it to.
  if (event.type === 'checkout.session.completed'
      && !row.annual_subscription_id
      && stripe.isConfigured(env)) {
    try {
      const sub = await stripe.annualSubscription(env, {
        customerId,
        anchor: nextOctoberFirst(new Date()),
      });
      fields.annualSubscriptionId = sub.id;
      fields.annualStatus = sub.status;
      fields.annualPeriodEnd = sub.current_period_end || null;
    } catch (e) {
      // Their monthly is live and their programme fee is paid; the renewal
      // schedule can be fixed by hand. Losing the whole webhook over it would
      // leave the account looking unpaid instead.
      await db.logActivity(env, row.user_id, 'billing.annual.failed',
        `Could not start the annual: ${e.message}`);
    }
  }

  await db.saveBilling(env, row.user_id, { ...fields, stripeCustomerId: customerId });
  await db.logActivity(env, row.user_id, 'billing.status',
    `Stripe says ${fields.status}`, { event: event.type });
  return json({ ok: true });
}
