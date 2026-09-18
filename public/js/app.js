// Shared portal front end: API wrapper, formatting, and the app shell.
// Plain ES modules, no bundler, matching the no-build-step deploy model.

// ---------------------------------------------------------------- fetch --
export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
  });

  // A 401 from any page means the session went away. Send them to sign in.
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Signed out');
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) {
    // The path is in the message on purpose. "Request failed (500)" on a page
    // that makes four calls tells you a quarter of what you need, and the
    // person reading it is usually the one who cannot open a console.
    // A hint, when the server has one, is the actionable half of the message:
    // it names the fix rather than the fault.
    const said = (data && data.error) || `${path} failed (${res.status})`;
    const err = new Error(data && data.hint ? `${said}. ${data.hint}` : said);
    err.status = res.status;
    err.code = data && data.code;
    err.data = data;
    throw err;
  }

  // A 200 that is not JSON is not a success. It is almost always an HTML page
  // where an API response should be, and returning {} for it sends the caller
  // off to fail somewhere further away with a worse message.
  if (data === null && res.status !== 204) {
    const err = new Error(`${path} did not return JSON (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

// ----------------------------------------------------------- formatting --
export function money(cents) {
  const n = Number(cents || 0) / 100;
  // Always both digits. This used to drop them on a whole number, so a
  // reservation read $289 on one line and $1,284.50 on the next, and a column
  // of money did not line up. Brent's rule, 2026-09-15: every figure carries
  // its cents, including the nought ones.
  return n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * A date column, as a person reads it.
 *
 * Date-only strings are parsed as local midnight rather than as UTC, which is
 * what stops "2026-03-14" rendering as the 13th for anybody west of Greenwich.
 *
 * It also takes a real instant now: a unix second count, or an ISO string with
 * a time on it. It used to glue T00:00:00 onto whatever it was handed, so a
 * timestamp produced an unparseable date and the raw value was printed to the
 * screen. The portal stores stamps as unix seconds and renders them with
 * timeAgo; this is the safety net for the next person who reaches for the
 * function whose name sounds right.
 */
export function dateFmt(iso) {
  // 0 is not a date here. A stamp of zero means unset in every table this
  // reads from, and the epoch is a worse answer than nothing.
  if (iso === null || iso === undefined || iso === '' || iso === 0) return '';
  const asDay = { month: 'short', day: 'numeric', year: 'numeric' };

  if (typeof iso === 'number' || /^\d{10,}$/.test(String(iso))) {
    const d = new Date(Number(iso) * 1000);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-US', asDay);
  }

  const text = String(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const d = new Date(`${text}T00:00:00`);
    return Number.isNaN(d.getTime()) ? text : d.toLocaleDateString('en-US', asDay);
  }

  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? text : d.toLocaleDateString('en-US', asDay);
}

/** Unix seconds or an ISO string to "3 days ago". */
export function timeAgo(value) {
  if (!value) return '';
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const secs = Math.round((Date.now() - ms) / 1000);
  const steps = [
    [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'],
  ];
  let n = secs;
  let unit = 'second';
  for (const [size, name] of steps) {
    if (Math.abs(n) < size) { unit = name; break; }
    n = n / size;
    unit = name;
  }
  if (unit === 'second' && Math.abs(secs) < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  return rtf.format(-Math.round(n), unit);
}

// Somewhere a meeting is, when that somewhere is a link.
//
// An invite from Teams, Zoom or Meet puts a join URL in the location, and
// those are long enough to fill a row on their own and unbroken enough to run
// out past the edge of a card.
const MEETING_HOSTS = /(?:teams\.microsoft\.com|teams\.live\.com|zoom\.us|meet\.google\.com|webex\.com|gotomeeting\.com|whereby\.com|chime\.aws)$/i;

/**
 * Text with any web address in it turned into something clickable and short.
 *
 * Only http and https: a location is somebody else's typing, and javascript:
 * in an href is how that becomes somebody else's script.
 *
 * Lived on the calendar page until the To do drawer needed the same thing.
 */
export function linkBits(text) {
  const parts = [];
  const s = String(text || '');
  let at = 0;
  for (const m of s.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    if (m.index > at) parts.push(esc(s.slice(at, m.index)));
    let url = m[0];
    // A URL at the end of a sentence should not swallow the full stop.
    const trail = url.match(/[.,;:)\]]+$/);
    if (trail && !url.slice(0, -trail[0].length).endsWith('(')) {
      url = url.slice(0, -trail[0].length);
    }
    let label = url;
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      label = MEETING_HOSTS.test(host) ? 'Join' : host;
    } catch { label = url.slice(0, 40); }
    parts.push(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"
      class="where-link">${esc(label)}</a>`);
    at = m.index + m[0].length - (url === m[0] ? 0 : m[0].length - url.length);
  }
  if (at < s.length) parts.push(esc(s.slice(at)));
  return parts.join('');
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function daysUntil(iso) {
  if (!iso) return null;
  const d = Date.parse(`${iso}T00:00:00`);
  if (!Number.isFinite(d)) return null;
  return Math.ceil((d - Date.now()) / 86400000);
}

// --------------------------------------------------------------- shell ---
const I = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  ship: 'M4 17.5c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1M5 14l1.2-4.2A2 2 0 0 1 8.1 8.3h7.8a2 2 0 0 1 1.9 1.5L19 14M12 8V5M9 5h6',
  people: 'M16 19v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V19M9.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 11h2m-1-1v2',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1Zm14-3a5 5 0 0 1 0 8',
  chart: 'M5 20V10m7 10V4m7 16v-7',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 1-.1 1.2l2 1.6-2 3.4-2.4-1a8 8 0 0 1-2 1.2l-.4 2.6h-4l-.4-2.6a8 8 0 0 1-2-1.2l-2.4 1-2-3.4 2-1.6A8 8 0 0 1 4 12a8 8 0 0 1 .1-1.2l-2-1.6 2-3.4 2.4 1a8 8 0 0 1 2-1.2L11 3h4l.4 2.6a8 8 0 0 1 2 1.2l2.4-1 2 3.4-2 1.6c.06.4.1.8.1 1.2Z',
  shield: 'M12 3l8 4v5c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V7l8-4Z',
  book: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 1 4 17.5Zm16 0A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 0 1.5-1.5Z',
  back: 'M10 19l-7-7 7-7M3 12h18',
  chevron: 'm6 9 6 6 6-6',
  calendar: 'M8 3v3m8-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  chat: 'M21 12a7 7 0 0 1-7 7H8l-4 3v-4.2A7 7 0 0 1 4 12a7 7 0 0 1 7-7h3a7 7 0 0 1 7 7Z',
  handshake: 'M7 11.5 4 8.5l3-2.5h4l2 1.5 2-1.5h4l3 2.5-3 3-1.5-1.2-3.2 3.4a1.6 1.6 0 0 1-2.3 0l-.6-.6-.9.8a1.5 1.5 0 0 1-2.1-2.1M7 11.5l2 2',
};

