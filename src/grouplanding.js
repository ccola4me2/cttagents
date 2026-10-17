// The public front page of the shared group domain (cruisegrouppage.com), and of Trip Vara's area on it.
//
// A group's page lives at /<name>; this answers the bare domain for somebody who arrived without a
// name: what the service is, a box to open a group by name, what a group page holds, and the answers
// to what a traveller asks first. It is the service's own page and nobody's agency brand, because the
// domain carries groups from more than one agency, so it wears the Cruise Group Page logo.
//
// Both Workers carry this file and either may answer: the domain is attached to the CTT Worker, which
// answers its own front page and hands /tv to the Trip Vara Worker, which answers its own. See
// grouphost.js.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The icons are drawn once, here, and used by the cards below.
const ICONS = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  route: '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  bed: '<path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.7a2 2 0 0 1 1.9 2z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

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
  :root {
    --navy: #0a2a5e; --blue: #0b63b0; --teal: #12a3c4; --sun: #ffb21f; --orange: #f7871e; --pink: #ef4a7c;
    --ink: #172036; --soft: #566684; --line: #e3eaf3; --bg: #f4f8fc; --white: #fff;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  html, body { margin: 0; }
  body { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--white); line-height: 1.6; -webkit-font-smoothing: antialiased; }
  a { color: var(--blue); }
  img { max-width: 100%; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 1.5rem; }

  header { background: rgba(255,255,255,0.94); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; backdrop-filter: saturate(160%) blur(8px); }
  .nav { display: flex; align-items: center; justify-content: space-between; min-height: 96px; padding-top: 0.5rem; padding-bottom: 0.5rem; gap: 1rem; }
  .brand { display: block; line-height: 0; }
  .brand img { display: block; width: 252px; height: auto; }
  .links { display: flex; align-items: center; gap: 1.9rem; }
  .links a { color: var(--ink); text-decoration: none; font-size: 0.95rem; font-weight: 600; }
  .links a:hover { color: var(--blue); }
  .links a.cta { background: var(--navy); color: var(--white); padding: 0.7rem 1.25rem; border-radius: 999px; }
  .links a.cta:hover { background: var(--blue); color: var(--white); }

  .hero { position: relative; overflow: hidden; background: linear-gradient(180deg, #eaf6fc 0%, #f7fbfe 55%, #ffffff 100%); padding: 4.5rem 0 6rem; }
  .hero::before { content: ""; position: absolute; right: -140px; top: -170px; width: 560px; height: 560px; border-radius: 50%; background: radial-gradient(circle at 40% 40%, rgba(255,178,31,0.30), rgba(247,135,30,0.12) 55%, transparent 70%); pointer-events: none; }
  .hero .wrap { position: relative; display: grid; grid-template-columns: 1.1fr 0.95fr; gap: 3.5rem; align-items: center; }
  .eyebrow { display: inline-block; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--blue); margin-bottom: 1rem; }
  h1 { font-size: clamp(2.3rem, 4.8vw, 3.6rem); line-height: 1.06; margin: 0 0 1.2rem; font-weight: 800; letter-spacing: -0.025em; color: var(--navy); }
  h1 span { background: linear-gradient(90deg, var(--teal), var(--blue)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lede { font-size: 1.15rem; color: var(--soft); max-width: 34rem; margin: 0 0 1.6rem; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 0; padding: 0; list-style: none; }
  .chips li { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.88rem; font-weight: 600; color: var(--navy); background: var(--white); border: 1px solid var(--line); border-radius: 999px; padding: 0.4rem 0.85rem; }
  .chips li::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--teal); }
  .chips li:nth-child(2)::before { background: var(--orange); }
  .chips li:nth-child(3)::before { background: var(--pink); }

  .finder { background: var(--white); border-radius: 20px; padding: 2rem; border: 1px solid var(--line); box-shadow: 0 30px 70px rgba(10, 42, 94, 0.16); }
  .finder h2 { margin: 0 0 0.4rem; font-size: 1.35rem; color: var(--navy); letter-spacing: -0.01em; }
  .finder p { margin: 0 0 1.2rem; color: var(--soft); font-size: 0.97rem; }
  .finder form { display: grid; gap: 0.75rem; }
  .finder .field { display: flex; align-items: center; border: 1.5px solid var(--line); border-radius: 12px; background: var(--bg); padding: 0 1rem; min-height: 56px; transition: border-color .15s, box-shadow .15s; }
  .finder .field:focus-within { border-color: var(--teal); box-shadow: 0 0 0 4px rgba(18,163,196,0.15); background: var(--white); }
  .finder .field span { color: var(--soft); font-size: 0.95rem; white-space: nowrap; }
  .finder input { flex: 1; border: none; background: transparent; font: inherit; font-size: 1.02rem; padding: 0.8rem 0 0.8rem 0.1rem; min-width: 80px; outline: none; color: var(--ink); }
  .finder button { background: linear-gradient(90deg, var(--orange), var(--pink)); color: var(--white); border: none; border-radius: 12px; font: inherit; font-weight: 700; font-size: 1.02rem; padding: 0 1.4rem; min-height: 56px; cursor: pointer; box-shadow: 0 10px 24px rgba(239,74,124,0.28); }
  .finder button:hover { filter: brightness(1.05); }
  .finder .hint { margin: 1rem 0 0; font-size: 0.86rem; color: var(--soft); }

  .wave { position: absolute; left: 0; right: 0; bottom: -1px; line-height: 0; }
  .wave svg { display: block; width: 100%; height: 70px; }

  section { padding: 5rem 0; }
  section.tint { background: var(--bg); }
  .head { max-width: 720px; margin: 0 auto 3rem; text-align: center; }
  .head .eyebrow { color: var(--teal); }
  h2.t { font-size: clamp(1.8rem, 3.2vw, 2.4rem); margin: 0 0 0.7rem; color: var(--navy); letter-spacing: -0.02em; line-height: 1.15; }
  .head p { margin: 0; color: var(--soft); font-size: 1.08rem; }

  .showcase { display: grid; grid-template-columns: 1fr 1.05fr; gap: 3.5rem; align-items: center; }
  .showcase .copy .eyebrow { color: var(--teal); }
  .showcase .copy p { color: var(--soft); font-size: 1.06rem; margin: 0 0 1.2rem; }
  .ticks { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.75rem; }
  .ticks li { display: flex; gap: 0.75rem; align-items: flex-start; color: var(--ink); font-size: 1rem; }
  .ticks li::before { content: ""; flex: none; width: 22px; height: 22px; margin-top: 1px; border-radius: 50%; background: var(--teal) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 12.5l4 4 8-9'/%3E%3C/svg%3E") center/14px no-repeat; }
  .frame { background: var(--white); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 30px 70px rgba(10,42,94,0.14); overflow: hidden; }
  .frame .bar { display: flex; align-items: center; gap: 0.4rem; padding: 0.7rem 1rem; background: var(--bg); border-bottom: 1px solid var(--line); }
  .frame .bar i { width: 10px; height: 10px; border-radius: 50%; background: #d3dbe8; display: block; }
  .frame .bar b { margin-left: 0.7rem; font-weight: 500; font-size: 0.8rem; color: var(--soft); background: var(--white); border: 1px solid var(--line); border-radius: 999px; padding: 0.15rem 0.8rem; }
  .frame .top { background: linear-gradient(120deg, var(--navy), var(--blue)); color: var(--white); padding: 1.4rem 1.4rem 1.2rem; }
  .frame .top small { display: block; letter-spacing: 0.14em; text-transform: uppercase; font-size: 0.66rem; font-weight: 700; color: #bfe6f3; margin-bottom: 0.3rem; }
  .frame .top strong { display: block; font-size: 1.25rem; letter-spacing: -0.01em; }
  .frame .top span { display: block; font-size: 0.85rem; color: #d3e6f6; margin-top: 0.15rem; }
  .frame .body { padding: 1.1rem 1.4rem 1.4rem; display: grid; gap: 0.7rem; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; border: 1px solid var(--line); border-radius: 12px; padding: 0.75rem 0.95rem; }
  .row b { color: var(--navy); font-size: 0.95rem; }
  .row small { display: block; color: var(--soft); font-size: 0.78rem; }
  .row .price { font-weight: 800; color: var(--navy); white-space: nowrap; }
  .row .tag { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; padding: 0.2rem 0.55rem; border-radius: 999px; background: #e6f6ef; color: #17805a; white-space: nowrap; }
  .row .tag.low { background: #fff1de; color: #a15a05; }
  .frame .go { text-align: center; background: var(--orange); color: var(--white); font-weight: 700; border-radius: 999px; padding: 0.7rem; font-size: 0.95rem; }
  .note { font-size: 0.8rem; color: var(--soft); text-align: center; margin: 0.9rem 0 0; }

  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; }
  .step { background: var(--white); border: 1px solid var(--line); border-radius: 18px; padding: 2rem; }
  .step .n { display: inline-flex; width: 44px; height: 44px; border-radius: 14px; color: var(--white); font-weight: 800; font-size: 1.1rem; align-items: center; justify-content: center; margin-bottom: 1.1rem; background: var(--teal); }
  .step:nth-child(2) .n { background: var(--orange); }
  .step:nth-child(3) .n { background: var(--pink); }
  .step h3 { margin: 0 0 0.5rem; font-size: 1.15rem; color: var(--navy); }
  .step p { margin: 0; color: var(--soft); font-size: 0.99rem; }

  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.25rem; }
  .feat { padding: 1.5rem; border-radius: 16px; background: var(--white); border: 1px solid var(--line); }
  .feat .ic { width: 46px; height: 46px; border-radius: 13px; display: flex; align-items: center; justify-content: center; margin-bottom: 1rem; background: #e3f5fa; }
  .feat:nth-child(3n+2) .ic { background: #fff0dc; }
  .feat:nth-child(3n) .ic { background: #fde6ee; }
  .feat .ic svg { width: 22px; height: 22px; stroke: var(--blue); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .feat:nth-child(3n+2) .ic svg { stroke: #c96a0a; }
  .feat:nth-child(3n) .ic svg { stroke: #c4305f; }
  .feat h3 { margin: 0 0 0.3rem; font-size: 1.06rem; color: var(--navy); }
  .feat p { margin: 0; color: var(--soft); font-size: 0.95rem; }

  .faq { max-width: 780px; margin: 0 auto; display: grid; gap: 0.8rem; }
  .faq details { background: var(--white); border: 1px solid var(--line); border-radius: 14px; padding: 0 1.4rem; }
  .faq summary { cursor: pointer; font-weight: 700; color: var(--navy); font-size: 1.04rem; padding: 1.15rem 0; list-style: none; display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
  .faq summary::-webkit-details-marker { display: none; }
  .faq summary::after { content: "+"; font-size: 1.5rem; line-height: 1; color: var(--teal); font-weight: 500; }
  .faq details[open] summary::after { content: "\\2212"; }
  .faq details p { margin: 0 0 1.2rem; color: var(--soft); font-size: 0.99rem; }

  .final { text-align: center; background: linear-gradient(120deg, var(--navy), var(--blue)); color: var(--white); border-radius: 24px; padding: 3.2rem 2rem; position: relative; overflow: hidden; }
  .final::after { content: ""; position: absolute; right: -80px; bottom: -120px; width: 320px; height: 320px; border-radius: 50%; background: radial-gradient(circle, rgba(255,178,31,0.35), transparent 65%); pointer-events: none; }
  .final h2 { margin: 0 0 0.6rem; font-size: clamp(1.7rem, 3vw, 2.2rem); letter-spacing: -0.02em; position: relative; }
  .final p { margin: 0 0 1.6rem; color: #cfe3f6; font-size: 1.06rem; position: relative; }
  .final a { display: inline-block; position: relative; background: linear-gradient(90deg, var(--orange), var(--pink)); color: var(--white); text-decoration: none; font-weight: 700; padding: 0.95rem 2rem; border-radius: 999px; }

  footer { padding: 2.6rem 0 3rem; text-align: center; color: var(--soft); font-size: 0.86rem; }
  footer img { display: block; width: 150px; height: auto; margin: 0 auto 1rem; }

  @media (max-width: 900px) {
    .hero .wrap, .showcase { grid-template-columns: 1fr; gap: 2.5rem; }
    .steps, .grid { grid-template-columns: 1fr; }
    .links a:not(.cta) { display: none; }
    .brand img { width: 200px; }
    .nav { min-height: 80px; }
    .hero { padding: 2.8rem 0 5rem; }
    section { padding: 3.5rem 0; }
    .finder { padding: 1.5rem; }
  }
</style>
</head>
<body>
<header>
  <div class="wrap nav">
    <a class="brand" href="${tv ? '/tv' : '/'}" aria-label="Cruise Group Page home">
      <img src="/cgp/logo.png" alt="Cruise Group Page" width="252" height="80">
    </a>
    <nav class="links" aria-label="Page sections">
      <a href="#how">How it works</a>
      <a href="#inside">What is on a page</a>
      <a href="#questions">Questions</a>
      <a class="cta" href="#find">Visit my group page</a>
    </nav>
  </div>
</header>

<section class="hero">
  <div class="wrap">
    <div>
      <span class="eyebrow">${tv ? 'Group cruises, organised, from Trip Vara agencies' : 'Group cruises, organised'}</span>
      <h1>One page for your <span>whole group.</span></h1>
      <p class="lede">Your travel advisor builds your group's page. Everyone sees the sailing, the cabins, the prices and the deadlines in one place, and signs up right there. No forwarded PDFs, no out-of-date screenshots.</p>
      <ul class="chips">
        <li>Sailing and cabins</li>
        <li>Prices and deadlines</li>
        <li>Sign up in minutes</li>
      </ul>
    </div>
    <div class="finder" id="find">
      <h2>Visit your group's page</h2>
      <p>Every group has its own address. Type the name from the link your advisor sent you, or paste the whole link.</p>
      <form id="finder" action="/" method="get">
        <label class="field"><span>${esc(host + start)}/</span><input id="gname" name="g" placeholder="your-group-name" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Your group's name"></label>
        <button type="submit">Visit my group page</button>
      </form>
      <p class="hint">Do not have it? Ask your travel advisor, they can send it again in seconds.</p>
    </div>
  </div>
  <div class="wave" aria-hidden="true"><svg viewBox="0 0 1440 70" preserveAspectRatio="none"><path d="M0 40c120 26 240 26 360 6s240-30 360-12 240 40 360 22 240-40 360-14v28H0z" fill="#ffffff"/></svg></div>
</section>

<section id="inside">
  <div class="wrap showcase">
    <div class="copy">
      <span class="eyebrow">What your group sees</span>
      <h2 class="t">Everything in one place, always up to date</h2>
      <p>The questions that normally fill a group chat are answered on one page, and the page changes when the details change.</p>
      <ul class="ticks">
        <li>The sailing dates, ship and ports, day by day</li>
        <li>Each cabin type with the group price and how many are left</li>
        <li>The deposit and payment dates, so nobody misses one</li>
        <li>A sign-up for you and everyone in your cabin</li>
        <li>Your advisor's name and contact details</li>
      </ul>
    </div>
    <div>
      <div class="frame" role="img" aria-label="An example of a group page">
        <div class="bar"><i></i><i></i><i></i><b>${esc(host + start)}/your-group</b></div>
        <div class="top"><small>Group cruise</small><strong>Caribbean Getaway, Spring Sailing</strong><span>Seven nights round trip, hosted by your travel advisor</span></div>
        <div class="body">
          <div class="row"><div><b>Interior</b><small>Per person, two sharing</small></div><div class="price">from $899</div><span class="tag">Available</span></div>
          <div class="row"><div><b>Balcony</b><small>Per person, two sharing</small></div><div class="price">from $1,299</div><span class="tag low">3 left</span></div>
          <div class="row"><div><b>Deposit due</b><small>Holds your cabin</small></div><div class="price">Dec 1</div><span class="tag">Reserve</span></div>
          <div class="go">Reserve your cabin</div>
        </div>
      </div>
      <p class="note">An example, not a real group. Names, dates and prices come from your advisor.</p>
    </div>
  </div>
</section>

<section class="tint" id="how">
  <div class="wrap">
    <div class="head">
      <span class="eyebrow">How it works</span>
      <h2 class="t">Three steps from idea to sailing</h2>
      <p>Built for the way group cruises really get organised: one person leads, and everyone else needs the same information at the same time.</p>
    </div>
    <div class="steps">
      <div class="step"><span class="n">1</span><h3>Your advisor sets it up</h3><p>Sailing dates, itinerary, cabin types, group rates, the deposit and the payment schedule, all entered once by a travel advisor.</p></div>
      <div class="step"><span class="n">2</span><h3>Share one link</h3><p>${esc(host + start)}/your-group-name goes out by text, email or Facebook. It reads cleanly on a phone and always shows the latest details.</p></div>
      <div class="step"><span class="n">3</span><h3>Everyone signs up in one place</h3><p>Each traveller registers on the page. Your advisor confirms the cabins, keeps the list of who is coming and chases the deadlines, so you do not have to.</p></div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="head">
      <span class="eyebrow">On every group page</span>
      <h2 class="t">Built to answer the questions first</h2>
      <p>What travellers ask before they book, in the order they ask it.</p>
    </div>
    <div class="grid">
      <div class="feat"><div class="ic">${icon('calendar')}</div><h3>Sailing dates and ship</h3><p>When you leave, when you are back, and what you are sailing on.</p></div>
      <div class="feat"><div class="ic">${icon('route')}</div><h3>Itinerary, port by port</h3><p>Every stop and sea day laid out in order.</p></div>
      <div class="feat"><div class="ic">${icon('bed')}</div><h3>Cabins with group pricing</h3><p>The rate your group was given for each cabin type, and what is left.</p></div>
      <div class="feat"><div class="ic">${icon('clock')}</div><h3>Deposit and payment dates</h3><p>What is due and when, in one clear list.</p></div>
      <div class="feat"><div class="ic">${icon('people')}</div><h3>Sign-up for travellers</h3><p>Register yourself and the people in your cabin in a couple of minutes.</p></div>
      <div class="feat"><div class="ic">${icon('phone')}</div><h3>A real person to call</h3><p>Your advisor's name and contact details, on the page.</p></div>
    </div>
  </div>
</section>

<section class="tint" id="questions">
  <div class="wrap">
    <div class="head">
      <span class="eyebrow">Questions</span>
      <h2 class="t">Good to know before you open your page</h2>
    </div>
    <div class="faq">
      <details><summary>How do I find my group's page?</summary><p>Your travel advisor sends you a link that looks like ${esc(host + start)}/your-group-name. Type the last part into the box at the top of this page, or paste the whole link. If you have lost it, ask your advisor to send it again.</p></details>
      <details><summary>Do I pay on the page?</summary><p>No. Signing up on a group page does not charge anything and the page does not take card details. Your advisor tells you how and when to pay once your cabin is held.</p></details>
      <details><summary>Who is behind my group's page?</summary><p>A travel advisor. Each page is published by the advisor who runs that group and shows their name and contact details, so you always know who to ask.</p></details>
      <details><summary>What if the cabin I want is gone?</summary><p>The page shows how many cabins are left of each type. When one is gone it says so and you can join the waitlist, and your advisor will tell you if one opens up.</p></details>
      <details><summary>Can I share the page with friends and family?</summary><p>Yes. Copy the link from the page, or use the share button on your phone. Anyone with the link can see the sailing and sign up.</p></details>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="final">
      <h2>Have your group's link?</h2>
      <p>Visit your group's page to see the sailing, the cabins and what to do next.</p>
      <a href="#find" id="again">Visit my group page</a>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <img src="/cgp/logo.png" alt="Cruise Group Page" width="150" height="48">
    &copy; ${year} Cruise Group Page. Group pages are published by travel advisors; each page shows the advisor responsible for that group.
  </div>
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
    // The button at the foot points at the box, and also puts the cursor in it.
    var again = document.getElementById('again');
    if (again) again.addEventListener('click', function () { setTimeout(function () { i.focus(); }, 400); });
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
