// Transactional email via Resend.
//
// Every send is best effort: if RESEND_API_KEY is not configured, or the API
// call fails, the calling request still succeeds. Account creation must never
// fail because an email did not go out.
//
// The exception is sendAutomationEmail at the bottom, which throws so the
// automation engine can record what happened, and distinguishes a failure
// worth retrying from one that is not.

import { PermanentError } from './util.js';

const BRAND_NAVY = '#1b3a5f';
const BRAND_CORAL = '#f1705b';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function appUrl(env) {
  return (env.APP_URL || 'https://tripvaratravel.com').replace(/\/$/, '');
}

/**
 * `footer` replaces the portal line at the bottom. Messages to advisors point
 * at the portal; messages to their clients must not, because a client has no
 * account there and being sent to a login screen by their travel agent is a
 * small betrayal of who the message is from.
 */
export function layout(env, { heading, body, cta, footer }) {
  const url = appUrl(env);
  const button = cta
    ? `<tr><td style="padding:8px 0 24px;">
         <a href="${escapeHtml(cta.href)}"
            style="display:inline-block;background:${BRAND_CORAL};color:#fff;text-decoration:none;
                   font-weight:600;font-size:15px;padding:13px 26px;border-radius:999px;">
           ${escapeHtml(cta.label)}
         </a></td></tr>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fbf9f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf9f5;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:560px;background:#ffffff;border:1px solid #e4edf5;border-radius:14px;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <tr><td style="background:${BRAND_NAVY};border-radius:14px 14px 0 0;padding:22px 32px;">
        <span style="color:#fff;font-size:17px;font-weight:600;letter-spacing:.22em;">TRIPVARA</span><br>
        <span style="color:${BRAND_CORAL};font-size:11px;letter-spacing:.06em;">From first inquiry to welcome home.</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="font-size:21px;font-weight:600;color:${BRAND_NAVY};padding-bottom:14px;">
            ${escapeHtml(heading)}
          </td></tr>
          <tr><td style="font-size:15px;line-height:1.6;color:#2f4459;padding-bottom:22px;">${body}</td></tr>
          ${button}
        </table>
      </td></tr>
      <tr><td style="border-top:1px solid #e4edf5;padding:18px 32px;font-size:12px;color:#5c7286;">
        ${footer || `Trip Vara advisor portal &middot; <a href="${url}" style="color:${BRAND_NAVY};">${
          escapeHtml(url.replace(/^https?:\/\//, ''))}</a>`}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * A plain-text version of the same message.
 *
 * An HTML-only email is one of the oldest spam signals there is: real mail
 * has carried both halves for thirty years, and a message with only one is
 * scored accordingly. Nothing is written twice here, because a second copy of
 * every template is a second copy to forget to update. The text is derived
 * from the HTML instead, so it is always in step by construction.
 *
 * Links become "label (url)" rather than disappearing: the point of the text
 * half is that somebody reading it can still act on it.
 */
export function plainText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href, label) => `${label.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h1|h2|h3|li|table)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '\u00b7')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function send(env, { to, subject, html, replyTo }) {
  const key = env.RESEND_API_KEY;
  if (!key) {
    console.log('email skipped, RESEND_API_KEY not set:', subject, '->', to);
    return { skipped: true };
  }
  const recipients = Array.isArray(to) ? to : String(to).split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return { skipped: true };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Trip Vara <noreply@tripvaratravel.com>',
        to: recipients,
        // So hitting reply answers the person who got in touch, rather than a
        // noreply box nobody reads.
        ...(replyTo ? { reply_to: [replyTo] } : {}),
        subject,
        html,
        text: plainText(html),
      }),
    });
    if (!res.ok) {
      console.error('resend error', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('resend threw', e);
    return { ok: false };
  }
}

function fullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export function sendAdvisorPendingEmail(env, user) {
  return send(env, {
    to: user.email,
    subject: 'Your Trip Vara portal request is in review',
    html: layout(env, {
      heading: 'Thanks, we have your request',
      body: `<p style="margin:0 0 12px;">Hi ${escapeHtml(user.first_name || 'there')},</p>
             <p style="margin:0 0 12px;">Your request for access to the Trip Vara advisor portal has been
             received and is waiting on approval. You will get another email the moment it is active.</p>
             <p style="margin:0;">Nothing else is needed from you right now.</p>`,
    }),
  });
}

export function sendAdvisorApprovedEmail(env, user) {
  return send(env, {
    to: user.email,
    subject: 'Your Trip Vara portal access is active',
    html: layout(env, {
      heading: 'You are in',
      body: `<p style="margin:0 0 12px;">Hi ${escapeHtml(user.first_name || 'there')},</p>
             <p style="margin:0;">Your advisor account is approved. Sign in to see your leads, pipeline
             and bookings in one place.</p>`,
      cta: { label: 'Sign in to the portal', href: `${appUrl(env)}/login` },
    }),
  });
}

export function sendAdminNewSignupEmail(env, user) {
  const to = env.NOTIFY_EMAIL;
  if (!to) return Promise.resolve({ skipped: true });
  return send(env, {
    to,
    subject: `Portal access request: ${fullName(user)}`,
    html: layout(env, {
      heading: 'An advisor is waiting for approval',
      body: `<p style="margin:0 0 12px;"><strong>${escapeHtml(fullName(user))}</strong>
             (${escapeHtml(user.email)}) requested access to the advisor portal.</p>
             <p style="margin:0;">Agency: ${escapeHtml(user.agency_name || 'not given')}<br>
             Phone: ${escapeHtml(user.phone || 'not given')}</p>`,
      cta: { label: 'Review in admin', href: `${appUrl(env)}/admin/` },
    }),
  });
}

/**
 * Somebody put their name down on a public page.
 *
 * A sign-up that only exists on a screen nobody has open is a lead that goes
 * cold, and the whole reason for the page is that the advisor stops finding
 * out by accident. Sent to whoever owns the thing that was signed up on, with
 * reply-to set to the person, so answering is one keystroke rather than a
 * trip through the portal to copy an address.
 */
export function sendSignupNoticeEmail(env, { to, advisorFirstName, what, href,
                                             name, email, phone, partySize, notes }) {
  if (!to) return Promise.resolve({ skipped: true });
  const rows = [
    ['Email', email],
    ['Mobile', phone],
    ['How many', partySize ? String(partySize) : ''],
  ].filter(([, v]) => v);

  return send(env, {
    to,
    replyTo: email || undefined,
    subject: `${name} put their name down: ${what}`,
    html: layout(env, {
      heading: `${escapeHtml(name)} is interested`,
      body: `<p style="margin:0 0 12px;">Hi ${escapeHtml(advisorFirstName || 'there')},</p>
             <p style="margin:0 0 12px;"><strong>${escapeHtml(name)}</strong> signed up on
             <strong>${escapeHtml(what)}</strong>.</p>
             ${rows.length ? `<p style="margin:0 0 12px;">${rows
               .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join('<br>')}</p>` : ''}
             ${notes ? `<p style="margin:0 0 12px;padding:12px 14px;background:#f6f9fc;
               border-radius:8px;">${escapeHtml(notes)}</p>` : ''}
             <p style="margin:0;">Reply to this email to answer them directly.</p>`,
      cta: href ? { label: 'Open it in the portal', href } : undefined,
    }),
  });
}

/**
 * What is due today, and what is already late.
 *
 * One message a day rather than one per task. Late work leads, because it is
 * the part that has gone wrong, and each line says what the task is about:
 * "Ring about the deposit" on its own is not enough to act on from a phone.
 */
export function sendTaskDigestEmail(env, { to, firstName, due = [], late = [] }) {
  const line = (t) => {
    const about = [t.client_name, t.booking_client, t.group_name].filter(Boolean)[0];
    const when = t.due_time ? ` at ${t.due_time}` : '';
    return `<li style="margin:0 0 6px;">${escapeHtml(t.title)}${escapeHtml(when)}`
      + `${about ? ` <span style="color:#5c7286;">&middot; ${escapeHtml(about)}</span>` : ''}`
      + `${t.priority === 'high' ? ' <strong style="color:#c2410c;">high</strong>' : ''}</li>`;
  };

  const block = (title, rows, colour) => (rows.length
    ? `<p style="margin:0 0 8px;font-weight:600;color:${colour};">${escapeHtml(title)}</p>
       <ul style="margin:0 0 20px;padding-left:20px;">${rows.map(line).join('')}</ul>`
    : '');

  const counts = [
    late.length ? `${late.length} overdue` : '',
    due.length ? `${due.length} due today` : '',
  ].filter(Boolean).join(', ');

  return send(env, {
    to,
    subject: `Your list: ${counts}`,
    html: layout(env, {
      heading: 'What is on your list',
      body: `<p style="margin:0 0 16px;">Morning ${escapeHtml(firstName || 'there')}.</p>`
        + block('Overdue', late, '#c2410c')
        + block('Due today', due, BRAND_NAVY)
        + '<p style="margin:0;">Ticking anything off stops it appearing here tomorrow.</p>',
      cta: { label: 'Open your list', href: `${appUrl(env)}/app/tasks` },
    }),
  });
}

export function sendPasswordResetEmail(env, user, token) {
  const minutes = Number(env.RESET_TTL_MINUTES || 60);
  return send(env, {
    to: user.email,
    subject: 'Reset your Trip Vara portal password',
    html: layout(env, {
      heading: 'Reset your password',
      body: `<p style="margin:0 0 12px;">Use the button below to set a new password. The link is good for
             ${minutes} minutes and can only be used once.</p>
             <p style="margin:0;">If you did not ask for this, you can ignore this email. Nothing changes
             until the link is used.</p>`,
      cta: { label: 'Set a new password', href: `${appUrl(env)}/reset-password?token=${encodeURIComponent(token)}` },
    }),
  });
}

/**
 * Ask Resend about the account behind RESEND_API_KEY.
 *
 * The send path is deliberately best effort and the password-reset endpoint
 * always answers the same way so it cannot be used to enumerate addresses.
 * That means neither can tell you whether mail actually goes out. This does:
 * it reports whether the key is accepted and whether the domain in MAIL_FROM
 * is verified, which is the usual reason a send silently fails.
 */
export async function checkResend(env) {
  if (!env.RESEND_API_KEY) return { configured: false };

  let res;
  try {
    res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    });
  } catch (e) {
    return { configured: true, reachable: false, error: String(e) };
  }

  if (res.status === 401 || res.status === 403) {
    return { configured: true, keyValid: false, error: 'Resend rejected the API key.' };
  }
  if (!res.ok) {
    return { configured: true, keyValid: true, error: `Resend returned ${res.status}.` };
  }

  const body = await res.json().catch(() => ({}));
  const domains = (body.data || []).map((d) => ({
    name: d.name,
    status: d.status,
    region: d.region,
  }));

  // The domain we actually send from, pulled out of MAIL_FROM.
  const from = String(env.MAIL_FROM || '');
  const match = from.match(/@([^>\s]+)/);
  const sendDomain = match ? match[1].toLowerCase() : null;
  const entry = domains.find((d) => (d.name || '').toLowerCase() === sendDomain) || null;

  return {
    configured: true,
    keyValid: true,
    sendDomain,
    sendDomainStatus: entry ? entry.status : 'not added to Resend',
    canSend: Boolean(entry && entry.status === 'verified'),
    domains,
  };
}

/**
 * Send a real email and return what Resend actually said.
 *
 * Every other send here is best effort and swallows failures, which is right
 * for request paths but means a broken setup is invisible. This one surfaces
 * the status and body so an admin can see the real reason a message did not
 * arrive. Admin only, and it sends for real.
 */
export async function sendTestEmail(env, to) {
  if (!env.RESEND_API_KEY) return { ok: false, reason: 'RESEND_API_KEY is not set.' };

  const payload = {
    from: env.MAIL_FROM || 'Trip Vara <noreply@tripvaratravel.com>',
    to: [to],
    subject: 'Trip Vara portal test email',
    html: layout(env, {
      heading: 'Email is working',
      body: '<p style="margin:0;">If you are reading this, the portal can send mail. Nothing else to do.</p>',
      cta: { label: 'Open the portal', href: `${appUrl(env)}/login` },
    }),
  };
  payload.text = plainText(payload.html);

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, reason: 'Could not reach Resend.', detail: String(e) };
  }

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }

  return {
    ok: res.ok,
    status: res.status,
    from: payload.from,
    to,
    // Resend puts the reason for a rejection in the body, and it is the only
    // place the real cause ever appears.
    response: body,
  };
}

/**
 * An email sent by an automation step.
 *
 * Unlike the transactional templates above, the body is written by an advisor
 * in the automation builder, so it is escaped and line breaks are converted
 * rather than trusted as HTML. Someone pasting an angle bracket into a
 * follow-up should not be able to break the message or inject markup.
 *
 * This one throws on failure, deliberately. The automation engine needs to
 * know a send failed so it can retry, where a signup email failing must never
 * break the signup.
 */
export async function sendAutomationEmail(env, to, subject, body) {
  // Neither of these improves by waiting five minutes and asking again.
  if (!env.RESEND_API_KEY) {
    throw new PermanentError('Email is not configured: the RESEND_API_KEY secret is not set on the Worker.');
  }
  if (!to) throw new PermanentError('No recipient address.');

  const html = layout(env, {
    heading: subject,
    body: `<p style="margin:0;">${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
  });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Trip Vara <noreply@tripvaratravel.com>',
      to: [to],
      subject,
      html,
      text: plainText(html),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message = `Resend returned ${res.status}. ${detail.slice(0, 200)}`;
    // 429 is rate limiting and 5xx is Resend having a bad day: both are worth
    // another go. A 401, 403 or 422 is a bad key, an unverified sending
    // domain or an address Resend will not accept, and those stay broken
    // until someone changes something.
    const transient = res.status === 429 || res.status >= 500;
    throw transient ? new Error(message) : new PermanentError(message);
  }
  return { ok: true };
}

