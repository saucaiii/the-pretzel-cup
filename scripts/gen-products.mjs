// Generates pretzel-cup/products/index.html and 32 /products/{slug}.html files
// from the product catalog defined below. Run with: node gen-products.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '/Users/chris/pretzel-cup/products';
mkdirSync(OUT, { recursive: true });

const CATEGORIES = [
  { id: 'pretzels',    name: 'Pretzels',         blurb: 'Hand-twisted and fresh-baked. Still the backbone of every order.' },
  { id: 'party-trays', name: 'Party Trays',      blurb: 'Built to feed a room. Rivets, mini dogs, poppers &mdash; take your pick.' },
  { id: 'specialty',   name: 'Specialty Items',  blurb: 'Pretzel wrapped around everything that belongs in a pretzel.' },
  { id: 'drinks',      name: 'Drinks',           blurb: 'Keep the salt moving. Available at select locations.' },
  { id: 'dips',        name: 'Dips',             blurb: 'Fourteen flavors. One pretzel. Do the math.' },
];

// Order within a category sets the sequence on the page. Keeping it faithful
// to the source menu's own ordering.
const PRODUCTS = [
  // ───── Pretzels ─────
  { slug: 'pretzels',          category: 'pretzels', name: 'Pretzels',        description: 'Hand-twisted and fresh-baked.', note: '' },
  { slug: 'pretzel-twist',     category: 'pretzels', name: 'Pretzel Twist',   description: 'Hand-twisted and fresh-baked.', note: '' },
  { slug: 'mini-pretzels',     category: 'pretzels', name: 'Mini Pretzels',   description: 'Tiny version of the classic pretzel.', note: 'Not available at all stores.' },
  { slug: 'crowd-pleaser',     category: 'pretzels', name: 'The Crowd Pleaser', description: '25 soft pretzels and a bottle of mustard.', note: '' },

  // ───── Party Trays ─────
  { slug: 'pretzel-poppers-party-tray',  category: 'party-trays', name: 'Pretzel Poppers Party Tray', description: '30 bite-sized poppers stuffed with seasoned beef and cheese.', note: '' },
  { slug: 'large-rivet-party-tray',      category: 'party-trays', name: 'Large Rivet Party Tray',     description: 'Rivets with any 3 dips. Serves about 20&ndash;25.', note: '' },
  { slug: 'all-mini-dogs-party-tray',    category: 'party-trays', name: 'All Mini Dogs Party Tray',   description: 'Mini all-beef pretzel dogs with any 2 dips. Serves about 20&ndash;25.', note: '' },
  { slug: 'small-rivet-party-tray',      category: 'party-trays', name: 'Small Rivet Party Tray',     description: 'Rivets with any 2 dips. Serves about 10&ndash;15.', note: '' },
  { slug: 'mini-dogs-and-rivets-party-tray', category: 'party-trays', name: 'Mini Dogs & Rivets Party Tray', description: 'Mini pretzel dogs and rivets with any 2 dips. Serves about 20&ndash;25.', note: '' },

  // ───── Specialty Items ─────
  { slug: 'cinnamon-rivet-shaker', category: 'specialty', name: 'Cinnamon Rivet Shaker', description: 'Rivets coated in cinnamon sugar, with 1 small dip.', note: '' },
  { slug: 'pretzel-poppers',       category: 'specialty', name: 'Pretzel Poppers',       description: '3 poppers stuffed with beef and cheese, in a grab-and-go box.', note: '' },
  { slug: 'pretzel-dog',           category: 'specialty', name: 'Pretzel Dog',           description: 'A pretzel wrapped around an all-beef hot dog and American cheese.', note: '' },
  { slug: 'rivet-shaker',          category: 'specialty', name: 'Rivet Shaker',          description: '9 rivets in a shaker cup, with 1 small dip.', note: '' },
  { slug: 'spicy-pretzel-sausage', category: 'specialty', name: 'Spicy Pretzel Sausage', description: 'Spicy sausage and American cheese wrapped in a pretzel.', note: '' },
  { slug: 'pepperoni-melt',        category: 'specialty', name: 'Pepperoni Melt',        description: 'Cheese and pepperoni on a pretzel, served with marinara.', note: '' },
  { slug: 'rivet-bucket',          category: 'specialty', name: 'Rivet Bucket',          description: 'Rivets for about 5&ndash;6 guests.', note: '' },

  // ───── Drinks ─────
  { slug: 'coke-beverages', category: 'drinks', name: 'Coke Beverages', description: '20 oz bottle.', note: 'Available at select locations.' },
  { slug: 'frozen-drinks',  category: 'drinks', name: 'Frozen Drinks',  description: '16 oz frozen drink.', note: 'Available at select locations.' },

  // ───── Dips ─────
  { slug: 'cookies-and-cream',      category: 'dips', name: 'Cookies and Cream',      description: 'Vanilla dip with chocolate cookie bits.', note: 'Limited time.' },
  { slug: 'strawberries-and-cream', category: 'dips', name: 'Strawberries and Cream', description: 'Strawberry-flavored dip.', note: 'Limited time.' },
  { slug: 'cotton-candy',           category: 'dips', name: 'Cotton Candy',           description: 'Cotton candy-flavored dip.', note: 'Limited time.' },
  { slug: 'butter-cream-frosting',  category: 'dips', name: 'Butter Cream Frosting',  description: 'Vanilla frosting-style dip.', note: '' },
  { slug: 'nacho-cheese',           category: 'dips', name: 'Nacho Cheese',           description: 'Mildly spicy cheddar dip.', note: '' },
  { slug: 'melted-cheddar-cheese',  category: 'dips', name: 'Melted Cheddar Cheese',  description: 'Savory cheddar dip.', note: '' },
  { slug: 'cinnamon',               category: 'dips', name: 'Cinnamon',               description: 'Buttery cinnamon sugar dip.', note: '' },
  { slug: 'cream-cheese',           category: 'dips', name: 'Cream Cheese',           description: 'Tangy cream cheese dip.', note: '' },
  { slug: 'brownie-batter',         category: 'dips', name: 'Brownie Batter',         description: 'Fudgy chocolate dip.', note: '' },
  { slug: 'marinara',               category: 'dips', name: 'Marinara',               description: 'Tomato sauce with garlic and herbs.', note: '' },
  { slug: 'super-hot-mustard',      category: 'dips', name: 'Super Hot Mustard',      description: 'Very spicy mustard.', note: '' },
  { slug: 'spicy-brown-mustard',    category: 'dips', name: 'Spicy Brown Mustard',    description: 'Grainy mustard with a warm kick.', note: '' },
  { slug: 'honey-mustard',          category: 'dips', name: 'Honey Mustard',          description: 'Sweet and tangy mustard.', note: '' },
  { slug: 'yellow-mustard',         category: 'dips', name: 'Yellow Mustard',         description: 'Classic tangy mustard.', note: '' },
];