// The portal is organised into hubs, the way a back office is: pick the area
// of the business you are working in, then the screen inside it.
const NAV = [
  { href: '/app/', label: 'Dashboard', icon: I.home },
  // Up here rather than inside a hub. A day is not a kind of client, and this
  // is opened as often as the dashboard is.
  { href: '/app/calendar', label: 'Calendar', icon: I.calendar },
  // Beside the calendar rather than inside a hub, and carrying its own count.
  // A message waiting is the one thing here that somebody else is waiting on,
  // and two clicks away is where it would be missed.
  { href: '/app/chat', label: 'Chat', icon: I.chat, badge: 'chat-count' },
  {
    hub: 'Reservation', icon: I.ship, items: [
      { href: '/app/reservations', label: 'Reservations' },
      { href: '/app/groups', label: 'Group space' },
      { href: '/app/complete', label: 'Fill in the gaps' },
      { href: '/app/import', label: 'Import reservations' },
      { href: '/app/payments', label: 'Payments Due' },
      { href: '/app/commissions', label: 'Commission owed' },
    ],
  },
  // A page of its own, next to the dashboard. A supplier directory is opened
  // to look somebody up, which is a thing you do between other things: behind
  // a hub it takes two clicks and reads as a setting for reservations rather
  // than the place you go to find a manager's phone number.
  { href: '/app/vendors', label: 'Vendors', icon: I.handshake },
  { href: '/app/cruise-search', label: 'Cruise search', icon: I.ship },
  {
    // The people first, then the work.
    //
    // Clients, Households and Sales opportunities are the same set of people
    // at three stages: somebody you know, the address they share, and the
    // trip they have not booked yet. They sit together at the top because
    // that is the order somebody thinks in. The daily lists follow.
    hub: 'Client', icon: I.people, items: [
      { href: '/app/leads', label: 'Leads' },
      { href: '/app/clients', label: 'Clients' },
      { href: '/app/import-clients', label: 'Import clients' },
      { href: '/app/households', label: 'Households' },
      { href: '/app/proposals', label: 'Proposals out' },
      { href: '/app/pipeline', label: 'Reservation board' },
      { href: '/app/segments', label: 'Lists' },
      { href: '/app/broadcasts', label: 'Emails' },
      { href: '/app/tasks', label: 'To do' },
      { href: '/app/hotlists', label: 'Who to call' },
      { href: '/app/credits', label: 'Client credits' },
    ],
  },
  {
    hub: 'Marketing', icon: I.megaphone, items: [
      { href: '/app/reviews', label: 'Reviews' },
      { href: '/app/specials', label: 'Specials' },
      { href: '/app/formbuilder', label: 'Forms' },
      { href: '/app/qr', label: 'QR codes' },
      { href: '/app/automations', label: 'Automations' },
    ],
  },
  {
    hub: 'Report', icon: I.chart, items: [
      { href: '/app/reports', label: 'Production' },
      { href: '/app/goals', label: 'Targets' },
    ],
  },
  {
    hub: 'Setup', icon: I.gear, items: [
      { href: '/app/settings', label: 'Settings' },
      { href: '/app/membership', label: 'Membership' },
      { href: '/app/manual', label: 'How this works' },
    ],
  },
];

const ADMIN_NAV = [
  { href: '/admin/', label: 'Advisors', icon: I.people },
  { href: '/admin/agencies', label: 'Agency', icon: I.handshake },
  { href: '/admin/manual', label: 'Running the agency', icon: I.book },
  { href: '/app/', label: 'Back to portal', icon: I.back },
];

const HUB_KEY = 'tv.nav.hub';

/** The hub a path belongs to, or null for a top level link. */
function hubOf(path) {
  for (const entry of NAV) {
    if (entry.hub && entry.items.some((i) => i.href === path)) return entry.hub;
  }
  return null;
}

function icon(d) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

function navLink(item, current) {
  const active = item.href === current ? ' aria-current="page"' : '';
  // An empty span rather than none at all, so the thing that fills it later
  // has somewhere to go and does not have to rebuild the sidebar to appear.
  const badge = item.badge
    ? `<span class="todo-count" id="${esc(item.badge)}" hidden></span>` : '';
  return `<a href="${item.href}"${active}>${item.icon ? icon(item.icon) : ''}${esc(item.label)}${badge}</a>`;
}

