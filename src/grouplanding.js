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

export function renderGroupLanding(env) {
  const host = String(env.GROUP_HOST || 'cruisegrouppage.com').trim() || 'cruisegrouppage.com';
  const year = new Date().getFullYear();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cruise Group Page: one page for your whole group</title>
<meta name="description" content="Your travel advisor builds your group's cruise page. Everyone sees the sailing, cabins, prices and deadlines in one place, and signs up right there.">
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
  .nav { display: flex; align-items: center; justify-content: space-between; height: 68px; }
  .brand { display: flex; align-items: center; gap: 0.65rem; text-decoration: none; color: var(--navy); font-weight: 800; letter-spacing: 0.02em; font-size: 1.05rem; }
  .brand svg { width: 34px; height: 34px; }
  .nav a.adv { font-size: 0.9rem; font-weight: 600; color: var(--navy); text-decoration: none; padding: 0.55em 1em; border: 1px solid var(--line); border-radius: 999px; }
  .nav a.adv:hover { border-color: var(--teal); color: var(--teal-d); }
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
  .adv-band { background: var(--navy); color: var(--white); border-radius: 18px; padding: 2.6rem; display: grid; grid-template-columns: 1.4fr 1fr; gap: 2rem; align-items: center; }
  .adv-band h2 { margin: 0 0 0.6rem; font-size: 1.7rem; letter-spacing: -0.01em; }
  .adv-band p { margin: 0; color: rgba(255,255,255,0.82); }
  .adv-band .btns { display: flex; flex-direction: column; gap: 0.7rem; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; text-decoration: none; font-weight: 700; border-radius: 10px; padding: 0.9rem 1.3rem; font-size: 0.98rem; }
  .btn.gold { background: var(--gold); color: var(--navy); }
  .btn.ghost { border: 1px solid rgba(255,255,255,0.35); color: var(--white); }
  .btn:hover { filter: brightness(1.06); }
  footer { padding: 2rem 0 2.6rem; color: var(--soft); font-size: 0.85rem; text-align: center; }
  @media (max-width: 860px) {
    .hero .wrap { grid-template-columns: 1fr; gap: 2rem; }
    .steps, .grid { grid-template-columns: 1fr; }
    .adv-band { grid-template-columns: 1fr; padding: 2rem; }
    .hero { padding: 3rem 0; }
    section { padding: 3rem 0; }
  }
</style>
</head>
<body>
<header>
  <div class="wrap nav">
    <a class="brand" href="/" aria-label="Cruise Group Page">
      <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19" fill="#0f2747"/><path d="M9 25h22l-3 5H12z" fill="#d9b35a"/><path d="M13 25V15h14v10" fill="none" stroke="#fff" stroke-width="2"/><path d="M20 15V9m-4 3h8" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M6 31c3 2 5 2 8 0s5-2 8 0 5 2 8 0" fill="none" stroke="#1a8fa3" stroke-width="2" stroke-linecap="round"/></svg>
      <span>Cruise Group Page</span>
    </a>
    <a class="adv" href="#advisors">For travel advisors</a>
  </div>
</header>

<section class="hero">
  <div class="wrap">
    <div>
      <span class="eyebrow">Group cruises, organised</span>
      <h1>One page for your whole group.</h1>
      <p class="lede">Your travel advisor builds your group's page. Everyone sees the sailing, the cabins, the prices and the deadlines in one place, and signs up right there. No forwarded PDFs, no out-of-date screenshots.</p>
    </div>
    <div class="finder">
      <h2>Have your group's link?</h2>
      <p>Every group has its own address. Type the name from the link your advisor sent you.</p>
      <form id="finder" action="/" method="get">
        <label class="field"><span>${esc(host)}/</span><input id="gname" name="g" placeholder="your-group-name" autocomplete="off" spellcheck="false" aria-label="Your group's name"></label>
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
      <div class="step"><span class="n">2</span><h3>Share one link</h3><p>${esc(host)}/your-group-name goes out by text, email or Facebook. It reads cleanly and always shows the latest details.</p></div>
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

<section id="advisors">
  <div class="wrap">
    <div class="adv-band">
      <div>
        <span class="eyebrow">For travel advisors</span>
        <h2>Run your groups from one place.</h2>
        <p>Group pages are built into your advisor portal. Create the group, write the page, choose its name and share the link. Registrations, manifests and deadline reminders are handled for you, and every page carries your name and contact details.</p>
      </div>
      <div class="btns">
        <a class="btn gold" href="https://cttagents.com/">CTT Agent Portal</a>
      </div>
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
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = (i.value || '').trim().toLowerCase();
      // Accept a pasted full link as well as a bare name.
      v = v.replace(/^https?:\\/\\//, '').replace(/^[^/]*\\//, '');
      v = v.split(/[/?#]/)[0].replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (v) window.location.href = '/' + v;
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
