import { Component } from '@theme/component';
import { formatMoney } from '@theme/money-formatting';
import { clampQuantity, defaultVariant, selectOption, variantSummary } from '@theme/stl-model';
import { addToCart } from '@theme/stl-cart';
import { fill, priceNodes, renderCard } from '@theme/stl-card';

const POPOVER_LAYOUT = '(min-width: 750px)';
const POPOVER_MIN_MEDIA_WIDTH = 600;
const CARD_GAP = 26;
const EDGE = 12;

/**
 * @typedef {object} ItemState
 * @property {string} id - Hotspot block ID
 * @property {string} lookId
 * @property {number} index - 1-based position in the look
 * @property {import('@theme/stl-model').StlProduct} product
 * @property {import('@theme/stl-model').StlVariant} variant - Currently selected variant
 * @property {number} quantity
 * @property {boolean} include - Included in "Add all"
 * @property {boolean} added
 * @property {HTMLButtonElement} hotspot
 * @property {HTMLElement} listItem
 */

/**
 * Shop the Look: lifestyle images with product hotspots, a synced product list,
 * a product card (popover on desktop, bottom sheet on mobile), single and
 * "add all" AJAX add-to-cart.
 *
 * Product data comes from JSON rendered by each `_stl-hotspot` block, so the
 * merchant's Theme Editor configuration is the single source of truth.
 *
 * @extends {Component}
 */
class StlLooksComponent extends Component {
  /** @type {Record<string, string>} */
  #strings = {};
  /** @type {Map<string, ItemState>} */
  #items = new Map();
  /** @type {HTMLDialogElement | null} */
  #dialog = null;
  /** @type {string | null} */
  #activeId = null;
  /** @type {HTMLElement | null} */
  #opener = null;
  /** Close events triggered by the component itself, still to arrive. */
  #busy = false;
  /** @type {AbortController | null} */
  #listeners = null;
  /** @type {AbortController | null} */
  #request = null;