function navHub(entry, current, open) {
  const id = `hub-${entry.hub.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return `<div class="nav-hub${open ? ' open' : ''}">
    <button type="button" class="hub-toggle" aria-expanded="${open}" aria-controls="${id}"
            data-hub="${esc(entry.hub)}">
      ${icon(entry.icon)}<span>${esc(entry.hub)}</span>${icon(I.chevron)}
    </button>
    <div class="hub-items" id="${id}">${entry.items.map((i) => navLink(i, current)).join('')}</div>
  </div>`;
}

function navEntry(entry, current, openHub) {
  return entry.hub ? navHub(entry, current, entry.hub === openHub) : navLink(entry, current);
}

/**
 * Wires the sidebar search: type, see grouped results, arrow through them,
 * Enter to go. "/" focuses it from anywhere that is not already a text field.
 *
 * Requests are debounced and the stale ones are discarded by sequence number
 * rather than aborted, because a slow first response arriving after a fast
 * second one is the ordinary case, not the rare one, and it would otherwise
 * paint results for a query the person has already finished typing over.
 */
function mountSearch(sidebar) {
  const input = sidebar.querySelector('#global-search');
  const panel = sidebar.querySelector('#search-results');
  if (!input || !panel) return;

  let timer = null;
  let sequence = 0;
  let items = [];
  let active = -1;

  function close() {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  }

  function highlight(next) {
    const links = [...panel.querySelectorAll('a')];
    if (!links.length) return;
    active = (next + links.length) % links.length;
    links.forEach((a, i) => a.classList.toggle('on', i === active));
    links[active].scrollIntoView({ block: 'nearest' });
  }

  function render(data) {
    items = data.groups.flatMap((g) => g.items);
    if (!data.groups.length) {
      panel.innerHTML = `<p class="search-empty">Nothing matches “${esc(data.query)}”.</p>`;
    } else {
      panel.innerHTML = data.groups.map((g) => `
        <p class="search-group">${esc(g.label)}</p>
        ${g.items.map((i) => `<a href="${i.href}" role="option">
          <span class="t">${esc(i.title)}${i.badge ? `<span class="badge badge-navy">${esc(i.badge)}</span>` : ''}</span>
          ${i.subtitle ? `<span class="s">${esc(i.subtitle)}</span>` : ''}
        </a>`).join('')}`).join('');
    }
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const mine = ++sequence;
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (mine !== sequence) return; // A newer query has already been sent.
        render(data);
      } catch {
        if (mine === sequence) close();
      }
    }, 180);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); return; }
    if (panel.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter') {
      const links = [...panel.querySelectorAll('a')];
      // With nothing arrowed to, Enter takes the first result, which is what
      // typing a name and hitting Enter is asking for.
      const target = links[active >= 0 ? active : 0];
      if (target) { e.preventDefault(); window.location.href = target.href; }
    }
  });

  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== input) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (typing) return;
    e.preventDefault();
    sidebar.classList.add('open');
    input.focus();
    input.select();
  });
}

/**
 * The task drawer: add or tick off a task from any screen.
 *
 * A working list you have to navigate to is a working list nobody updates. The
 * cost of walking to another page to record that you rang somebody is exactly
 * the cost that stops it being recorded, so the drawer opens over whatever you
 * are doing and closes again.
 *
 * Sections are the ones that describe an actual working day: what you pinned,
 * what is late, what is due today, what is coming this week.
 */
/**
 * The bell.
 *
 * What needs somebody and what has arrived, in one list, newest first. It goes
 * quiet once read, which is the difference between it and the To do count
 * beside it: a count is a number you act on and does not stop being true
 * because you looked at it.
 *
 * Read only. Every line goes to the screen that owns it, because that is where
 * the words for doing something about it already are.
 */
/**
 * How many messages are waiting, on the Chat link itself.
 *
 * A minute apart, not five seconds: this is on every page in the portal, and
 * the page actually showing the conversation polls properly. A badge is for
 * noticing, and a minute late is still noticing.
 */
/**
 * A message arriving, on whatever screen the advisor is on.
 *
 * Only for messages that arrive while this page is open. A backlog waiting
 * since Tuesday is what the count beside the Chat link is for; popping a card
 * for it on every page load would teach everybody to dismiss the card without
 * reading it, which is how a notification stops working.
 *
 * Twenty seconds rather than five: the chat page itself polls properly, and
 * this runs on every other page in the portal at once.
 */
function mountChatCount(sidebar) {
  const badge = sidebar.querySelector('#chat-count');
  if (!badge) return;

  const SEEN = 'chat-toast-seen';
  // Where the page started. Anything older than this was already waiting.
  let since = 0;
  let shown = '';
  try { shown = localStorage.getItem(SEEN) || ''; } catch { shown = ''; }

  // Not while you are looking at the conversation. The chat page draws the
  // message itself, and a card announcing what is already on the screen is
  // noise with a dismiss button.
  const onChat = location.pathname.startsWith('/app/chat');

  function announce(m) {
    document.querySelectorAll('.chat-toast').forEach((old) => old.remove());
    const card = document.createElement('div');
    card.className = 'chat-toast';
    card.setAttribute('role', 'status');
    card.innerHTML = `
      <button type="button" class="chat-toast-x" aria-label="Dismiss">&times;</button>
      <p class="chat-toast-who">${esc(m.author)}${m.room ? ` in ${esc(m.room)}` : ''}</p>
      <p class="chat-toast-words">${esc(m.words)}</p>`;

    const go = () => { location.href = `/app/chat?c=${encodeURIComponent(m.channelId)}`; };
    card.addEventListener('click', go);
    card.querySelector('.chat-toast-x').addEventListener('click', (e) => {
      // Dismissing is not opening, so the click must not reach the card.
      e.stopPropagation();
      card.remove();
    });
    document.body.appendChild(card);
    setTimeout(() => card.remove(), 12000);
  }

  async function tick() {
    // A hidden tab is a tab nobody is looking at. Every advisor leaves this
    // open all day and the request would otherwise run all night as well.
    if (document.hidden) return;
    try {
      const { unread = 0, latest = null, now = 0 } = await api('/api/chat/unread');
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.hidden = !unread;

      // The first answer sets the line, and announces nothing: everything
      // unread at that moment is a backlog, however new it looks.
      if (!since) { since = now || Math.floor(Date.now() / 1000); return; }
      if (onChat || !latest || latest.id === shown || latest.at <= since) return;

      shown = latest.id;
      try { localStorage.setItem(SEEN, shown); } catch { /* a private window */ }
      announce(latest);
    } catch { badge.hidden = true; }
  }

  tick();
  setInterval(tick, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function mountBell(sidebar) {
  const button = sidebar.querySelector('#open-bell');
  const badge = sidebar.querySelector('#bell-count');
  if (!button) return;

  let panel = null;
  let state = { items: [], unread: 0, off: false };

  const KIND = {
    task: 'Task', lead: 'Lead', appointment: 'Appointment', form: 'Form',
    mention: 'Chat',
  };

  /** "3 days ago", "in 2 hours": how somebody would say it out loud. */
  function ago(at, nowSecs) {
    const secs = nowSecs - at;
    const ahead = secs < 0;
    const n = Math.abs(secs);
    if (n < 90) return 'just now';
    // A day either way is a word, not an arithmetic result. "in 24 hours" is
    // how nobody says tomorrow.
    if (n >= 64800 && n < 129600) return ahead ? 'tomorrow' : 'yesterday';
    const say = n < 5400 ? `${Math.round(n / 60)} minutes`
      : n < 64800 ? `${Math.round(n / 3600)} hours`
        : `${Math.round(n / 86400)} days`;
    return ahead ? `in ${say}` : `${say} ago`;
  }

  async function refresh() {
    try {
      state = await api('/api/alerts');
      badge.textContent = String(state.unread || 0);
      badge.hidden = !state.unread;
      badge.classList.toggle('late', Boolean(state.unread));
    } catch { /* the bell is a nicety, not a feature */ }
  }

  function draw() {
    const nowSecs = state.now || Math.floor(Date.now() / 1000);
    const seen = state.seenAt || 0;
    const body = panel.querySelector('.drawer-body');

    if (state.off) {
      body.innerHTML = `<div class="empty"><h3>The bell is switched off</h3>
        <p>Turn it back on under <a href="/app/settings">Settings</a>.</p></div>`;
      return;
    }
    if (!state.items.length) {
      body.innerHTML = '<div class="empty"><h3>Nothing waiting</h3>'
        + '<p>Nothing is due and nothing has come in.</p></div>';
      return;
    }
    body.innerHTML = `<ul class="rows alert-rows">${state.items.map((i) => `<li>
      <a href="${esc(i.href)}" class="alert-row${
        i.at > seen && i.at <= nowSecs ? ' fresh' : ''}">
        <span>
          <span class="t">${esc(i.title)}</span>
          <span class="m">
            <span class="tag">${esc(KIND[i.kind] || i.kind)}</span>
            <span class="when${i.late ? ' late' : ''}">${esc(ago(i.at, nowSecs))}</span>
            ${i.detail ? `&middot; ${esc(i.detail)}` : ''}
          </span>
        </span>
      </a></li>`).join('')}</ul>`;
  }

  function build() {
    panel = document.createElement('div');
    panel.className = 'drawer';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Alerts');
    panel.innerHTML = `
      <div class="drawer-panel">
        <header class="drawer-head">
          <h2>Alerts</h2>
          <div>
            <a class="btn btn-ghost btn-sm" href="/app/settings">Settings</a>
            <button class="btn btn-ghost btn-sm" type="button" data-close>Close</button>
          </div>
        </header>
        <div class="drawer-body"></div>
      </div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', (e) => {
      if (e.target === panel || e.target.closest('[data-close]')) close();
    });
  }

  function close() {
    panel.classList.remove('open');
    document.body.classList.remove('drawer-open');
  }

  button.addEventListener('click', async () => {
    if (!panel) build();
    await refresh();
    draw();
    panel.classList.add('open');
    document.body.classList.add('drawer-open');
    // Read on opening, not on closing. Somebody who opens it and is called
    // away has still seen it, and a bell that stays lit after being read is
    // one people stop believing.
    if (state.unread) {
      try {
        const res = await api('/api/alerts/seen', { method: 'POST' });
        state.seenAt = res.seenAt;
        badge.hidden = true;
        badge.classList.remove('late');
      } catch { /* it will clear next time */ }
    }
  });

  refresh();
  // Often enough to be worth having, rarely enough that a tab left open all
  // day is not a load on anything.
  setInterval(refresh, 5 * 60 * 1000);
}

