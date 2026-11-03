// Wholesale 100-for-25 promo math.
//
// Rule: every full 100 units of a pretzel SKU adds 25 of the SAME SKU
// as a $0 bonus line. Stackable per SKU (200 → 50 free, 300 → 75,
// etc.). SKUs across different pretzel styles each get their own
// bonus; dips, trays, and shakers do not participate.
//
// This module is the SINGLE source of truth. The browser renders an
// informational preview; the submit handler calls applyBonus() with
// product rows pulled from the DB and the authoritative line items it
// then hands to Stripe Checkout.
//
// Inputs (both from DB):
//   products: Array<{ sku, name, unit_price_cents }>
//   lines:    Array<{ sku, qty }>   (qty must be a positive integer)
//
// Output: {
//   items:          Array<{ sku, name, qty, unit_price_cents, line_total_cents, is_bonus }>,
//   subtotal_cents: int,   // billed lines
//   discount_cents: int,   // retail value of bonus units (bonus_qty * SKU unit price)
//   total_cents:    int,   // what the customer pays (= subtotal_cents under this scheme)
// }
//
// Why discount_cents is informational: the bonus is modelled as a $0
// LINE, not a Stripe coupon, so the customer sees "+25 Wrapped Pretzel
// — free" on their receipt and the reporting layer can split retail vs
// discount by promo code.

const PRETZEL_SKUS = new Set(['pretzel-unwrapped', 'pretzel-wrapped', 'twist-wrapped']);
const BONUS_PER = 25;
const BONUS_THRESHOLD = 100;

function applyBonus({ products, lines }) {
  if (!Array.isArray(products) || !Array.isArray(lines)) {
    throw new Error('promo.applyBonus: products and lines must be arrays');
  }
  const bySku = new Map();
  for (const p of products) {
    if (!p || typeof p.sku !== 'string') continue;
    bySku.set(p.sku, p);
  }
  const items = [];
  let subtotal_cents = 0;
  let discount_cents = 0;
  for (const l of lines) {
    const p = bySku.get(l && l.sku);
    const qty = Number.isFinite(l && l.qty) ? Math.floor(l.qty) : NaN;
    if (!p || !(qty > 0)) continue;
    const line_total = qty * p.unit_price_cents;
    items.push({
      sku: p.sku,
      name: p.name,
      qty,
      unit_price_cents: p.unit_price_cents,
      line_total_cents: line_total,
      is_bonus: false,
    });
    subtotal_cents += line_total;
    if (PRETZEL_SKUS.has(p.sku)) {
      const packs = Math.floor(qty / BONUS_THRESHOLD);
      if (packs > 0) {
        const bonus_qty = packs * BONUS_PER;
        items.push({
          sku: p.sku,
          name: p.name,
          qty: bonus_qty,
          unit_price_cents: 0,
          line_total_cents: 0,
          is_bonus: true,
        });
        discount_cents += bonus_qty * p.unit_price_cents;
      }
    }
  }
  return { items, subtotal_cents, discount_cents, total_cents: subtotal_cents };
}

module.exports = { applyBonus, PRETZEL_SKUS, BONUS_PER, BONUS_THRESHOLD };
