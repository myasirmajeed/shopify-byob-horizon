import { Component } from '@theme/component';
import { formatMoney } from '@theme/money-formatting';
import { CartLinesUpdateEvent, CartErrorEvent } from '@shopify/events';

/**
 * @typedef {object} BoxSize
 * @property {string} variantId
 * @property {string} title
 * @property {number} price - Box fee in minor units
 * @property {number} min
 * @property {number} max
 */

/**
 * @typedef {object} BoxLine
 * @property {string} variantId
 * @property {string} title - Product title plus variant title when it has options
 * @property {number} price - Unit price in minor units
 * @property {number} quantity
 */

/**
 * @typedef {object} BoxRefs
 * @property {HTMLElement} sizeLabel
 * @property {HTMLElement} count
 * @property {HTMLElement} progressBar
 * @property {HTMLElement} progressMin
 * @property {HTMLElement} status
 * @property {HTMLDetailsElement} contents
 * @property {HTMLElement} empty
 * @property {HTMLUListElement} lines
 * @property {HTMLElement} boxFee
 * @property {HTMLElement} itemsTotal
 * @property {HTMLElement} total
 * @property {HTMLButtonElement} submit
 * @property {HTMLElement} submitLabel
 * @property {HTMLElement} error
 * @property {HTMLTemplateElement} lineTemplate
 * @property {HTMLScriptElement} strings
 */

const SUCCESS_LABEL_DURATION = 2500;

/** Matches the breakpoint where the summary becomes a sidebar (see byob-builder.liquid). */
const DESKTOP_LAYOUT = '(min-width: 990px)';

/**
 * Build-your-own-box builder.
 *
 * Owns the box state (selected size + packed variants), keeps the summary,
 * progress, pricing and product cards in sync, and adds the finished box to the
 * cart through the AJAX Cart API. All lines in one box share a `_byob_id`
 * property so they can be identified together in the cart and on the order.
 *
 * @extends {Component<BoxRefs>}
 */
class ByobBuilderComponent extends Component {
  requiredRefs = ['status', 'submit', 'submitLabel', 'lines', 'lineTemplate', 'strings', 'total'];

  /** @type {Map<string, BoxLine>} */
  #lines = new Map();

  /** @type {BoxSize | null} */
  #size = null;

  /** @type {Record<string, string>} */
  #strings = {};

  #isSubmitting = false;

  /** @type {AbortController | null} */
  #request = null;

  /** @type {number | undefined} */
  #labelTimeout;