function mountTodo(sidebar, user) {
  const button = sidebar.querySelector('#open-todo');
  const badge = sidebar.querySelector('#todo-count');
  if (!button) return;

  let drawer = null;
  let tasks = [];
  let today = new Date().toISOString().slice(0, 10);

  /**
   * Things ticked while the drawer has been open, kept where they were.
   *
   * Without this a tick is indistinguishable from a deletion: the row goes,
   * and if you did not mean it there is nothing left on screen to untick. The
   * row stays, struck through, until the drawer is closed, which is the point
   * at which somebody has seen what they did.
   *
   * Keyed by the row id, holding the row exactly as it was so unticking can
   * put back what ticking took away. For a follow-up that is the date, which
   * is the only one of the three that the server cannot work out for itself.
   */
  const settled = new Map();

  function counts() {
    const open = tasks.filter((t) => !t.done_at || settled.has(t.id));
    const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    // Pinned tasks are lifted out of the date sections rather than repeated in
    // them. A pin means "this is the one I am on", and seeing it twice in one
    // scrolling list is noise, not emphasis.
    const rest = open.filter((t) => !t.pinned_at);
    return {
      pinned: open.filter((t) => t.pinned_at),
      late: rest.filter((t) => t.due_date && t.due_date < today),
      today: rest.filter((t) => t.due_date === today),
      week: rest.filter((t) => t.due_date && t.due_date > today && t.due_date <= week),
      open,
    };
  }

  function setBadge() {
    // Settled rows are not counted, even while they are still on screen. The
    // badge answers how much is left, and a thing you have just ticked is not.
    const open = tasks.filter((t) => !t.done_at && !settled.has(t.id));
    // Counted from every open task, pinned included: the badge answers "how
    // much needs me today", and pinning something does not deal with it.
    const late = open.filter((t) => t.due_date && t.due_date < today);
    const n = late.length + open.filter((t) => t.due_date === today).length;
    const c = { late };
    badge.textContent = String(n);
    badge.hidden = n === 0;
    badge.classList.toggle('late', c.late.length > 0);
  }

  async function refresh() {
    try {
      // This advisor's own, always. An owner's task list reads the agency by
      // default, which is right on the tasks page and wrong here: the drawer
      // ticks off, pins and pushes, and every one of those is refused on
      // somebody else's task. It offered three buttons that could not work.
      const d = await api(`/api/tasks?state=open&advisor=${encodeURIComponent(user.id)}`);
      // A lead's follow-up date is a thing due on a day, which is what this
      // whole drawer is. They arrive shaped like tasks and are merged here, so
      // the count on the sidebar means everything needing you rather than
      // everything needing you that somebody remembered to write as a task.
      tasks = [...(d.tasks || []), ...(d.leads || []), ...(d.appointments || [])];
      // The server has stopped returning the ones just ticked, which is right:
      // they are done. The drawer puts them back so there is still something
      // to look at and something to untick.
      for (const [id, kept] of settled) {
        if (!tasks.some((t) => t.id === id)) tasks.push(kept);
      }
      today = d.today || today;
      setBadge();
    } catch { /* the badge is a nicety, not a feature */ }
  }

  const KIND_MARK = {
    call: 'Call', email: 'Email', document: 'Docs', payment: 'Payment', meeting: 'Meeting',
  };

  const REPEAT_MARK = {
    daily: 'daily', weekly: 'weekly', fortnightly: 'fortnightly',
    monthly: 'monthly', yearly: 'yearly',
  };

  /** "in 3 days", "yesterday", "today": how a date is actually spoken about. */
  function whenWords(iso) {
    if (!iso) return '';
    const days = Math.round(
      (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (days < 0) return `${-days} days late`;
    if (days <= 7) return `in ${days} days`;
    return dateFmt(iso).replace(/,? \d{4}$/, '');
  }

  /**
   * A lead's next step, in the same list as the tasks.
   *
   * The tick means you did it, and clears the date. It does not close the
   * lead: the stage stays, the note about what you were going to do stays, and
   * they stay on the board with no date against them, which is where somebody
   * you have just rung belongs. Closing a lead is a bigger thing and is said
   * out loud on the board.
   *
   * No pin. Pinning is a task idea and there is no task here to pin.
   */
  function leadRow(t, late) {
    return `<li class="lead-row${settled.has(t.id) ? ' done' : ''}">
      <label class="task-tick">
        <input type="checkbox" data-lead-done="${esc(t.client_id)}"
          ${settled.has(t.id) ? 'checked' : ''}
          aria-label="Mark the follow-up with ${esc(t.client_name)} done">
        <span>
          <span class="t">${esc(t.title)}</span>
          <span class="who">${esc(t.client_name)}</span>
          <span class="marks">
            <span class="when${late ? ' late' : ''}">${esc(whenWords(t.due_date))}</span>
            <span class="tag">Lead</span>
            ${t.stage ? `<span class="tag">${esc(t.stage)}</span>` : ''}
          </span>
        </span>
      </label>
      <div class="row-tools">
        <a class="pin" href="/app/leads" aria-label="Open the lead board"
           title="Open the lead board">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h13m-5-5 5 5-5 5"/></svg>
        </a>
      </div>
    </li>`;
  }

  /**
   * An hour in the diary, in the same list as the things due.
   *
   * No tick and no pin, for the same reason a lead has neither: ticking off
   * two o'clock is not a thing anybody does, and the calendar is where
   * cancelling it and marking it done are both said out loud.
   */
  function apptRow(t, late) {
    const when = [t.due_time, t.end_time].filter(Boolean).join(' to ');
    // Already escaped, and the join link shortened to a word. A raw Teams URL
    // is about two hundred characters with nothing to break on, and it used to
    // walk straight out of the side of the card.
    const about = [esc(t.client_name), linkBits(t.location)]
      .filter(Boolean).join('  ·  ');
    return `<li class="appt-row${settled.has(t.id) ? ' done' : ''}">
      <label class="task-tick">
        <input type="checkbox" data-appt-done="${esc(t.appointment_id)}"
          ${settled.has(t.id) ? 'checked' : ''}
          aria-label="Mark ${esc(t.title)} done">
        <span>
          <span class="t">${esc(t.title)}</span>
          ${about ? `<span class="who">${about}</span>` : ''}
          <span class="marks">
            <span class="when${late ? ' late' : ''}">${esc(whenWords(t.due_date))}${
              when ? ` ${esc(when)}` : ''}</span>
            <span class="tag">Appointment</span>
          </span>
        </span>
      </label>
      <div class="row-tools">
        <a class="pin" href="/app/calendar" aria-label="Open the calendar"
           title="Open the calendar">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h13m-5-5 5 5-5 5"/></svg>
        </a>
      </div>
    </li>`;
  }

  function row(t) {
    const late = t.due_date && t.due_date < today;
    if (t.lead) return leadRow(t, late);
    if (t.appointment) return apptRow(t, late);
    // What the task is about, in the order somebody would say it. Only the
    // first one that exists: three of these on one line is a paragraph, and
    // the drawer is meant to be scanned.
    const about = [t.client_name, t.booking_client, t.group_name].filter(Boolean)[0];
    const marks = [
      t.due_date
        ? `<span class="when${late ? ' late' : ''}">${esc(whenWords(t.due_date))}${
            t.due_time ? ` ${esc(t.due_time)}` : ''}</span>`
        : '',
      t.priority === 'high' ? '<span class="tag hot">high</span>' : '',
      KIND_MARK[t.kind] ? `<span class="tag">${esc(KIND_MARK[t.kind])}</span>` : '',
      t.steps
        ? `<span class="tag${t.steps_done === t.steps ? ' all' : ''}">${t.steps_done}/${t.steps}</span>`
        : '',
      REPEAT_MARK[t.repeat_rule] ? `<span class="tag">${esc(REPEAT_MARK[t.repeat_rule])}</span>` : '',
    ].filter(Boolean).join('');

    return `<li class="${settled.has(t.id) ? 'done' : ''}">
      <label class="task-tick">
        <input type="checkbox" data-tick="${esc(t.id)}"
          ${settled.has(t.id) ? 'checked' : ''}>
        <span>
          <span class="t">${esc(t.title)}</span>
          ${about ? `<span class="who">${esc(about)}</span>` : ''}
          ${marks ? `<span class="marks">${marks}</span>` : ''}
        </span>
      </label>
      <div class="row-tools">
        <button type="button" class="pin${t.pinned_at ? ' on' : ''}" data-pin="${esc(t.id)}"
          aria-pressed="${Boolean(t.pinned_at)}" aria-label="${t.pinned_at ? 'Unpin' : 'Pin'} ${esc(t.title)}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="${t.pinned_at ? 'currentColor' : 'none'}"
               stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6Zm3 11v7"/></svg>
        </button>
        <button type="button" class="pin" data-push="${esc(t.id)}"
          aria-label="Push ${esc(t.title)} to tomorrow" title="Push to tomorrow">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h11m-4-4 4 4-4 4M20 5v14"/></svg>
        </button>
      </div>
    </li>`;
  }

  // An empty section is not worth a line of its own. Four of them stacked,
  // each saying nothing is there, is a screen that reports absence four times
  // and tells you nothing you did not know from the first.
  function section(title, list) {
    if (!list.length) return '';
    return `<p class="drawer-group">${esc(title)} <span>${list.length}</span></p>
      <ul class="rows task-rows">${list.map(row).join('')}</ul>`;
  }

  function draw() {
    const c = counts();
    const body = drawer.querySelector('.drawer-body');

    const later = c.open.length - c.pinned.length - c.late.length - c.today.length - c.week.length;
    const strip = `<div class="drawer-strip">
      <span class="chip${c.late.length ? ' hot' : ''}"><b>${c.late.length}</b> late</span>
      <span class="chip"><b>${c.today.length + c.pinned.length}</b> today</span>
      <span class="chip"><b>${c.week.length}</b> this week</span>
      ${later > 0 ? `<span class="chip quiet"><b>${later}</b> later</span>` : ''}
    </div>`;

    const sections = section('Pinned', c.pinned)
      + section('Past due', c.late)
      + section('Due today', c.today)
      + section('This week', c.week);

    if (!c.open.length) {
      body.innerHTML = `<div class="drawer-clear">
        <p class="big">Nothing on your list</p>
        <p>Add the next thing you have to do, or let a reservation make its own.</p>
      </div>`;
      return;
    }

    // Everything open, but none of it in the next seven days. Saying so beats
    // an empty panel that looks broken while thirty tasks sit behind it.
    body.innerHTML = strip + (sections || `<div class="drawer-clear">
      <p class="big">Nothing due this week</p>
      <p>${c.open.length} task${c.open.length === 1 ? '' : 's'} further out.
        <a href="/app/tasks">See them all</a>.</p>
    </div>`);

    drawer.querySelectorAll('[data-tick]').forEach((box) => {
      box.addEventListener('change', async () => {
        const id = box.dataset.tick;
        const was = tasks.find((t) => t.id === id);
        box.disabled = true;
        try {
          await api(`/api/tasks/${encodeURIComponent(id)}`,
            { method: 'PUT', body: { done: box.checked } });
          if (box.checked) settled.set(id, was); else settled.delete(id);
          await refresh();
          draw();
        } catch { box.checked = !box.checked; box.disabled = false; }
      });
    });

    // An hour with somebody in it, ticked off. It also takes itself off the
    // list an hour after it finishes, so this is for the one you got out of
    // early or did not go to.
    drawer.querySelectorAll('[data-appt-done]').forEach((box) => {
      box.addEventListener('change', async () => {
        const id = `appt:${box.dataset.apptDone}`;
        const was = tasks.find((t) => t.id === id);
        box.disabled = true;
        try {
          await api(`/api/appointments/${encodeURIComponent(box.dataset.apptDone)}`,
            { method: 'PUT', body: { done: box.checked } });
          if (box.checked) settled.set(id, was); else settled.delete(id);
          await refresh();
          draw();
        } catch { box.checked = !box.checked; box.disabled = false; }
      });
    });

    // A follow-up done clears the date. Unticking puts the same date back,
    // which is why the row is kept: the date is the one thing here the server
    // cannot work out again for itself, and without it in hand a mis-click
    // would be permanent.
    drawer.querySelectorAll('[data-lead-done]').forEach((box) => {
      box.addEventListener('change', async () => {
        const clientId = box.dataset.leadDone;
        const id = `lead:${clientId}`;
        const was = settled.get(id) || tasks.find((t) => t.id === id);
        box.disabled = true;
        try {
          await api(`/api/leads/${encodeURIComponent(clientId)}/followed`, {
            method: 'POST',
            body: box.checked ? {} : { on: (was && was.due_date) || '' },
          });
          if (box.checked) settled.set(id, was); else settled.delete(id);
          await refresh();
          draw();
        } catch { box.checked = !box.checked; box.disabled = false; }
      });
    });

    // Pushing a task to tomorrow is the thing an overdue list is for. Sending
    // the whole record back would be the only way to change one date, so the
    // API takes a due date on its own the way it takes done and pinned.
    drawer.querySelectorAll('[data-push]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const t = tasks.find((x) => x.id === btn.dataset.push);
        if (!t) return;
        // From today, not from the date it had: pushing a task that was due
        // last Tuesday should land tomorrow, not last Wednesday.
        const to = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000)
          .toISOString().slice(0, 10);
        btn.disabled = true;
        try {
          await api(`/api/tasks/${encodeURIComponent(btn.dataset.push)}`,
            { method: 'PUT', body: { dueDate: to } });
          await refresh();
          draw();
        } catch { btn.disabled = false; }
      });
    });

    drawer.querySelectorAll('[data-pin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const t = tasks.find((x) => x.id === btn.dataset.pin);
        try {
          await api(`/api/tasks/${encodeURIComponent(btn.dataset.pin)}`,
            { method: 'PUT', body: { pinned: !(t && t.pinned_at) } });
          await refresh();
          draw();
        } catch { /* leave it as it was */ }
      });
    });
  }

  function build() {
    drawer = document.createElement('div');
    drawer.className = 'drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', 'To do');
    drawer.innerHTML = `
      <div class="drawer-panel">
        <header class="drawer-head">
          <h2>To do</h2>
          <div>
            <a class="btn btn-ghost btn-sm" href="/app/tasks">All tasks</a>
            <button class="btn btn-ghost btn-sm" type="button" data-close>Close</button>
          </div>
        </header>
        <form class="drawer-add" id="drawer-add">
          <div class="add-line">
            <input name="title" maxlength="200" required autocomplete="off"
              placeholder="What needs doing?">
            <button class="btn btn-primary btn-sm" type="submit">Add</button>
          </div>
          <div class="add-when">
            <button type="button" class="day" data-day="0">Today</button>
            <button type="button" class="day" data-day="1">Tomorrow</button>
            <button type="button" class="day" data-day="7">Next week</button>
            <input name="dueDate" type="date" aria-label="Due date">
          </div>
        </form>
        <div class="drawer-body"></div>
      </div>`;
    document.body.appendChild(drawer);

    drawer.addEventListener('click', (e) => {
      // Clicking the dimmed area behind the panel closes it.
      if (e.target === drawer || e.target.closest('[data-close]')) close();
    });

    // The day chips write into the same date box the calendar does, so there
    // is one answer to "when", however it was given. Pressing the chosen one
    // again clears it: a quick add with no date is a someday task, and having
    // to open the calendar to say so would be silly.
    const dateBox = drawer.querySelector('#drawer-add [name="dueDate"]');
    drawer.querySelectorAll('[data-day]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const iso = new Date(Date.parse(`${today}T00:00:00Z`)
          + Number(btn.dataset.day) * 86400000).toISOString().slice(0, 10);
        dateBox.value = dateBox.value === iso ? '' : iso;
        drawer.querySelectorAll('[data-day]').forEach((b) =>
          b.classList.toggle('on', dateBox.value
            && b === btn && dateBox.value === iso));
      });
    });
    dateBox.addEventListener('change', () => {
      // Picked from the calendar instead, so no chip is the answer any more
      // unless it happens to be the same day.
      drawer.querySelectorAll('[data-day]').forEach((b) => {
        const iso = new Date(Date.parse(`${today}T00:00:00Z`)
          + Number(b.dataset.day) * 86400000).toISOString().slice(0, 10);
        b.classList.toggle('on', dateBox.value === iso);
      });
    });

    drawer.querySelector('#drawer-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const title = form.elements.title.value.trim();
      if (!title) return;
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await api('/api/tasks', {
          method: 'POST',
          body: { title, dueDate: form.elements.dueDate.value || undefined },
        });
        form.reset();
        drawer.querySelectorAll('[data-day]').forEach((b) => b.classList.remove('on'));
        await refresh();
        draw();
        form.elements.title.focus();
      } finally { button.disabled = false; }
    });
  }

  function close() {
    if (!drawer) return;
    // Closing is the moment somebody has seen what they ticked, so the settled
    // rows stop being kept. Opening it again shows what is left.
    settled.clear();
    drawer.classList.remove('open');
    button.focus();
  }

  async function open() {
    if (!drawer) build();
    await refresh();
    draw();
    drawer.classList.add('open');
    drawer.querySelector('input[name="title"]').focus();
  }

  button.addEventListener('click', () => {
    if (drawer && drawer.classList.contains('open')) close(); else open();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer && drawer.classList.contains('open')) close();
  });

  // The badge is worth having before the drawer is opened, so one light query
  // runs in the background once the shell is up.
  refresh();
}

