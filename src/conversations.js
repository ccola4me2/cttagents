// Conversations: the SMS, email and chat threads on the sub-account.
//
// Everything here reads and writes straight through to GoHighLevel. Nothing
// is mirrored into D1, so a message sent from the portal and one sent from
// the GHL app are the same message.

import { json, badRequest, clean, oneOf, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import { logActivity } from './db.js';
import { escapeHtml, linkify } from './email.js';

const SEND_TYPES = ['SMS', 'Email'];

export async function handleListConversations(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  try {
    const conversations = await ghl.searchConversations(env, ghl.locationFor(env, user), {
      query: url.searchParams.get('q') || undefined,
      contactId: url.searchParams.get('contactId') || undefined,
      limit: url.searchParams.get('limit') || 40,
    });
    return json({ conversations });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleListMessages(request, env, conversationId) {
  const { response } = await requireUser(request, env);
  if (response) return response;

  try {
    const messages = await ghl.listMessages(env, conversationId, { limit: 60 });
    // GHL returns newest first; the UI reads oldest to newest like a chat.
    messages.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
    return json({ messages });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleSendMessage(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const contactId = clean(body.contactId, 64);
  const type = oneOf(body.type, SEND_TYPES.map((t) => t.toLowerCase())) === 'email' ? 'Email' : 'SMS';
  const message = clean(body.message, 4000);
  const subject = clean(body.subject, 200);

  if (!contactId) return badRequest('No contact to send to.');
  if (!message) return badRequest('The message is empty.');
  if (type === 'Email' && !subject) return badRequest('Email needs a subject.');

  try {
    const sent = await ghl.sendMessage(env, {
      contactId,
      conversationId: clean(body.conversationId, 64) || undefined,
      type,
      message,
      subject: type === 'Email' ? subject : undefined,
      // GHL wants HTML for email; plain text is escaped into a simple body.
      // Escaped first and only then linkified, so a quote in a pasted address
      // cannot close the attribute it lands in. Same order as the broadcast
      // body, for the same reason: this is text an advisor typed.
      html: type === 'Email'
        ? `<p>${linkify(escapeHtml(message)).replace(/\n/g, '<br>')}</p>`
        : undefined,
    });
    await logActivity(env, user.id, 'message.send', `Sent ${type.toLowerCase()}`, { contactId });
    return json({ ok: true, ...sent }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
