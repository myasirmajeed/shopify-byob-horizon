/**
 * Pure cart-offer logic for the Advanced Cart demo: threshold progress, gift
 * reconciliation and upsell ranking. No DOM and no requests, so every rule is
 * derived from the cart JSON Shopify returned.
 * @module acx-offers
 */

/**
 * @typedef {{ id: number, title: string, price: number, compareAtPrice: number | null, available: boolean }} AcxVariant
 * @typedef {{
 *   id: number, title: string, url: string, image: string, imageAlt: string,
 *   available: boolean, hasOnlyDefaultVariant: boolean, variants: AcxVariant[]
 * }} AcxProduct
 * @typedef {{ trigger: number, products: AcxProduct[] }} UpsellRule
 */

export const GIFT_PROPERTY = '_acx_gift';

/**
 * @param {Record<string, any>} item - Cart line
 * @param {number | null} giftProductId
 */
export function isGiftLine(item, giftProductId) {
  return Boolean(item.properties?.[GIFT_PROPERTY]) || (giftProductId !== null && item.product_id === giftProductId);
}

/**
 * Merchandise total that counts toward the gift: every non-gift line after its
 * own discounts, in the cart's (presentment) currency minor units.
 * @param {Record<string, any>} cart
 * @param {number | null} giftProductId
 */
export function qualifyingTotal(cart, giftProductId) {
  return cart.items
    .filter((/** @type {any} */ item) => !isGiftLine(item, giftProductId))
    .reduce((/** @type {number} */ sum, /** @type {any} */ item) => sum + item.final_line_price, 0);
}

/**
 * @param {number} total - Minor units
 * @param {number} threshold - Minor units; 0 disables the offer
 */
export function progress(total, threshold) {
  if (!(threshold > 0)) return { remaining: 0, reached: false, percent: 0 };
  const remaining = Math.max(0, threshold - total);
  return { remaining, reached: remaining === 0, percent: Math.min(100, Math.round((total / threshold) * 100)) };
}

/**
 * Works out which cart changes keep exactly one gift in the cart, and only
 * while the cart qualifies. Returns the operations to apply; an empty list
 * means the cart is already consistent, which is what stops update loops.
 * @param {Record<string, any>} cart
 * @param {{ giftProductId: number | null, threshold: number }} config
 */
export function giftPlan(cart, { giftProductId, threshold }) {
  // The gift the shopper chose in the drawer (marked with the private property)
  // wins over copies added any other way.
  const lines = cart.items
    .filter((/** @type {any} */ item) => isGiftLine(item, giftProductId))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(Boolean(b.properties?.[GIFT_PROPERTY])) - Number(Boolean(a.properties?.[GIFT_PROPERTY])));
  const eligible = threshold > 0 && qualifyingTotal(cart, giftProductId) >= threshold;
  /** @type {{ key: string, quantity: number, reason: 'not-eligible' | 'duplicate' | 'quantity' }[]} */
  const ops = [];
  lines.forEach((/** @type {any} */ line, /** @type {number} */ index) => {
    if (!eligible) ops.push({ key: line.key, quantity: 0, reason: 'not-eligible' });
    else if (index > 0) ops.push({ key: line.key, quantity: 0, reason: 'duplicate' });
    else if (line.quantity !== 1) ops.push({ key: line.key, quantity: 1, reason: 'quantity' });
  });
  return { eligible, line: eligible ? lines[0] ?? null : null, ops };
}

/**
 * Normalizes a product from the Product Recommendations API (`/products/x.js`
 * shape) into the same shape the Liquid JSON uses.
 * @param {Record<string, any>} product
 * @returns {AcxProduct}
 */
export function fromAjaxProduct(product) {
  const image = product.featured_image ? sizedImage(String(product.featured_image), 320) : '';
  return {
    id: product.id,
    title: product.title,
    url: product.url || `/products/${product.handle}`,
    image,
    imageAlt: product.media?.[0]?.alt || product.title,
    available: Boolean(product.available),
    hasOnlyDefaultVariant: product.variants?.length === 1 && product.variants[0].title === 'Default Title',
    variants: (product.variants ?? []).map((/** @type {any} */ variant) => ({
      id: variant.id,
      title: variant.title,
      price: variant.price,
      compareAtPrice: variant.compare_at_price ?? null,
      available: Boolean(variant.available),
    })),
  };
}

/**
 * @param {string} url - Shopify CDN image URL
 * @param {number} width
 */
export function sizedImage(url, width) {
  if (!url) return '';
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  try {
    const parsed = new URL(absolute, window.location.origin);
    parsed.searchParams.set('width', String(width));
    return parsed.toString();
  } catch {
    return absolute;
  }
}

/**
 * Ranks upsells for the current cart: merchant rules for products in the cart
 * (newest line first), then Shopify's related-product recommendations, then the
 * merchant's fallback list. Skips anything already in the cart, dismissed,
 * the gift, and products without an available variant.
 * @param {{
 *   cart: Record<string, any>,
 *   rules: UpsellRule[],
 *   recommended: AcxProduct[],
 *   fallback: AcxProduct[],
 *   dismissed: Set<number>,
 *   giftProductId: number | null,
 *   limit: number,
 * }} input
 * @returns {Array<AcxProduct & { source: 'rule' | 'recommended' | 'fallback' }>}
 */
export function rankUpsells({ cart, rules, recommended, fallback, dismissed, giftProductId, limit }) {
  const inCart = new Set(cart.items.map((/** @type {any} */ item) => item.product_id));
  /** @type {Array<AcxProduct & { source: 'rule' | 'recommended' | 'fallback' }>} */
  const ranked = [];
  const seen = new Set();
  /**
   * @param {AcxProduct} product
   * @param {'rule' | 'recommended' | 'fallback'} source
   */
  const push = (product, source) => {
    if (!product || seen.has(product.id)) return;
    seen.add(product.id);
    if (inCart.has(product.id) || dismissed.has(product.id) || product.id === giftProductId) return;
    if (!product.variants.some((variant) => variant.available)) return;
    ranked.push({ ...product, source });
  };

  if (cart.items.length) {
    for (const item of cart.items) {
      for (const rule of rules) {
        if (rule.trigger === item.product_id) rule.products.forEach((product) => push(product, 'rule'));
      }
    }
    recommended.forEach((product) => push(product, 'recommended'));
    fallback.forEach((product) => push(product, 'fallback'));
  }
  return ranked.slice(0, limit);
}

/**
 * Products whose recommendations are worth fetching: the newest distinct
 * non-gift products in the cart.
 * @param {Record<string, any>} cart
 * @param {number | null} giftProductId
 * @param {number} count
 * @returns {number[]}
 */
export function recommendationSeeds(cart, giftProductId, count = 2) {
  const seeds = [];
  for (const item of cart.items) {
    if (isGiftLine(item, giftProductId) || seeds.includes(item.product_id)) continue;
    seeds.push(item.product_id);
    if (seeds.length === count) break;
  }
  return seeds;
}

/** @param {AcxProduct} product */
export function firstAvailableVariant(product) {
  return product.variants.find((variant) => variant.available) ?? product.variants[0];
}

/**
 * @param {number | undefined} value
 * @param {number} [max]
 */
export function clampQuantity(value, max = 999) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, max);
}
