/**
 * Pure, DOM-free logic for the Build Your Own Box 2 builder: catalog lookups,
 * pricing, step validation and the cart payload. Keeping this separate makes the
 * rules easy to read and to unit test.
 * @module yb2-model
 */

/** @typedef {'size' | 'flavors' | 'sleeve' | 'review'} StepId */

/**
 * @typedef {object} Catalog
 * @property {{ id: number, title: string }} product
 * @property {Array<{ id: number, option1: string, option2: string, price: number, available: boolean }>} variants
 * @property {Array<{ value: string, label: string, pieces: number }>} sizes
 * @property {Array<{ value: string, label: string }>} sleeves
 * @property {Array<{ id: number, title: string, available: boolean, image?: string | null }>} flavors
 */

/**
 * @typedef {object} BoxState
 * @property {string | null} size - Box size option value
 * @property {string | null} sleeve - Sleeve option value
 * @property {Record<string, number>} flavors - Flavor product ID → quantity
 * @property {StepId} step
 */

/** @type {StepId[]} */
export const STEPS = ['size', 'flavors', 'sleeve', 'review'];

/** @returns {BoxState} */
export function emptyState() {
  return { size: null, sleeve: null, flavors: {}, step: 'size' };
}

/**
 * @param {Catalog} catalog
 * @param {string | null} value
 */
export function findSize(catalog, value) {
  return catalog.sizes.find((size) => size.value === value) ?? null;
}

/**
 * @param {Catalog} catalog
 * @param {string | null} value
 */
export function findSleeve(catalog, value) {
  return catalog.sleeves.find((sleeve) => sleeve.value === value) ?? null;
}

/**
 * @param {Catalog} catalog
 * @param {string | null} size
 * @param {string | null} sleeve
 */
export function findVariant(catalog, size, sleeve) {
  if (!size || !sleeve) return null;
  return catalog.variants.find((variant) => variant.option1 === size && variant.option2 === sleeve) ?? null;
}

/** @param {BoxState} state */
export function pieceCount(state) {
  let count = 0;
  for (const quantity of Object.values(state.flavors)) count += quantity;
  return count;
}

/**
 * Cheapest available variant for a size. Its price is shown as the "box price";
 * the difference to the chosen sleeve's variant is shown as the sleeve price, so
 * the parts always add up to the real variant price charged in the cart.
 * @param {Catalog} catalog
 * @param {string | null} size
 */
export function basePrice(catalog, size) {
  const prices = catalog.variants
    .filter((variant) => variant.option1 === size && variant.available)
    .map((variant) => variant.price);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * @param {Catalog} catalog
 * @param {string | null} size
 * @param {string} sleeve
 * @returns {number | null} Extra cost in minor units, or null when unavailable
 */
export function sleeveSurcharge(catalog, size, sleeve) {
  const base = basePrice(catalog, size);
  const variant = findVariant(catalog, size, sleeve);
  if (base === null || !variant || !variant.available) return null;
  return variant.price - base;
}

/**
 * @param {Catalog} catalog
 * @param {BoxState} state
 */
export function pricing(catalog, state) {
  const box = basePrice(catalog, state.size);
  const variant = findVariant(catalog, state.size, state.sleeve);
  const total = variant ? variant.price : box;
  return {
    box,
    sleeve: variant && box !== null ? variant.price - box : null,
    total,
  };
}

/**
 * Validation for every step, derived from state on demand.
 * @param {Catalog} catalog
 * @param {BoxState} state
 */
export function validate(catalog, state) {
  const size = findSize(catalog, state.size);
  const capacity = size?.pieces ?? 0;
  const count = pieceCount(state);
  const variant = findVariant(catalog, state.size, state.sleeve);

  const sizeValid = Boolean(size);
  const flavorsValid = sizeValid && count === capacity;
  const sleeveValid = Boolean(findSleeve(catalog, state.sleeve)) && Boolean(variant?.available);

  return {
    capacity,
    count,
    remaining: Math.max(capacity - count, 0),
    overBy: Math.max(count - capacity, 0),
    variant,
    steps: {
      size: sizeValid,
      flavors: flavorsValid,
      sleeve: sleeveValid,
      review: sizeValid && flavorsValid && sleeveValid,
    },
  };
}

/**
 * A step is reachable when every step before it is valid.
 * @param {ReturnType<typeof validate>} validation
 * @param {StepId} step
 */
export function canVisit(validation, step) {
  const index = STEPS.indexOf(step);
  return STEPS.slice(0, index).every((previous) => validation.steps[previous]);
}

/**
 * Drops anything in a restored state that no longer exists in the catalog.
 * @param {Catalog} catalog
 * @param {Partial<BoxState> | null} saved
 * @returns {BoxState}
 */
export function sanitize(catalog, saved) {
  const state = emptyState();
  if (!saved || typeof saved !== 'object') return state;

  if (findSize(catalog, saved.size ?? null)) state.size = saved.size ?? null;
  if (findSleeve(catalog, saved.sleeve ?? null)) state.sleeve = saved.sleeve ?? null;

  const available = new Set(catalog.flavors.filter((flavor) => flavor.available).map((flavor) => String(flavor.id)));
  for (const [id, quantity] of Object.entries(saved.flavors ?? {})) {
    const qty = Math.floor(Number(quantity));
    if (available.has(id) && qty > 0) state.flavors[id] = qty;
  }

  const validation = validate(catalog, state);
  const step = STEPS.includes(/** @type {StepId} */ (saved.step)) ? /** @type {StepId} */ (saved.step) : 'size';
  state.step = canVisit(validation, step) ? step : 'size';
  return state;
}

/**
 * Builds the `/cart/add.js` item for the configured box. Visible properties
 * describe the box for the shopper; `_yb2_config` (hidden by the leading
 * underscore) keeps machine-readable product IDs for fulfilment.
 * @param {Catalog} catalog
 * @param {BoxState} state
 * @param {{ total: string, flavor: string }} labels - Property names; `flavor` contains `[number]`
 */
export function buildCartItem(catalog, state, labels) {
  const validation = validate(catalog, state);
  if (!validation.steps.review || !validation.variant) return null;

  const titles = new Map(catalog.flavors.map((flavor) => [String(flavor.id), flavor.title]));
  // Catalog order keeps the property list stable regardless of click order.
  const lines = catalog.flavors
    .map((flavor) => [String(flavor.id), state.flavors[String(flavor.id)] ?? 0])
    .filter(([, quantity]) => Number(quantity) > 0);

  /** @type {Record<string, string>} */
  const properties = { [labels.total]: String(validation.count) };
  lines.forEach(([id, quantity], index) => {
    properties[labels.flavor.replace('[number]', String(index + 1))] = `${titles.get(String(id))} × ${quantity}`;
  });
  properties._yb2_config = JSON.stringify({
    v: 1,
    size: state.size,
    sleeve: state.sleeve,
    items: lines.map(([id, quantity]) => [Number(id), quantity]),
  });

  return { id: validation.variant.id, quantity: 1, properties };
}
