// One conversation, wherever it is being shown.
//
// The chat page and the discussion card on a reservation are the same thing in
// two frames, so they are the same code. Two implementations would drift, and
// the one that drifts is always the card, because it is the one nobody opens
// while building the other.
//
// Polling, not sockets. Everyone here is part-time and nobody sits in it all
// day, so a request every few seconds while the tab is actually in front is
// both enough and far cheaper than the Durable Object a socket would need.
// Hidden tabs stop entirely and catch up when they come back.

import { api, esc } from '/js/app.js';

const POLL_MS = 5000;
const IDLE_AFTER_MS = 15 * 60 * 1000;

/** A time somebody reads at a glance: the clock today, the date before that. */
function stamp(seconds) {
  const d = new Date((seconds || 0) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * The words, safe, with the links clickable and the names picked out.
 *
 * Escaped first and never unescaped, so everything after this works on text
 * that can no longer close a tag or an attribute. A message is somebody else's
 * typing, and the whole point of the room is that people paste things into it.
 */
export function render(body, people = []) {
  let html = esc(String(body || ''));
  html = html.replace(/\bhttps?:\/\/[^\s<>"']+/g, (raw) => {
    const url = raw.replace(/[.,;:!?)\]]+$/, '');
    const tail = raw.slice(url.length);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`;
  });
  // Only names that actually reached somebody.
  //
  // This used to style every @word, so "@Sammantha" with the typo looked
  // exactly like "@Samantha" that worked, and there was no way to tell a
  // mention that notified somebody from one that quietly notified nobody.
  // The rule here is the server's rule in findMentions: a whole name, or a
  // first name that belongs to exactly one person.
  html = html.replace(/(^|\s)@(here\b|[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)/gu,
    (raw, lead, name) => {
      if (/^here$/i.test(name)) return `${lead}<span class="mention">@here</span>`;
      const hit = resolve(name, people);
      if (!hit) return raw;
      // A two word match styles both words; a first name match styles only the
      // word that matched, so the surname of somebody else is left alone.
      const shown = hit.whole ? name : name.split(/\s+/)[0];
      const tail = name.slice(shown.length);
      return `${lead}<span class="mention">@${shown}</span>${tail}`;
    });
  return html.replace(/\n/g, '<br>');
}

/**
 * Does this name reach somebody, by the server's rule.
 *
 * `whole` says whether both words were used, so the highlighter knows how much
 * of what was typed actually did the work.
 */
export function resolve(name, people) {
  const words = String(name || '').trim().toLowerCase();
  if (!words) return null;
  const full = people.filter((p) => (p.name || '').toLowerCase() === words);
  if (full.length === 1) return { person: full[0], whole: true };
  const firstWord = words.split(/\s+/)[0];
  const first = people.filter((p) => (p.first || '').toLowerCase() === firstWord);
  return first.length === 1 ? { person: first[0], whole: false } : null;
}

/**
 * Put a conversation in an element and keep it up to date.
 *
 * `source` is either { channelId } for a named room or a direct message, or
 * { subjectKind, subjectId } for the thread hanging off a record. The second
 * form makes the thread on first read, so a card on a reservation nobody has
 * ever talked about behaves exactly like one they have.
 */
export function mountThread(host, source, { onRead } = {}) {
  let channelId = source.channelId || null;
  let since = 0;
  let people = [];
  let mayPost = false;
  let refusal = '';
  let stopped = false;
  let timer = null;
  let lastTouch = Date.now();
  const seen = new Map();

  host.innerHTML = `
    <div class="chat-thread">
      <div class="chat-messages" id="chat-messages"><p class="muted chat-empty">Loading...</p></div>
      <div class="chat-compose" id="chat-compose" hidden>
        <textarea id="chat-body" rows="2" maxlength="4000"
          placeholder="Write something. Use @ and a name to ask somebody."></textarea>
        <div class="chat-at" id="chat-at" hidden role="listbox"></div>
        <div class="chat-compose-foot">
          <span class="muted chat-hint">Enter sends. Shift and Enter for a new line.</span>
          <button class="btn btn-primary btn-sm" type="button" id="chat-send">Send</button>
        </div>
      </div>
      <p class="muted chat-refusal" id="chat-refusal" hidden></p>
    </div>`;

  const list = host.querySelector('#chat-messages');
  const composer = host.querySelector('#chat-compose');
  const refusalBox = host.querySelector('#chat-refusal');
  const field = host.querySelector('#chat-body');
  const send = host.querySelector('#chat-send');
  const atBox = host.querySelector('#chat-at');

  function draw() {
    const rows = [...seen.values()].sort((a, b) => a.createdAt - b.createdAt);
    if (!rows.length) {
      list.innerHTML = '<p class="muted chat-empty">Nothing said here yet.</p>';
      return;
    }
    // Consecutive lines from one person in the same few minutes read as one
    // turn in a conversation, because that is what they are. Repeating the
    // name above every line turns a paragraph into a transcript.
    let lastUser = '';
    let lastAt = 0;
    list.innerHTML = rows.map((m) => {
      const run = m.userId === lastUser && (m.createdAt - lastAt) < 300;
      lastUser = m.userId;
      lastAt = m.createdAt;
      const head = run ? '' : `<p class="chat-who">${esc(m.author)}
        <span class="muted">${esc(stamp(m.createdAt))}</span></p>`;
      const tools = m.mine && !m.deleted
        ? `<span class="chat-tools">
             <button type="button" class="linkish" data-edit="${esc(m.id)}">Edit</button>
             <button type="button" class="linkish" data-drop="${esc(m.id)}">Remove</button>
           </span>` : '';
      const text = m.deleted
        ? '<span class="muted chat-gone">Message removed</span>'
        : `${render(m.body, people)}${m.editedAt ? ' <span class="muted chat-edited">edited</span>' : ''}`;
      return `<div class="chat-line${run ? ' chat-run' : ''}${m.mentionsMe ? ' chat-at-me' : ''}"
        data-id="${esc(m.id)}">${head}<div class="chat-body">${text}${tools}</div></div>`;
    }).join('');

    list.querySelectorAll('[data-drop]').forEach((b) =>
      b.addEventListener('click', () => drop(b.dataset.drop)));
    list.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => edit(b.dataset.edit)));
    list.scrollTop = list.scrollHeight;
  }

  function take(d) {
    channelId = (d.channel && d.channel.id) || channelId;
    people = d.people || people;
    if (d.mayPost !== undefined) { mayPost = d.mayPost; refusal = d.refusal || ''; }
    for (const m of d.messages || []) {
      seen.set(m.id, m);
      if (m.createdAt > since) since = m.createdAt;
    }
    composer.hidden = !mayPost;
    refusalBox.hidden = mayPost || !refusal;
    refusalBox.textContent = refusal;
    draw();
  }

  async function first() {
    const url = channelId
      ? `/api/chat/messages?channel=${encodeURIComponent(channelId)}`
      : `/api/chat/thread?kind=${encodeURIComponent(source.subjectKind)}&id=${encodeURIComponent(source.subjectId)}`;
    try {
      take(await api(url));
      await markRead();
    } catch (e) {
      list.innerHTML = `<p class="muted chat-empty">${esc(e.message || 'Could not open that conversation.')}</p>`;
    }
  }

  async function poll() {
    if (stopped || !channelId || document.hidden) return;
    // A tab left open overnight stops asking. Touching it starts it again.
    if (Date.now() - lastTouch > IDLE_AFTER_MS) return;
    try {
      const d = await api(`/api/chat/messages?channel=${encodeURIComponent(channelId)}&after=${since}`);
      const had = seen.size;
      take(d);
      if (seen.size !== had) await markRead();
    } catch { /* a poll that fails is a poll; the next one will do */ }
  }

  async function markRead() {
    if (!channelId) return;
    try {
      await api('/api/chat/read', { method: 'POST', body: { channelId } });
      if (onRead) onRead();
    } catch { /* the mark is a convenience, not the message */ }
  }

  async function post() {
    const body = field.value.trim();
    if (!body || !channelId) return;
    send.disabled = true;
    try {
      const d = await api('/api/chat/messages', { method: 'POST', body: { channelId, body } });
      field.value = '';
      take({ messages: [d.message] });
    } catch (e) {
      refusalBox.textContent = e.message || 'That did not send.';
      refusalBox.hidden = false;
    } finally { send.disabled = false; field.focus(); }
  }

  async function drop(id) {
    if (!confirm('Remove this message? It stays in the room marked as removed.')) return;
    try {
      await api(`/api/chat/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const was = seen.get(id);
      if (was) seen.set(id, { ...was, deleted: true, body: '' });
      draw();
    } catch (e) { alert(e.message || 'Could not remove that.'); }
  }

  async function edit(id) {
    const was = seen.get(id);
    if (!was) return;
    const next = prompt('Edit this message', was.body);
    if (next === null || !next.trim() || next === was.body) return;
    try {
      const d = await api(`/api/chat/messages/${encodeURIComponent(id)}`,
        { method: 'PUT', body: { body: next.trim() } });
      seen.set(id, d.message);
      draw();
    } catch (e) { alert(e.message || 'Could not change that.'); }
  }

  /**
   * Picking a name, rather than hoping you spelled it right.
   *
   * The placeholder has promised "use @ and a name" since this shipped, and
   * typing @ did nothing at all: no list, no hint, and no way to find out
   * whether it had worked short of asking the person. The names are already
   * here, sent with every poll, so this is a list over a list.
   *
   * Matched on first name, surname or the whole name, because people reach for
   * all three, and the server only understands two of them. Picking always
   * inserts the whole name, which is the form that is never ambiguous.
   */
  let atFrom = -1;
  let atRows = [];
  let atPick = 0;

  const closeAt = () => { atFrom = -1; atRows = []; atBox.hidden = true; };

  function drawAt() {
    if (!atRows.length) { closeAt(); return; }
    atPick = Math.max(0, Math.min(atPick, atRows.length - 1));
    atBox.innerHTML = atRows.map((p, i) => `<button type="button" role="option"
      aria-selected="${i === atPick}" class="chat-at-row${i === atPick ? ' on' : ''}"
      data-pick="${i}">${esc(p.name)}</button>`).join('');
    atBox.hidden = false;
  }

  function lookAt() {
    const caret = field.selectionStart;
    const before = field.value.slice(0, caret);
    // Only an @ that starts a word, and only while still on the same word.
    const m = before.match(/(^|\s)@([\p{L}][\p{L}'-]*)?$/u);
    if (!m) { closeAt(); return; }
    atFrom = caret - (m[2] || '').length - 1;
    const q = (m[2] || '').toLowerCase();
    atRows = people.filter((p) => {
      if (!q) return true;
      const name = (p.name || '').toLowerCase();
      return name.startsWith(q) || (p.first || '').toLowerCase().startsWith(q)
        || name.split(/\s+/).some((w) => w.startsWith(q));
    }).slice(0, 6);
    atPick = 0;
    drawAt();
  }

  function choose(i) {
    const p = atRows[i];
    if (!p) return;
    const caret = field.selectionStart;
    field.value = `${field.value.slice(0, atFrom)}@${p.name} ${field.value.slice(caret)}`;
    const at = atFrom + p.name.length + 2;
    field.focus();
    field.setSelectionRange(at, at);
    closeAt();
  }

  atBox.addEventListener('mousedown', (e) => {
    // mousedown rather than click: the field must not lose focus first.
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    e.preventDefault();
    choose(Number(b.dataset.pick));
  });

  field.addEventListener('input', lookAt);
  field.addEventListener('blur', () => setTimeout(closeAt, 120));

  send.addEventListener('click', post);
  field.addEventListener('keydown', (e) => {
    lastTouch = Date.now();
    // While the list is open the arrows and Enter belong to it. Sending a
    // half typed name because Enter did its usual job is the bug this whole
    // list exists to prevent.
    if (!atBox.hidden && atRows.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); atPick += 1; drawAt(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); atPick -= 1; drawAt(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(atPick); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAt(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); }
  });
  host.addEventListener('pointerdown', () => { lastTouch = Date.now(); });

  const onVisible = () => { if (!document.hidden) { lastTouch = Date.now(); poll(); } };
  document.addEventListener('visibilitychange', onVisible);

  first();
  timer = setInterval(poll, POLL_MS);

  return {
    get channelId() { return channelId; },
    get people() { return people; },
    stop() {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
