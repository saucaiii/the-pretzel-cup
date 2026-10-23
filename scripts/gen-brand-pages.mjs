// Generates the brand site's 5 marketing pages. Run with:
//   node scripts/gen-brand-pages.mjs
//
// Outputs:
//   /index.html              — homepage (brand landing, long scroll)
//   /deliveries/index.html   — 3 territories deep dive
//   /partners/index.html     — UBS Arena + schools (placeholder slots)
//   /host/index.html         — party / event CTA + party trays
//   /order/index.html        — iOS app + 2 store locations
//
// All pages share brand.css + the same nav/header/footer markup
// defined here. Edit this file + rerun — do not hand-edit the HTML.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/Users/chris/pretzel-cup';

// ─── CONTENT DATA ───────────────────────────────────────────────

// Three delivery territories. Names and area blurbs are reasonable
// defaults derived from the current 7-Eleven store footprint — edit
// to match PPF's actual route descriptors.
const TERRITORIES = [
  {
    id: 'franklin-square',
    name: 'Franklin Square',
    tagline: 'Our home base.',
    towns: ['Franklin Square', 'Valley Stream', 'Elmont', 'West Hempstead'],
    zips: ['11010', '11580', '11581', '11003'],
    detail: 'Daily deliveries to shops, offices, schools, and 7-Eleven partners across the Franklin Square corridor. Start your morning with a tray that was pretzel dough an hour ago.',
    stops: 10,
  },
  {
    id: 'rockville-centre',
    name: 'Rockville Centre',
    tagline: 'Mid-island hub.',
    towns: ['Rockville Centre', 'Hewlett', 'Lynbrook', 'Malverne'],
    zips: ['11570', '11557', '11563', '11565'],
    detail: 'Lynbrook, RVC, Hewlett and surrounding villages. Same-day delivery for standing orders; next-morning for new accounts.',
    stops: 8,
  },
  {
    id: 'south-shore',
    name: 'South Shore',
    tagline: 'Beach to bay.',
    towns: ['Oceanside', 'Long Beach', 'Island Park', 'Freeport', 'Baldwin', 'Roosevelt'],
    zips: ['11572', '11561', '11558', '11520', '11510', '11575'],
    detail: 'The south-shore route runs from Oceanside out to Long Beach and up through Freeport, Baldwin, and Roosevelt. Perfect for beachfront events and summer catering.',
    stops: 15,
  },
];

const PARTNERS = {
  anchor: {
    name: 'UBS Arena',
    role: 'Game Day & Event Partner',
    detail: 'Fresh-twisted pretzels at the home of the New York Islanders. From puck drop to third-period encores, every tray is baked that morning.',
  },
  schools: [
    { name: 'School Partner', note: 'Weekly delivery · Backfill coming' },
    { name: 'School Partner', note: 'Weekly delivery · Backfill coming' },
    { name: 'School Partner', note: 'Weekly delivery · Backfill coming' },
    { name: 'School Partner', note: 'Weekly delivery · Backfill coming' },
    { name: 'School Partner', note: 'Fundraiser program · Backfill coming' },
    { name: 'School Partner', note: 'Fundraiser program · Backfill coming' },
  ],
};

const STORES = [
  {
    id: 'franklin-square',
    name: 'Franklin Square',
    address: '850 Hempstead Turnpike, Franklin Square, NY 11010',
    phone: '(516) 505-7437',
    hours: [
      { days: 'Mon–Fri', time: '7:00 AM – 8:00 PM' },
      { days: 'Sat–Sun', time: '8:00 AM – 8:00 PM' },
    ],
    note: 'Walk-ins, call-aheads, and app orders — all three welcomed.',
  },
  {
    id: 'lynbrook',
    name: 'Lynbrook',
    address: '558 Merrick Road, Lynbrook, NY 11563',
    phone: '(516) 599-0202',
    hours: [
      { days: 'Mon–Fri', time: '7:00 AM – 8:00 PM' },
      { days: 'Sat–Sun', time: '8:00 AM – 8:00 PM' },
    ],
    note: 'Walk-ins, call-aheads, and app orders — all three welcomed.',
  },
];

// Product categories reused from /products — image paths point to the
// shared asset directory under /products/images/.
const PRODUCT_CATEGORIES = [
  { id: 'pretzels',    name: 'Pretzels',        count: 4,  heroImage: '/products/images/pretzels.jpg' },
  { id: 'party-trays', name: 'Party Trays',     count: 5,  heroImage: '/products/images/large-rivet-party-tray.jpg' },
  { id: 'specialty',   name: 'Specialty Items', count: 7,  heroImage: '/products/images/pretzel-dog.jpg' },
  { id: 'drinks',      name: 'Drinks',          count: 2,  heroImage: '/products/images/coke-beverages.jpg' },
  { id: 'dips',        name: 'Dips',            count: 14, heroImage: '/products/images/cookies-and-cream.jpg' },
];

