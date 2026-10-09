import { Component } from '@theme/component';
import { addItems } from '@theme/acx-cart-api';
import { fill, moneyFormatter, priceNodes, readJson, setButtonBusy } from '@theme/acx-ui';

/**
 * @typedef {import('@theme/acx-offers').AcxProduct} AcxProduct
 * @typedef {import('@theme/acx-offers').AcxVariant} AcxVariant
 */

const ADDED_RESET = 2200;

/**
 * Product card with variant picker and AJAX add to cart. The markup is a real
 * `/cart/add` form, so it still works before (or without) JavaScript.
 * @extends {Component}
 */
class AcxProductCardComponent extends Component {
  /** @type {AcxProduct | null} */
  #product = null;
  /** @type {Record<string, string>} */
  #strings = {};
  /** @type {number | undefined} */
  #resetTimer;

  connectedCallback() {
    super.connectedCallback();
    this.#product = readJson(this, '[data-card-product]');
    this.#strings = readJson(document, '[data-acx-product-strings]') ?? {};
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#resetTimer);
  }

  /** @returns {AcxVariant | null} */
  get #variant() {
    const field = this.querySelector('[name="id"]');
    const id = Number(field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value : 0);
    return this.#product?.variants.find((variant) => variant.id === id) ?? null;
  }

  selectVariant() {
    const variant = this.#variant;
    if (!variant) return;
    this.querySelector('[data-card-price]')?.replaceChildren(priceNodes(variant, this.#strings, moneyFormatter(this)));
    this.#setStatus('');
    this.#renderButton(variant.available ? this.#strings.addToCart : this.#strings.soldOut, !variant.available);
  }

  /** @param {SubmitEvent} event */
  async add(event) {
    event.preventDefault();
    const variant = this.#variant;
    const button = this.querySelector('[data-card-add]');
    if (!variant || !(button instanceof HTMLButtonElement) || button.disabled) return;
    if (!variant.available) {
      this.#setStatus(this.#strings.soldOut, 'error');
      return;
    }

    clearTimeout(this.#resetTimer);
    this.#setStatus('');
    const label = this.querySelector('[data-card-add-label]');
    setButtonBusy(button, label instanceof HTMLElement ? label : null, true, this.#strings.adding);
    try {
      const { failed } = await addItems(this, [{ id: variant.id, quantity: 1 }]);
      if (failed.length) {
        this.#renderButton(this.#strings.addToCart, false);
        this.#setStatus(failed[0].message || this.#strings.addError, 'error');
        return;
      }
      this.#renderButton(this.#strings.added, false);
      button.setAttribute('data-added', '');
      this.#resetTimer = window.setTimeout(() => {
        button.removeAttribute('data-added');
        this.#renderButton(this.#strings.addToCart, false);
      }, ADDED_RESET);
    } catch (error) {
      this.#renderButton(this.#strings.addToCart, false);
      this.#setStatus(errorMessage(error, this.#strings), 'error');
    }
  }

  /**
   * @param {string} text
   * @param {boolean} disabled
   */
  #renderButton(text, disabled) {
    const button = this.querySelector('[data-card-add]');
    const label = this.querySelector('[data-card-add-label]');
    if (!(button instanceof HTMLButtonElement)) return;
    setButtonBusy(button, label instanceof HTMLElement ? label : null, false, text);
    button.disabled = disabled;
  }

  /**
   * @param {string} message
   * @param {'error' | 'success'} [tone]
   */
  #setStatus(message, tone = 'error') {
    const status = this.querySelector('[data-card-status]');
    if (!(status instanceof HTMLElement)) return;
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = !message;
  }
}

/**
 * @typedef {{ product: AcxProduct, row: HTMLElement }} FbtItem
 */

/**
 * Frequently bought together: pick products, see the combined price, and add
 * the selection in one `/cart/add.js` request (with a per-item fallback that
 * reports exactly what could not be added).
 * @extends {Component}
 */
class AcxFbtComponent extends Component {
  /** @type {FbtItem[]} */
  #items = [];
  /** @type {Record<string, string>} */
  #strings = {};
  /** @type {(cents: number) => string} */
  #money = (cents) => String(cents);

  connectedCallback() {
    super.connectedCallback();
    this.#strings = readJson(document, '[data-acx-product-strings]') ?? {};
    this.#money = moneyFormatter(this);
    this.#items = [...this.querySelectorAll('[data-fbt-item]')]
      .map((row) => ({ product: readJson(row, '[data-fbt-product]'), row: /** @type {HTMLElement} */ (row) }))
      .filter((item) => item.product);
    this.#update();
  }

  toggleItem() {
    this.#setStatus('');
    this.#update();
  }