  connectedCallback() {
    super.connectedCallback();

    try {
      this.#strings = JSON.parse(this.refs.strings.textContent || '{}');
    } catch {
      this.#strings = {};
    }

    const checked = this.querySelector('.byob__size-input:checked');
    if (checked instanceof HTMLInputElement) this.#size = this.#readSize(checked);

    if (this.refs.contents && matchMedia(DESKTOP_LAYOUT).matches) this.refs.contents.open = true;

    this.#render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#request?.abort();
    clearTimeout(this.#labelTimeout);
  }

  /* ---------- Event handlers (routed through on:* attributes) ---------- */

  /** @param {Event} event */
  handleSizeChange(event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.#size = this.#readSize(event.target);
    this.#render();
  }

  /**
   * Switching variants keeps any already-packed variant in the box; the stepper
   * then controls the newly selected variant.
   * @param {Event} event
   */
  handleVariantChange(event) {
    const card = this.#cardFrom(event.target);
    if (card) this.#renderCard(card);
  }

  /** @param {Event} event */
  increase(event) {
    const card = this.#cardFrom(event.target);
    const variant = card && this.#selectedVariant(card);
    if (!card || !variant) return;

    const line = this.#lines.get(variant.variantId);
    const quantity = line?.quantity ?? 0;
    if (quantity >= variant.stock || this.#remaining() <= 0) return;

    this.#lines.set(variant.variantId, { ...variant, quantity: quantity + 1 });
    this.#render();
  }

  /** @param {Event} event */
  decrease(event) {
    const card = this.#cardFrom(event.target);
    const variant = card && this.#selectedVariant(card);
    if (variant) this.#changeQuantity(variant.variantId, -1);
  }

  /** @param {Event} event */
  removeLine(event) {
    if (!(event.target instanceof HTMLElement)) return;
    const { variantId } = event.target.dataset;
    if (!variantId) return;

    this.#lines.delete(variantId);
    this.#render();
    // The removed button is gone; keep focus inside the summary.
    this.refs.contents?.querySelector('summary')?.focus();
  }

  async addToCart() {
    if (!this.#isValid() || this.#isSubmitting || !this.#size) return;

    this.#isSubmitting = true;
    this.#setError('');
    this.refs.submitLabel.textContent = this.#strings.adding ?? '';
    this.#render();

    const boxId = createBoxId();
    const size = this.#size;
    const lines = [...this.#lines.values()];
    const boxLabel = `${size.title} · ${boxId}`;
    const contents = lines.map((line) => `${line.quantity} × ${line.title}`).join(', ');

    const items = [
      {
        id: Number(size.variantId),
        quantity: 1,
        properties: {
          [this.#strings.propertyContents || 'Contents']: contents,
          _byob_id: boxId,
        },
      },
      ...lines.map((line) => ({
        id: Number(line.variantId),
        quantity: line.quantity,
        properties: {
          [this.#strings.propertyPackedIn || 'Packed in']: boxLabel,
          _byob_id: boxId,
        },
      })),
    ];

    const sectionIds = [...document.querySelectorAll('cart-items-component')]
      .map((element) => (element instanceof HTMLElement ? element.dataset.sectionId : ''))
      .filter(Boolean);

    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: items.map((item) => ({ merchandiseId: String(item.id), quantity: item.quantity })),
        promise: deferred.promise,
      })
    );

    this.#request?.abort();
    this.#request = new AbortController();
    const { signal } = this.#request;

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items, sections: sectionIds.join(',') }),
        signal,
      });
      const result = await response.json();

