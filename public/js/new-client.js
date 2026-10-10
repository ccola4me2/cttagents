// "That name is not on your books. Add them?"
//
// Taking a reservation for somebody new used to file the trip under a bare name and
// stop there: a client record was made as a side effect, with no email, no phone and
// nothing to reach them on, and nobody was told it had happened. This asks, at the
// moment the name is known to be new, and offers the two boxes that matter.
//
// Never a gate. "Just use the name" carries on exactly as before, because a form that
// will not let you book somebody until you have their email is a form people lie to.

import { api, esc } from '/js/app.js';

const asked = new Set();

async function mine() {
  try { return (await api('/api/auth/me')).user?.id || null; } catch { return null; }
}

/**
 * Resolves true to carry on with the reservation, false if the person cancelled.
 *
 * `known(name)` is for names the caller already recognises, such as a contact picked
 * from the old CRM, which are not asked about.
 */
export async function confirmNewClient(rawName, { known } = {}) {
  const name = String(rawName || '').trim();
  if (!name) return true;
  const key = name.toLowerCase();
  if (asked.has(key) || (known && known(name))) return true;

  // Their own book, which is where the reservation will be filed.
  const me = await mine();
  let found = [];
  try {
    const res = await api(`/api/clients?q=${encodeURIComponent(name)}&limit=20${me ? `&advisor=${encodeURIComponent(me)}` : ''}`);
    found = res.clients || [];
  } catch {
    // Could not look. Not a reason to stop somebody taking a booking, and not a reason
    // to claim they are new either.
    return true;
  }
  if (found.some((c) => String(c.name || '').trim().toLowerCase() === key)) return true;

  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `
      <form method="dialog" id="nc-form">
        <div class="card-head"><h2>Add ${esc(name)} as a client?</h2></div>
        <div class="card-pad">
          <p class="field-hint" style="margin-top:0;">${esc(name)} is not on your books yet.
            Add their details now and they are saved as a client with this reservation filed
            under them. Everything else can be filled in from their client page.</p>
          <div class="notice notice-error" id="nc-error" hidden></div>
          <div class="field"><label for="nc-name">Name</label>
            <input id="nc-name" maxlength="120" value="${esc(name)}" readonly></div>
          <div class="field-row">
            <div class="field"><label for="nc-email">Email</label>
              <input id="nc-email" type="email" maxlength="160" autocomplete="off"></div>
            <div class="field"><label for="nc-phone">Mobile</label>
              <input id="nc-phone" type="tel" maxlength="40" autocomplete="off"></div>
          </div>
        </div>
        <div class="card-foot" style="gap:.5rem;flex-wrap:wrap;">
          <button class="btn btn-ghost" type="button" id="nc-cancel">Cancel</button>
          <span style="flex:1;"></span>
          <button class="btn btn-ghost" type="button" id="nc-skip">Just use the name</button>
          <button class="btn btn-primary" type="submit" id="nc-add">Add client and continue</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const done = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    const $ = (id) => dlg.querySelector(id);

    $('#nc-cancel').addEventListener('click', () => done(false));
    $('#nc-skip').addEventListener('click', () => { asked.add(key); done(true); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    $('#nc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#nc-error');
      err.hidden = true;
      const btn = $('#nc-add');
      btn.disabled = true;
      try {
        await api('/api/clients', { method: 'POST', body: {
          name,
          email: $('#nc-email').value.trim(),
          phone: $('#nc-phone').value.trim(),
        } });
        asked.add(key);
        done(true);
      } catch (ex) {
        err.textContent = ex.message || 'That did not save. Try again, or use the name only.';
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.showModal();
    $('#nc-email').focus();
  });
}
