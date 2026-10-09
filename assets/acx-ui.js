/**
 * Small DOM helpers shared by the Advanced Cart demo components. Product data
 * is only ever written with textContent, never parsed as HTML.
 * @module acx-ui
 */

import { formatMoney } from '@theme/money-formatting';

/**
 * Replaces `[key]` placeholders produced by Liquid's `t` filter.
 * @param {string | undefined} template
 * @param {Record<string, string | number>} values
 */
export function fill(template, values) {
  if (!template) return '';
  return template.replace(/\[(\w+)\]/g, (match, key) => (key in values ? String(values[key]) : match));
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {any}
 */
export function readJson(root, selector) {
  const node = root.querySelector(selector);
  if (!node?.textContent) return null;
  try {
    return JSON.parse(node.textContent);
  } catch {
    return null;
  }
}

/**
 * @param {HTMLElement} element - Carries `data-money-format` and `data-currency`
 * @returns {(cents: number) => string}
 */
export function moneyFormatter(element) {
  const format = element.dataset.moneyFormat || '${{amount}}';
  const currency = element.dataset.currency || 'USD';
  return (cents) => formatMoney(cents, format, currency);
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Sale-aware price markup with visually hidden labels for screen readers.
 * @param {{ price: number, compareAtPrice: number | null }} variant
 * @param {Record<string, string>} strings
 * @param {(cents: number) => string} money
 */
export function priceNodes(variant, strings, money) {
  const fragment = document.createDocumentFragment();
  if (variant.compareAtPrice !== null && variant.compareAtPrice > variant.price) {
    fragment.append(el('span', 'visually-hidden', strings.salePrice));
    fragment.append(el('span', 'acx-price acx-price--sale', money(variant.price)));
    fragment.append(el('span', 'visually-hidden', strings.regularPrice));
    fragment.append(el('s', 'acx-price acx-price--compare', money(variant.compareAtPrice)));
  } else {
    fragment.append(el('span', 'acx-price', money(variant.price)));
  }
  return fragment;
}

/**
 * Fills a `<select>` with a product's variants; sold-out variants stay visible
 * but disabled so shoppers can see the full range.
 * @param {HTMLSelectElement} select
 * @param {import('@theme/acx-offers').AcxProduct} product
 * @param {number} selectedId
 * @param {Record<string, string>} strings
 */
export function fillVariantSelect(select, product, selectedId, strings) {
  const options = product.variants.map((variant) => {
    const option = el('option', '', variant.available ? variant.title : fill(strings.variantSoldOut, { variant: variant.title }));
    option.value = String(variant.id);
    option.disabled = !variant.available;
    option.selected = variant.id === selectedId;
    return option;
  });
  select.replaceChildren(...options);
}

/**
 * Shows a button's busy state while keeping its accessible name meaningful.
 * @param {HTMLButtonElement} button
 * @param {HTMLElement | null} label
 * @param {boolean} busy
 * @param {string} [text]
 */
export function setButtonBusy(button, label, busy, text) {
  button.disabled = busy;
  button.toggleAttribute('aria-busy', busy);
  button.toggleAttribute('data-busy', busy);
  if (label && text !== undefined) label.textContent = text;
}
