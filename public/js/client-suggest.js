// The client box that suggests people already on the books.
//
// Typing a name the system already holds creates a second record with the
// same name, and then their history is split across two: half the trips on
// one, half on the other, and a lifetime value that is wrong on both.
// Suggesting what is already there is how that stops happening.
//
// Not a datalist, which looks like the right control and is not: Chrome
// ignores the label on an option, so the thing that tells two Smiths apart
// never shows, the browser decides what matches, and when nothing does it
// renders nothing, which is indistinguishable from a search that never ran.

import { api, esc } from '/js/app.js';

const CSS_ID = 'client-suggest-css';
const CSS = `
  .suggest {
    position: absolute; z-index: 20; left: 0; right: 0; top: 100%;
    background: #fff; border: 1px solid var(--navy-200, #c3ccd8);
    border-radius: 8px; box-shadow: 0 6px 18px rgba(16, 32, 48, .12);
    max-height: 16rem; overflow-y: auto; margin-top: 2px;
  }
  .suggest-row {
    display: block; width: 100%; text-align: left; background: none;
    border: 0; border-bottom: 1px solid var(--navy-50, #eef1f5);
    padding: .5rem .7rem; cursor: pointer; font: inherit;
  }
  .suggest-row:last-child { border-bottom: 0; }
  .suggest-row:hover, .suggest-row.on { background: var(--navy-50, #eef1f5); }
  .suggest-row .nm { display: block; font-size: .92rem; }
  .suggest-row .hint { display: block; font-size: .74rem; color: var(--navy-400, #7b8798); }
  .suggest-empty { margin: 0; padding: .55rem .7rem; font-size: .84rem; color: var(--navy-400, #7b8798); }
`;

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const el = document.createElement('style');
  el.id = CSS_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * Attach the suggestion list to a name input.
 *
 * `onChoose(row)` gets whichever person was picked, with their id, their CRM
 * contact id if they have one, and where they came from. Typing a name nobody
 * has is still allowed: a new client is a real thing that happens, and a box
 * that refuses one is a box people work around.
 */
export function mountClientSuggest(input, { onChoose, emptyText, mineOnly } = {}) {
  if (!input) return;
  ensureStyles();

  const box = document.createElement('div');
  box.className = 'suggest';
  box.hidden = true;
  input.setAttribute('autocomplete', 'off');
  input.parentElement.style.position = 'relative';
  input.after(box);

  let rows = [];
  let cursor = -1;
  let timer;

  const close = () => { box.hidden = true; cursor = -1; };

  function choose(row) {
    input.value = row.name;
    close();
    if (onChoose) onChoose(row);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function draw() {
    if (!rows.length) {
      box.innerHTML = `<p class="suggest-empty">${
        esc(emptyText || 'Nobody by that name yet. Keep typing to add them.')}</p>`;
      box.hidden = false;
      return;
    }
    box.innerHTML = rows.map((c, i) => {
      // What is shown beside the name is what tells two Smiths apart.
      const hint = [
        c.email,
        c.trips ? `${c.trips} trip${c.trips === 1 ? '' : 's'}` : '',
        c.source === 'crm' ? 'in the CRM, not yet booked' : '',
      ].filter(Boolean).join(' · ');
      return `<button type="button" class="suggest-row${i === cursor ? ' on' : ''}" data-i="${i}">
        <span class="nm">${esc(c.name)}</span>
        ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
      </button>`;
    }).join('');
    box.hidden = false;
    box.querySelectorAll('[data-i]').forEach((b) => {
      // mousedown, not click: blurring the input on click closes the list
      // before the click lands.
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(rows[Number(b.dataset.i)]);
      });
    });
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    // Two letters, because one matches most of the book and suggesting all of
    // it is the same as suggesting nothing.
    clearTimeout(timer);
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      let found;
      try {
        // An owner sees the agency's clients, which is right for reading and
        // wrong for a box whose whole job is to pick one to attach something
        // to: writes are always self-scoped, so offering another advisor's
        // client means offering one the save will then refuse. It also showed
        // four identical rows, one per advisor, with nothing to tell them apart.
        found = await api(`/api/clients?q=${encodeURIComponent(q)}&limit=8`
          + (mineOnly ? `&advisor=${encodeURIComponent(mineOnly)}` : ''));
      } catch { close(); return; }
      // People already booked here first, then people the CRM knows who have
      // never been booked. Without the second group the first booking for an
      // existing contact means typing a name the system already holds, and
      // creating a second version of them.
      rows = [...(found.clients || []).slice(0, 8), ...(found.fromCrm || [])].slice(0, 10);
      cursor = -1;
      draw();
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (box.hidden || !rows.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = (cursor + 1) % rows.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = (cursor - 1 + rows.length) % rows.length; draw(); }
    else if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); choose(rows[cursor]); }
    else if (e.key === 'Escape') close();
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}