/**
 * Fills #sidebar, wires sign out and the mobile menu, and returns the signed
 * in user. Every portal page calls this first.
 */
/**
 * Put a currency sign on every box that holds money.
 *
 * Money and percentages both use inputmode="decimal", so the name is what
 * tells them apart: a rate, a percentage, a count of days or nights is not
 * money however it is typed. Marked by class rather than wrapped, so nothing
 * in the surrounding markup moves.
 *
 * Watched rather than done once, because most of these boxes are drawn after
 * the page loads and half of them are drawn again on every save.
 */
const NOT_MONEY = /(pct|percent|rate|days|nights|qty|count|travellers|cabins|year|month)/i;

export function markMoneyFields(root = document) {
  const boxes = root.querySelectorAll
    ? root.querySelectorAll('input[inputmode="decimal"]:not(.money):not(.rate)')
    : [];
  for (const el of boxes) {
    if (NOT_MONEY.test(`${el.name || ''} ${el.id || ''}`)) continue;
    el.classList.add('money');
  }
}

function watchMoneyFields() {
  markMoneyFields();
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('input[inputmode="decimal"]')) {
          markMoneyFields(node.parentElement || document);
        } else {
          markMoneyFields(node);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function mountActingBanner({ user, admin }) {
  if (document.getElementById('acting-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'acting-bar';
  bar.className = 'acting-bar';
  bar.innerHTML = `<span>You are working in
      <strong>${esc(user.name || user.email)}</strong>'s account.
      Anything you add here is theirs.</span>
    <button class="btn btn-sm" type="button" id="acting-stop">Stop</button>`;
  document.body.prepend(bar);
  document.body.classList.add('is-acting');
  document.getElementById('acting-stop').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Stopping...';
    try {
      await api('/api/admin/act', { method: 'DELETE' });
      window.location.href = '/admin/';
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Stop';
      alert(err.message || 'Could not stop.');
    }
  });
}

export async function mountShell({ admin = false } = {}) {
  const { user, actingAs } = await api('/api/auth/me');
  if (!user) { window.location.href = '/login'; throw new Error('Signed out'); }

  // Across every page, not tucked in a corner. The portal is behaving as
  // somebody else for as long as this is up, and the one way that goes wrong
  // is an admin forgetting and filing a booking under the wrong advisor.
  if (actingAs) mountActingBanner(actingAs);

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return user;

  const current = location.pathname.replace(/index\.html$/, '');
  const items = admin ? ADMIN_NAV : NAV;
  const showAdminLink = !admin && user.role === 'admin';

  // The hub holding the current page always opens. Otherwise reopen whichever
  // hub the advisor last worked in, so the sidebar looks the same each visit.
  let openHub = hubOf(current);
  if (!openHub) {
    try { openHub = localStorage.getItem(HUB_KEY); } catch { openHub = null; }
  }

  sidebar.innerHTML = `
    <a class="wordmark on-dark" href="${admin ? '/admin/' : '/app/'}">
      <img src="/logo-mark.png" alt="">
      <span><b>Cruises Tours &amp; Travel</b><small>${admin ? 'Admin' : 'Travel Advisor Portal'}</small></span>
    </a>
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="sidebar-nav">
      <span class="sr-only">Menu</span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    ${admin ? '' : `<button type="button" class="nav-todo" id="open-todo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>
      <span>To do</span><span class="todo-count" id="todo-count" hidden></span>
    </button>
    <button type="button" class="nav-todo" id="open-bell">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>
      <span>Alerts</span><span class="todo-count" id="bell-count" hidden></span>
    </button>
    <div class="nav-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="global-search" type="search" placeholder="Search anything" autocomplete="off"
             role="combobox" aria-expanded="false" aria-controls="search-results"
             aria-label="Search clients, reservations and payments">
      <kbd>/</kbd>
      <div class="search-results" id="search-results" role="listbox" hidden></div>
    </div>`}
    <nav id="sidebar-nav" aria-label="Portal">
      ${items.map((i) => navEntry(i, current, openHub)).join('')}
      ${showAdminLink ? navLink({ href: '/admin/', label: 'Admin', icon: I.shield }, current) : ''}
    </nav>
    <div class="sidebar-foot">
      <p class="who">${esc(user.name)}<span>${esc(user.email)}</span></p>
      <button type="button" id="signout">Sign out</button>
    </div>`;

  sidebar.querySelector('#signout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  // The bell rides with the To do count: both are an advisor's own, and an
  // admin screen has neither.
  if (!admin) {
    mountSearch(sidebar);
    mountTodo(sidebar, user);
    mountBell(sidebar);
    mountChatCount(sidebar);
  }
  watchMoneyFields();

  sidebar.querySelectorAll('.hub-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const hub = button.closest('.nav-hub');
      const open = !hub.classList.contains('open');
      // One hub at a time, like a back office menu.
      sidebar.querySelectorAll('.nav-hub').forEach((other) => {
        other.classList.remove('open');
        other.querySelector('.hub-toggle').setAttribute('aria-expanded', 'false');
      });
      if (open) {
        hub.classList.add('open');
        button.setAttribute('aria-expanded', 'true');
      }
      try { localStorage.setItem(HUB_KEY, open ? button.dataset.hub : ''); } catch { /* private mode */ }
    });
  });

  const toggle = sidebar.querySelector('.menu-toggle');
  toggle.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  return user;
}

