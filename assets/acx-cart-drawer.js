import { Component } from '@theme/component';
import { lockScroll, unlockScroll, prefersReducedMotion } from '@theme/utilities';
import { CART_UPDATED, CART_BUSY, addItems, changeLine, setDiscountCodes, refreshCart, lastCart } from '@theme/acx-cart-api';
import {
  GIFT_PROPERTY,
  clampQuantity,
  firstAvailableVariant,
  fromAjaxProduct,
  giftPlan,
  isGiftLine,
  progress,
  qualifyingTotal,
  rankUpsells,
  recommendationSeeds,
  sizedImage,
} from '@theme/acx-offers';
import { el, fill, fillVariantSelect, moneyFormatter, priceNodes, readJson, setButtonBusy } from '@theme/acx-ui';

/** Rapid +/- clicks inside this window become one cart request. */
const QUANTITY_DELAY = 350;
const DISMISSED_KEY = 'acx-dismissed-upsells';
const HEADER_TRIGGER = '[data-testid="cart-drawer-trigger"], a.action__cart';

/**
 * @typedef {import('@theme/acx-offers').AcxProduct} AcxProduct
 * @typedef {Record<string, any>} AjaxCart
 * @typedef {{
 *   strings: Record<string, string>,
 *   cart: AjaxCart | null,
 *   freeShipping: { enabled: boolean, threshold: number },
 *   gift: { enabled: boolean, threshold: number, productId: number | null, title: string, variants: Array<{ id: number, title: string, available: boolean }> },
 *   rules: import('@theme/acx-offers').UpsellRule[],
 *   fallback: AcxProduct[],
 *   upsellLimit: number,
 *   useRecommendations: boolean,
 *   recommendationsUrl: string,
 *   recommendationTag: string,
 * }} DrawerConfig
 */

/**
 * Advanced cart drawer: line items with coalesced quantity updates, free
 * shipping and gift progress, smart upsells, discount codes and an empty-cart
 * state. Renders only what Shopify's cart JSON says — every change is a real
 * AJAX Cart API request made through `@theme/acx-cart-api`.
 *
 * On the page that renders it, it is the only cart UI: the header cart button
 * opens this drawer and Horizon's drawer auto-open is paused, so two cart
 * systems never compete.
 *
 * @extends {Component}
 */
class AcxCartDrawerComponent extends Component {
  /** @type {DrawerConfig} */
  #config = /** @type {any} */ ({});
  /** @type {Record<string, string>} */
  #strings = {};
  /** @type {HTMLDialogElement | null} */
  #dialog = null;
  /** @type {AjaxCart | null} */
  #cart = null;
  /** @type {HTMLElement | null} */
  #opener = null;
  /** @type {AbortController | null} */
  #listeners = null;
  /** @type {Map<string, { quantity: number, timer: number }>} */
  #pendingQuantity = new Map();
  /** @type {Set<string>} */
  #inflight = new Set();
  /** @type {Map<number, Promise<AcxProduct[]>>} */
  #recommendationRequests = new Map();
  /** @type {Map<number, AcxProduct[]>} */
  #recommended = new Map();
  /** @type {Set<number>} */
  #dismissed = new Set();
  /** @type {Map<number, number>} Selected variant per upsell product */
  #upsellVariant = new Map();
  #reconciling = false;
  #closing = false;
  /** @type {Array<{ element: Element, attribute: string, value: string | null }>} */
  #restore = [];
  /** @type {(cents: number) => string} */
  #money = (cents) => String(cents);

