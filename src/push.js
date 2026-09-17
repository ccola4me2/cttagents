// A notification on a device, with the tab closed.
//
// Deliberately carries nothing. The Web Push protocol allows an encrypted
// payload, and this sends none: the message is a knock, and the service worker
// that wakes up asks this portal what is waiting. Three reasons, in order of
// how much they matter.
//
// Nothing about a client passes through a push service. Google's and Apple's
// servers relay the knock and there is nothing in it to relay. The payload
// would be encrypted, but the safest data is the data that was never sent.
//
// What the notification says is true when it is read, not when it was queued.
// A payload written five minutes ago can announce a thing already dealt with.
//
// And RFC 8291's encryption is a real amount of cryptography to get right,
// where getting it subtly wrong means a message that silently never arrives.
// Not sending one removes the whole question.
//
// VAPID is still required: the push service will not accept an anonymous
// knock. That is a signed JWT, which WebCrypto does natively.

import { json, badRequest, clean, uid, now, bytesToB64, b64ToBytes } from './util.js';
import { requireUser } from './auth.js';

/** base64url, which is what every part of this protocol speaks. */
function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

/**
 * The signing key, from the two secrets.
 *
 * Stored the way every web push tool emits them: the public key as the
 * uncompressed point, 65 bytes beginning 0x04, and the private key as the
 * 32 byte scalar. WebCrypto wants a JWK, so it is assembled here rather than
 * asking somebody to store a third representation of the same key.
 */
async function signingKey(env) {
  const pub = fromB64url(env.VAPID_PUBLIC_KEY);
  const d = fromB64url(env.VAPID_PRIVATE_KEY);
  if (pub.length !== 65 || pub[0] !== 4) {
    throw new Error('VAPID_PUBLIC_KEY is not a 65 byte uncompressed P-256 point');
  }
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY is not a 32 byte scalar');

  return crypto.subtle.importKey('jwk', {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: b64url(d),
    ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * The token a push service will accept.
 *
 * Audience is the push service's own origin and nothing else: a token made for
 * one service is not valid at another, which is the point of it.
 */
async function vapidToken(env, endpoint) {
  const key = await signingKey(env);
  const aud = new URL(endpoint).origin;
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({
    aud,
    // Twelve hours. The spec caps it at twenty four, and a token that outlives
    // the thing it authorised is worth less than one that expires.
    exp: now() + 12 * 3600,
    sub: env.VAPID_SUBJECT || `mailto:${env.MAIL_REPLY_TO || 'hello@example.com'}`,
  })));
  const signed = `${header}.${body}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signed)
  );
  return `${signed}.${b64url(new Uint8Array(sig))}`;
}

/** Is push configured at all? Everything else is a no-op until it is. */
export function pushReady(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/**
 * Knock on one device.
 *
 * A push service answers 404 or 410 when a subscription is finished: the
 * browser was cleared, the app was removed, the user said no. That is not an
 * error to retry, it is an answer, and the row is marked rather than deleted
 * so a device that comes back is recognised instead of counted twice.
 */
export async function pushTo(env, sub) {
  if (!pushReady(env)) return { skipped: true };
  const token = await vapidToken(env, sub.endpoint);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '3600',
      Urgency: 'normal',
      // No body, so no encryption headers and no Content-Encoding.
      'Content-Length': '0',
      Authorization: `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`,
    },
  });

  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare(
      `UPDATE push_subscriptions SET failed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).bind(now(), now(), sub.id, sub.user_id).run().catch(() => null);
    return { gone: true, status: res.status };
  }
  if (res.status >= 400) return { failed: true, status: res.status };

  await env.DB.prepare(
    `UPDATE push_subscriptions SET last_sent_at = ?, failed_at = NULL, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(now(), now(), sub.id, sub.user_id).run().catch(() => null);
  return { sent: true, status: res.status };
}

/** Every device an advisor has said yes on, that has not since gone away. */
export async function devicesFor(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, endpoint, p256dh, auth, last_sent_at
       FROM push_subscriptions
      WHERE user_id = ? AND failed_at IS NULL
      ORDER BY created_at ASC LIMIT 20`
  ).bind(userId).all().catch(() => ({ results: [] }));
  return results || [];
}

// ------------------------------------------------------------ endpoints --

/**
 * What the browser needs before it can ask.
 *
 * The public key is public: it is handed to every browser that subscribes, and
 * the whole design assumes it is. Returned rather than written into the page
 * so there is one copy of it, in the secret, and none in the source.
 */
export async function handlePushKey(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  return json({ ready: pushReady(env), key: env.VAPID_PUBLIC_KEY || null });
}

export async function handlePushSubscribe(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  if (!pushReady(env)) {
    return badRequest('Notifications are not switched on for this portal yet.');
  }

  const body = await request.json().catch(() => ({}));
  const endpoint = clean(body.endpoint, 1000);
  const p256dh = clean(body.keys && body.keys.p256dh, 200);
  const auth = clean(body.keys && body.keys.auth, 100);
  if (!endpoint || !/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    return badRequest('That is not a subscription this can use.');
  }

  // One row per browser. A browser that re-subscribes gets the same endpoint
  // back, so this replaces its own row rather than collecting a new one every
  // time somebody signs in, and a device that had gone away comes back to
  // life rather than staying marked as dead.
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO push_subscriptions
       (id, user_id, endpoint, p256dh, auth, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       label = excluded.label,
       failed_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(uid(), user.id, endpoint, p256dh, auth,
         clean(body.label, 120) || null, ts, ts).run();

  // On here as well as on the device. The browser's permission and this switch
  // are two different yeses and both have to be true.
  await env.DB.prepare('UPDATE users SET push_alerts = 1, updated_at = ? WHERE id = ?')
    .bind(ts, user.id).run();

  return json({ ok: true });
}

/**
 * This device, no longer.
 *
 * The switch is left alone unless this was the last device. Turning it off on
 * a laptop should not stop a phone, and somebody who has no devices left has
 * nothing the switch could mean.
 */
export async function handlePushUnsubscribe(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await request.json().catch(() => ({}));
  const endpoint = clean(body.endpoint, 1000);
  if (endpoint) {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
      .bind(endpoint, user.id).run();
  } else {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?')
      .bind(user.id).run();
  }

  const left = await devicesFor(env, user.id);
  if (!left.length) {
    await env.DB.prepare('UPDATE users SET push_alerts = 0, updated_at = ? WHERE id = ?')
      .bind(now(), user.id).run();
  }
  return json({ ok: true, devices: left.length });
}