/**
 * Adds a reveal control to every password field on the page.
 *
 * Done in JS rather than in each page's markup so the four auth pages cannot
 * drift apart, and so a new password field gets the control by existing. The
 * input keeps its own id, name and autocomplete: only the type is toggled.
 */
export function enhancePasswordFields(root = document) {
  const eye = 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Zm10 2.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z';
  const eyeOff = 'M3 3l18 18M10.6 10.7a2.6 2.6 0 0 0 3.7 3.6M9.9 5.7A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4M6.5 7.6A16.6 16.6 0 0 0 2 12s3.6 6.5 10 6.5c1.2 0 2.2-.2 3.2-.5';

  root.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.closest('.pw')) return;
    const wrap = document.createElement('span');
    wrap.className = 'pw';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pw-toggle';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Show password');
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${eye}"/></svg>`;

    button.addEventListener('click', () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      button.setAttribute('aria-pressed', String(!shown));
      button.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      button.querySelector('path').setAttribute('d', shown ? eye : eyeOff);
      // Typing should carry on where it left off, not at the start.
      const end = input.value.length;
      input.focus();
      try { input.setSelectionRange(end, end); } catch { /* not all types allow it */ }
    });
    wrap.appendChild(button);
  });
}

/**
 * The advisor scope control, for screens that can show more than your own
 * records. Renders nothing for an advisor associate, whose only scope is
 * themselves, so the control never appears where it has no choices to offer.
 *
 * The choice lives in the URL rather than in memory, so it survives a refresh,
 * can be linked to a colleague, and is visible in the address bar rather than
 * being a hidden mode you have forgotten you are in.
 */
