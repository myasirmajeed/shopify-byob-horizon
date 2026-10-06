/**
 * Pure, DOM-free logic for the Product Personalizer: variant resolution, pricing,
 * validation and the cart payload. Prices are always taken from real Shopify
 * variants (box + add-on products), so the estimate equals the cart total.
 * @module pz-model
 */

/**
 * @typedef {object} Catalog
 * @property {{ id: number, title: string }} product
 * @property {Array<{ id: number, options: string[], price: number, available: boolean }>} variants
 * @property {Array<{ id: number, productId: number, title: string, price: number, key: string, available: boolean }>} addons
 * @property {number} maxChars
 * @property {number} maxQuantity
 */

/**
 * @typedef {object} Design
 * @property {string | null} style - Option 1 value
 * @property {string | null} color - Option 2 value
 * @property {string | null} size - Option 3 value
 * @property {string} message
 * @property {'script' | 'serif' | 'modern'} lettering
 * @property {'none' | 'hearts' | 'stars' | 'floral'} motif
 * @property {number[]} addons - Selected add-on variant IDs
 * @property {number} quantity
 */

export const LETTERING = /** @type {const} */ (['script', 'serif', 'modern']);
export const MOTIFS = /** @type {const} */ (['none', 'hearts', 'stars', 'floral']);