      if (!response.ok || result.status) {
        throw new CartAddError(result.description || result.message || this.#strings.error);
      }

      const cart = await fetchCart(signal);
      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          items: cart.items,
          source: 'byob-builder-component',
          sourceId: this.dataset.sectionId,
          itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
          sections: result.sections,
          didError: false,
        },
      });

      this.#lines.clear();
      this.refs.submitLabel.textContent = this.#strings.added ?? '';
      this.#labelTimeout = window.setTimeout(() => {
        this.refs.submitLabel.textContent = this.#strings.addToCart ?? '';
      }, SUCCESS_LABEL_DURATION);
    } catch (error) {
      if (signal.aborted) return;
      console.error(error);

      const message = error instanceof CartAddError ? error.message : this.#strings.error;
      this.#setError(message || '');
      this.refs.submitLabel.textContent = this.#strings.addToCart ?? '';
      deferred.reject(error);
      this.dispatchEvent(
        new CartErrorEvent({
          error: message || 'Add to cart failed',
          code: error instanceof CartAddError ? 'INVALID' : 'SERVICE_UNAVAILABLE',
        })
      );
    } finally {
      this.#isSubmitting = false;
      this.#render();
    }
  }

  /* ---------- State helpers ---------- */

  /**
   * @param {HTMLInputElement} input
   * @returns {BoxSize}
   */
  #readSize(input) {
    const min = parseInt(input.dataset.min ?? '1', 10);
    return {
      variantId: input.value,
      title: input.dataset.title ?? '',
      price: parseInt(input.dataset.price ?? '0', 10),
      min,
      max: Math.max(min, parseInt(input.dataset.max ?? String(min), 10)),
    };
  }

  /**
   * @param {EventTarget | null} target
   * @returns {HTMLElement | null}
   */
  #cardFrom(target) {
    return target instanceof Element ? target.closest('[data-byob-card]') : null;
  }

  /**
   * @param {HTMLElement} card
   * @returns {(Omit<BoxLine, 'quantity'> & { stock: number }) | null}
   */
  #selectedVariant(card) {
    const select = card.querySelector('[data-card-select]');
    if (!(select instanceof HTMLSelectElement)) return null;

    const option = select.selectedOptions[0];
    if (!option || option.disabled) return null;

    const productTitle = card.dataset.productTitle ?? '';
    const isDefault = select.hidden;
    return {
      variantId: option.value,
      title: isDefault ? productTitle : `${productTitle} – ${option.dataset.title}`,
      price: parseInt(option.dataset.price ?? '0', 10),
      stock: parseInt(option.dataset.stock ?? '0', 10),
    };
  }

  /**
   * @param {string} variantId
   * @param {number} delta
   */
  #changeQuantity(variantId, delta) {
    const line = this.#lines.get(variantId);
    if (!line) return;

    const quantity = line.quantity + delta;
    if (quantity <= 0) {
      this.#lines.delete(variantId);
    } else {
      this.#lines.set(variantId, { ...line, quantity });
    }
    this.#render();
  }

  #itemCount() {
    let count = 0;
    for (const line of this.#lines.values()) count += line.quantity;
    return count;
  }

  #itemsTotal() {
    let total = 0;
    for (const line of this.#lines.values()) total += line.price * line.quantity;
    return total;
  }

  #remaining() {
    return this.#size ? this.#size.max - this.#itemCount() : 0;
  }

  #isValid() {
    if (!this.#size) return false;
    const count = this.#itemCount();
    return count >= this.#size.min && count <= this.#size.max;
  }

  /* ---------- Rendering ---------- */

  #render() {
    const size = this.#size;
    const count = this.#itemCount();
    const itemsTotal = this.#itemsTotal();
    const max = size?.max ?? 0;
    const min = size?.min ?? 0;

    /** @type {'empty' | 'under' | 'ready' | 'over'} */
    let state = 'under';
    if (!size) state = 'empty';
    else if (count > max) state = 'over';
    else if (count >= min) state = 'ready';
    this.dataset.state = state;

    // Summary header + progress
    if (this.refs.sizeLabel) this.refs.sizeLabel.textContent = size ? `· ${size.title}` : '';
    if (this.refs.count) {
      // The noun follows the box capacity: "1 of 3 items", "2 of 1 item".
      const template = max === 1 ? this.#strings.countOne : this.#strings.countOther;
      this.refs.count.textContent = fill(template, { count, max });
    }
    this.style.setProperty('--byob-progress', String(max ? Math.min(count / max, 1) : 0));
    this.style.setProperty('--byob-min-position', `${max ? (min / max) * 100 : 0}%`);
    if (this.refs.progressMin) this.refs.progressMin.hidden = !size || min === max;

    this.#setStatus(this.#statusText(state, count, min, max));

    // Pricing
    const boxFee = size?.price ?? 0;
    if (this.refs.boxFee) this.refs.boxFee.textContent = this.#money(boxFee);
    if (this.refs.itemsTotal) this.refs.itemsTotal.textContent = this.#money(itemsTotal);
    this.refs.total.textContent = this.#money(boxFee + itemsTotal);

    // Contents list
    this.#renderLines();

    // Cards
    for (const card of this.querySelectorAll('[data-byob-card]')) {
      if (card instanceof HTMLElement) this.#renderCard(card);
    }

    this.refs.submit.disabled = this.#isSubmitting || !this.#isValid();
    this.refs.submit.setAttribute('aria-busy', String(this.#isSubmitting));
  }

  /**
   * @param {'empty' | 'under' | 'ready' | 'over'} state
   * @param {number} count
   * @param {number} min
   * @param {number} max
   */
  #statusText(state, count, min, max) {
    const s = this.#strings;
    switch (state) {
      case 'empty':
        return s.boxUnavailable ?? '';
      case 'over': {
        const extra = count - max;
        return extra === 1 ? s.tooManyOne : fill(s.tooManyOther, { count: extra });
      }
      case 'ready': {
        const room = max - count;
        if (room === 0) return s.full ?? '';
        return room === 1 ? s.readyRoomOne : fill(s.readyRoomOther, { count: room });
      }
      default: {
        const needed = min - count;
        return needed === 1 ? s.needMoreOne : fill(s.needMoreOther, { count: needed });
      }
    }
  }

  #renderLines() {
    const { lines, lineTemplate, empty } = this.refs;
    const fragment = document.createDocumentFragment();

    for (const line of this.#lines.values()) {
      const node = /** @type {DocumentFragment} */ (lineTemplate.content.cloneNode(true));
      const qty = node.querySelector('[data-line-qty]');
      const title = node.querySelector('[data-line-title]');
      const price = node.querySelector('[data-line-price]');
      const remove = node.querySelector('[data-line-remove]');

      if (qty) qty.textContent = `${line.quantity}×`;
      if (title) title.textContent = line.title;
      if (price) price.textContent = this.#money(line.price * line.quantity);
      if (remove instanceof HTMLElement) {
        remove.dataset.variantId = line.variantId;
        remove.setAttribute('aria-label', fill(this.#strings.remove, { product: line.title }));
      }
      fragment.append(node);
    }

    lines.replaceChildren(fragment);
    if (empty) empty.hidden = this.#lines.size > 0;
  }

  /** @param {HTMLElement} card */
  #renderCard(card) {
    const variant = this.#selectedVariant(card);
    const qtyOutput = card.querySelector('[data-card-qty]');
    const increase = card.querySelector('[data-card-increase]');
    const decrease = card.querySelector('[data-card-decrease]');
    const price = card.querySelector('[data-card-price]');
    const badge = card.querySelector('[data-card-badge]');

    const quantity = variant ? this.#lines.get(variant.variantId)?.quantity ?? 0 : 0;

    // Total across every variant of this product, for the "in box" badge.
    let productQuantity = 0;
    const select = card.querySelector('[data-card-select]');
    if (select instanceof HTMLSelectElement) {
      for (const option of select.options) productQuantity += this.#lines.get(option.value)?.quantity ?? 0;
    }

    if (qtyOutput) qtyOutput.textContent = String(quantity);
    if (price && variant) price.textContent = this.#money(variant.price);
    if (decrease instanceof HTMLButtonElement) decrease.disabled = this.#isSubmitting || quantity === 0;
    if (increase instanceof HTMLButtonElement) {
      increase.disabled =
        this.#isSubmitting || !variant || !this.#size || quantity >= variant.stock || this.#remaining() <= 0;
    }
    if (badge instanceof HTMLElement) {
      badge.hidden = productQuantity === 0;
      badge.textContent = `${productQuantity}×`;
    }
    card.toggleAttribute('data-in-box', productQuantity > 0);
  }

  /** @param {string} message */
  #setStatus(message) {
    // Only touch the live region when the text changes so screen readers announce once.
    if (this.refs.status.textContent !== message) this.refs.status.textContent = message;
  }

  /** @param {string} message */
  #setError(message) {
    if (!this.refs.error) return;
    this.refs.error.textContent = message;
    this.refs.error.hidden = !message;
  }

  /** @param {number} cents */
  #money(cents) {
    return formatMoney(cents, this.dataset.moneyFormat ?? '${{amount}}', this.dataset.currency ?? 'USD');
  }
}

class CartAddError extends Error {}

/**
 * Replaces `[key]` placeholders produced by the Liquid `t` filter.
 * @param {string | undefined} template
 * @param {Record<string, string | number>} values
 */
function fill(template, values) {
  if (!template) return '';
  return template.replace(/\[(\w+)\]/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** Short, human-readable ID shared by every line in one box. */
function createBoxId() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? Date.now();
  return `BOX-${random.toString(36).toUpperCase().slice(0, 6)}`;
}

/** @param {AbortSignal} signal */
async function fetchCart(signal) {
  const response = await fetch(`${Theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`Failed to fetch cart: ${response.status}`);
  return response.json();
}

if (!customElements.get('byob-builder-component')) {
  customElements.define('byob-builder-component', ByobBuilderComponent);
}