// Verify counts match the source menu (32 products across 5 categories).
if (PRODUCTS.length !== 32) throw new Error('Expected 32 products, got ' + PRODUCTS.length);
for (const p of PRODUCTS) {
  if (!CATEGORIES.find(c => c.id === p.category)) throw new Error('Unknown category on ' + p.slug);
}

// Shared CSS block — mirrors the design tokens from index.html so the products
// pages feel like one site. Any token change here should be mirrored in index.html.
const SHARED_CSS = `
:root {
  --ppf-green: #0D5237;
  --ppf-green-deep: #083521;
  --ppf-green-light: #126b48;
  --ppf-gold-light: #F2E7A4;
  --ppf-gold:       #D4B662;
  --ppf-gold-deep:  #B2872F;
  --ppf-black: #000000;
  --ppf-white: #FFFFFF;
  --bg: var(--ppf-green);
  --bg-2: var(--ppf-green-deep);
  --bg-3: var(--ppf-green-light);
  --line: rgba(255, 255, 255, 0.12);
  --line-2: rgba(255, 255, 255, 0.22);
  --ink: var(--ppf-white);
  --ink-2: rgba(255, 255, 255, 0.78);
  --ink-3: rgba(255, 255, 255, 0.55);
  --accent: var(--ppf-gold);
  --accent-2: var(--ppf-gold-light);
  --display: 'Anton', 'Bebas Neue', 'Arial Black', sans-serif;
  --body: 'Inter', 'Helvetica Neue', system-ui, sans-serif;
  --script: 'Caveat', 'Brush Script MT', cursive;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--body);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  min-height: 100dvh;
}
a { color: var(--accent); text-decoration: none; transition: color 150ms ease; }
a:hover { color: var(--accent-2); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; border-radius: 2px; }
.skip-link { position: absolute; left: -9999px; top: 0; background: var(--accent); color: var(--ppf-black); padding: 12px 16px; font-weight: 700; z-index: 1000; border-radius: var(--radius-sm); font-family: var(--display); letter-spacing: 0.04em; text-transform: uppercase; }
.skip-link:focus-visible { left: 8px; top: 8px; }

.diamond-strip {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 64px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 64' width='80' height='64'><g fill='%23ffffff' opacity='0.32'><path d='M5 4 L18 0 L13 12 L0 16 Z'/><path d='M25 4 L38 0 L33 12 L20 16 Z'/><path d='M45 4 L58 0 L53 12 L40 16 Z'/><path d='M65 4 L78 0 L73 12 L60 16 Z'/><path d='M5 24 L18 20 L13 32 L0 36 Z'/><path d='M25 24 L38 20 L33 32 L20 36 Z'/><path d='M45 24 L58 20 L53 32 L40 36 Z'/><path d='M65 24 L78 20 L73 32 L60 36 Z'/><path d='M5 44 L18 40 L13 52 L0 56 Z'/><path d='M25 44 L38 40 L33 52 L20 56 Z'/><path d='M45 44 L58 40 L53 52 L40 56 Z'/><path d='M65 44 L78 40 L73 52 L60 56 Z'/></g></svg>");
  background-repeat: repeat-x;
  background-size: 80px 64px;
  pointer-events: none;
  z-index: 1;
}

.header-wrap { position: relative; background: var(--ppf-green); border-bottom: 1px solid var(--line); }
.header {
  position: relative; z-index: 2;
  padding: 80px 24px 24px;
  max-width: 1280px;
  margin: 0 auto;
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: 16px; font-family: var(--display); font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase; }
.brand a { color: var(--ink); }
.brand a:hover { color: var(--ink); }
.brand-logo { width: 64px; height: 57px; display: block; flex-shrink: 0; }
@media (min-width: 600px) { .brand-logo { width: 80px; height: 71px; } }
.brand-text { display: flex; flex-direction: column; line-height: 1; }
.brand-text .top { font-size: 11px; letter-spacing: 0.18em; opacity: 0.7; font-family: var(--body); font-weight: 600; margin-bottom: 6px; }
.brand-text .bot { font-size: 24px; letter-spacing: 0.02em; }

.nav-cluster { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.site-nav { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.nav-link {
  display: inline-flex; align-items: center;
  padding: 10px 12px;
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-2);
  background: transparent;
  font-family: var(--display);
  font-weight: 400;
}
.nav-link:hover { color: var(--ink); background: rgba(0,0,0,0.2); text-decoration: none; }
.nav-link.is-active { color: var(--ppf-black); background: var(--accent); }
.nav-link.is-active:hover { color: var(--ppf-black); background: var(--accent-2); }
.cta-btn {
  display: inline-flex; align-items: center;
  padding: 11px 18px;
  background: var(--accent); color: var(--ppf-black);
  border-radius: 999px;
  font-family: var(--display);
  font-size: 12px; letter-spacing: 0.14em;
  text-transform: uppercase;
  transition: background 160ms ease, transform 160ms ease;
}
.cta-btn:hover { background: var(--accent-2); color: var(--ppf-black); text-decoration: none; transform: translateY(-1px); }
.cta-btn.is-ghost { background: transparent; color: var(--ink-2); border: 1px solid var(--line-2); }
.cta-btn.is-ghost:hover { background: rgba(0,0,0,0.2); color: var(--ink); border-color: var(--accent); }

/* HERO (menu landing) */
.menu-hero { padding: 56px 24px 32px; max-width: 1280px; margin: 0 auto; }
.hero-eyebrow { font-family: var(--display); font-size: 13px; letter-spacing: 0.22em; color: var(--accent); margin-bottom: 20px; text-transform: uppercase; }
.menu-hero h1 { font-family: var(--display); font-weight: 400; font-size: clamp(56px, 10vw, 120px); line-height: 0.88; letter-spacing: 0.005em; margin: 0 0 24px; text-transform: uppercase; text-wrap: balance; }
.menu-hero h1 .fresh-script { font-family: var(--script); text-transform: none; font-size: clamp(56px, 10vw, 120px); font-weight: 700; color: var(--accent); letter-spacing: -0.01em; display: inline-block; transform: rotate(-3deg); margin: 0 4px; line-height: 1; }
.hero-sub { font-size: 18px; color: var(--ink-2); max-width: 60ch; margin: 0 0 28px; line-height: 1.5; }
.hero-sub strong { color: var(--ink); font-weight: 700; }
.hero-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.hero-chip {
  display: inline-flex; align-items: center; padding: 10px 16px;
  border: 1px solid var(--line-2); border-radius: 999px;
  font-family: var(--display); font-size: 13px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink-2); background: rgba(0,0,0,0.2);
}
.hero-chip:hover { border-color: var(--accent); color: var(--ink); text-decoration: none; }
.hero-chip-count { color: var(--accent); margin-left: 8px; font-variant-numeric: tabular-nums; }

/* CATEGORY SECTIONS */
.cat-section { padding: 32px 24px 56px; max-width: 1280px; margin: 0 auto; border-top: 1px solid var(--line); }
.cat-section:first-of-type { border-top: none; padding-top: 0; }
.cat-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 16px; margin-bottom: 28px; }
.cat-title { font-family: var(--display); font-weight: 400; font-size: clamp(40px, 6vw, 72px); line-height: 0.95; letter-spacing: 0.01em; margin: 0; text-transform: uppercase; }
.cat-sub { color: var(--ink-2); font-size: 15px; max-width: 48ch; margin: 0; }

.product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px; }
.product-card {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: transform 220ms ease, border-color 220ms ease, box-shadow 220ms ease;
  display: flex; flex-direction: column;
  color: var(--ink);
}
.product-card:hover { transform: translateY(-4px); border-color: var(--accent); box-shadow: 0 16px 32px -16px rgba(0, 0, 0, 0.6); text-decoration: none; }
@media (prefers-reduced-motion: reduce) { .product-card { transition: none; } .product-card:hover { transform: none; } }
.product-card-img {
  width: 100%; aspect-ratio: 1 / 1;
  background: var(--ppf-white) center/cover no-repeat;
  display: block;
}
.product-card-body { padding: 18px 20px 22px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.product-card-name { font-family: var(--display); font-size: 20px; letter-spacing: 0.02em; line-height: 1.1; margin: 0; text-transform: uppercase; text-wrap: balance; }
.product-card-desc { font-size: 13px; color: var(--ink-2); margin: 0; line-height: 1.45; }
.product-card-note { font-size: 11px; color: var(--accent); margin: 4px 0 0; font-weight: 600; letter-spacing: 0.04em; }

/* PRODUCT DETAIL */
.detail-wrap { padding: 48px 24px 80px; max-width: 1120px; margin: 0 auto; }
.breadcrumbs { font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 32px; font-family: var(--display); }
.breadcrumbs a { color: var(--ink-3); }
.breadcrumbs a:hover { color: var(--accent); text-decoration: none; }
.breadcrumbs .sep { opacity: 0.5; margin: 0 10px; }

.detail-grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 48px; align-items: start; }
@media (max-width: 820px) { .detail-grid { grid-template-columns: 1fr; gap: 32px; } }
.detail-image {
  width: 100%; aspect-ratio: 1 / 1;
  background: var(--ppf-white) center/cover no-repeat;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  overflow: hidden;
}
.detail-info { padding-top: 8px; }
.detail-cat-chip {
  display: inline-flex; align-items: center;
  padding: 6px 12px;
  border: 1px solid var(--line-2); border-radius: 999px;
  font-family: var(--display); font-size: 11px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--accent);
  margin-bottom: 20px;
}
.detail-name { font-family: var(--display); font-weight: 400; font-size: clamp(48px, 6vw, 80px); line-height: 0.95; letter-spacing: 0.01em; margin: 0 0 16px; text-transform: uppercase; text-wrap: balance; }
.detail-desc { font-size: 19px; color: var(--ink); line-height: 1.5; margin: 0 0 20px; max-width: 42ch; }
.detail-note {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 12px 18px;
  background: rgba(212, 182, 98, 0.1);
  border: 1px solid rgba(212, 182, 98, 0.3);
  border-radius: var(--radius-md);
  color: var(--accent-2);
  font-size: 13px; font-weight: 600;
  margin: 0 0 32px;
}
.detail-cta-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.detail-cta {
  display: inline-flex; align-items: center;
  padding: 14px 24px;
  background: var(--accent); color: var(--ppf-black);
  border-radius: var(--radius-sm);
  font-family: var(--display); font-size: 13px; letter-spacing: 0.14em;
  text-transform: uppercase; font-weight: 400;
}
.detail-cta:hover { background: var(--accent-2); text-decoration: none; }
.detail-cta.is-ghost { background: transparent; color: var(--ink-2); border: 1px solid var(--line-2); }
.detail-cta.is-ghost:hover { color: var(--ink); border-color: var(--accent); background: rgba(0,0,0,0.2); }

.related-section { max-width: 1280px; margin: 0 auto; padding: 48px 24px 80px; border-top: 1px solid var(--line); }
.related-head { font-family: var(--display); font-size: 13px; letter-spacing: 0.22em; color: var(--accent); margin-bottom: 12px; text-transform: uppercase; }
.related-title { font-family: var(--display); font-weight: 400; font-size: clamp(32px, 5vw, 56px); line-height: 0.95; margin: 0 0 28px; text-transform: uppercase; }

/* FOOTER */
.footer { background: var(--ppf-green-deep); border-top: 1px solid var(--line); padding: 48px 24px 36px; text-align: center; }
.footer-tagline { font-family: var(--display); font-size: 36px; color: var(--ink); letter-spacing: 0.04em; margin-bottom: 10px; text-transform: uppercase; }
.footer-tagline sup { font-size: 0.4em; margin-left: 2px; vertical-align: super; }
.footer-meta { font-size: 11px; color: var(--ink-3); font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; font-family: var(--display); }
`;