// Letters and numbers in any script, spaces and common punctuation. Emoji and
// symbols are rejected because the lid printer cannot reproduce them.
const UNSUPPORTED = /[^\p{L}\p{M}\p{N} .,!?'’"“”&\-:;()@#+/]/gu;

/**
 * @param {Partial<Design>} [overrides]
 * @returns {Design}
 */
export function defaultDesign(overrides = {}) {
  return {
    style: null,
    color: null,
    size: null,
    message: '',
    lettering: 'script',
    motif: 'none',
    addons: [],
    quantity: 1,
    ...overrides,
  };
}

/**
 * @param {Catalog} catalog
 * @param {Pick<Design, 'style' | 'color' | 'size'>} design
 */
export function findVariant(catalog, { style, color, size }) {
  if (!style || !color || !size) return null;
  return (
    catalog.variants.find((v) => v.options[0] === style && v.options[1] === color && v.options[2] === size) ?? null
  );
}

/**
 * Whether choosing `value` for option `index` (0-2) can lead to an available variant,
 * given the other current choices. Used to mark sold-out option values.
 * @param {Catalog} catalog
 * @param {Design} design
 * @param {0 | 1 | 2} index
 * @param {string} value
 */
export function isOptionAvailable(catalog, design, index, value) {
  const current = [design.style, design.color, design.size];
  return catalog.variants.some(
    (v) => v.available && v.options[index] === value && v.options.every((o, i) => i === index || !current[i] || o === current[i])
  );
}

/** @param {Catalog} catalog */
export function lowestPrice(catalog) {
  const prices = catalog.variants.filter((v) => v.available).map((v) => v.price);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * Character count by code point so accented letters and non-Latin scripts count as one.
 * @param {string} text
 */
export function characterCount(text) {
  return [...text].length;
}

/**
 * @param {string} message
 * @param {number} max
 */
export function checkMessage(message, max) {
  const count = characterCount(message);
  const invalid = [...new Set(message.match(UNSUPPORTED) ?? [])];
  return { count, over: Math.max(count - max, 0), invalid };
}

/**
 * @param {Catalog} catalog
 * @param {Design} design
 */
export function pricing(catalog, design) {
  const variant = findVariant(catalog, design);
  const selected = catalog.addons.filter((addon) => design.addons.includes(addon.id));
  const addons = selected.reduce((sum, addon) => sum + addon.price, 0);
  const box = variant ? variant.price : null;
  const each = box === null ? null : box + addons;
  return {
    variant,
    box,
    addons,
    selectedAddons: selected,
    each,
    total: each === null ? null : each * design.quantity,
  };
}

/**
 * @typedef {{ field: 'style' | 'color' | 'size' | 'message' | 'quantity', code: string, values?: Record<string, string | number> }} ValidationError
 */

/**
 * @param {Catalog} catalog
 * @param {Design} design
 * @returns {ValidationError[]}
 */
export function validate(catalog, design) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (!design.style) errors.push({ field: 'style', code: 'style' });
  if (!design.color) errors.push({ field: 'color', code: 'color' });
  if (!design.size) errors.push({ field: 'size', code: 'size' });

  const variant = findVariant(catalog, design);
  if (variant && !variant.available) errors.push({ field: 'size', code: 'unavailable' });

  const message = checkMessage(design.message.trim(), catalog.maxChars);
  if (message.over > 0) errors.push({ field: 'message', code: 'message_long', values: { count: message.over } });
  if (message.invalid.length) errors.push({ field: 'message', code: 'message_chars', values: { chars: message.invalid.join(' ') } });

  if (!Number.isInteger(design.quantity) || design.quantity < 1 || design.quantity > catalog.maxQuantity) {
    errors.push({ field: 'quantity', code: 'quantity', values: { max: catalog.maxQuantity } });
  }
  return errors;
}

/**
 * Restores a saved design, dropping anything that no longer exists in the catalog.
 * @param {Catalog} catalog
 * @param {unknown} saved
 * @param {Design} fallback
 * @returns {Design}
 */
export function sanitize(catalog, saved, fallback) {
  if (!saved || typeof saved !== 'object') return fallback;
  const s = /** @type {Record<string, any>} */ (saved);
  const values = (index) => new Set(catalog.variants.map((v) => v.options[index]));
  const pick = (value, index, current) => (typeof value === 'string' && values(index).has(value) ? value : current);
  const addonIds = new Set(catalog.addons.filter((a) => a.available).map((a) => a.id));
  const quantity = Math.floor(Number(s.quantity));

  return {
    style: pick(s.style, 0, fallback.style),
    color: pick(s.color, 1, fallback.color),
    size: pick(s.size, 2, fallback.size),
    message: typeof s.message === 'string' ? s.message.slice(0, catalog.maxChars * 2) : '',
    lettering: LETTERING.includes(s.lettering) ? s.lettering : fallback.lettering,
    motif: MOTIFS.includes(s.motif) ? s.motif : fallback.motif,
    addons: Array.isArray(s.addons) ? s.addons.map(Number).filter((id) => addonIds.has(id)) : [],
    quantity: quantity >= 1 && quantity <= catalog.maxQuantity ? quantity : 1,
  };
}

/**
 * Builds the `/cart/add.js` items: the box variant plus one line per add-on, all
 * at the same quantity and linked by a hidden `_pz_bundle` property.
 * @param {Catalog} catalog
 * @param {Design} design
 * @param {{ message: string, lettering: string, design: string, addons: string, for: string }} labels
 * @param {{ lettering: string, motif: string }} names - Display names for the chosen lettering/motif
 * @param {string} bundleId
 */
export function buildCartItems(catalog, design, labels, names, bundleId) {
  if (validate(catalog, design).length) return null;
  const { variant, selectedAddons } = pricing(catalog, design);
  if (!variant) return null;

  const message = design.message.trim();
  /** @type {Record<string, string>} */
  const properties = {};
  if (message) {
    properties[labels.message] = message;
    properties[labels.lettering] = names.lettering;
  }
  if (design.motif !== 'none') properties[labels.design] = names.motif;
  if (selectedAddons.length) properties[labels.addons] = selectedAddons.map((addon) => addon.title).join(', ');
  properties._pz_bundle = bundleId;

  const boxLabel = `${catalog.product.title} (${design.color} / ${design.size})`;
  return [
    { id: variant.id, quantity: design.quantity, properties },
    ...selectedAddons.map((addon) => ({
      id: addon.id,
      quantity: design.quantity,
      properties: { [labels.for]: boxLabel, _pz_bundle: bundleId },
    })),
  ];
}