  connectedCallback() {
    super.connectedCallback();
    this.#strings = readJson(this.querySelector('[data-stl-strings]')) ?? {};
    this.#dialog = this.querySelector('[data-stl-dialog]');
    this.#items.clear();

    const template = this.querySelector('template[data-stl-item-template]');
    for (const look of this.querySelectorAll('[data-look]')) {
      if (!(look instanceof HTMLElement)) continue;
      const lookId = look.dataset.look ?? '';
      const list = look.querySelector('[data-look-list]');
      let index = 0;
      for (const hotspot of look.querySelectorAll('[data-hotspot]')) {
        if (!(hotspot instanceof HTMLButtonElement)) continue;
        const id = hotspot.dataset.hotspot ?? '';
        const product = readJson(look.querySelector(`[data-stl-product="${id}"]`));
        if (!product?.variants?.length) continue;
        index += 1;
        const number = hotspot.querySelector('[data-hotspot-number]');
        if (number) number.textContent = String(index);

        const listItem = /** @type {HTMLElement} */ (
          /** @type {DocumentFragment} */ (template instanceof HTMLTemplateElement ? template.content.cloneNode(true) : null)
            ?.firstElementChild
        );
        if (!listItem) continue;
        listItem.dataset.itemId = id;
        list?.append(listItem);

        const variant = defaultVariant(product);
        /** @type {ItemState} */
        const state = {
          id,
          lookId,
          index,
          product,
          variant,
          quantity: 1,
          include: Boolean(variant?.available),
          added: false,
          hotspot,
          listItem,
        };
        this.#items.set(id, state);
        this.#renderItem(state);
      }
      this.#renderTotal(lookId);
    }

    this.#buildTabs();
    this.#dialog?.addEventListener('close', this.#handleDialogClose);
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    document.addEventListener('keydown', this.#handleKeydown, { signal });
    document.addEventListener('pointerdown', this.#handlePointerDown, { signal });
    window.addEventListener('resize', this.#handleResize, { signal });
    document.addEventListener('shopify:block:select', this.#handleEditorSelect, { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#listeners?.abort();
    this.#request?.abort();
    this.#dialog?.removeEventListener('close', this.#handleDialogClose);
  }

  /* ---------------- Look switching ---------------- */

  /**
   * Builds the ARIA tabs from the look blocks. Nested theme-block settings can't
   * be read from the section in Liquid, so each look exposes its title and
   * thumbnail as data attributes instead.
   */
  #buildTabs() {
    const tablist = this.querySelector('[data-stl-tabs]');
    const looks = [...this.querySelectorAll('[data-look]')].filter((l) => l instanceof HTMLElement);
    if (!(tablist instanceof HTMLElement)) return;
    if (looks.length < 2) {
      // A single look is not a tab set.
      for (const look of looks) {
        look.removeAttribute('role');
        look.removeAttribute('aria-labelledby');
      }
      return;
    }

    const fragment = document.createDocumentFragment();
    looks.forEach((look, index) => {
      const id = look.dataset.look ?? '';
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'stl-tab';
      tab.id = `StlTab-${id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', look.id);
      tab.setAttribute('aria-selected', String(!look.hidden));
      tab.tabIndex = look.hidden ? -1 : 0;
      tab.dataset.lookTarget = id;
      tab.setAttribute('on:click', '/selectLook');

      if (look.dataset.lookThumb) {
        const img = document.createElement('img');
        img.className = 'stl-tab__thumb';
        img.src = look.dataset.lookThumb;
        img.alt = '';
        img.width = 56;
        img.height = 56;
        img.loading = 'lazy';
        tab.append(img);
      }
      const text = document.createElement('span');
      text.className = 'stl-tab__text';
      const kicker = document.createElement('span');
      kicker.className = 'stl-tab__kicker';
      kicker.textContent = fill(this.#strings.lookNumber, { number: index + 1 });
      const title = document.createElement('span');
      title.className = 'stl-tab__title';
      title.textContent = look.dataset.lookTitle ?? '';
      text.append(kicker, title);
      tab.append(text);
      fragment.append(tab);
    });
    tablist.replaceChildren(fragment);
    tablist.hidden = false;
  }

  /** @param {Event} event */
  selectLook(event) {
    const tab = event.target instanceof Element ? event.target.closest('[data-look-target]') : null;
    if (tab instanceof HTMLElement) this.showLook(tab.dataset.lookTarget ?? '');
  }

  /**
   * Arrow keys, Home and End move between looks (ARIA tabs pattern).
   * @param {KeyboardEvent} event
   */
  handleTabKeydown(event) {
    const tabs = [...this.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(/** @type {Element} */ (document.activeElement));
    if (current < 0) return;
    let next = current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = /** @type {HTMLElement} */ (tabs[next]);
    tab.focus();
    this.showLook(tab.dataset.lookTarget ?? '');
  }

  /**
   * Public: show a look by block ID.
   * @param {string} lookId
   */
  showLook(lookId) {
    const panel = this.querySelector(`[data-look="${lookId}"]`);
    if (!panel) return;
    this.#close(false);
    for (const tab of this.querySelectorAll('[role="tab"]')) {
      if (!(tab instanceof HTMLElement)) continue;
      const selected = tab.dataset.lookTarget === lookId;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const look of this.querySelectorAll('[data-look]')) {
      if (look instanceof HTMLElement) look.hidden = look.dataset.look !== lookId;
    }
  }

  /* ---------------- Hotspots, list and card ---------------- */

  /** @param {Event} event */
  selectHotspot(event) {
    const hotspot = event.target instanceof Element ? event.target.closest('[data-hotspot]') : null;
    if (!(hotspot instanceof HTMLElement)) return;
    const id = hotspot.dataset.hotspot ?? '';
    // A second click on the open hotspot closes its card.
    if (this.#dialog?.open && this.#activeId === id) {
      this.#close(true);
      return;
    }
    this.open(id, hotspot);
  }

  /** @param {Event} event */
  viewItem(event) {
    const item = this.#itemFromEvent(event);
    if (item) this.open(item.id, /** @type {HTMLElement} */ (event.target));
  }

  /**
   * Public: open the product card for a hotspot.
   * @param {string} id
   * @param {HTMLElement} [opener]
   */
  open(id, opener) {
    const item = this.#items.get(id);
    const dialog = this.#dialog;
    if (!item || !dialog) return;
    if (dialog.open) this.#close(false);

    this.#activeId = id;
    this.#opener = opener ?? item.hotspot;
    this.#setActive(id);
    this.#hideStatus();
    this.#renderCard(item);

    const media = item.hotspot.closest('[data-look-media]');
    const usePopover =
      matchMedia(POPOVER_LAYOUT).matches && media instanceof HTMLElement && media.clientWidth >= POPOVER_MIN_MEDIA_WIDTH;

    if (usePopover) {
      dialog.dataset.mode = 'popover';
      media.append(dialog);
      dialog.show();
      this.#position(item);
      if (opener && !item.hotspot.contains(opener)) media.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      dialog.dataset.mode = 'sheet';
      dialog.style.removeProperty('left');
      dialog.style.removeProperty('top');
      this.append(dialog);
      dialog.showModal();
    }
    item.hotspot.setAttribute('aria-expanded', 'true');
    dialog.querySelector('[data-card-title]')?.focus({ preventScroll: true });
  }

  closeCard() {
    this.#close(true);
  }

  /** @param {Event} event */
  selectCardOption(event) {
    const input = event.target;
    const item = this.#activeItem();
    if (!(input instanceof HTMLInputElement) || !item) return;
    item.variant = selectOption(item.product, item.variant, Number(input.dataset.optionIndex), input.value);
    if (!item.variant.available) item.include = false;
    else if (!item.added) item.include = true;
    this.#renderCard(item, true);
    this.#renderItem(item);
    this.#renderTotal(item.lookId);
  }

  decreaseQuantity() {
    this.#setQuantity((this.#activeItem()?.quantity ?? 1) - 1);
  }

  increaseQuantity() {
    this.#setQuantity((this.#activeItem()?.quantity ?? 1) + 1);
  }

  /** @param {Event} event */
  changeQuantity(event) {
    if (event.target instanceof HTMLInputElement) this.#setQuantity(Number(event.target.value));
  }

  /** @param {Event} event */
  toggleInclude(event) {
    const item = this.#itemFromEvent(event);
    if (!item || !(event.target instanceof HTMLInputElement)) return;
    item.include = event.target.checked && item.variant.available;
    this.#renderTotal(item.lookId);
  }

  /* ---------------- Cart ---------------- */

  async addFromCard() {
    const item = this.#activeItem();
    if (item) await this.#add([item], 'card');
  }

  /** @param {Event} event */
  async addFromList(event) {
    const item = this.#itemFromEvent(event);
    if (item) await this.#add([item], 'list');
  }

  /** @param {Event} event */
  async addAll(event) {
    const look = event.target instanceof Element ? event.target.closest('[data-look]') : null;
    if (!(look instanceof HTMLElement)) return;
    const items = this.#lookItems(look.dataset.look ?? '').filter((i) => i.include && i.variant.available);
    if (!items.length) {
      this.#setLookStatus(look.dataset.look ?? '', this.#strings.nothingSelected, 'error');
      return;
    }
    await this.#add(items, 'all');
  }

  /**
   * @param {ItemState[]} items
   * @param {'card' | 'list' | 'all'} source
   */
  async #add(items, source) {
    if (this.#busy) return;
    this.#busy = true;
    const lookId = items[0]?.lookId ?? '';
    this.#setBusy(items, source, true);

    this.#request?.abort();
    this.#request = new AbortController();
    try {
      const result = await addToCart(
        this,
        items.map((i) => ({ id: i.variant.id, quantity: i.quantity })),
        this.#request.signal
      );
      const addedIds = new Set(result.added.map((line) => line.id));
      const added = items.filter((i) => addedIds.has(i.variant.id));
      const failed = items.filter((i) => !addedIds.has(i.variant.id));
      for (const item of added) {
        item.added = true;
        this.#renderItem(item);
      }

      if (source === 'card') {
        this.#setCardStatus(failed.length ? this.#strings.error : this.#strings.addedToCart, failed.length ? 'error' : 'success');
      }
      if (source === 'all') {
        const skippedTitles = [
          ...failed.map((i) => i.product.title),
          ...this.#lookItems(lookId).filter((i) => !i.variant.available).map((i) => i.product.title),
        ];
        const addedText =
          added.length === 1 ? this.#strings.addedAllOne : fill(this.#strings.addedAllOther, { count: added.length });
        const message = [added.length ? addedText : this.#strings.error, skippedTitles.length ? fill(this.#strings.skipped, { items: skippedTitles.join(', ') }) : '']
          .filter(Boolean)
          .join('. ');
        this.#setLookStatus(lookId, message, added.length ? 'success' : 'error');
      }
      if (source === 'list' && failed.length) this.#setLookStatus(lookId, this.#strings.error, 'error');
      this.#announce(added.length ? `${this.#strings.addedToCart}: ${added.map((i) => i.product.title).join(', ')}` : this.#strings.error);
    } catch (error) {
      if (this.#request?.signal.aborted) return;
      console.error(error);
      if (source === 'card') this.#setCardStatus(this.#strings.error, 'error');
      else this.#setLookStatus(lookId, this.#strings.error, 'error');
    } finally {
      this.#busy = false;
      this.#setBusy(items, source, false);
      this.#renderTotal(lookId);
    }
  }

  /* ---------------- Rendering ---------------- */

  /**
   * @param {ItemState} item
   * @param {boolean} [keepFocus] - Re-render without moving focus (after a variant change)
   */
  #renderCard(item, keepFocus = false) {
    if (!this.#dialog) return;
    const focusedValue = keepFocus && document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    const focusKey = focusedValue ? `${focusedValue.dataset.optionIndex}|${focusedValue.value}` : '';
    renderCard(this.#dialog, {
      product: item.product,
      variant: item.variant,
      quantity: item.quantity,
      strings: this.#strings,
      money: this.#money,
      uid: item.id,
    });
    if (focusKey) {
      const [index, value] = focusKey.split('|');
      const again = [...this.#dialog.querySelectorAll(`input[data-option-index="${index}"]`)].find(
        (i) => i instanceof HTMLInputElement && i.value === value
      );
      if (again instanceof HTMLElement) again.focus();
    }
  }

  /** @param {ItemState} item */
  #renderItem(item) {
    const li = item.listItem;
    const q = (s) => li.querySelector(s);
    const { product, variant } = item;
    const available = variant.available;

    li.toggleAttribute('data-unavailable', !available);
    const image = /** @type {HTMLImageElement | null} */ (q('[data-item-image]'));
    const src = variant.image || product.image;
    if (image && src && image.getAttribute('src') !== src) image.src = src;

    const number = q('[data-item-number]');
    if (number) number.textContent = String(item.index);
    const title = q('[data-item-title]');
    if (title) title.textContent = product.title;
    const summary = variantSummary(product, variant);
    const variantText = q('[data-item-variant]');
    if (variantText) {
      variantText.textContent = [summary, item.quantity > 1 ? `× ${item.quantity}` : ''].filter(Boolean).join(' · ');
    }
    q('[data-item-price]')?.replaceChildren(priceNodes(variant, this.#strings, this.#money, { badges: false }));

    const view = q('[data-item-view]');
    view?.setAttribute('aria-label', fill(this.#strings.viewProduct, { product: product.title }));
    view?.setAttribute('aria-haspopup', 'dialog');

    const include = /** @type {HTMLInputElement | null} */ (q('[data-item-include]'));
    if (include) {
      include.checked = item.include && available;
      include.disabled = !available;
    }
    const includeLabel = q('[data-item-include-label]');
    if (includeLabel) includeLabel.textContent = fill(this.#strings.include, { product: product.title });

    const add = /** @type {HTMLButtonElement | null} */ (q('[data-item-add]'));
    if (add) {
      add.disabled = !available;
      add.setAttribute('aria-label', fill(this.#strings.addProduct, { product: product.title }));
    }

    const badge = q('[data-item-badge]');
    if (badge instanceof HTMLElement) {
      badge.hidden = available && !item.added;
      badge.dataset.tone = available ? 'success' : 'muted';
      badge.textContent = available ? `✓ ${this.#strings.added}` : this.#strings.soldOut;
    }
    item.hotspot.toggleAttribute('data-added', item.added);
  }

  /** @param {string} lookId */
  #renderTotal(lookId) {
    const look = this.querySelector(`[data-look="${lookId}"]`);
    if (!look) return;
    const chosen = this.#lookItems(lookId).filter((i) => i.include && i.variant.available);
    const total = chosen.reduce((sum, i) => sum + i.variant.price * i.quantity, 0);
    const totalEl = look.querySelector('[data-look-total]');
    if (totalEl) totalEl.textContent = this.#money(total);
    const label = look.querySelector('[data-look-addall-label]');
    if (label && !this.#busy) {
      label.textContent =
        chosen.length === 1 ? this.#strings.addAllSelectedOne : fill(this.#strings.addAllSelectedOther, { count: chosen.length });
    }
    const button = look.querySelector('[data-look-addall-button]');
    if (button instanceof HTMLButtonElement) button.disabled = this.#busy || chosen.length === 0;
  }

  /**
   * @param {ItemState[]} items
   * @param {'card' | 'list' | 'all'} source
   * @param {boolean} busy
   */
  #setBusy(items, source, busy) {
    if (source === 'card' && this.#dialog) {
      const button = this.#dialog.querySelector('[data-card-add]');
      const label = this.#dialog.querySelector('[data-card-add-label]');
      if (button instanceof HTMLButtonElement) button.disabled = busy || !this.#activeItem()?.variant.available;
      if (label) label.textContent = busy ? this.#strings.adding : this.#strings.addToCart;
    }
    if (source === 'list') {
      for (const item of items) {
        const button = item.listItem.querySelector('[data-item-add]');
        if (button instanceof HTMLButtonElement) button.disabled = busy || !item.variant.available;
      }
    }
    if (source === 'all') {
      const look = this.querySelector(`[data-look="${items[0]?.lookId}"]`);
      const label = look?.querySelector('[data-look-addall-label]');
      const button = look?.querySelector('[data-look-addall-button]');
      if (busy && label) label.textContent = this.#strings.addingAll;
      if (button instanceof HTMLButtonElement) button.disabled = busy;
    }
  }

  /** Places the popover card beside its hotspot, inside the image bounds. */
  #position(item) {
    const dialog = this.#dialog;
    const media = item.hotspot.closest('[data-look-media]');
    if (!dialog || !(media instanceof HTMLElement)) return;
    const mw = media.clientWidth;
    const mh = media.clientHeight;
    const cw = dialog.offsetWidth;
    const ch = Math.min(dialog.scrollHeight, mh - EDGE * 2);
    const hx = (Number(item.hotspot.dataset.x) / 100) * mw;
    const hy = (Number(item.hotspot.dataset.y) / 100) * mh;

    let left = hx + CARD_GAP;
    if (left + cw > mw - EDGE) left = hx - CARD_GAP - cw;
    left = Math.min(Math.max(EDGE, left), mw - cw - EDGE);
    const top = Math.min(Math.max(EDGE, hy - ch / 2), mh - ch - EDGE);
    dialog.style.left = `${Math.round(left)}px`;
    dialog.style.top = `${Math.round(top)}px`;
  }

  /** @param {string} id */
  #setActive(id) {
    for (const item of this.#items.values()) {
      const active = item.id === id;
      item.listItem.toggleAttribute('data-active', active);
      item.hotspot.toggleAttribute('data-active', active);
      if (!active) item.hotspot.setAttribute('aria-expanded', 'false');
    }
  }

  /* ---------------- Dialog lifecycle ---------------- */

  /**
   * Closes the card and cleans up synchronously. The native `close` event fires
   * asynchronously, so it is only acted on while the card is still closed and
   * still has an active item (a native Escape close on the modal sheet).
   * @param {boolean} returnFocus
   */
  #close(returnFocus) {
    if (!this.#dialog?.open) return;
    this.#dialog.close();
    this.#afterClose(returnFocus);
  }

  /** Native closes (Escape on the modal sheet) arrive here. */
  #handleDialogClose = () => {
    if (this.#dialog?.open || this.#activeId === null) return;
    this.#afterClose(true);
  };

  /** @param {boolean} returnFocus */
  #afterClose(returnFocus) {
    const item = this.#activeItem();
    if (item) {
      item.hotspot.setAttribute('aria-expanded', 'false');
      item.hotspot.removeAttribute('data-active');
    }
    if (returnFocus && this.#opener?.isConnected) this.#opener.focus({ preventScroll: true });
    this.#activeId = null;
  }

  /** @param {KeyboardEvent} event */
  #handleKeydown = (event) => {
    // Modal sheets close on Escape natively; the desktop popover needs this.
    if (event.key === 'Escape' && this.#dialog?.open && this.#dialog.dataset.mode === 'popover') {
      event.preventDefault();
      this.#close(true);
    }
  };

  /** @param {PointerEvent} event */
  #handlePointerDown = (event) => {
    const dialog = this.#dialog;
    if (!dialog?.open) return;
    const target = event.target instanceof Element ? event.target : null;
    if (dialog.dataset.mode === 'sheet') {
      // Tap on the backdrop (the dialog element itself, outside its content box).
      if (target === dialog) {
        const r = dialog.getBoundingClientRect();
        if (event.clientY < r.top) this.#close(true);
      }
      return;
    }
    if (target && !dialog.contains(target) && !target.closest('[data-hotspot], [data-item-view]')) this.#close(false);
  };

  #handleResize = () => {
    const item = this.#activeItem();
    if (!item || !this.#dialog?.open) return;
    const wantsPopover = matchMedia(POPOVER_LAYOUT).matches;
    if (wantsPopover !== (this.#dialog.dataset.mode === 'popover')) this.#close(false);
    else if (wantsPopover) this.#position(item);
  };

  /** Theme editor: selecting a look or hotspot block shows it. */
  #handleEditorSelect = (/** @type {CustomEvent} */ event) => {
    const id = event.detail?.blockId;
    if (!id) return;
    if (this.querySelector(`[data-look="${id}"]`)) {
      this.showLook(id);
      return;
    }
    const item = this.#items.get(id);
    if (item) {
      this.showLook(item.lookId);
      this.open(item.id);
    }
  };

  /* ---------------- Helpers ---------------- */

  #activeItem() {
    return this.#activeId ? this.#items.get(this.#activeId) ?? null : null;
  }

  /** @param {Event} event */
  #itemFromEvent(event) {
    const li = event.target instanceof Element ? event.target.closest('[data-item]') : null;
    return li instanceof HTMLElement ? this.#items.get(li.dataset.itemId ?? '') ?? null : null;
  }

  /** @param {string} lookId */
  #lookItems(lookId) {
    return [...this.#items.values()].filter((i) => i.lookId === lookId);
  }

  /** @param {number} value */
  #setQuantity(value) {
    const item = this.#activeItem();
    if (!item) return;
    item.quantity = clampQuantity(value);
    this.#renderCard(item, true);
    this.#renderItem(item);
    this.#renderTotal(item.lookId);
  }

  /**
   * @param {string} message
   * @param {'success' | 'error'} tone
   */
  #setCardStatus(message, tone) {
    const status = this.#dialog?.querySelector('[data-card-status]');
    if (!(status instanceof HTMLElement)) return;
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = false;
  }

  #hideStatus() {
    const status = this.#dialog?.querySelector('[data-card-status]');
    if (status instanceof HTMLElement) status.hidden = true;
  }

  /**
   * @param {string} lookId
   * @param {string} message
   * @param {'success' | 'error'} tone
   */
  #setLookStatus(lookId, message, tone) {
    const status = this.querySelector(`[data-look="${lookId}"] [data-look-addall-status]`);
    if (!(status instanceof HTMLElement)) return;
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = false;
  }

  /** @param {string} message */
  #announce(message) {
    const region = this.querySelector('[data-stl-announcer]');
    if (!region) return;
    region.textContent = '';
    requestAnimationFrame(() => (region.textContent = message));
  }

  /** @param {number} cents */
  #money = (cents) =>
    formatMoney(cents, this.dataset.moneyFormat || '${{amount}}', this.dataset.currency || 'USD');
}

/** @param {Element | null} element */
function readJson(element) {
  try {
    return JSON.parse(element?.textContent || 'null');
  } catch {
    return null;
  }
}

if (!customElements.get('stl-looks-component')) {
  customElements.define('stl-looks-component', StlLooksComponent);
}
