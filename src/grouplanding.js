// The public landing page at the root of the shared group domain (cruisegrouppage.com).
//
// A group's page lives at /<name>; this answers the bare domain for somebody who arrived
// without a name: what the service is, a box to open a group by name, and where a travel
// advisor goes to make one. The page is identical on both portals because either Worker may
// answer the root (the domain is attached to one, the other sits behind the PEER binding).

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * area is where this is being answered: the shared domain's own front page (CTT's groups, at /<name>)
 * or Trip Vara's area (every agency on Trip Vara, at /tv/<name>). The page is the same service either
 * way, so it carries the service's name and mark and not any one agency's.
 */
export function renderGroupLanding(env, { area = 'ctt' } = {}) {
  const host = String(env.GROUP_HOST || 'cruisegrouppage.com').trim() || 'cruisegrouppage.com';
  const tv = area === 'tv';
  // What a link to a group here starts with, shown in the box and used by the finder.
  const start = tv ? '/tv' : '';
  const year = new Date().getFullYear();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cruise Group Page: one page for your whole group</title>
<meta name="description" content="Your travel advisor builds your group's cruise page. Everyone sees the sailing, cabins, prices and deadlines in one place, and signs up right there.">
<meta property="og:type" content="website">
<meta property="og:title" content="Cruise Group Page: one page for your whole group">
<meta property="og:description" content="Sailing, cabins, prices and deadlines in one place, and everyone signs up right there.">
<meta property="og:image" content="https://${esc(host)}/cgp/share.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" sizes="32x32" href="/cgp/icon-32.png">
<link rel="shortcut icon" href="/cgp/favicon.ico">
<link rel="apple-touch-icon" href="/cgp/icon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root { --navy: #0f2747; --navy-2: #163a66; --teal: #1a8fa3; --teal-d: #136f80; --ink: #1f2a37; --soft: #5b6775; --line: #e3e8ef; --bg: #f6f8fb; --white: #fff; --gold: #d9b35a; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); line-height: 1.55; -webkit-font-smoothing: antialiased; }
  a { color: var(--teal-d); }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 0 1.25rem; }
  header { background: var(--white); border-bottom: 1px solid var(--line); }
  .nav { display: flex; align-items: center; justify-content: space-between; height: 76px; }
  .brand { display: flex; align-items: center; gap: 0.65rem; text-decoration: none; color: var(--navy); font-weight: 800; letter-spacing: 0.02em; font-size: 1.05rem; }
    .hero { background: linear-gradient(135deg, var(--navy) 0%, var(--navy-2) 55%, var(--teal-d) 100%); color: var(--white); padding: 4.5rem 0 4rem; position: relative; overflow: hidden; }
  .hero::after { content: ""; position: absolute; inset: auto -10% -45% -10%; height: 60%; background: radial-gradient(ellipse at center, rgba(255,255,255,0.10), transparent 60%); pointer-events: none; }
  .hero .wrap { position: relative; display: grid; grid-template-columns: 1.15fr 1fr; gap: 3rem; align-items: center; }
  .eyebrow { display: inline-block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: var(--gold); margin-bottom: 1rem; }
  h1 { font-size: clamp(2.1rem, 4.4vw, 3.3rem); line-height: 1.08; margin: 0 0 1.1rem; font-weight: 800; letter-spacing: -0.02em; }
  .lede { font-size: 1.12rem; color: rgba(255,255,255,0.86); max-width: 34rem; margin: 0; }
  .finder { background: var(--white); color: var(--ink); border-radius: 16px; padding: 1.6rem; box-shadow: 0 24px 60px rgba(5, 20, 45, 0.35); }
  .finder h2 { margin: 0 0 0.35rem; font-size: 1.15rem; color: var(--navy); }
  .finder p { margin: 0 0 1rem; color: var(--soft); font-size: 0.93rem; }
  .finder form { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .finder .field { flex: 1 1 220px; display: flex; align-items: center; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); padding: 0 0.85rem; min-height: 50px; }
  .finder .field span { color: var(--soft); font-size: 0.92rem; white-space: nowrap; }
  .finder input { flex: 1; border: none; background: transparent; font: inherit; font-size: 1rem; padding: 0.7rem 0 0.7rem 0.1rem; min-width: 80px; outline: none; color: var(--ink); }
  .finder button { background: var(--teal); color: var(--white); border: none; border-radius: 10px; font: inherit; font-weight: 700; padding: 0 1.4rem; min-height: 50px; cursor: pointer; }
  .finder button:hover { background: var(--teal-d); }
  .finder .hint { margin: 0.7rem 0 0; font-size: 0.82rem; color: var(--soft); }
  section { padding: 4rem 0; }
  section.alt { background: var(--white); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .head { max-width: 720px; margin: 0 auto 2.4rem; text-align: center; }
  .head .eyebrow { color: var(--teal-d); }
  h2.t { font-size: clamp(1.6rem, 3vw, 2.2rem); margin: 0 0 0.6rem; color: var(--navy); letter-spacing: -0.01em; }
  .head p { margin: 0; color: var(--soft); font-size: 1.05rem; }
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.4rem; }
  .step { background: var(--white); border: 1px solid var(--line); border-radius: 14px; padding: 1.6rem; }
  .step .n { display: inline-flex; width: 36px; height: 36px; border-radius: 50%; background: var(--navy); color: var(--gold); font-weight: 800; align-items: center; justify-content: center; margin-bottom: 0.9rem; }
  .step h3 { margin: 0 0 0.4rem; font-size: 1.08rem; color: var(--navy); }
  .step p { margin: 0; color: var(--soft); font-size: 0.95rem; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.2rem; }
  .feat { display: flex; gap: 0.9rem; align-items: flex-start; padding: 1.1rem 1.2rem; border-radius: 12px; background: var(--bg); border: 1px solid var(--line); }
  .feat .ic { flex: none; width: 40px; height: 40px; border-radius: 10px; background: var(--navy); display: flex; align-items: center; justify-content: center; }
  .feat .ic svg { width: 20px; height: 20px; stroke: var(--gold); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .feat h3 { margin: 0 0 0.2rem; font-size: 1rem; color: var(--navy); }
  .feat p { margin: 0; color: var(--soft); font-size: 0.9rem; }
  footer { padding: 2rem 0 2.6rem; color: var(--soft); font-size: 0.85rem; text-align: center; }
  @media (max-width: 860px) {
    .hero .wrap { grid-template-columns: 1fr; gap: 2rem; }
    .steps, .grid { grid-template-columns: 1fr; }
    .hero { padding: 3rem 0; }
    section { padding: 3rem 0; }
  }
</style>
</head>
<body>
<header>
  <div class="wrap nav">
    <a class="brand" href="${tv ? '/tv' : '/'}" aria-label="Cruise Group Page">
      <img src="/cgp/logo.png" alt="Cruise Group Page" width="164" height="52" style="display:block;">
    </a>
  </div>
</header>

<section class="hero">
  <div class="wrap">
    <div>
      <span class="eyebrow">${tv ? 'Group cruises, organised, from Trip Vara agencies' : 'Group cruises, organised'}</span>
      <h1>One page for your whole group.</h1>
      <p class="lede">Your travel advisor builds your group's page. Everyone sees the sailing, the cabins, the prices and the deadlines in one place, and signs up right there. No forwarded PDFs, no out-of-date screenshots.</p>
    </div>
    <div class="finder">
      <h2>Have your group's link?</h2>
      <p>Every group has its own address. Type the name from the link your advisor sent you.</p>
      <form id="finder" action="/" method="get">
        <label class="field"><span>${esc(host + start)}/</span><input id="gname" name="g" placeholder="your-group-name" autocomplete="off" spellcheck="false" aria-label="Your group's name"></label>
        <button type="submit">Open my group</button>
      </form>
      <p class="hint">Don't have it? Ask your travel advisor, they can send it again in seconds.</p>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="head">
      <span class="eyebrow">How it works</span>
      <h2 class="t">Three steps from idea to sailing</h2>
      <p>Built for the way group cruises actually get organised: one person leads, everyone else needs the same information at the same time.</p>
    </div>
    <div class="steps">
      <div class="step"><span class="n">1</span><h3>Your advisor sets it up</h3><p>Sailing dates, itinerary, cabin types, group rates, the deposit and the payment schedule, all entered once by a licensed travel advisor.</p></div>
      <div class="step"><span class="n">2</span><h3>Share one link</h3><p>${esc(host + start)}/your-group-name goes out by text, email or Facebook. It reads cleanly and always shows the latest details.</p></div>
      <div class="step"><span class="n">3</span><h3>Everyone signs up in one place</h3><p>Each traveller registers on the page. Your advisor confirms the cabins, keeps the manifest and chases the deadlines, so you don't have to.</p></div>
    </div>
  </div>
</section>

<section class="alt">
  <div class="wrap">
    <div class="head">
      <span class="eyebrow">What's on a group page</span>
      <h2 class="t">Everything your group keeps asking about</h2>
      <p>The questions that normally fill a group chat, answered on one page that stays current.</p>
    </div>
    <div class="grid">
      <div class="feat"><div class="ic"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></div><div><h3>Sailing dates and ship</h3><p>When you leave, when you're back, and what you're sailing on.</p></div></div>
      <div class="feat"><div class="ic"><svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg></div><div><h3>Itinerary, port by port</h3><p>Every stop and sea day laid out in order.</p></div></div>
      <div class="feat"><div class="ic"><svg viewBox="0 0 24 24"><path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM7 10V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4"/></svg></div><div><h3>Cabin types with group pricing</h3><p>The rates your group was given, per cabin type, with what's included.</p></div></div>
      <div class="feat"><div class="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><div><h3>Deposit and payment deadlines</h3><p>What's due and when, so nobody misses a date.</p></div></div>
      <div class="feat"><div class="ic"><svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg></div><div><h3>Sign-up for travellers</h3><p>Register yourself and the people in your cabin in a couple of minutes.</p></div></div>
      <div class="feat"><div class="ic"><svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.7a2 2 0 0 1 1.9 2z"/></svg></div><div><h3>Your advisor's contact details</h3><p>A real person to call when you have a question.</p></div></div>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">&copy; ${year} Cruise Group Page. Group pages are published by licensed travel advisors; each page shows the advisor responsible for that group.</div>
</footer>

<script>
  (function () {
    var f = document.getElementById('finder');
    var i = document.getElementById('gname');
    var START = ${JSON.stringify(start)};
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = (i.value || '').trim().toLowerCase();
      // Accept a pasted full link as well as a bare name, and a link into the other area.
      v = v.replace(/^https?:\\/\\//, '').replace(/^[^/]*\\//, '');
      var start = START;
      if (/^tv(\\/|$)/.test(v)) { start = '/tv'; v = v.replace(/^tv\\/?/, ''); }
      v = v.split(/[/?#]/)[0].replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (v) window.location.href = start + '/' + v;
      else i.focus();
    });
  })();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  });
}