const PARTY_TRAYS = [
  { slug: 'large-rivet-party-tray',          name: 'Large Rivet Party Tray',       serves: 'Serves 20–25' },
  { slug: 'mini-dogs-and-rivets-party-tray', name: 'Mini Dogs & Rivets Tray',      serves: 'Serves 20–25' },
  { slug: 'all-mini-dogs-party-tray',        name: 'All Mini Dogs Party Tray',     serves: 'Serves 20–25' },
  { slug: 'pretzel-poppers-party-tray',      name: 'Pretzel Poppers Party Tray',   serves: '30 poppers' },
  { slug: 'small-rivet-party-tray',          name: 'Small Rivet Party Tray',       serves: 'Serves 10–15' },
  { slug: 'crowd-pleaser',                   name: 'The Crowd Pleaser',            serves: '25 pretzels' },
];

const APP_STORE_URL = 'https://apps.apple.com/us/app/philly-pretzel-factory/id1185574639';

// ─── MARKUP HELPERS ─────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);)/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function raw(s) { return String(s); }

function head(title, description) {
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0D5237" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&family=Caveat:wght@600;700&display=swap" />
<link rel="stylesheet" href="/brand.css" />
</head>
<body>`;
}

function header(active) {
  const nav = [
    { href: '/products',   label: 'Products',   id: 'products' },
    { href: '/deliveries', label: 'Deliveries', id: 'deliveries' },
    { href: '/partners',   label: 'Partners',   id: 'partners' },
    { href: '/host',       label: 'Host',       id: 'host' },
    { href: '/cup',        label: 'The Cup',    id: 'cup' },
  ];
  const links = nav.map(n => `<a href="${n.href}" class="nav-link${active === n.id ? ' is-active' : ''}">${n.label}</a>`).join('');
  return `
<a href="#main" class="skip-link">Skip to content</a>
<div class="header-wrap">
  <div class="diamond-strip" aria-hidden="true"></div>
  <header class="header">
    <a class="brand-link" href="/" aria-label="Philly Pretzel Factory home">
      <img src="/ppf-logo.jpg" alt="" class="brand-logo" width="68" height="60" fetchpriority="high" />
      <span class="brand-text">
        <span class="top">Philly Pretzel Factory</span>
        <span class="bot">Made To Crave</span>
      </span>
    </a>
    <div class="nav-cluster">
      <nav class="site-nav" aria-label="Primary">${links}</nav>
      <a href="/order" class="cta-btn">Order Now</a>
    </div>
  </header>
</div>`;
}

function footer() {
  return `
<footer class="footer">
  <p class="footer-tagline" translate="no">Made&nbsp;to&nbsp;Crave<sup>&reg;</sup></p>
  <p class="footer-meta">Philly Pretzel Factory &middot; Franklin Square &middot; Lynbrook</p>
  <nav class="footer-links" aria-label="Site footer">
    <a href="/products">Menu</a>
    <a href="/deliveries">Deliveries</a>
    <a href="/partners">Partners</a>
    <a href="/host">Host an Event</a>
    <a href="/order">Order</a>
    <a href="/cup">The Pretzel Cup</a>
  </nav>
</footer>
</body>
</html>
`;
}

// Reusable marquee — "crave" phrases from the brand guide's approved list.
function marquee() {
  const items = [
    'Fresh-Baked Daily',
    'Made to Crave',
    'Hand-Twisted',
    'Billions Baked',
    'Crave Big · Snack Bigger',
    'Fresh-Baked Daily',
    'Bring Your Cravings',
    'Hand-Twisted',
    'Billions Baked',
    'Made to Crave',
  ];
  // Duplicate the track content so the CSS -50% translate loops seamlessly.
  const row = items.map(x => `<span class="marquee-item">${x}</span>`).join('');
  return `
<div class="marquee" aria-hidden="true">
  <div class="marquee-track">
    ${row}
    ${row}
  </div>
</div>`;
}

// Inline Apple-logo SVG — avoids pulling an external image for a tiny icon.
const APPLE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:24px;height:24px;"><path d="M16.365 1.43c0 1.14-.433 2.248-1.202 3.048-.823.852-2.136 1.49-3.177 1.405-.123-1.098.425-2.236 1.19-3.014.826-.86 2.26-1.515 3.189-1.44zM20.548 17.4c-.603 1.39-.892 2.012-1.668 3.242-1.084 1.712-2.613 3.844-4.507 3.858-1.684.014-2.117-1.096-4.403-1.084-2.287.012-2.764 1.1-4.449 1.084-1.894-.012-3.342-1.937-4.426-3.65C-.86 16.3-1.182 10.606 1.052 7.58 2.6 5.46 5.072 4.24 7.408 4.24c2.236 0 3.643 1.218 5.49 1.218 1.788 0 2.878-1.22 5.46-1.22 2.09 0 4.312 1.135 5.9 3.107-5.19 2.84-4.348 10.252-3.71 10.055z"/></svg>`;

function appStoreBadge() {
  return `
<a class="app-badge" href="${APP_STORE_URL}" target="_blank" rel="noopener">
  <span class="app-badge-icon" aria-hidden="true">${APPLE_SVG}</span>
  <span class="app-badge-text">
    <span class="top">Download on the</span>
    <span class="bot">App Store</span>
  </span>
</a>`;
}

// ─── HERO CAROUSEL ──────────────────────────────────────────────
// Five fading slides at the top of the homepage. Each slide reuses the
// standard hero layout (copy left, art panel right) but swaps content.
// Auto-advances every ADVANCE_MS unless the user prefers reduced motion
// or is hovering/focused inside the carousel. The behavior JS is inline
// at the bottom of the markup — the homepage is the only page that
// needs it, so it stays scoped here rather than in brand.css + a .js file.
const HERO_SLIDES = [
  {
    key: 'crave',
    eyebrow: 'Franklin Square · Lynbrook · Delivered Fresh',
    headline: 'Made<br/>To <span class="crave-script">Crave.</span>',
    sub: 'Hand-twisted and fresh-baked every morning. <strong>Walk into one of our shops, order in the app, or let us deliver straight to your event.</strong>',
    ctas: [
      { label: 'Order Now',    href: '/order',    style: '' },
      { label: 'See the Menu', href: '/products', style: 'is-ghost' },
    ],
    art: '/products/images/large-rivet-party-tray.jpg',
    stamp: { top: 'FRESH', bot: 'Hourly' },
  },
  {
    key: 'ubs',
    eyebrow: 'Proudly Serving · UBS Arena',
    headline: 'Game Day.<br/>Pretzel <span class="crave-script">Night.</span>',
    sub: 'Fresh-twisted pretzels at the home of the New York Islanders. From puck drop to third-period encores, every tray is <strong>baked that morning.</strong>',
    ctas: [
      { label: 'See All Partners', href: '/partners', style: '' },
      { label: 'Order Now',        href: '/order',    style: 'is-ghost' },
    ],
    art: '/products/images/pretzels.jpg',
    stamp: { top: 'GAME', bot: 'DAY' },
  },
  {
    key: 'seasonal',
    eyebrow: 'Limited Time · Seasonal Dips',
    headline: 'Three dips.<br/>One <span class="crave-script">season.</span>',
    sub: 'Cookies &amp; Cream, Strawberries &amp; Cream, Cotton Candy. <strong>Limited-time flavors</strong> you won&rsquo;t find any other month of the year.',
    ctas: [
      { label: 'See the Dips', href: '/products#dips', style: '' },
      { label: 'Order Now',    href: '/order',         style: 'is-ghost' },
    ],
    art: '/products/images/cookies-and-cream.jpg',
    stamp: { top: 'LIMITED', bot: 'TIME' },
  },
  {
    key: 'deliveries',
    eyebrow: 'Three Routes · Nassau County',
    headline: 'We deliver<br/>the <span class="crave-script">crave.</span>',
    sub: 'Standing orders delivered same-morning across <strong>Franklin Square, Rockville Centre, and the South Shore.</strong>',
    ctas: [
      { label: 'See Delivery Routes', href: '/deliveries', style: '' },
      { label: 'Request Delivery',    href: 'mailto:orders@phillypretzelfactory.com?subject=Delivery%20inquiry', style: 'is-ghost' },
    ],
    art: '/products/images/mini-dogs-and-rivets-party-tray.jpg',
    stamp: { top: 'DAILY', bot: 'ROUTES' },
  },
  {
    key: 'events',
    eyebrow: 'Parties · Fundraisers · Events',
    headline: 'Hosting?<br/>We&rsquo;re <span class="crave-script">catering.</span>',
    sub: 'Trays scale from a classroom of 25 to a sold-out arena. <strong>Tell us the day, we&rsquo;ll handle the rest.</strong>',
    ctas: [
      { label: 'Plan Your Event', href: '/host',   style: '' },
      { label: 'Order Now',       href: '/order',  style: 'is-ghost' },
    ],
    art: '/products/images/pretzel-poppers-party-tray.jpg',
    stamp: { top: 'SCALES', bot: '25 to 2,500' },
  },
];

function heroCarousel() {
  const slides = HERO_SLIDES.map((s, i) => {
    const ctaRow = s.ctas.map(c => `<a href="${c.href}" class="cta-btn ${c.style}">${c.label}</a>`).join('\n        ');
    return `
    <article class="carousel-slide${i === 0 ? ' is-active' : ''}"
             data-slide="${i}" id="slide-${i}"
             role="group" aria-roledescription="slide"
             aria-label="${i + 1} of ${HERO_SLIDES.length}: ${s.key}"
             aria-hidden="${i === 0 ? 'false' : 'true'}">
      <div class="hero">
        <div>
          <div class="hero-eyebrow">${s.eyebrow}</div>
          <h1>${s.headline}</h1>
          <p class="hero-sub">${s.sub}</p>
          <div class="hero-cta-row">
            ${ctaRow}
          </div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="hero-art-img" style="background-image:url('${s.art}')"></div>
          <div class="hero-art-stamp"><span><strong>${s.stamp.top}</strong>${s.stamp.bot}</span></div>
        </div>
      </div>
    </article>`;
  }).join('');

  const dots = HERO_SLIDES.map((s, i) => `
      <button type="button" class="carousel-dot${i === 0 ? ' is-active' : ''}"
              role="tab" aria-selected="${i === 0 ? 'true' : 'false'}"
              aria-controls="slide-${i}"
              aria-label="Slide ${i + 1}: ${s.key}"
              data-dot="${i}"></button>`).join('');

  return `
<section class="hero-carousel" aria-roledescription="carousel" aria-label="Featured highlights">
  <div class="carousel-track" id="carousel-track">
    ${slides}
  </div>

  <button type="button" class="carousel-arrow carousel-prev" aria-label="Previous slide" data-dir="-1">
    <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
  </button>
  <button type="button" class="carousel-arrow carousel-next" aria-label="Next slide" data-dir="1">
    <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
  </button>

  <div class="carousel-dots" role="tablist" aria-label="Choose a slide">${dots}
  </div>
</section>

<script>
(function () {
  var root = document.querySelector('.hero-carousel');
  if (!root) return;
  var slides = Array.prototype.slice.call(root.querySelectorAll('.carousel-slide'));
  var dots   = Array.prototype.slice.call(root.querySelectorAll('.carousel-dot'));
  var prev   = root.querySelector('.carousel-prev');
  var next   = root.querySelector('.carousel-next');
  if (slides.length < 2) return;

  var ADVANCE_MS = 7000;
  var current = 0;
  var timer = null;
  var paused = false;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function go(idx) {
    idx = ((idx % slides.length) + slides.length) % slides.length;
    if (idx === current) return;
    slides[current].classList.remove('is-active');
    slides[current].setAttribute('aria-hidden', 'true');
    dots[current].classList.remove('is-active');
    dots[current].setAttribute('aria-selected', 'false');
    slides[idx].classList.add('is-active');
    slides[idx].setAttribute('aria-hidden', 'false');
    dots[idx].classList.add('is-active');
    dots[idx].setAttribute('aria-selected', 'true');
    current = idx;
  }

  function schedule() {
    if (reduced || paused) return;
    clearTimeout(timer);
    timer = setTimeout(function () { go(current + 1); schedule(); }, ADVANCE_MS);
  }
  function reset() { clearTimeout(timer); schedule(); }

  dots.forEach(function (d, i) {
    d.addEventListener('click', function () { go(i); reset(); });
  });
  prev.addEventListener('click', function () { go(current - 1); reset(); });
  next.addEventListener('click', function () { go(current + 1); reset(); });

  // Pause on hover / keyboard focus so viewers can read without the slide swapping.
  root.addEventListener('mouseenter', function () { paused = true; clearTimeout(timer); });
  root.addEventListener('mouseleave', function () { paused = false; schedule(); });
  root.addEventListener('focusin',    function () { paused = true; clearTimeout(timer); });
  root.addEventListener('focusout',   function () { paused = false; schedule(); });

  // Pause when the tab is hidden to avoid stacking advances.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimeout(timer); } else { schedule(); }
  });

  // Left/right arrow keys when a dot has focus — standard carousel pattern.
  root.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft')  { go(current - 1); reset(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { go(current + 1); reset(); e.preventDefault(); }
  });

  schedule();
})();
</script>`;
}

// ─── PAGE: HOMEPAGE ─────────────────────────────────────────────
function renderHome() {
  const productTiles = PRODUCT_CATEGORIES.map(c => `
    <a class="tile" href="/products#${c.id}" aria-label="${esc(c.name)}">
      <span class="tile-bg is-fill" style="background-image:url('${c.heroImage}')"></span>
      <span class="tile-overlay"></span>
      <span class="tile-content">
        <span class="tile-count">${c.count} ITEMS</span>
        <h3 class="tile-name">${esc(c.name)}</h3>
      </span>
    </a>`).join('');

  const territoryCards = TERRITORIES.map(t => `
    <article class="card">
      <span class="card-chip">${esc(t.tagline)}</span>
      <h3 class="card-title">${esc(t.name)}</h3>
      <p class="card-body">${esc(t.detail)}</p>
      <div class="card-cta"><a href="/deliveries#${t.id}" class="cta-btn is-ghost">See the route</a></div>
    </article>`).join('');

  const partnerCards = `
    <article class="card is-featured">
      <span class="card-chip">${esc(PARTNERS.anchor.role)}</span>
      <h3 class="card-title">${esc(PARTNERS.anchor.name)}</h3>
      <p class="card-body">${esc(PARTNERS.anchor.detail)}</p>
    </article>
    ${PARTNERS.schools.slice(0, 3).map(s => `
    <article class="card">
      <span class="card-chip">School Partner</span>
      <h3 class="card-title">${esc(s.name)}</h3>
      <p class="card-body" style="opacity:0.6;">${esc(s.note)}</p>
    </article>`).join('')}
  `;

  const storeCards = STORES.map(s => `
    <article class="card">
      <span class="card-chip">Store Location</span>
      <h3 class="card-title">${esc(s.name)}</h3>
      <p class="card-body">${esc(s.address)}</p>
      <p class="card-detail-row"><strong>Call</strong>${esc(s.phone)}</p>
      <div class="card-cta pill-row">
        <a class="cta-btn" href="${APP_STORE_URL}" target="_blank" rel="noopener">Order in the App</a>
        <a class="cta-btn is-ghost" href="tel:${s.phone.replace(/\D/g, '')}">Call Store</a>
      </div>
    </article>`).join('');

  return `${head('Philly Pretzel Factory — Made to Crave', 'Fresh-baked pretzels, party trays, and specialty items — Franklin Square and Lynbrook, serving Nassau County with daily delivery.')}
${header(null)}
<main id="main">
  ${heroCarousel()}

  ${marquee()}

  <section class="section-wrap" aria-labelledby="products-head">
    <div class="section-head">
      <div class="section-eyebrow">The Menu · 32 Items</div>
      <h2 class="section-heading" id="products-head">Pick your <span class="crave-script">craving.</span></h2>
      <p class="section-sub">Five categories, one standard: fresh-baked and hand-twisted. Tap any one to see the full set.</p>
    </div>
    <div class="tile-grid">${productTiles}</div>
    <div style="margin-top:28px;"><a href="/products" class="cta-btn is-ghost">See the full menu</a></div>
  </section>

  <section class="section-wrap" aria-labelledby="deliveries-head" style="background: var(--bg-2); max-width: none;">
    <div class="section-wrap" style="padding: 0;">
      <div class="section-head">
        <div class="section-eyebrow">We Deliver</div>
        <h2 class="section-heading" id="deliveries-head">Three territories.<br/>Same <span class="crave-script">fresh</span> pretzels.</h2>
        <p class="section-sub">Nassau County, covered. Daily routes to shops, offices, schools, and 7-Elevens across the south shore.</p>
      </div>
      <div class="card-grid">${territoryCards}</div>
      <div style="margin-top:28px;"><a href="/deliveries" class="cta-btn is-ghost">See all delivery info</a></div>
    </div>
  </section>

  <section class="section-wrap" aria-labelledby="partners-head">
    <div class="section-head">
      <div class="section-eyebrow">Proudly Serving</div>
      <h2 class="section-heading" id="partners-head">The <span class="crave-script">crowds</span> we feed.</h2>
      <p class="section-sub">From puck drop at UBS Arena to Friday-afternoon pep rallies — we show up with trays. More partners coming to this page as the lineup grows.</p>
    </div>
    <div class="card-grid">${partnerCards}</div>
    <div style="margin-top:28px;"><a href="/partners" class="cta-btn is-ghost">See all partners</a></div>
  </section>

  <section class="callout" aria-labelledby="host-head">
    <div class="callout-inner">
      <h2 id="host-head">Hosting a party<br/>or <span class="white">event?</span></h2>
      <p>Pretzel trays scale from a classroom of 25 to a sold-out arena. Tell us how many mouths you're feeding and we'll handle the rest.</p>
      <a href="/host" class="cta-btn">Plan your event</a>
    </div>
  </section>

  <section class="section-wrap" aria-labelledby="order-head">
    <div class="section-head">
      <div class="section-eyebrow">Order Now</div>
      <h2 class="section-heading" id="order-head">In-store<br/>or <span class="crave-script">in the app.</span></h2>
      <p class="section-sub">Download the Philly Pretzel Factory app to order ahead, earn rewards, and skip the line. Or walk right into one of our two shops.</p>
      <div class="app-badges" style="margin-top: 24px;">${appStoreBadge()}</div>
    </div>
    <div class="card-grid">${storeCards}</div>
  </section>

  <section class="section-wrap is-tight" aria-labelledby="cup-head">
    <div class="cup-teaser">
      <div class="cup-teaser-seal" aria-hidden="true">10%</div>
      <div>
        <h3 id="cup-head">The Pretzel Cup</h3>
        <p>Weekly sales competition across our 7-Eleven network. The top store takes 10% off their next supply bill. See who's leading this week.</p>
      </div>
      <a href="/cup" class="cta-btn is-ghost">See the leaderboard</a>
    </div>
  </section>
</main>
${footer()}`;
}

// ─── PAGE: DELIVERIES ───────────────────────────────────────────
function renderDeliveries() {
  const territoryBlocks = TERRITORIES.map((t, i) => `
    <article class="card" id="${t.id}" style="padding: 36px 32px;">
      <span class="card-chip">Route ${i + 1}</span>
      <h3 class="card-title" style="font-size: 36px;">${esc(t.name)}</h3>
      <p class="card-sub">${esc(t.tagline)}</p>
      <p class="card-body">${esc(t.detail)}</p>
      <div>
        <p class="card-detail-row" style="margin: 0 0 10px;"><strong>Towns</strong></p>
        <div class="pill-row">${t.towns.map(x => `<span class="pill">${esc(x)}</span>`).join('')}</div>
      </div>
      <div>
        <p class="card-detail-row" style="margin: 0 0 10px;"><strong>ZIPs</strong></p>
        <div class="pill-row">${t.zips.map(x => `<span class="pill is-accent">${esc(x)}</span>`).join('')}</div>
      </div>
      <p class="card-detail-row"><strong>Standing Stops</strong>${t.stops}+</p>
    </article>`).join('');

  return `${head('Deliveries — Philly Pretzel Factory', 'Three delivery territories across Nassau County — Franklin Square, Rockville Centre, and the South Shore.')}
${header('deliveries')}
<main id="main">
  <section class="hero">
    <div>
      <div class="hero-eyebrow">Daily Delivery · Nassau County</div>
      <h1>We bring<br/>the <span class="crave-script">crave.</span></h1>
      <p class="hero-sub">Three routes cover shops, offices, 7-Elevens, schools, and event venues across Nassau County. <strong>Standing orders delivered same-morning, new accounts next-day.</strong></p>
      <div class="hero-cta-row">
        <a href="mailto:orders@phillypretzelfactory.com?subject=Delivery%20inquiry" class="cta-btn">Request Delivery</a>
        <a href="/order" class="cta-btn is-ghost">Prefer to visit?</a>
      </div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="hero-art-img" style="background-image:url('/products/images/mini-dogs-and-rivets-party-tray.jpg')"></div>
    </div>
  </section>

  ${marquee()}

  <section class="section-wrap">
    <div class="section-head">
      <div class="section-eyebrow">Three Routes</div>
      <h2 class="section-heading">Pick <span class="crave-script">your</span> territory.</h2>
      <p class="section-sub">Each route runs daily. Jump below for towns served, ZIPs covered, and how to get on the standing-delivery list.</p>
    </div>
    <div class="card-grid">${territoryBlocks}</div>
  </section>

  <section class="callout">
    <div class="callout-inner">
      <h2>Not on the <span class="white">route?</span></h2>
      <p>If you're outside these towns, email us. Big orders, schools, and standing accounts stretch our map all the time.</p>
      <a class="cta-btn" href="mailto:orders@phillypretzelfactory.com?subject=Off-route%20delivery%20inquiry">Email the team</a>
    </div>
  </section>
</main>
${footer()}`;
}

// ─── PAGE: PARTNERS ─────────────────────────────────────────────
function renderPartners() {
  const schoolCards = PARTNERS.schools.map(s => `
    <article class="card">
      <span class="card-chip">School Partner</span>
      <h3 class="card-title">${esc(s.name)}</h3>
      <p class="card-body" style="opacity:0.6;">${esc(s.note)}</p>
    </article>`).join('');

  return `${head('Partners — Philly Pretzel Factory', 'Proudly serving UBS Arena, local schools, and community partners across Nassau County.')}
${header('partners')}
<main id="main">
  <section class="hero">
    <div>
      <div class="hero-eyebrow">Partners · ${PARTNERS.schools.length + 1} and Counting</div>
      <h1>Proudly<br/><span class="crave-script">serving.</span></h1>
      <p class="hero-sub">Arenas, schools, offices, and events across the island. <strong>If you're hosting the room, we're baking the pretzels.</strong></p>
      <div class="hero-cta-row">
        <a href="mailto:partners@phillypretzelfactory.com?subject=Partnership%20inquiry" class="cta-btn">Become a Partner</a>
      </div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="hero-art-img" style="background-image:url('/products/images/pretzels.jpg')"></div>
    </div>
  </section>

  ${marquee()}

  <section class="section-wrap">
    <div class="section-head">
      <div class="section-eyebrow">Featured Partner</div>
      <h2 class="section-heading">${esc(PARTNERS.anchor.name)}</h2>
      <p class="section-sub">${esc(PARTNERS.anchor.detail)}</p>
    </div>
    <article class="card is-featured" style="padding: 48px 40px;">
      <span class="card-chip">${esc(PARTNERS.anchor.role)}</span>
      <h3 class="card-title" style="font-size: 40px;">${esc(PARTNERS.anchor.name)}</h3>
      <p class="card-body" style="font-size: 16px;">${esc(PARTNERS.anchor.detail)}</p>
      <p class="card-sub">New York Islanders · Belmont Park, Elmont, NY</p>
    </article>
  </section>

  <section class="section-wrap" style="background: var(--bg-2);">
    <div class="section-head">
      <div class="section-eyebrow">School Partners</div>
      <h2 class="section-heading">In the <span class="crave-script">cafeteria.</span></h2>
      <p class="section-sub">We work with schools on weekly deliveries and fundraiser programs. Full partner names coming soon — this list backfills as we confirm each one.</p>
    </div>
    <div class="card-grid">${schoolCards}</div>
  </section>

  <section class="callout">
    <div class="callout-inner">
      <h2>Want pretzels on<br/>your <span class="white">roster?</span></h2>
      <p>Arenas, schools, offices, community events — we scale from one tray to thousands. Let's talk.</p>
      <a class="cta-btn" href="mailto:partners@phillypretzelfactory.com?subject=Partnership%20inquiry">Start a conversation</a>
    </div>
  </section>
</main>
${footer()}`;
}

// ─── PAGE: HOST ────────────────────────────────────────────────
function renderHost() {
  const trayCards = PARTY_TRAYS.map(t => `
    <a class="tile" href="/products/${t.slug}" aria-label="${esc(t.name)}">
      <span class="tile-bg is-fill" style="background-image:url('/products/images/${t.slug}.jpg')"></span>
      <span class="tile-overlay"></span>
      <span class="tile-content">
        <span class="tile-count">${esc(t.serves)}</span>
        <h3 class="tile-name">${esc(t.name)}</h3>
      </span>
    </a>`).join('');

  return `${head('Host a Party or Event — Philly Pretzel Factory', 'Party trays and event catering from Philly Pretzel Factory — from classroom-size to arena-size.')}
${header('host')}
<main id="main">
  <section class="hero">
    <div>
      <div class="hero-eyebrow">Parties · Events · Fundraisers</div>
      <h1>Hosting?<br/>We're <span class="crave-script">catering.</span></h1>
      <p class="hero-sub">Birthday parties, grad nights, team meetings, fundraisers, game-day spreads. <strong>Tell us the headcount and the day, we'll handle the trays.</strong></p>
      <div class="hero-cta-row">
        <a href="mailto:events@phillypretzelfactory.com?subject=Event%20catering%20inquiry" class="cta-btn">Email the team</a>
        <a href="tel:+15165057437" class="cta-btn is-ghost">Call us</a>
      </div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="hero-art-img" style="background-image:url('/products/images/pretzel-poppers-party-tray.jpg')"></div>
      <div class="hero-art-stamp"><span><strong>SCALES</strong>25 to 2,500</span></div>
    </div>
  </section>

  ${marquee()}

  <section class="section-wrap">
    <div class="section-head">
      <div class="section-eyebrow">Party Trays</div>
      <h2 class="section-heading">Pick a <span class="crave-script">tray.</span></h2>
      <p class="section-sub">Our six party trays. Mix-and-match dips to taste. Need a different size? Just ask — custom trays are our favorite kind of order.</p>
    </div>
    <div class="tile-grid">${trayCards}</div>
  </section>

  <section class="section-wrap" style="background: var(--bg-2);">
    <div class="section-head">
      <div class="section-eyebrow">How It Works</div>
      <h2 class="section-heading">Three <span class="crave-script">steps.</span></h2>
    </div>
    <div class="card-grid">
      <article class="card">
        <span class="card-chip">01</span>
        <h3 class="card-title">Tell us</h3>
        <p class="card-body">Email or call with your date, headcount, and venue. We'll suggest the right trays.</p>
      </article>
      <article class="card">
        <span class="card-chip">02</span>
        <h3 class="card-title">We bake</h3>
        <p class="card-body">Everything is twisted and baked the morning of your event. No day-old trays, ever.</p>
      </article>
      <article class="card">
        <span class="card-chip">03</span>
        <h3 class="card-title">We deliver</h3>
        <p class="card-body">We drop off within our three delivery territories, or you can pick up from Franklin Square or Lynbrook.</p>
      </article>
    </div>
  </section>

  <section class="callout">
    <div class="callout-inner">
      <h2>Ready when <span class="white">you are.</span></h2>
      <p>Give us 48 hours notice for standard trays, a week for anything big. Short notice? Call — we've pulled off miracles before.</p>
      <a class="cta-btn" href="mailto:events@phillypretzelfactory.com?subject=Event%20catering%20inquiry">Request a quote</a>
    </div>
  </section>
</main>
${footer()}`;
}

// ─── PAGE: ORDER ────────────────────────────────────────────────
function renderOrder() {
  const storeCards = STORES.map(s => `
    <article class="card" id="${s.id}" style="padding: 40px 32px;">
      <span class="card-chip">Store Location</span>
      <h3 class="card-title" style="font-size: 36px;">${esc(s.name)}</h3>
      <p class="card-body" style="font-size: 15px;">${esc(s.address)}</p>
      <div>
        <p class="card-detail-row" style="margin: 0 0 6px;"><strong>Phone</strong><a href="tel:${s.phone.replace(/\D/g, '')}">${esc(s.phone)}</a></p>
        ${s.hours.map(h => `<p class="card-detail-row" style="margin: 0 0 6px;"><strong>${esc(h.days)}</strong>${esc(h.time)}</p>`).join('')}
      </div>
      <p class="card-body" style="font-size: 13px; color: var(--ink-3);">${esc(s.note)}</p>
      <div class="card-cta pill-row">
        <a class="cta-btn" href="${APP_STORE_URL}" target="_blank" rel="noopener">Order in the App</a>
        <a class="cta-btn is-ghost" href="tel:${s.phone.replace(/\D/g, '')}">Call Store</a>
        <a class="cta-btn is-ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}" target="_blank" rel="noopener">Get Directions</a>
      </div>
    </article>`).join('');

  return `${head('Order — Philly Pretzel Factory', 'Order fresh pretzels from Philly Pretzel Factory via the app or at our Franklin Square and Lynbrook locations.')}
${header(null)}
<main id="main">
  <section class="hero">
    <div>
      <div class="hero-eyebrow">In-Store · In the App</div>
      <h1>Order up.<br/>Fresh in <span class="crave-script">minutes.</span></h1>
      <p class="hero-sub">Download the app to order ahead, earn rewards, and skip the line. Or walk right in — <strong>Franklin Square and Lynbrook, open 7 days a week.</strong></p>
      <div class="app-badges" style="margin-top: 24px;">${appStoreBadge()}</div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="hero-art-img" style="background-image:url('/products/images/pretzel-twist.jpg')"></div>
    </div>
  </section>

  ${marquee()}

  <section class="section-wrap">
    <div class="section-head">
      <div class="section-eyebrow">Two Shops</div>
      <h2 class="section-heading">Walk in. <span class="crave-script">Snack</span> out.</h2>
      <p class="section-sub">Both locations bake all day. Call ahead for big orders. Open seven days a week.</p>
    </div>
    <div class="card-grid">${storeCards}</div>
  </section>

  <section class="section-wrap is-tight" style="background: var(--bg-2);">
    <div class="section-head" style="margin-bottom: 24px;">
      <div class="section-eyebrow">On the App</div>
      <h2 class="section-heading" style="font-size: clamp(32px, 5vw, 56px);">Order ahead. <span class="crave-script">Earn free pretzels.</span></h2>
      <p class="section-sub">The Philly Pretzel Factory app lets you place pickup orders and stack rewards toward free trays. Install it once, use it forever.</p>
    </div>
    <div class="app-badges">${appStoreBadge()}</div>
  </section>

  <section class="callout">
    <div class="callout-inner">
      <h2>Big order? <span class="white">Big event?</span></h2>
      <p>Trays over 25 or anything beyond a walk-in snack belongs on the catering page. Faster to get what you need.</p>
      <a class="cta-btn" href="/host">Head to the Host page</a>
    </div>
  </section>
</main>
${footer()}`;
}

// ─── WRITE ─────────────────────────────────────────────────────
function writePage(subpath, html) {
  const dir = subpath === '' ? ROOT : join(ROOT, subpath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  return file;
}

const outs = [
  writePage('',             renderHome()),
  writePage('deliveries',   renderDeliveries()),
  writePage('partners',     renderPartners()),
  writePage('host',         renderHost()),
  writePage('order',        renderOrder()),
];
console.log('Wrote:\n  ' + outs.join('\n  '));