/**
 * A payment reminder, sent to the client by their advisor.
 *
 * Written as the advisor rather than as the software: the client has a
 * relationship with a person, and a message that reads like a system
 * notification invites being ignored. The reply-to is the advisor's own
 * address for the same reason.
 *
 * The deadline is stated as a date and as what happens after it, because
 * "balance due 26 September" and "the cruise line will cancel your booking on
 * 26 September" get very different response rates.
 */
/**
 * Sends an already-rendered message, and is honest about why it failed.
 *
 * The retry ladder above it treats a thrown Error as worth trying again and a
 * PermanentError as not. A missing API key and a rejected address will fail
 * exactly the same way on the tenth attempt as the first.
 */
export async function sendHtml(env, { to, replyTo, subject, html }) {
  if (!env.RESEND_API_KEY) {
    throw new PermanentError('Email is not configured: the RESEND_API_KEY secret is not set on the Worker.');
  }
  if (!to) throw new PermanentError('There is no address to send to.');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Trip Vara <noreply@tripvaratravel.com>',
      to: [to],
      ...(replyTo ? { reply_to: [replyTo] } : {}),
      subject,
      html,
      text: plainText(html),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message = `Resend returned ${res.status}. ${detail.slice(0, 200)}`;
    const transient = res.status === 429 || res.status >= 500;
    throw transient ? new Error(message) : new PermanentError(message);
  }
  return { ok: true, subject };
}

