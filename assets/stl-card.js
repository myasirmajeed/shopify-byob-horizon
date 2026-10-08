/**
 * Renders the Shop the Look product card (prices, rating, variant pills,
 * quantity and add button) from product data into the shared `<dialog>`.
 * Uses DOM APIs and textContent only, so product data is never parsed as HTML.
 * @module stl-card
 */

import { isValueAvailable } from '@theme/stl-model';

/**
 * @param {string | undefined} template
 * @param {Record<string, string | number>} values
 */
export function fill(template, values) {
  if (!template) return '';
  return template.replace(/\[(\w+)\]/g, (match, key) => (key in values ? String(values[key]) : match));
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Price markup shared by the card and list items.
 * @param {import('@theme/stl-model').StlVariant} variant
 * @param {Record<string, string>} strings
 * @param {(cents: number) => string} money
 * @param {{ badges?: boolean }} [options]
 */
export function priceNodes(variant, strings, money, { badges = true } = {}) {
  const fragment = document.createDocumentFragment();
  const onSale = variant.compareAtPrice !== null && variant.compareAtPrice > variant.price;
  if (onSale) {
    fragment.append(el('span', 'visually-hidden', strings.salePrice));
    fragment.append(el('span', 'stl-price stl-price--sale', money(variant.price)));
    fragment.append(el('span', 'visually-hidden', strings.regularPrice));
    fragment.append(el('s', 'stl-price stl-price--compare', money(/** @type {number} */ (variant.compareAtPrice))));
    if (badges) fragment.append(el('span', 'stl-badge', strings.sale));
  } else {
    fragment.append(el('span', 'stl-price', money(variant.price)));
  }
  if (badges && !variant.available) fragment.append(el('span', 'stl-badge stl-badge--muted', strings.soldOut));
  return fragment;
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {{
 *   product: import('@theme/stl-model').StlProduct,
 *   variant: import('@theme/stl-model').StlVariant,
 *   quantity: number,
 *   strings: Record<string, string>,
 *   money: (cents: number) => string,
 *   uid: string,
 * }} model
 */
export function renderCard(dialog, { product, variant, quantity, strings, money, uid }) {
  const q = (selector) => dialog.querySelector(selector);

  const image = /** @type {HTMLImageElement | null} */ (q('[data-card-image]'));
  if (image) {
    const src = variant.image || product.image;
    if (src && image.getAttribute('src') !== src) image.src = src;
    image.alt = product.imageAlt || product.title;
  }

  const title = q('[data-card-title]');
  if (title) title.textContent = product.title;

  q('[data-card-prices]')?.replaceChildren(priceNodes(variant, strings, money));

  const rating = q('[data-card-rating]');
  if (rating instanceof HTMLElement) {
    rating.hidden = !product.rating;
    if (product.rating) {
      const value = Number(product.rating.value);
      const scale = Number(product.rating.scale) || 5;
      const stars = el('span', 'stl-card__stars');
      stars.setAttribute('aria-hidden', 'true');
      for (let i = 1; i <= scale; i++) stars.append(starIcon(i <= Math.round(value)));
      const count = product.rating.count;
      const countText = count === 1 ? strings.ratingCountOne : fill(strings.ratingCountOther, { count });
      const label = el('span', '', `${value.toFixed(1)} · ${countText}`);
      rating.setAttribute('aria-label', `${fill(strings.rating, { rating: value.toFixed(1) })}, ${countText}`);
      rating.replaceChildren(stars, label);
    }
  }

  const description = q('[data-card-description]');
  if (description) description.textContent = product.description;

  const options = q('[data-card-options]');
  if (options) {
    const fragment = document.createDocumentFragment();
    if (!product.hasOnlyDefaultVariant) {
      product.options.forEach((option, index) => {
        const fieldset = el('fieldset', 'stl-option');
        const legend = el('legend', 'stl-option__legend', `${option.name}: `);
        legend.append(el('span', 'stl-option__current', variant.options[index] ?? ''));
        const values = el('div', 'stl-option__values');
        for (const value of option.values) {
          const available = isValueAvailable(product, variant, index, value);
          const label = el('label', 'stl-pill');
          if (!available) label.dataset.unavailable = '';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = `stl-option-${uid}-${index}`;
          input.value = value;
          input.checked = variant.options[index] === value;
          input.dataset.optionIndex = String(index);
          input.setAttribute('on:change', '/selectCardOption');
          label.append(input, document.createTextNode(value));
          if (!available) label.append(el('span', 'visually-hidden', ` (${strings.soldOut})`));
          values.append(label);
        }
        fieldset.append(legend, values);
        fragment.append(fieldset);
      });
    }
    options.replaceChildren(fragment);
  }

  const qty = /** @type {HTMLInputElement | null} */ (q('[data-card-quantity]'));
  if (qty) qty.value = String(quantity);
  const decrease = /** @type {HTMLButtonElement | null} */ (q('[data-card-decrease]'));
  if (decrease) decrease.disabled = quantity <= 1;

  const add = /** @type {HTMLButtonElement | null} */ (q('[data-card-add]'));
  const addLabel = q('[data-card-add-label]');
  if (add) add.disabled = !variant.available;
  if (addLabel) addLabel.textContent = variant.available ? strings.addToCart : strings.soldOut;

  const link = /** @type {HTMLAnchorElement | null} */ (q('[data-card-link]'));
  if (link) link.href = product.hasOnlyDefaultVariant ? product.url : `${product.url}?variant=${variant.id}`;
}

/** @param {boolean} filled */
function starIcon(filled) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M8 1.6l1.9 4.1 4.5.5-3.3 3 .9 4.4L8 11.4l-4 2.2.9-4.4-3.3-3 4.5-.5z');
  svg.append(path);
  return svg;
}
