// Proving there is a person on the other end.
//
// The public pages here have had a honeypot and an hourly limit per address
// since they existed, and those stop the cheap end of the problem: a script
// that fills every input it finds, and somebody holding the submit button
// down. They do nothing about a real browser driven by somebody who wants to
// fill a group trip with forty invented families.
//
// Turnstile is Cloudflare's check, it runs without asking anybody to identify
// bicycles, and on a Worker the verification is one request to a service in
// the same network. It does not replace the honeypot or the rate limit: all
// three stay, because they fail in different directions and the cheapest one
// catches the most.
//
// Fails open when it is not configured, deliberately. The keys are per site
// and have to be made in the dashboard, so between this shipping and somebody
// creating them there is a window where the alternative is every public form
// on the portal refusing every submission. The honeypot and the rate limit
// still apply in that window. Whether it is switched on is visible on the
// admin health page rather than left to be guessed at.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Both halves, or it is not configured. */
export function turnstileReady(env) {
  return Boolean(env && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/**
 * The widget, for a server rendered page.
 *
 * The script is loaded from Cloudflare's own domain, which is the one external
 * script any of these pages pull. Everything else on a public page here is
 * inline on purpose, so this is a deliberate exception rather than drift.
 *
 * Returns nothing at all when it is not configured, so a page that is not
 * using it does not carry a script tag for a widget that will never appear.
 */
export function turnstileWidget(env) {
  if (!turnstileReady(env)) return '';
  return '<div class="cf-turnstile" data-sitekey="'
    + String(env.TURNSTILE_SITE_KEY).replace(/"/g, '&quot;')
    + '" data-theme="light"></div>\n'
    + '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';
}

/**
 * Did this submission come with a token that checks out?
 *
 * True when there is nothing configured, which is the fail-open above.
 *
 * True as well when the check itself cannot be reached. A form that stops
 * taking enquiries because a verification service is having a bad morning
 * costs the agency real work, and the honeypot and the rate limit are still
 * standing. A token that is present and rejected is a different thing and
 * returns false.
 */
export async function verifyTurnstile(env, token, ip) {
  if (!turnstileReady(env)) return true;
  if (!token || typeof token !== 'string') return false;

  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    const data = await res.json();
    return Boolean(data && data.success);
  } catch (e) {
    console.error('turnstile', e);
    return true;
  }
}

/** What a page says when the check says no. */
export const TURNSTILE_FAILED = 'That did not look like a person. Reload the page and try again.';