const SHARED_HEAD = (title, description) => `<!DOCTYPE html>
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
<style>${SHARED_CSS}</style>
</head>
<body>`;

const SHARED_HEADER = (activePage) => `
<a href="#main" class="skip-link">Skip to content</a>
<div class="header-wrap">
  <div class="diamond-strip" aria-hidden="true"></div>
  <header class="header">
    <div class="brand" translate="no">
      <a href="/" aria-label="Philly Pretzel Factory home" style="display:flex;align-items:center;gap:16px;">
        <img src="/ppf-logo.jpg" alt="" class="brand-logo" width="80" height="71" fetchpriority="high" />
        <span class="brand-text">
          <span class="top">Philly Pretzel Factory</span>
          <span class="bot">Made To Crave</span>
        </span>
      </a>
    </div>
    <div class="nav-cluster">
      <nav class="site-nav" aria-label="Primary">
        <a href="/products" class="nav-link${activePage === 'products' ? ' is-active' : ''}">Products</a>
        <a href="/deliveries" class="nav-link${activePage === 'deliveries' ? ' is-active' : ''}">Deliveries</a>
        <a href="/partners" class="nav-link${activePage === 'partners' ? ' is-active' : ''}">Partners</a>
        <a href="/host" class="nav-link${activePage === 'host' ? ' is-active' : ''}">Host</a>
        <a href="/cup" class="nav-link${activePage === 'cup' ? ' is-active' : ''}">The Cup</a>
      </nav>
      <a href="/order" class="cta-btn">Order Now</a>
    </div>
  </header>
</div>`;

