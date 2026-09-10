// Stripe, for the fee an advisor pays the agency to use this portal.
//
// Deliberately small. Stripe hosts the two screens that would otherwise be
// weeks of work -- Checkout for taking the card, the Billing Portal for
// changing it and cancelling -- so this file creates sessions, reads a
// subscription, and verifies the webhook. It never sees a card number and no
// card detail is ever stored here.
//
// Stripe is the source of truth for the money. D1 holds a copy of the
// subscription status, updated by webhook, because the read-only gate runs on
// every write and cannot depend on reaching Stripe.

const API = 'https://api.stripe.com/v1';

export class StripeError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function key(env) {
  const k = env.STRIPE_SECRET_KEY;
  if (!k) throw new StripeError('Payments are not set up yet.', 503, { code: 'not_configured' });
  return k;
}

export function isConfigured(env) {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_MONTHLY && env.STRIPE_PRICE_ANNUAL);
}

/**
 * Stripe takes form encoding, including for nested fields, which it spells
 * `a[b]` and `a[0][b]`. Flattened here rather than at each call site so the
 * callers below read as the objects they are.
 */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, name, out);
    else if (Array.isArray(v)) v.forEach((item, i) => form(item, `${name}[${i}]`, out));
    else out.append(name, String(v));
  }
  return out;
}

async function call(env, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key(env)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body ? form(body).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Stripe's own message is the useful one: "Your card was declined" says
    // more than anything this file could invent.
    throw new StripeError(data?.error?.message || `Stripe returned ${res.status}`,
      res.status === 401 ? 503 : 502, data?.error);
  }
  return data;
}

/** The customer for an advisor, made once and reused. */
export async function ensureCustomer(env, user, existingId) {
  if (existingId) {
    const found = await call(env, 'GET', `/customers/${existingId}`).catch(() => null);
    if (found && !found.deleted) return found;
  }
  return call(env, 'POST', '/customers', {
    email: user.email,
    name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email,
    // So a Stripe row can be traced back without a lookup table.
    metadata: { user_id: user.id, portal: 'cttagents' },
  });
}

/**
 * Where the advisor goes to pay, and the only charge they see today.
 *
 * The session sets up the monthly subscription and puts the Annual Program Fee
 * on the same first invoice as a one-off line. One card entry, one payment.
 *
 * The annual is a one-off here rather than a second subscription because the
 * amount due today is not a whole year: $70 in full plus insurance for the
 * months remaining. Stripe can prorate a price or not prorate it, but not
 * prorate half of it, so the arithmetic is ours and the result is charged as a
 * fixed line. The recurring $250 is created afterwards, anchored to October.
 */
export function checkoutSession(env, {
  customerId, returnUrl, monthlyAnchor, annualDueCents, annualLabel,
}) {
  const body = {
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: env.STRIPE_PRICE_MONTHLY, quantity: 1 }],
    success_url: `${returnUrl}?paid=1`,
    cancel_url: returnUrl,
    subscription_data: {
      metadata: { portal: 'cttagents' },
      // Bills on the 1st from here on. Stripe works out the part-month
      // between today and then, by day, and charges it now.
      billing_cycle_anchor: monthlyAnchor,
      proration_behavior: 'create_prorations',
    },
  };
  if (annualDueCents > 0) {
    body.subscription_data.add_invoice_items = [{
      price_data: {
        currency: 'usd',
        product_data: { name: annualLabel || 'Annual Program Fee' },
        unit_amount: annualDueCents,
      },
      quantity: 1,
    }];
  }
  return call(env, 'POST', '/checkout/sessions', body);
}

/**
 * The recurring $250, set going after the first payment has landed.
 *
 * Anchored to the next 1 October with no proration, so nothing is charged now
 * -- today's share was already on the invoice above -- and the first real
 * charge is a full year on the renewal date.
 */
export function annualSubscription(env, { customerId, anchor }) {
  return call(env, 'POST', '/subscriptions', {
    customer: customerId,
    items: [{ price: env.STRIPE_PRICE_ANNUAL, quantity: 1 }],
    billing_cycle_anchor: anchor,
    proration_behavior: 'none',
    metadata: { portal: 'cttagents', kind: 'annual-program-fee' },
  });
}

/** Change a card, see invoices, cancel. Stripe's page, not ours. */
export function portalSession(env, { customerId, returnUrl }) {
  return call(env, 'POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
}

export function getSubscription(env, id) {
  return call(env, 'GET', `/subscriptions/${id}`);
}

/**
 * Is this webhook really from Stripe?
 *
 * Signed over the raw body, so the caller must not have parsed it. Timing-safe
 * compare and a timestamp window, because a signature check that accepts a
 * replay is a signature check somebody can reuse.
 */
export async function verifyWebhook(env, rawBody, signatureHeader, toleranceSeconds = 300) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new StripeError('Webhook signing secret is not set.', 503);
  const parts = Object.fromEntries(
    String(signatureHeader || '').split(',').map((p) => p.split('=').map((x) => x.trim()))
  );
  const timestamp = Number(parts.t);
  const sent = parts.v1;
  if (!timestamp || !sent) throw new StripeError('Malformed signature.', 400);

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > toleranceSeconds) throw new StripeError('Signature too old.', 400);

  const enc = new TextEncoder();
  const mac = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', mac, enc.encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== sent.length) throw new StripeError('Bad signature.', 400);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sent.charCodeAt(i);
  if (diff !== 0) throw new StripeError('Bad signature.', 400);

  return JSON.parse(rawBody);
}