  connectedCallback() {
    super.connectedCallback();
    this.#config = readJson(this, '[data-acx-config]') ?? this.#config;
    this.#strings = this.#config.strings ?? {};
    this.#money = moneyFormatter(this);
    this.#dialog = this.querySelector('[data-acx-dialog]');
    this.#dismissed = new Set(readSession(DISMISSED_KEY));

    this.#listeners?.abort();
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    document.addEventListener(CART_UPDATED, this.#handleCartUpdated, { signal });
    document.addEventListener(CART_BUSY, this.#handleBusy, { signal });
    document.addEventListener('click', this.#handleOpenTrigger, { signal });
    if (this.dataset.interceptHeader === 'true') {
      // Window capture runs before Horizon's delegated document listeners.
      window.addEventListener('click', this.#interceptHeader, { capture: true, signal });
      this.#claimThemeCart();
    }
    this.#dialog?.addEventListener('cancel', this.#handleCancel, { signal });
    this.#dialog?.addEventListener('click', this.#handleBackdropClick, { signal });

    const cart = lastCart() ?? this.#config.cart;
    if (cart) this.#render(cart);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#listeners?.abort();
    for (const { timer } of this.#pendingQuantity.values()) clearTimeout(timer);
    this.#pendingQuantity.clear();
    unlockScroll(this);
    for (const { element, attribute, value } of this.#restore) {
      if (value === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, value);
    }
    this.#restore = [];
  }

  /* ------------------------------------------------------------------ */
  /* Open / close                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Element | null} [opener]
   * @param {{ refresh?: boolean }} [options]
   */
  open(opener = document.activeElement, { refresh = true } = {}) {
    const dialog = this.#dialog;
    if (!dialog) return;
    if (dialog.open) {
      if (this.#closing) this.#finishClose(false);
      else return;
    }
    this.#opener = opener instanceof HTMLElement ? opener : null;
    dialog.showModal();
    lockScroll(this);
    this.#setTriggersExpanded(true);
    this.querySelector('[data-acx-title]')?.focus({ preventScroll: true });
    if (refresh) refreshCart().catch(() => this.#showStatus(this.#strings.loadError));
  }

  close() {
    const dialog = this.#dialog;
    if (!dialog?.open || this.#closing) return;
    if (prefersReducedMotion()) {
      this.#finishClose(true);
      return;
    }
    this.#closing = true;
    dialog.setAttribute('data-closing', '');
    const panel = dialog.querySelector('.acx-drawer__panel');
    const done = () => this.#closing && this.#finishClose(true);
    panel?.addEventListener('animationend', done, { once: true });
    setTimeout(done, 450);
  }

  /** @param {boolean} returnFocus */
  #finishClose(returnFocus) {
    this.#closing = false;
    this.#dialog?.removeAttribute('data-closing');
    this.#dialog?.close();
    unlockScroll(this);
    this.#setTriggersExpanded(false);
    if (returnFocus && this.#opener?.isConnected) this.#opener.focus({ preventScroll: true });
    this.#opener = null;
  }

  /** @param {Event} event */
  #handleCancel = (event) => {
    event.preventDefault();
    this.close();
  };

  /** Clicks on the dialog's own box land on the backdrop area outside the panel. */
  #handleBackdropClick = (/** @type {MouseEvent} */ event) => {
    if (event.target === this.#dialog) this.close();
  };

  #handleOpenTrigger = (/** @type {MouseEvent} */ event) => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-acx-open-cart]') : null;
    if (!trigger) return;
    event.preventDefault();
    this.open(trigger);
  };

  #interceptHeader = (/** @type {MouseEvent} */ event) => {
    const trigger = event.target instanceof Element ? event.target.closest(HEADER_TRIGGER) : null;
    if (!trigger || this.contains(trigger)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.open(trigger);
  };

  /**
   * Points the header cart button at this drawer and pauses Horizon's
   * auto-open while this page is shown. Restored on disconnect.
   */
  #claimThemeCart() {
    const dialogId = this.#dialog?.id;
    for (const trigger of document.querySelectorAll(HEADER_TRIGGER)) {
      if (!(trigger instanceof HTMLButtonElement) || !dialogId) continue;
      this.#restore.push({ element: trigger, attribute: 'aria-controls', value: trigger.getAttribute('aria-controls') });
      trigger.setAttribute('aria-controls', dialogId);
    }
    for (const themeDrawer of document.querySelectorAll('cart-drawer-component[auto-open]')) {
      this.#restore.push({ element: themeDrawer, attribute: 'auto-open', value: '' });
      themeDrawer.removeAttribute('auto-open');
    }
  }

  /** @param {boolean} expanded */
  #setTriggersExpanded(expanded) {
    for (const trigger of document.querySelectorAll(`${HEADER_TRIGGER}, [data-acx-open-cart]`)) {
      if (trigger instanceof HTMLButtonElement) trigger.setAttribute('aria-expanded', String(expanded));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Cart updates                                                        */
  /* ------------------------------------------------------------------ */

  #handleCartUpdated = (/** @type {CustomEvent} */ event) => {
    const { cart, reason, added = [], failed = [], open } = event.detail;
    this.#render(cart);

    if (reason === 'add' && added.length) {
      this.#hideStatus();
      const titles = added
        .map((/** @type {any} */ item) => cart.items.find((/** @type {any} */ line) => line.variant_id === item.id)?.product_title)
        .filter(Boolean);
      this.#announce(fill(this.#strings.added, { items: titles.join(', ') }));
    }
    if (failed.length && reason !== 'add') {
      this.#showStatus(failed[0].message || this.#strings.addError);
    }
    if (open) this.open(document.activeElement, { refresh: false });

    this.#reconcileGift(cart);
    this.#loadRecommendations(cart);
  };

  #handleBusy = (/** @type {CustomEvent} */ event) => {
    const busy = Boolean(event.detail?.busy);
    this.toggleAttribute('data-busy', busy);
    const loading = this.querySelector('[data-acx-loading]');
    if (loading instanceof HTMLElement) loading.hidden = !busy;
    const checkout = this.querySelector('[data-acx-checkout]');
    if (checkout instanceof HTMLButtonElement) {
      checkout.disabled = busy;
      checkout.toggleAttribute('aria-busy', busy);
    }
  };

  /** @param {AjaxCart} cart */
  #render(cart) {
    this.#cart = cart;
    const empty = cart.item_count === 0;
    const count = this.querySelector('[data-acx-count]');
    if (count) {
      count.textContent = empty
        ? ''
        : cart.item_count === 1
          ? this.#strings.countOne
          : fill(this.#strings.countOther, { count: cart.item_count });
    }
    this.#toggle('[data-acx-empty]', !empty);
    this.#toggle('[data-acx-lines]', empty);
    this.#toggle('[data-acx-footer]', empty);
    this.#toggle('[data-acx-summary]', empty);

    this.#renderLines(cart);
    this.#renderOffers(cart);
    this.#renderTotals(cart);
    this.#renderDiscounts(cart);
    this.#renderUpsells(cart);
  }

  /**
   * @param {string} selector
   * @param {boolean} hidden
   */
  #toggle(selector, hidden) {
    const node = this.querySelector(selector);
    if (node instanceof HTMLElement) node.hidden = hidden;
  }

  /* ------------------------------------------------------------------ */
  /* Line items                                                          */
  /* ------------------------------------------------------------------ */

  /** @param {AjaxCart} cart */
  #renderLines(cart) {
    const list = this.querySelector('[data-acx-lines]');
    const template = this.querySelector('template[data-acx-line-template]');
    if (!(list instanceof HTMLElement) || !(template instanceof HTMLTemplateElement)) return;

    const previous = [...list.children].filter((node) => node instanceof HTMLElement);
    const focused = document.activeElement?.closest?.('[data-acx-line]');
    const focusedIndex = focused instanceof HTMLElement ? previous.indexOf(focused) : -1;
    /** @type {Map<string, HTMLElement>} */
    const byKey = new Map(previous.map((node) => [/** @type {HTMLElement} */ (node).dataset.key ?? '', /** @type {HTMLElement} */ (node)]));

    const nodes = cart.items.map((/** @type {any} */ item) => {
      let node = byKey.get(item.key);
      if (node) byKey.delete(item.key);
      else node = /** @type {HTMLElement} */ (/** @type {DocumentFragment} */ (template.content.cloneNode(true)).firstElementChild);
      this.#fillLine(node, item);
      return node;
    });

    nodes.forEach((node, index) => {
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
    });
    for (const stale of byKey.values()) stale.remove();

    // A removed line took focus with it: move to the line now in its place.
    if (focusedIndex !== -1 && !focused?.isConnected) {
      const next = nodes[Math.min(focusedIndex, nodes.length - 1)];
      const target = next?.querySelector('[data-line-title]') ?? this.querySelector('[data-acx-empty-heading]');
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    }
  }

  /**
   * @param {HTMLElement} node
   * @param {any} item - Cart line
   */
  #fillLine(node, item) {
    const strings = this.#strings;
    const gift = isGiftLine(item, this.#config.gift?.productId ?? null);
    node.dataset.key = item.key;
    node.dataset.productId = String(item.product_id);
    node.toggleAttribute('data-gift', gift);
    node.toggleAttribute('data-busy', this.#inflight.has(item.key));
    const q = (/** @type {string} */ selector) => node.querySelector(selector);

    const link = q('[data-line-link]');
    if (link instanceof HTMLAnchorElement) link.href = item.url;
    const image = q('[data-line-image]');
    if (image instanceof HTMLImageElement) {
      const src = item.image ? sizedImage(item.image, 200) : '';
      if (src && image.getAttribute('src') !== src) image.src = src;
      image.hidden = !src;
    }

    const title = q('[data-line-title]');
    if (title instanceof HTMLAnchorElement) {
      title.textContent = item.product_title;
      title.href = item.url;
    }
    const badge = q('[data-line-gift]');
    if (badge instanceof HTMLElement) badge.hidden = !gift;

    const variant = q('[data-line-variant]');
    if (variant instanceof HTMLElement) {
      const text = item.product_has_only_default_variant
        ? ''
        : (item.options_with_values ?? []).map((/** @type {any} */ o) => `${o.name}: ${o.value}`).join(' · ');
      variant.textContent = text;
      variant.hidden = !text;
    }

    // Visible line-item properties (BYOB contents, personalization). Keys
    // starting with "_" are private by Shopify convention and stay hidden.
    const props = q('[data-line-props]');
    if (props instanceof HTMLElement) {
      const entries = Object.entries(item.properties ?? {}).filter(
        ([key, value]) => !key.startsWith('_') && value !== null && String(value).trim() !== ''
      );
      props.replaceChildren(
        ...entries.map(([key, value]) => {
          const row = el('div', 'acx-line__prop');
          row.append(el('dt', '', `${key}:`), el('dd', '', String(value)));
          return row;
        })
      );
      props.hidden = entries.length === 0;
    }

    const discounts = q('[data-line-discounts]');
    if (discounts instanceof HTMLElement) {
      const allocations = item.line_level_discount_allocations ?? [];
      discounts.replaceChildren(
        ...allocations.map((/** @type {any} */ allocation) =>
          el('li', '', fill(strings.lineDiscount, { title: allocation.discount_application.title, amount: this.#money(allocation.amount) }))
        )
      );
      discounts.hidden = allocations.length === 0;
    }

    const price = q('[data-line-price]');
    if (price instanceof HTMLElement) {
      const parts = [];
      if (item.original_line_price > item.final_line_price) {
        parts.push(el('span', 'visually-hidden', strings.regularPrice), el('s', 'acx-price acx-price--compare', this.#money(item.original_line_price)));
        parts.push(el('span', 'visually-hidden', strings.salePrice));
      }
      parts.push(el('span', 'acx-price', item.final_line_price === 0 ? strings.free : this.#money(item.final_line_price)));
      if (item.quantity > 1 && item.final_line_price > 0) parts.push(el('span', 'acx-line__unit', fill(strings.each, { price: this.#money(item.final_price) })));
      price.replaceChildren(...parts);
    }

    const qty = q('[data-line-qty]');
    if (qty instanceof HTMLElement) qty.hidden = gift;
    const input = q('[data-line-input]');
    if (input instanceof HTMLInputElement) {
      const pending = this.#pendingQuantity.get(item.key);
      if (document.activeElement !== input || !pending) input.value = String(pending?.quantity ?? item.quantity);
      input.setAttribute('aria-label', fill(strings.quantityFor, { title: item.product_title }));
    }
    q('[data-line-decrease]')?.setAttribute('aria-label', fill(strings.decreaseFor, { title: item.product_title }));
    q('[data-line-increase]')?.setAttribute('aria-label', fill(strings.increaseFor, { title: item.product_title }));
    const remove = q('[data-line-remove]');
    if (remove instanceof HTMLButtonElement) {
      remove.setAttribute('aria-label', fill(gift ? strings.removeGiftFor : strings.removeFor, { title: item.product_title }));
      remove.setAttribute('aria-disabled', String(this.#inflight.has(item.key)));
    }
  }

  /** @param {Event} event */
  increaseLine(event) {
    this.#stepLine(event, 1);
  }

  /** @param {Event} event */
  decreaseLine(event) {
    this.#stepLine(event, -1);
  }

  /**
   * @param {Event} event
   * @param {number} delta
   */
  #stepLine(event, delta) {
    const line = this.#lineFrom(event);
    const input = line?.querySelector('[data-line-input]');
    if (!line || !(input instanceof HTMLInputElement)) return;
    this.#queueQuantity(line, clampQuantity(Number(input.value) + delta));
  }

  /** @param {Event} event */
  inputLine(event) {
    const line = this.#lineFrom(event);
    const input = event.target;
    if (!line || !(input instanceof HTMLInputElement)) return;
    if (input.value.trim() === '' || Number.isNaN(Number(input.value))) {
      const item = this.#item(line.dataset.key);
      input.value = String(item?.quantity ?? 1);
      return;
    }
    this.#queueQuantity(line, clampQuantity(Number(input.value)), 0);
  }

  /** @param {Event} event */
  removeLine(event) {
    const line = this.#lineFrom(event);
    if (!line || this.#inflight.has(line.dataset.key ?? '')) return;
    this.#queueQuantity(line, 0, 0);
  }

  /**
   * Records the wanted quantity and (re)starts the debounce, so a burst of
   * clicks sends one request with the final value.
   * @param {HTMLElement} line
   * @param {number} quantity
   * @param {number} [delay]
   */
  #queueQuantity(line, quantity, delay = QUANTITY_DELAY) {
    const key = line.dataset.key;
    if (!key) return;
    const input = line.querySelector('[data-line-input]');
    if (input instanceof HTMLInputElement) input.value = String(quantity);
    this.#setLineError(line, '');
    const previous = this.#pendingQuantity.get(key);
    if (previous) clearTimeout(previous.timer);
    const timer = window.setTimeout(() => this.#flushQuantity(key), delay);
    this.#pendingQuantity.set(key, { quantity, timer });
  }

  /** @param {string} key */
  async #flushQuantity(key) {
    if (this.#inflight.has(key)) return; // picked up again when the current request settles
    const entry = this.#pendingQuantity.get(key);
    if (!entry) return;
    this.#pendingQuantity.delete(key);
    const item = this.#item(key);
    if (!item) return;
    if (item.quantity === entry.quantity) {
      const line = this.#line(key);
      if (line) this.#fillLine(line, item);
      return;
    }

    this.#inflight.add(key);
    this.#setLineBusy(key, true);
    const title = item.product_title;
    try {
      const cart = await changeLine(this, key, entry.quantity, { reason: entry.quantity === 0 ? 'remove' : 'quantity' });
      const updated = cart.items.find((/** @type {any} */ line) => line.key === key);
      if (entry.quantity === 0) {
        this.#announce(fill(this.#strings.removed, { title }));
      } else if (updated && updated.quantity < entry.quantity) {
        const message = fill(this.#strings.limited, { quantity: updated.quantity, title });
        const line = this.#line(key);
        if (line) this.#setLineError(line, message);
        this.#announce(message);
      } else {
        this.#announce(fill(this.#strings.quantityUpdated, { title, quantity: entry.quantity }));
      }
    } catch (error) {
      const message = (error instanceof Error && error.message) || this.#strings.lineError;
      const line = this.#line(key);
      if (line) this.#setLineError(line, message);
      else this.#showStatus(message);
      this.#announce(message);
    } finally {
      this.#inflight.delete(key);
      this.#setLineBusy(key, false);
      if (this.#pendingQuantity.has(key)) this.#flushQuantity(key);
    }
  }

  /** @param {Event} event */
  #lineFrom(event) {
    const target = event.target;
    const line = target instanceof Element ? target.closest('[data-acx-line]') : null;
    return line instanceof HTMLElement ? line : null;
  }

  /** @param {string | undefined} key */
  #item(key) {
    return this.#cart?.items.find((/** @type {any} */ item) => item.key === key) ?? null;
  }

  /** @param {string} key */
  #line(key) {
    for (const node of this.querySelectorAll('[data-acx-line]')) {
      if (node instanceof HTMLElement && node.dataset.key === key) return node;
    }
    return null;
  }

  /**
   * @param {string} key
   * @param {boolean} busy
   */
  #setLineBusy(key, busy) {
    const line = this.#line(key);
    if (!line) return;
    line.toggleAttribute('data-busy', busy);
    line.setAttribute('aria-busy', String(busy));
    // aria-disabled instead of disabled: a disabled button would drop keyboard focus.
    line.querySelector('[data-line-remove]')?.setAttribute('aria-disabled', String(busy));
  }

  /**
   * @param {HTMLElement} line
   * @param {string} message
   */
  #setLineError(line, message) {
    const error = line.querySelector('[data-line-error]');
    if (!(error instanceof HTMLElement)) return;
    error.textContent = message;
    error.hidden = !message;
  }

  /* ------------------------------------------------------------------ */
  /* Free shipping and gift                                              */
  /* ------------------------------------------------------------------ */

  /** Thresholds are set in the shop currency; convert to the cart's currency. */
  #minorUnits(/** @type {number} */ amount) {
    const rate = Number(window.Shopify?.currency?.rate) || 1;
    return Math.round(amount * 100 * rate);
  }

  /** @param {AjaxCart} cart */
  #renderOffers(cart) {
    const empty = cart.item_count === 0;
    const { freeShipping, gift } = this.#config;

    const shipping = this.querySelector('[data-acx-shipping]');
    if (shipping instanceof HTMLElement) {
      const show = Boolean(freeShipping?.enabled) && !empty;
      shipping.hidden = !show;
      if (show) {
        const state = progress(cart.total_price, this.#minorUnits(freeShipping.threshold));
        shipping.toggleAttribute('data-reached', state.reached);
        this.#setMeter(shipping, state.percent);
        const text = shipping.querySelector('[data-acx-shipping-text]');
        if (text) {
          text.textContent = state.reached
            ? this.#strings.shippingUnlocked
            : fill(this.#strings.shippingRemaining, { amount: this.#money(state.remaining) });
        }
      }
    }

    const giftBox = this.querySelector('[data-acx-gift]');
    if (!(giftBox instanceof HTMLElement)) return;
    const show = Boolean(gift?.enabled && gift.productId) && !empty;
    giftBox.hidden = !show;
    if (!show) return;

    const threshold = this.#minorUnits(gift.threshold);
    const plan = giftPlan(cart, { giftProductId: gift.productId, threshold });
    const state = progress(qualifyingTotal(cart, gift.productId), threshold);
    this.#setMeter(giftBox, state.percent);
    const status = plan.eligible ? (plan.line ? 'added' : 'choose') : 'locked';
    giftBox.dataset.state = status;

    const text = giftBox.querySelector('[data-acx-gift-text]');
    if (text) {
      if (status === 'locked') text.textContent = fill(this.#strings.giftRemaining, { amount: this.#money(state.remaining), gift: gift.title });
      else if (status === 'choose') text.textContent = fill(this.#strings.giftChoose, { gift: gift.title });
      else {
        const variant = plan.line.product_has_only_default_variant ? '' : ` (${plan.line.variant_title})`;
        text.textContent = fill(this.#strings.giftAdded, { gift: `${gift.title}${variant}` });
      }
    }
    const chooser = giftBox.querySelector('[data-acx-gift-choose]');
    if (chooser instanceof HTMLElement) chooser.hidden = status !== 'choose';
  }

  /**
   * @param {HTMLElement} container
   * @param {number} percent
   */
  #setMeter(container, percent) {
    const meter = container.querySelector('[role="progressbar"]');
    if (!(meter instanceof HTMLElement)) return;
    meter.setAttribute('aria-valuenow', String(percent));
    meter.style.setProperty('--acx-progress', `${percent}%`);
  }

  /** @param {Event} event */
  async addGift(event) {
    const { gift } = this.#config;
    const button = event.target instanceof HTMLButtonElement ? event.target : null;
    const chosen = this.querySelector('input[name="acx-gift-variant"]:checked');
    const variantId = Number(chosen instanceof HTMLInputElement ? chosen.value : gift.variants.find((v) => v.available)?.id);
    if (!button || !variantId) return;

    const label = button.querySelector('[data-acx-gift-label]');
    setButtonBusy(button, label instanceof HTMLElement ? label : null, true, this.#strings.adding);
    try {
      const result = await addItems(this, [{ id: variantId, quantity: 1, properties: { [GIFT_PROPERTY]: '1' } }], {
        reason: 'gift',
        open: false,
      });
      if (result.failed.length) this.#showStatus(result.failed[0].message || this.#strings.giftError);
      else this.#announce(fill(this.#strings.giftAdded, { gift: gift.title }));
      const status = this.querySelector('[data-acx-gift-status]');
      if (status instanceof HTMLElement) status.focus({ preventScroll: true });
    } catch {
      this.#showStatus(this.#strings.giftError);
    } finally {
      setButtonBusy(button, label instanceof HTMLElement ? label : null, false, this.#strings.addGift);
    }
  }

  /**
   * Keeps at most one gift, with quantity 1, and only while the cart
   * qualifies. Runs after every cart update; a consistent cart produces no
   * operations, so the updates it triggers settle instead of looping.
   * @param {AjaxCart} cart
   */
  async #reconcileGift(cart) {
    const { gift } = this.#config;
    if (!gift?.enabled || !gift.productId || this.#reconciling) return;
    const plan = giftPlan(cart, { giftProductId: gift.productId, threshold: this.#minorUnits(gift.threshold) });
    if (!plan.ops.length) return;

    this.#reconciling = true;
    try {
      for (const op of plan.ops) {
        await changeLine(this, op.key, op.quantity, { reason: 'gift-sync' });
        if (op.reason === 'not-eligible') this.#announce(this.#strings.giftRemoved);
      }
    } catch {
      this.#showStatus(this.#strings.giftSyncError);
    } finally {
      this.#reconciling = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Totals and discount codes                                           */
  /* ------------------------------------------------------------------ */

  /** @param {AjaxCart} cart */
  #renderTotals(cart) {
    const set = (/** @type {string} */ selector, /** @type {string} */ text) => {
      const node = this.querySelector(selector);
      if (node) node.textContent = text;
    };
    set('[data-acx-subtotal]', this.#money(cart.original_total_price));
    set('[data-acx-savings]', `−${this.#money(cart.total_discount)}`);
    set('[data-acx-total]', this.#money(cart.total_price));
    // Subtotal only adds information when discounts make it differ from the total.
    this.#toggle('[data-acx-savings-row]', !(cart.total_discount > 0));
    this.#toggle('[data-acx-subtotal-row]', !(cart.total_discount > 0));
  }

  /** @param {AjaxCart} cart */
  #renderDiscounts(cart) {
    const list = this.querySelector('[data-acx-codes]');
    const template = this.querySelector('template[data-acx-code-template]');
    if (!(list instanceof HTMLElement) || !(template instanceof HTMLTemplateElement)) return;
    const codes = (cart.discount_codes ?? []).filter((/** @type {any} */ code) => code.applicable);
    list.replaceChildren(
      ...codes.map((/** @type {any} */ { code }) => {
        const node = /** @type {HTMLElement} */ (/** @type {DocumentFragment} */ (template.content.cloneNode(true)).firstElementChild);
        node.dataset.code = code;
        const text = node.querySelector('[data-code-text]');
        if (text) text.textContent = code;
        node.querySelector('[data-code-remove]')?.setAttribute('aria-label', fill(this.#strings.removeCode, { code }));
        return node;
      })
    );
    list.hidden = codes.length === 0;
  }

  /** Codes Shopify currently accepts on this cart. */
  #appliedCodes() {
    return (this.#cart?.discount_codes ?? []).filter((/** @type {any} */ code) => code.applicable).map((/** @type {any} */ code) => code.code);
  }

  /** @param {SubmitEvent} event */
  async applyDiscount(event) {
    event.preventDefault();
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const input = form.elements.namedItem('code');
    const button = form.querySelector('button[type="submit"]');
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) return;
    // Shopify codes are case-insensitive; uppercase keeps the applied pill consistent.
    const code = input.value.trim().toUpperCase();
    const existing = this.#appliedCodes();

    if (!code) {
      this.#discountStatus(this.#strings.discountEmpty, 'error');
      input.focus();
      return;
    }
    if (existing.some((applied) => applied.toLowerCase() === code.toLowerCase())) {
      this.#discountStatus(fill(this.#strings.discountAlready, { code }), 'error');
      return;
    }

    const discountBefore = this.#cart?.total_discount ?? 0;
    setButtonBusy(button, null, true);
    input.setAttribute('aria-invalid', 'false');
    this.#discountStatus(this.#strings.discountChecking, 'info');
    try {
      const cart = await setDiscountCodes(this, [...existing, code]);
      const result = (cart.discount_codes ?? []).find((/** @type {any} */ entry) => entry.code.toLowerCase() === code.toLowerCase());
      if (result?.applicable) {
        input.value = '';
        // Shipping codes are accepted but only change the price at checkout.
        const visible = cart.total_discount > discountBefore;
        this.#discountStatus(fill(visible ? this.#strings.discountApplied : this.#strings.discountAppliedCheckout, { code: result.code }), 'success');
      } else {
        input.setAttribute('aria-invalid', 'true');
        this.#discountStatus(fill(this.#strings.discountInvalid, { code }), 'error');
        // Don't leave a rejected code attached to the cart.
        if (result) await setDiscountCodes(this, existing).catch(() => {});
        input.select();
      }
    } catch {
      this.#discountStatus(this.#strings.discountError, 'error');
    } finally {
      setButtonBusy(button, null, false);
    }
  }

  /** @param {Event} event */
  async removeDiscount(event) {
    const pill = event.target instanceof Element ? event.target.closest('[data-code]') : null;
    const code = pill instanceof HTMLElement ? pill.dataset.code : '';
    if (!code) return;
    const button = event.target instanceof HTMLButtonElement ? event.target : null;
    if (button) setButtonBusy(button, null, true);
    try {
      await setDiscountCodes(this, this.#appliedCodes().filter((applied) => applied !== code));
      this.#discountStatus(fill(this.#strings.discountRemoved, { code }), 'success');
      const input = this.querySelector('[data-acx-discount-input]');
      if (input instanceof HTMLInputElement) input.focus({ preventScroll: true });
    } catch {
      this.#discountStatus(this.#strings.discountError, 'error');
      if (button) setButtonBusy(button, null, false);
    }
  }

  /**
   * @param {string} message
   * @param {'info' | 'success' | 'error'} tone
   */
  #discountStatus(message, tone) {
    const status = this.querySelector('[data-acx-discount-status]');
    if (!(status instanceof HTMLElement)) return;
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = !message;
  }

  /* ------------------------------------------------------------------ */
  /* Upsells                                                             */
  /* ------------------------------------------------------------------ */

  /** @param {AjaxCart} cart */
  #renderUpsells(cart) {
    const section = this.querySelector('[data-acx-upsells]');
    const list = this.querySelector('[data-acx-upsell-list]');
    const template = this.querySelector('template[data-acx-upsell-template]');
    if (!(section instanceof HTMLElement) || !(list instanceof HTMLElement) || !(template instanceof HTMLTemplateElement)) return;

    const giftProductId = this.#config.gift?.enabled ? this.#config.gift.productId : null;
    const recommended = recommendationSeeds(cart, giftProductId).flatMap((id) => this.#recommended.get(id) ?? []);
    const ranked = rankUpsells({
      cart,
      rules: this.#config.rules ?? [],
      recommended,
      fallback: this.#config.fallback ?? [],
      dismissed: this.#dismissed,
      giftProductId,
      limit: this.#config.upsellLimit || 3,
    });
    section.hidden = ranked.length === 0;

    const existing = new Map(
      [...list.children].map((node) => [Number(/** @type {HTMLElement} */ (node).dataset.productId), /** @type {HTMLElement} */ (node)])
    );
    const nodes = ranked.map((product) => {
      let node = existing.get(product.id);
      if (node) existing.delete(product.id);
      else {
        node = /** @type {HTMLElement} */ (/** @type {DocumentFragment} */ (template.content.cloneNode(true)).firstElementChild);
        this.#fillUpsell(node, product);
      }
      return node;
    });
    nodes.forEach((node, index) => {
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
    });
    for (const stale of existing.values()) stale.remove();
  }

  /**
   * @param {HTMLElement} node
   * @param {AcxProduct & { source: string }} product
   */
  #fillUpsell(node, product) {
    const strings = this.#strings;
    node.dataset.productId = String(product.id);
    node.dataset.source = product.source;
    const variantId = this.#upsellVariant.get(product.id) ?? firstAvailableVariant(product).id;
    const variant = product.variants.find((v) => v.id === variantId) ?? firstAvailableVariant(product);
    const q = (/** @type {string} */ selector) => node.querySelector(selector);

    const image = q('[data-upsell-image]');
    if (image instanceof HTMLImageElement) {
      image.src = product.image;
      image.alt = '';
      image.hidden = !product.image;
    }
    const title = q('[data-upsell-title]');
    if (title instanceof HTMLAnchorElement) {
      title.textContent = product.title;
      title.href = product.url;
    }
    q('[data-upsell-price]')?.replaceChildren(priceNodes(variant, strings, this.#money));
    const availability = q('[data-upsell-availability]');
    if (availability) availability.textContent = variant.available ? strings.available : strings.soldOut;

    const select = q('[data-upsell-select]');
    if (select instanceof HTMLSelectElement) {
      const multiple = !product.hasOnlyDefaultVariant && product.variants.length > 1;
      select.hidden = !multiple;
      select.id = `AcxUpsellVariant-${product.id}`;
      const label = q('[data-upsell-select-label]');
      if (label instanceof HTMLLabelElement) {
        label.htmlFor = select.id;
        label.textContent = fill(strings.optionsFor, { title: product.title });
        label.hidden = !multiple;
      }
      if (multiple) fillVariantSelect(select, product, variant.id, strings);
    }
    const add = q('[data-upsell-add]');
    if (add instanceof HTMLButtonElement) {
      add.disabled = !variant.available;
      add.setAttribute('aria-label', fill(strings.addProduct, { title: product.title }));
    }
    q('[data-upsell-dismiss]')?.setAttribute('aria-label', fill(strings.dismissFor, { title: product.title }));
    node.dataset.variantId = String(variant.id);
  }

  /** @param {number} id */
  #upsellProduct(id) {
    const all = [
      ...(this.#config.rules ?? []).flatMap((rule) => rule.products),
      ...[...this.#recommended.values()].flat(),
      ...(this.#config.fallback ?? []),
    ];
    return all.find((product) => product.id === id) ?? null;
  }

  /** @param {Event} event */
  selectUpsellVariant(event) {
    const node = event.target instanceof Element ? event.target.closest('[data-acx-upsell]') : null;
    const select = event.target;
    if (!(node instanceof HTMLElement) || !(select instanceof HTMLSelectElement)) return;
    const product = this.#upsellProduct(Number(node.dataset.productId));
    if (!product) return;
    this.#upsellVariant.set(product.id, Number(select.value));
    this.#fillUpsell(node, { ...product, source: node.dataset.source ?? '' });
  }

  /** @param {Event} event */
  async addUpsell(event) {
    const node = event.target instanceof Element ? event.target.closest('[data-acx-upsell]') : null;
    const button = event.target instanceof HTMLButtonElement ? event.target : null;
    if (!(node instanceof HTMLElement) || !button) return;
    const productId = Number(node.dataset.productId);
    const variantId = Number(node.dataset.variantId);
    const label = button.querySelector('[data-upsell-add-label]');
    setButtonBusy(button, label instanceof HTMLElement ? label : null, true, this.#strings.adding);
    try {
      const result = await addItems(this, [{ id: variantId, quantity: 1 }], { reason: 'upsell', open: false });
      if (result.failed.length) {
        this.#showStatus(result.failed[0].message || this.#strings.addError);
      } else {
        const title = this.#upsellProduct(productId)?.title ?? '';
        this.#announce(fill(this.#strings.added, { items: title }));
        // The card leaves the list; put focus on the line it became.
        const line = this.querySelector(`[data-acx-line][data-product-id="${productId}"] [data-line-title]`);
        if (line instanceof HTMLElement) line.focus({ preventScroll: false });
      }
    } catch (error) {
      this.#showStatus((error instanceof Error && error.message) || this.#strings.addError);
    } finally {
      if (button.isConnected) setButtonBusy(button, label instanceof HTMLElement ? label : null, false, this.#strings.add);
    }
  }

  /** @param {Event} event */
  dismissUpsell(event) {
    const node = event.target instanceof Element ? event.target.closest('[data-acx-upsell]') : null;
    if (!(node instanceof HTMLElement) || !this.#cart) return;
    const next = node.nextElementSibling ?? node.previousElementSibling;
    const nextId = next instanceof HTMLElement ? next.dataset.productId : null;
    this.#dismissed.add(Number(node.dataset.productId));
    writeSession(DISMISSED_KEY, [...this.#dismissed]);
    this.#renderUpsells(this.#cart);
    this.#announce(this.#strings.dismissed);
    const target =
      (nextId && this.querySelector(`[data-acx-upsell][data-product-id="${nextId}"] [data-upsell-add]`)) ||
      this.querySelector('[data-acx-upsell] [data-upsell-add]') ||
      this.querySelector('[data-acx-title]');
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  }

  /**
   * Fetches Shopify's related-product recommendations for the newest cart
   * products, once per product, and re-ranks when they arrive.
   * @param {AjaxCart} cart
   */
  async #loadRecommendations(cart) {
    const { useRecommendations, recommendationsUrl, recommendationTag } = this.#config;
    if (!useRecommendations || !recommendationsUrl) return;
    const giftProductId = this.#config.gift?.enabled ? this.#config.gift.productId : null;
    const seeds = recommendationSeeds(cart, giftProductId).filter((id) => !this.#recommendationRequests.has(id));
    if (!seeds.length) return;

    await Promise.all(
      seeds.map((id) => {
        const url = new URL(`${recommendationsUrl}.json`, window.location.origin);
        url.searchParams.set('product_id', String(id));
        url.searchParams.set('limit', '6');
        url.searchParams.set('intent', 'related');
        const request = fetch(url, { headers: { Accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : { products: [] }))
          .then((data) =>
            (data.products ?? [])
              .filter((/** @type {any} */ product) => !recommendationTag || (product.tags ?? []).includes(recommendationTag))
              .map(fromAjaxProduct)
          )
          .catch(() => []);
        this.#recommendationRequests.set(id, request);
        return request.then((products) => this.#recommended.set(id, products));
      })
    );
    if (this.#cart) this.#renderUpsells(this.#cart);
  }

  /* ------------------------------------------------------------------ */
  /* Status                                                              */
  /* ------------------------------------------------------------------ */

  /** @param {string} message */
  #showStatus(message) {
    const status = this.querySelector('[data-acx-status]');
    if (!(status instanceof HTMLElement)) return;
    const text = status.querySelector('[data-acx-status-text]');
    if (text) text.textContent = message || this.#strings.genericError;
    status.hidden = false;
  }

  #hideStatus() {
    const status = this.querySelector('[data-acx-status]');
    if (status instanceof HTMLElement) status.hidden = true;
  }

  dismissStatus() {
    this.#hideStatus();
    this.querySelector('[data-acx-title]')?.focus({ preventScroll: true });
  }

  /** @param {string} message */
  #announce(message) {
    const region = this.querySelector('[data-acx-announcer]');
    if (!region || !message) return;
    region.textContent = '';
    requestAnimationFrame(() => (region.textContent = message));
  }
}

/** @param {string} key */
function readSession(key) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode); dismissals then last for this page view.
  }
}

if (!customElements.get('acx-cart-drawer-component')) {
  customElements.define('acx-cart-drawer-component', AcxCartDrawerComponent);
}