const SHARED_FOOTER = `
<footer class="footer">
  <div class="footer-tagline" translate="no">Made&nbsp;to&nbsp;Crave<sup>&reg;</sup></div>
  <p class="footer-meta">Philly Pretzel Factory &middot; The Pretzel Cup &middot; Fresh every morning</p>
</footer>
</body>
</html>
`;

function esc(s) {
  return String(s).replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);)/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Light-pass escaper: leaves HTML entities (&mdash;, &ndash;, etc.) alone.
function escKeepEntities(s) { return String(s); }

// ─── INDEX PAGE (/products) ───
function renderIndex() {
  const sections = CATEGORIES.map(cat => {
    const items = PRODUCTS.filter(p => p.category === cat.id);
    const cards = items.map(p => `
      <a class="product-card" href="/products/${p.slug}" aria-label="${esc(p.name)}">
        <span class="product-card-img" role="img" aria-label="${esc(p.name)}" style="background-image:url('/products/images/${p.slug}.jpg')"></span>
        <div class="product-card-body">
          <h3 class="product-card-name">${escKeepEntities(p.name)}</h3>
          <p class="product-card-desc">${escKeepEntities(p.description)}</p>
          ${p.note ? `<p class="product-card-note">${escKeepEntities(p.note)}</p>` : ''}
        </div>
      </a>`).join('');
    return `
    <section class="cat-section" id="${cat.id}" aria-labelledby="${cat.id}-heading">
      <div class="cat-head">
        <h2 class="cat-title" id="${cat.id}-heading">${escKeepEntities(cat.name)}</h2>
        <p class="cat-sub">${escKeepEntities(cat.blurb)}</p>
      </div>
      <div class="product-grid">${cards}</div>
    </section>`;
  }).join('');

  const chips = CATEGORIES.map(cat => {
    const count = PRODUCTS.filter(p => p.category === cat.id).length;
    return `<a class="hero-chip" href="#${cat.id}">${escKeepEntities(cat.name)}<span class="hero-chip-count">${count}</span></a>`;
  }).join('');

  return `${SHARED_HEAD('The Menu — The Pretzel Cup', 'Every pretzel, party tray, specialty item, drink, and dip in the Philly Pretzel Factory lineup.')}
${SHARED_HEADER('products')}
<main id="main">
  <section class="menu-hero">
    <div class="hero-eyebrow">The Menu &middot; ${PRODUCTS.length} Items</div>
    <h1>Fresh.<br/>Hand-twisted.<br/><span class="fresh-script">Still warm.</span></h1>
    <p class="hero-sub">Everything the 7-Eleven network is moving. <strong>Pretzels, trays, specialty items, drinks, dips.</strong> Tap any one to see the full details.</p>
    <nav class="hero-chips" aria-label="Jump to category">${chips}</nav>
  </section>
  ${sections}
</main>
${SHARED_FOOTER}`;
}