export function mountScopePicker(host, data, reload) {
  if (!host) return;
  const scope = data && data.scope;
  if (!scope || !scope.canPick) { host.innerHTML = ''; return; }

  const advisors = (data.advisors || []);
  const current = scope.all ? 'all' : (scope.advisorId || 'all');
  // Picking an advisor here only changes what you are *looking* at. Every write
  // files under whoever is signed in, so nothing you add while browsing an
  // advisor's records can land in their book by accident. Adding something on
  // their behalf is a deliberate second step, which is the button below.
  // Offered only where it would actually work. Anybody in the agency can be
  // worked as, owner or associate, because an owner already works on the whole
  // agency and sitting in a colleague's seat borrows nothing extra. The one
  // account that is not offered is whoever runs the portal, which reaches
  // every agency here and so is the one case that would be borrowing access.
  const picked = advisors.find((a) => a.id === current
    && a.id !== scope.viewerId
    && !a.platformOwner);
  host.innerHTML = `<select aria-label="Whose records to show" style="width:auto;">
    <option value="all"${current === 'all' ? ' selected' : ''}>All advisors</option>
    ${advisors.map((a) => `<option value="${esc(a.id)}"${a.id === current ? ' selected' : ''}>
      ${esc(a.name)}${a.role === 'admin' ? ' (owner)' : ''}</option>`).join('')}
  </select>
  ${picked ? `<button class="btn btn-sm btn-ghost" type="button" data-act-as="${esc(picked.id)}"
    title="Sign into ${esc(picked.name)}'s account so anything you add is filed as theirs"
    >Work as ${esc(picked.name.split(' ')[0])}</button>` : ''}`;

  host.querySelector('select').addEventListener('change', (e) => {
    const url = new URL(location.href);
    // Written out rather than erased. Absence and "everyone" used to be the
    // same URL, which left a screen no way to open on you by default and
    // still let you ask for the whole agency.
    url.searchParams.set('advisor', e.target.value);
    history.replaceState(null, '', url);
    reload();
  });

  const actBtn = host.querySelector('[data-act-as]');
  if (actBtn) {
    actBtn.addEventListener('click', async () => {
      if (!confirm(`Work as ${picked.name}?\n\nEverything you add or change until you `
        + `stop will belong to them, not to you.`)) return;
      actBtn.disabled = true;
      try {
        await api(`/api/admin/act/${encodeURIComponent(picked.id)}`, { method: 'POST' });
        // Straight to their dashboard rather than reloading this screen, so it
        // is unmistakable whose seat you are now in.
        window.location.href = '/app/';
      } catch (err) {
        actBtn.disabled = false;
        alert(err.message || 'Could not switch.');
      }
    });
  }
}