export async function sendPaymentReminder(env, {
  to, replyTo, clientName, advisorName, agencyName,
  amountCents, dueDate, hard, tripName, vendor, confirmation,
}) {
  if (!env.RESEND_API_KEY) {
    throw new PermanentError('Email is not configured: the RESEND_API_KEY secret is not set on the Worker.');
  }
  if (!to) throw new PermanentError('That client has no email address on file.');

  const money = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  const when = new Date(`${dueDate}T00:00:00Z`).toLocaleDateString('en-US', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const trip = [tripName, vendor].filter(Boolean).join(' with ') || 'your trip';
  const subject = hard
    ? `Final payment for ${trip} is due ${when}`
    : `A reminder about your balance for ${trip}`;

  const lines = [
    `Hello ${clientName || 'there'},`,
    hard
      ? `This is a reminder that the balance of ${money(amountCents)} for ${trip} is due on ${when}. `
        + `This date is set by the vendor, and the booking may be cancelled if it passes unpaid.`
      : `Just a friendly note that the balance of ${money(amountCents)} for ${trip} will be due shortly. `
        + `I like to give plenty of notice so nothing is rushed.`,
    confirmation ? `Your confirmation number is ${confirmation}.` : '',
    'If you have already sent this, please ignore this note. Otherwise reply here and I will take care of it.',
    `Thank you,\n${advisorName || 'Your travel advisor'}${agencyName ? `\n${agencyName}` : ''}`,
  ].filter(Boolean);

  const html = layout(env, {
    heading: hard ? 'Payment due' : 'A gentle reminder',
    body: lines.map((p) => `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''),
  });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Trip Vara <noreply@tripvaratravel.com>',
      to: [to],
      ...(replyTo ? { reply_to: [replyTo] } : {}),
      subject,
      html,
      text: plainText(html),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message = `Resend returned ${res.status}. ${detail.slice(0, 200)}`;
    const transient = res.status === 429 || res.status >= 500;
    throw transient ? new Error(message) : new PermanentError(message);
  }
  return { ok: true, subject };
}