  /** @param {Event} event */
  selectVariant(event) {
    const row = event.target instanceof Element ? event.target.closest('[data-fbt-item]') : null;
    const item = this.#items.find((entry) => entry.row === row);
    if (!item) return;
    const variant = this.#variant(item);
    const check = item.row.querySelector('[data-fbt-check]');
    if (check instanceof HTMLInputElement && variant) {
      check.disabled = !variant.available;
      if (!variant.available) check.checked = false;
    }
    if (variant) item.row.querySelector('[data-fbt-price]')?.replaceChildren(priceNodes(variant, this.#strings, this.#money));
    this.#update();
  }

  /** @param {FbtItem} item */
  #variant(item) {
    const select = item.row.querySelector('[data-fbt-select]');
    const id = select instanceof HTMLSelectElement ? Number(select.value) : item.product.variants[0]?.id;
    return item.product.variants.find((variant) => variant.id === id) ?? null;
  }

  #selected() {
    return this.#items
      .map((item) => ({ item, variant: this.#variant(item) }))
      .filter(({ item, variant }) => {
        const check = item.row.querySelector('[data-fbt-check]');
        return check instanceof HTMLInputElement && check.checked && variant?.available;
      });
  }

  #update() {
    const selected = this.#selected();
    const total = selected.reduce((sum, { variant }) => sum + (variant?.price ?? 0), 0);
    const totalNode = this.querySelector('[data-fbt-total]');
    if (totalNode) totalNode.textContent = this.#money(total);
    for (const { row } of this.#items) {
      const check = row.querySelector('[data-fbt-check]');
      row.toggleAttribute('data-selected', check instanceof HTMLInputElement && check.checked);
    }
    for (const visual of this.querySelectorAll('[data-fbt-visual]')) {
      const id = /** @type {HTMLElement} */ (visual).dataset.fbtVisual;
      const row = this.#items.find((item) => String(item.product.id) === id)?.row;
      visual.toggleAttribute('data-muted', !row?.hasAttribute('data-selected'));
    }

    const button = this.querySelector('[data-fbt-add]');
    const label = this.querySelector('[data-fbt-add-label]');
    if (button instanceof HTMLButtonElement && !button.hasAttribute('data-busy')) {
      button.disabled = selected.length === 0;
      if (label) {
        label.textContent =
          selected.length === 0
            ? this.#strings.nothingSelected
            : selected.length === 1
              ? this.#strings.addSelectedOne
              : fill(this.#strings.addSelectedOther, { count: selected.length });
      }
    }
  }

  async addSelected() {
    const selected = this.#selected();
    const button = this.querySelector('[data-fbt-add]');
    const label = this.querySelector('[data-fbt-add-label]');
    if (!selected.length || !(button instanceof HTMLButtonElement)) return;

    this.#setStatus('');
    setButtonBusy(button, label instanceof HTMLElement ? label : null, true, this.#strings.adding);
    const items = selected.map(({ variant }) => ({ id: /** @type {AcxVariant} */ (variant).id, quantity: 1 }));
    try {
      const { added, failed } = await addItems(this, items);
      const titleOf = (/** @type {number} */ variantId) =>
        selected.find(({ variant }) => variant?.id === variantId)?.item.product.title ?? '';
      const parts = [];
      if (added.length) parts.push(added.length === 1 ? this.#strings.addedOne : fill(this.#strings.addedOther, { count: added.length }));
      if (failed.length) {
        parts.push(
          fill(this.#strings.notAdded, {
            items: failed.map((entry) => `${titleOf(entry.item.id)}${entry.message ? ` (${entry.message})` : ''}`).join(', '),
          })
        );
      }
      this.#setStatus(parts.join(' '), failed.length ? 'error' : 'success');
    } catch (error) {
      this.#setStatus(errorMessage(error, this.#strings), 'error');
    } finally {
      setButtonBusy(button, label instanceof HTMLElement ? label : null, false);
      button.removeAttribute('data-busy');
      this.#update();
    }
  }

  /**
   * @param {string} message
   * @param {'error' | 'success'} [tone]
   */
  #setStatus(message, tone = 'success') {
    const status = this.querySelector('[data-fbt-status]');
    if (!(status instanceof HTMLElement)) return;
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = !message;
  }
}

/**
 * @param {unknown} error
 * @param {Record<string, string>} strings
 */
function errorMessage(error, strings) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'NETWORK') return strings.networkError;
  return (error instanceof Error && error.message) || strings.addError;
}

if (!customElements.get('acx-product-card-component')) {
  customElements.define('acx-product-card-component', AcxProductCardComponent);
}
if (!customElements.get('acx-fbt-component')) {
  customElements.define('acx-fbt-component', AcxFbtComponent);
}