/** The advisor query string for the current URL, to pass through to the API. */
export function advisorParam() {
  const a = new URLSearchParams(location.search).get('advisor');
  return a ? `advisor=${encodeURIComponent(a)}` : '';
}

/** Renders an error into a container, with a friendlier GHL setup case. */
export function showError(container, err) {
  if (!container) return;
  if (err && err.code === 'not_configured') {
    container.innerHTML = `<div class="notice-setup">
      <p style="font-size:.72rem;font-weight:650;letter-spacing:.16em;text-transform:uppercase;color:var(--coral-500);margin:0 0 .6rem;">Setup needed</p>
      <h3>CTT Tools is not connected yet</h3>
      <p style="margin-top:.6rem;">Set the <code>GHL_API_TOKEN</code> secret on the Worker so the portal can
      read contacts, opportunities and calendars from your account. Reservations and reports work without it.</p>
    </div>`;
    return;
  }
  // Never just "something went wrong". An error with no text of its own still
  // has a name and a status, and any of that is more use to whoever is looking
  // at the screen than a shrug.
  const said = (err && err.message) || '';
  const detail = said || [err && err.name, err && err.status && `status ${err.status}`]
    .filter(Boolean).join(', ') || String(err);
  container.innerHTML = `<div class="notice notice-error">${esc(detail)}</div>`;
}

/** Small helper for forms: disable while submitting, surface errors. */
export function onSubmit(form, handler, { errorBox } = {}) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    // The notice sits inside the form on dialogs, but is a sibling of it on
    // the auth pages. Look in both before falling back to an alert.
    const box = errorBox
      || form.querySelector('.notice-error')
      || (form.parentElement && form.parentElement.querySelector('.notice-error'));
    if (box) { box.hidden = true; box.textContent = ''; }
    if (button) button.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form).entries()));
    } catch (err) {
      if (box) { box.textContent = err.message || 'Something went wrong.'; box.hidden = false; }
      else alert(err.message || 'Something went wrong.');
    } finally {
      if (button) button.disabled = false;
    }
  });
}
