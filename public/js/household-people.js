// The people in a household, on the screen where a household is edited.
//
// Moving somebody in used to live only on the expanded row of the Households
// list, and a brand new family member meant leaving, making them a client and
// coming back. Here, in the edit dialog: who is in it, bring in somebody who
// is already a client, or type in somebody who is not and they are added to
// the client list already sitting in this house.
//
// Used by the Households list and by the Household card on a client, so the
// two cannot drift apart on what editing a household offers.

import { api, esc, showError } from '/js/app.js';

/**
 * Fill `box` with the people in one household and the ways to change them.
 *
 * `onChange(result)` is told after every change so the page behind the dialog
 * can redraw; `result.dissolved` is true when the last move out left one
 * person and the household went with it, which means the dialog has nothing
 * left to show.
 */
export async function mountHouseholdPeople(box, householdId, { onChange = () => {} } = {}) {
  box.innerHTML = '<p class="spinner">Loading...</p>';
  let d;
  try {
    d = await api(`/api/households/${encodeURIComponent(householdId)}`);
  } catch (e) { showError(box, e); return; }

  const rows = (d.members || []).map((m) => `
    <li style="display:flex;justify-content:space-between;gap:1rem;padding:.3rem 0;align-items:center;">
      <span><a href="/app/client?id=${encodeURIComponent(m.id)}">${esc(m.name)}</a>
        <span class="muted" style="font-size:.8rem;">${
  esc([m.phone, m.email].filter(Boolean).join(' · ')) || 'no contact on file'}</span></span>
      <button class="btn btn-ghost btn-sm" type="button" data-hp-out="${esc(m.id)}">Move out</button>
    </li>`).join('');

  box.innerHTML = `
    <h3 style="margin:0 0 .4rem;font-size:.95rem;">People in this household</h3>
    <div class="notice notice-error" data-hp-error hidden></div>
    <ul style="list-style:none;margin:0 0 1rem;padding:0;">${rows}</ul>

    <div class="field"><label for="hp-q">Bring in somebody who is already a client</label>
      <input id="hp-q" type="search" placeholder="Start typing a name" autocomplete="off">
      <div data-hp-results></div>
      <p class="field-hint">Somebody already in another household moves into this one.
        A person lives in one place.</p></div>

    <details data-hp-new>
      <summary style="cursor:pointer;font-weight:600;">Add a new client to this household</summary>
      <div style="padding-top:.6rem;">
        <div class="field"><label for="hp-name">Name</label>
          <input id="hp-name" maxlength="120" autocomplete="off"></div>
        <div class="field-row">
          <div class="field"><label for="hp-email">Email</label>
            <input id="hp-email" type="email" maxlength="160" autocomplete="off"></div>
          <div class="field"><label for="hp-phone">Mobile</label>
            <input id="hp-phone" type="tel" maxlength="40" autocomplete="off"></div>
        </div>
        <div class="field"><label for="hp-birthday">Date of birth</label>
          <input id="hp-birthday" type="date"></div>
        <button class="btn btn-secondary btn-sm" type="button" data-hp-create>Add to the client list and this household</button>
      </div>
    </details>`;

  const err = box.querySelector('[data-hp-error]');
  const fail = (e, fallback) => {
    err.textContent = (e && e.message) || fallback;
    err.hidden = false;
  };
  const done = async (result) => {
    await onChange(result);
    if (result && result.dissolved) { box.innerHTML = ''; return; }
    await mountHouseholdPeople(box, householdId, { onChange });
  };

  box.querySelectorAll('[data-hp-out]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Move them out? They stay on the client list with their trips and credits.')) return;
    b.disabled = true;
    try {
      const out = await api(`/api/households/${encodeURIComponent(householdId)}/members/${
        encodeURIComponent(b.dataset.hpOut)}`, { method: 'DELETE' });
      await done(out);
    } catch (e) { fail(e, 'Could not move them out.'); b.disabled = false; }
  }));

  const q = box.querySelector('#hp-q');
  const results = box.querySelector('[data-hp-results]');
  let timer = null;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const text = q.value.trim();
      if (text.length < 2) { results.innerHTML = ''; return; }
      try {
        const r = await api(`/api/clients?q=${encodeURIComponent(text)}`);
        const here = new Set((d.members || []).map((m) => m.id));
        const list = (r.clients || []).filter((c) => !here.has(c.id)).slice(0, 12);
        results.innerHTML = list.length
          ? `<ul style="list-style:none;margin:.5rem 0 0;padding:0;">${list.map((c) => `
              <li style="padding:.25rem 0;"><button class="btn btn-ghost btn-sm" type="button"
                data-hp-pick="${esc(c.id)}">${esc(c.name)}</button>
                <span class="muted">${esc(c.email || c.phone || '')}${
  c.household_name ? ` &middot; now in ${esc(c.household_name)}` : ''}</span></li>`).join('')}</ul>`
          : '<p class="muted" style="margin:.5rem 0 0;">Nobody by that name. Add them as a new client below.</p>';
        results.querySelectorAll('[data-hp-pick]').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const out = await api(`/api/households/${encodeURIComponent(householdId)}/members`,
              { method: 'POST', body: { clientId: b.dataset.hpPick } });
            await done(out);
          } catch (e) { fail(e, 'Could not move them in.'); b.disabled = false; }
        }));
      } catch (e) { showError(results, e); }
    }, 200);
  });

  const create = box.querySelector('[data-hp-create]');
  create.addEventListener('click', async () => {
    err.hidden = true;
    const name = box.querySelector('#hp-name').value.trim();
    if (!name) { fail(null, 'Type their name.'); return; }
    create.disabled = true;
    try {
      const out = await api(`/api/households/${encodeURIComponent(householdId)}/members`, {
        method: 'POST',
        body: { newClient: {
          name,
          email: box.querySelector('#hp-email').value,
          phone: box.querySelector('#hp-phone').value,
          birthday: box.querySelector('#hp-birthday').value,
        } },
      });
      await done(out);
    } catch (e) { fail(e, 'Could not add them.'); create.disabled = false; }
  });
}
