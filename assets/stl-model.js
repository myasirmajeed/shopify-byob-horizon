/**
 * Pure product/variant helpers for Shop the Look. No DOM access.
 * @module stl-model
 */

/**
 * @typedef {object} StlVariant
 * @property {number} id
 * @property {string} title
 * @property {string[]} options
 * @property {number} price
 * @property {number | null} compareAtPrice
 * @property {boolean} available
 * @property {string | null} image
 */

/**
 * @typedef {object} StlProduct
 * @property {number} id
 * @property {string} title
 * @property {string} label
 * @property {string} url
 * @property {string} description
 * @property {string | null} image
 * @property {string} imageAlt
 * @property {boolean} available
 * @property {boolean} hasOnlyDefaultVariant
 * @property {{ value: string, scale: string, count: number } | null} rating
 * @property {Array<{ name: string, values: string[] }>} options
 * @property {StlVariant[]} variants
 */

/**
 * First available variant, or the first variant when everything is sold out.
 * @param {StlProduct} product
 */
export function defaultVariant(product) {
  return product.variants.find((v) => v.available) ?? product.variants[0] ?? null;
}

/**
 * @param {StlProduct} product
 * @param {number} id
 */
export function variantById(product, id) {
  return product.variants.find((v) => v.id === id) ?? null;
}

/**
 * @param {StlProduct} product
 * @param {string[]} options
 */
export function variantByOptions(product, options) {
  return product.variants.find((v) => v.options.every((value, i) => value === options[i])) ?? null;
}

/**
 * Selects `value` for option `index`. If that exact combination doesn't exist,
 * falls back to the best variant that has the value (available first), so the
 * selection always maps to a real variant ID.
 * @param {StlProduct} product
 * @param {StlVariant} current
 * @param {number} index
 * @param {string} value
 */
export function selectOption(product, current, index, value) {
  const wanted = current.options.map((v, i) => (i === index ? value : v));
  const exact = variantByOptions(product, wanted);
  if (exact) return exact;
  const withValue = product.variants.filter((v) => v.options[index] === value);
  return withValue.find((v) => v.available) ?? withValue[0] ?? current;
}

/**
 * Whether choosing `value` for option `index`, keeping the other current
 * options, leads to an available variant.
 * @param {StlProduct} product
 * @param {StlVariant} current
 * @param {number} index
 * @param {string} value
 */
export function isValueAvailable(product, current, index, value) {
  const wanted = current.options.map((v, i) => (i === index ? value : v));
  return Boolean(variantByOptions(product, wanted)?.available);
}

/**
 * Human-readable variant summary, empty for single-variant products.
 * @param {StlProduct} product
 * @param {StlVariant | null} variant
 */
export function variantSummary(product, variant) {
  if (!variant || product.hasOnlyDefaultVariant) return '';
  return variant.options.join(' / ');
}

/**
 * @param {number} value
 * @param {number} [max]
 */
export function clampQuantity(value, max = 99) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}