// ─── DETAIL PAGE (/products/{slug}) ───
function renderDetail(p) {
  const cat = CATEGORIES.find(c => c.id === p.category);
  const related = PRODUCTS.filter(q => q.category === p.category && q.slug !== p.slug).slice(0, 4);
  const relCards = related.map(q => `
    <a class="product-card" href="/products/${q.slug}" aria-label="${esc(q.name)}">
      <span class="product-card-img" role="img" aria-label="${esc(q.name)}" style="background-image:url('/products/images/${q.slug}.jpg')"></span>
      <div class="product-card-body">
        <h3 class="product-card-name">${escKeepEntities(q.name)}</h3>
        <p class="product-card-desc">${escKeepEntities(q.description)}</p>
      </div>
    </a>`).join('');

  // Strip HTML entities for meta description (keeps it readable in SERPs)
  const metaDesc = p.description.replace(/&[a-z]+;|&#\d+;/g, m => m === '&mdash;' ? '—' : m === '&ndash;' ? '–' : '');

  return `${SHARED_HEAD(`${p.name} — The Pretzel Cup`, metaDesc)}
${SHARED_HEADER('products')}
<main id="main">
  <div class="detail-wrap">
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href="/products">Menu</a>
      <span class="sep" aria-hidden="true">/</span>
      <a href="/products#${cat.id}">${escKeepEntities(cat.name)}</a>
      <span class="sep" aria-hidden="true">/</span>
      <span>${escKeepEntities(p.name)}</span>
    </nav>
    <div class="detail-grid">
      <div class="detail-image" role="img" aria-label="${esc(p.name)}" style="background-image:url('/products/images/${p.slug}.jpg')"></div>
      <div class="detail-info">
        <span class="detail-cat-chip">${escKeepEntities(cat.name)}</span>
        <h1 class="detail-name">${escKeepEntities(p.name)}</h1>
        <p class="detail-desc">${escKeepEntities(p.description)}</p>
        ${p.note ? `<p class="detail-note">${escKeepEntities(p.note)}</p>` : ''}
        <div class="detail-cta-row">
          <a href="/order" class="detail-cta">Order Now</a>
          <a href="/products" class="detail-cta is-ghost">Back To Menu</a>
        </div>
      </div>
    </div>
  </div>
  ${related.length ? `
  <section class="related-section" aria-labelledby="related-heading">
    <div class="related-head">More ${escKeepEntities(cat.name)}</div>
    <h2 class="related-title" id="related-heading">You might also crave</h2>
    <div class="product-grid">${relCards}</div>
  </section>` : ''}
</main>
${SHARED_FOOTER}`;
}

// ─── WRITE EVERYTHING ───
writeFileSync(join(OUT, 'index.html'), renderIndex());
let count = 0;
for (const p of PRODUCTS) {
  writeFileSync(join(OUT, `${p.slug}.html`), renderDetail(p));
  count++;
}
console.log(`Wrote ${OUT}/index.html + ${count} detail pages.`);
