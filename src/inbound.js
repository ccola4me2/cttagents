// Invites, forwarded to an address.
//
// The address is the whole permission: anything arriving at it goes into one
// advisor's diary. So it is a token rather than a name, it is issued rather
// than guessed at, and it is null until somebody asks for one, which means an
// address that has never been handed out cannot be arrived at by typing.
//
// Nothing here trusts the sender. A From header is a claim, not a fact, and
// checking it would only break the common case of forwarding from a personal
// account while stopping nobody who could read the address in the first place.
//
// Failure bounces rather than vanishing. An advisor who forwards something and
// hears nothing has no way to tell "it worked" from "it went in the bin", and
// the bin is where a silent inbound integration puts everybody's trust.

import { now, uid } from './util.js';
import { parseInvite, calendarPartOf } from './ics.js';
import { applyInvite, zoneOf } from './appointments.js';
import * as db from './db.js';

/** The local part of an address, lowercased, without any plus-tag. */
function localPartOf(address) {
  const at = String(address || '').indexOf('@');
  const local = at === -1 ? String(address || '') : String(address).slice(0, at);
  return local.toLowerCase().split('+')[0].trim();
}

/**
 * The token in an address, if there is one that looks like ours.
 *
 * Both shapes: the whole local part, and the appt- prefix that makes it read
 * as something rather than as line noise on a business card.
 */
export function tokenOf(address) {
  const local = localPartOf(address).replace(/^appt[-.]/, '');
  return /^[a-f0-9]{16,64}$/.test(local) ? local : null;
}

/**
 * One forwarded message, turned into a diary entry.
 *
 * Separated from the mail plumbing so it can be run against a message that is
 * a string in a test rather than a stream from a mail server. The email export
 * below is the ten lines that turn one into the other.
 */
export async function handleInboundInvite(env, { to, raw }) {
  const token = tokenOf(to);
  if (!token) {
    return { reject: 'That address does not take meeting invites.' };
  }

  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE invite_token = ? AND status = 'active'"
  ).bind(token).first().catch(() => null);
  if (!user) {
    // The same answer whether the token is wrong or the account is closed.
    // Telling the two apart would let somebody find out which tokens exist.
    return { reject: 'That address does not take meeting invites.' };
  }

  const calendar = calendarPartOf(raw);
  if (!calendar) {
    return {
      user,
      reject: 'There was no meeting invite in that message. Forward the invite '
        + 'itself rather than a reply about it, or attach the .ics file.',
    };
  }

  const invite = parseInvite(calendar, { zone: zoneOf(env, user) });
  if (invite.error) return { user, reject: invite.error };

  const res = await applyInvite(env, user, invite);
  if (res.error) return { user, reject: res.error };

  await db.logActivity(env, user.id, 'appointment.invite',
    `${res.outcome} ${invite.title} on ${invite.onDate}, by email`,
    { uid: invite.uid, from: 'email' });

  return { user, outcome: res.outcome, invite };
}

/**
 * The address to give an advisor, and the token behind it.
 *
 * Made on request rather than for everybody at once: an address nobody has
 * asked for is an address nobody is watching, and there is no reason for one
 * to exist before somebody wants it.
 */
export async function inviteAddressFor(env, user, { make = false } = {}) {
  let token = user.invite_token || null;
  if (!token && make) {
    // Two randomUUIDs of hex, which is the same source the session tokens and
    // the form invite ids come from.
    token = (uid() + uid()).replace(/-/g, '').slice(0, 32);
    await env.DB.prepare('UPDATE users SET invite_token = ?, updated_at = ? WHERE id = ?')
      .bind(token, now(), user.id).run();
  }
  if (!token) return { address: null, domain: inviteDomain(env) };
  return { address: `appt-${token}@${inviteDomain(env)}`, domain: inviteDomain(env) };
}

/** Where forwarded invites are received. Its own subdomain, so the agency's
 *  ordinary mail is not touched by any of this. */
export function inviteDomain(env) {
  return env.INVITE_DOMAIN || '';
}
