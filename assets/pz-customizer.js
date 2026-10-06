import { Component } from '@theme/component';
import { formatMoney } from '@theme/money-formatting';
import {
  buildCartItems,
  checkMessage,
  defaultDesign,
  findVariant,
  isOptionAvailable,
  lowestPrice,
  pricing,
  sanitize,
  validate,
} from '@theme/pz-model';
import { renderPreview } from '@theme/pz-preview';
import { addItemsToCart, openCart, PzCartError } from '@theme/pz-cart';

const STORAGE_VERSION = 1;
/** @type {Record<string, 0 | 1 | 2>} */
const OPTION_INDEX = { style: 0, color: 1, size: 2 };

/**
 * Product Personalizer: a gift box customer-designed from real variants, a
 * personal message and add-on products, with a live SVG preview.
 *
 * The design lives in one object; every handler updates it and calls #render(),
 * which writes only the DOM that depends on it. Errors for unselected options
 * appear after the first add-to-cart attempt; message errors appear as you type.
 *
 * @extends {Component}
 */
class PzCustomizerComponent extends Component {
  requiredRefs = ['catalog', 'strings', 'preview', 'messageInput', 'quantityInput', 'total', 'submit', 'errors', 'errorList'];

  /** @type {import('@theme/pz-model').Catalog & { swatches: Array<{ value: string, hex: string, ink: string }> }} */
  #catalog = { product: { id: 0, title: '' }, variants: [], addons: [], swatches: [], maxChars: 30, maxQuantity: 20 };

  /** @type {Record<string, any>} */
  #strings = {};

  /** @type {import('@theme/pz-model').Design} */
  #design = defaultDesign();

  #attempted = false;
  #isSubmitting = false;
  /** @type {AbortController | null} */
  #request = null;

  connectedCallback() {
    super.connectedCallback();

    this.#catalog = { ...this.#catalog, ...readJson(this.refs.catalog) };
    this.#strings = readJson(this.refs.strings);

    const fallback = this.#defaults();
    const saved = this.#load();
    this.#design = sanitize(this.#catalog, saved, fallback);
    if (this.refs.restored) this.refs.restored.hidden = !saved || JSON.stringify(this.#design) === JSON.stringify(fallback);

    this.#syncInputs();
    this.#render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#request?.abort();
  }

  /* ---------------- Event handlers (routed via on:* attributes) ---------------- */

  /** @param {Event} event */
  selectOption(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const option = /** @type {'style' | 'color' | 'size'} */ (input.dataset.option);
    if (!(option in OPTION_INDEX)) return;
    this.#update({ [option]: input.value });
  }

  /** @param {Event} event */
  handleMessage(event) {
    if (event.target instanceof HTMLInputElement) this.#update({ message: event.target.value });
  }

  /** @param {Event} event */
  selectLettering(event) {
    if (event.target instanceof HTMLInputElement) this.#update({ lettering: /** @type {any} */ (event.target.value) });
  }

  /** @param {Event} event */
  selectMotif(event) {
    if (event.target instanceof HTMLInputElement) this.#update({ motif: /** @type {any} */ (event.target.value) });
  }

  /** @param {Event} event */
  toggleAddon(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const id = Number(input.value);
    const addons = input.checked ? [...new Set([...this.#design.addons, id])] : this.#design.addons.filter((a) => a !== id);
    this.#update({ addons });
  }

  decrease() {
    this.#setQuantity(this.#safeQuantity() - 1);
  }

  increase() {
    this.#setQuantity(this.#safeQuantity() + 1);
  }

  /** @param {Event} event */
  handleQuantity(event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const raw = event.target.value.trim();
    // Keep invalid values (empty, 0, decimals) in state so validation can explain them.
    this.#update({ quantity: raw === '' ? NaN : Number(raw) });
  }

  normalizeQuantity() {
    this.#setQuantity(this.#safeQuantity());
  }

  /** @param {Event} event */
  handleSubmit(event) {
    event.preventDefault();
    this.addToCart();
  }

  async addToCart() {
    if (this.#isSubmitting) return;
    this.#attempted = true;
    this.#hideSuccess();

    const errors = validate(this.#catalog, this.#design);
    if (errors.length) {
      this.#render();
      this.refs.errors.focus();
      return;
    }

    const items = buildCartItems(
      this.#catalog,
      this.#design,
      this.#strings.properties,
      {
        lettering: this.#strings.lettering?.[this.#design.lettering] ?? this.#design.lettering,
        motif: this.#strings.motif?.[this.#design.motif] ?? this.#design.motif,
      },
      createBundleId()
    );
    if (!items) return;

    this.#isSubmitting = true;
    this.#render();
    this.#request?.abort();
    this.#request = new AbortController();

    try {
      await addItemsToCart(this, items, this.#request.signal);
      if (this.refs.success) this.refs.success.hidden = false;
      this.#announce(this.#strings.added);
    } catch (error) {
      if (this.#request?.signal.aborted) return;
      console.error(error);
      const message = error instanceof PzCartError && error.message ? error.message : this.#strings.errors?.generic;
      this.#showErrors([message]);
      this.refs.errors.focus();
    } finally {
      this.#isSubmitting = false;
      this.#render();
    }
  }

  viewCart() {
    openCart();
  }

  reset() {
    this.#attempted = false;
    this.#design = this.#defaults();
    this.#save();
    if (this.refs.restored) this.refs.restored.hidden = true;
    this.#hideSuccess();
    this.#syncInputs();
    this.#render();
  }

  /** @param {Event} event */
  focusField(event) {
    const field = event.target instanceof HTMLElement ? event.target.dataset.focusField : '';
    const target = this.#fieldControl(field ?? '');
    target?.focus();
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---------------- State ---------------- */

  #defaults() {
    const first = this.#catalog.variants.find((v) => v.available) ?? this.#catalog.variants[0];
    // Style and colour start pre-selected so the preview has something to show;
    // size is a deliberate choice because it changes the price.
    return defaultDesign({ style: first?.options[0] ?? null, color: first?.options[1] ?? null });
  }

  /** @param {Partial<import('@theme/pz-model').Design>} changes */
  #update(changes) {
    this.#design = { ...this.#design, ...changes };
    this.#hideSuccess();
    this.#save();
    this.#render();
  }

  #safeQuantity() {
    const q = this.#design.quantity;
    return Number.isFinite(q) ? Math.round(q) : 1;
  }

  /** @param {number} value */
  #setQuantity(value) {
    const quantity = Math.min(Math.max(1, value), this.#catalog.maxQuantity);
    this.refs.quantityInput.value = String(quantity);
    this.#update({ quantity });
  }

  #load() {
    try {
      const raw = window.localStorage.getItem(this.dataset.storageKey ?? '');
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed?.version === STORAGE_VERSION ? parsed.design : null;
    } catch {
      return null;
    }
  }

  #save() {
    try {
      window.localStorage.setItem(this.dataset.storageKey ?? '', JSON.stringify({ version: STORAGE_VERSION, design: this.#design }));
    } catch {
      // Storage unavailable; the design still works for this visit.
    }
  }

  /** Reflects the design into the native controls (after restore or reset). */
  #syncInputs() {
    const d = this.#design;
    for (const input of this.refs.styleInputs ?? []) input.checked = input.value === d.style;
    for (const input of this.refs.colorInputs ?? []) input.checked = input.value === d.color;
    for (const input of this.refs.sizeInputs ?? []) input.checked = input.value === d.size;
    for (const input of this.refs.letteringInputs ?? []) input.checked = input.value === d.lettering;
    for (const input of this.refs.motifInputs ?? []) input.checked = input.value === d.motif;
    for (const input of this.refs.addonInputs ?? []) input.checked = d.addons.includes(Number(input.value));
    this.refs.messageInput.value = d.message;
    this.refs.quantityInput.value = String(d.quantity);
  }

  /* ---------------- Rendering ---------------- */

  #render() {
    const d = this.#design;
    const price = pricing(this.#catalog, d);
    const errors = validate(this.#catalog, d);

    this.#renderOptions();
    this.#renderMessage();
    this.#renderPrice(price);
    this.#renderErrors(errors);
    this.#renderPreview(price);

    const q = this.#safeQuantity();
    if (this.refs.decreaseButton) this.refs.decreaseButton.disabled = q <= 1;
    if (this.refs.increaseButton) this.refs.increaseButton.disabled = q >= this.#catalog.maxQuantity;

    this.refs.submit.disabled = this.#isSubmitting;
    if (this.refs.submitLabel) this.refs.submitLabel.textContent = this.#isSubmitting ? this.#strings.adding : this.#strings.addToCart;
  }

  #renderOptions() {
    const d = this.#design;
    if (this.refs.styleValue) this.refs.styleValue.textContent = d.style ?? '';
    if (this.refs.colorValue) this.refs.colorValue.textContent = d.color ?? '';
    if (this.refs.sizeValue) this.refs.sizeValue.textContent = d.size ?? '';

    for (const [name, index] of Object.entries(OPTION_INDEX)) {
      for (const input of this.refs[`${name}Inputs`] ?? []) {
        input.disabled = !isOptionAvailable(this.#catalog, d, index, input.value);
        const meta = input.closest('label')?.querySelector('[data-option-price]');
        if (!meta || name === 'color') continue;
        const candidate = { ...d, [name]: input.value };
        const variant = findVariant(this.#catalog, candidate);
        if (variant) {
          meta.textContent = this.#money(variant.price);
        } else {
          // No size yet: show the lowest price for this style.
          const prices = this.#catalog.variants.filter((v) => v.options[index] === input.value && v.available).map((v) => v.price);
          meta.textContent = prices.length ? fill(this.#strings.from, { price: this.#money(Math.min(...prices)) }) : '';
        }
      }
    }
  }

  #renderMessage() {
    const max = this.#catalog.maxChars;
    const { count, over, invalid } = checkMessage(this.#design.message, max);
    const counter = this.refs.messageCounter;
    if (counter) {
      counter.textContent = fill(this.#strings.counter, { count, max });
      counter.dataset.state = over > 0 ? 'over' : count >= max - 5 ? 'near' : 'ok';
    }
    this.refs.messageInput.setAttribute('aria-invalid', String(over > 0 || invalid.length > 0));
  }

  /** @param {ReturnType<typeof pricing>} price */
  #renderPrice(price) {
    const d = this.#design;
    const strings = this.#strings;
    const quantityValid = Number.isInteger(d.quantity) && d.quantity >= 1 && d.quantity <= this.#catalog.maxQuantity;

    if (this.refs.variantLabel) this.refs.variantLabel.textContent = [d.style, d.color, d.size].filter(Boolean).join(' · ');
    if (this.refs.priceBox) this.refs.priceBox.textContent = price.box === null ? '—' : this.#money(price.box);
    if (this.refs.priceAddons) {
      this.refs.priceAddons.textContent = price.selectedAddons.length
        ? `${price.selectedAddons.map((a) => a.title).join(', ')} · +${this.#money(price.addons)}`
        : strings.none;
    }
    if (this.refs.priceEach) this.refs.priceEach.textContent = price.each === null ? '—' : this.#money(price.each);
    if (this.refs.priceQuantity) this.refs.priceQuantity.textContent = quantityValid ? `× ${d.quantity}` : '—';

    // "From" only before a variant is chosen; an invalid quantity shows a dash, not a misleading price.
    const lowest = lowestPrice(this.#catalog);
    if (price.total !== null && quantityValid) this.refs.total.textContent = this.#money(price.total);
    else if (!price.variant && lowest !== null) this.refs.total.textContent = fill(strings.from, { price: this.#money(lowest) });
    else this.refs.total.textContent = '—';
  }

  /** @param {import('@theme/pz-model').ValidationError[]} errors */
  #renderErrors(errors) {
    // Message errors are shown live; the rest only after an add-to-cart attempt.
    const visible = this.#attempted ? errors : errors.filter((e) => e.field === 'message');
    const byField = new Map();
    for (const error of visible) if (!byField.has(error.field)) byField.set(error.field, error);

    for (const element of this.querySelectorAll('[data-field-error]')) {
      if (!(element instanceof HTMLElement)) continue;
      const error = byField.get(element.dataset.fieldError);
      element.hidden = !error;
      element.textContent = error ? this.#errorText(error) : '';
    }
    for (const field of this.querySelectorAll('[data-field]')) {
      if (field instanceof HTMLElement) field.toggleAttribute('data-invalid', byField.has(field.dataset.field));
    }

    const summary = this.#attempted ? errors : [];
    this.refs.errors.hidden = summary.length === 0;
    const fragment = document.createDocumentFragment();
    for (const error of summary) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.focusField = error.field;
      button.setAttribute('on:click', '/focusField');
      button.textContent = this.#errorText(error);
      item.append(button);
      fragment.append(item);
    }
    this.refs.errorList.replaceChildren(fragment);
  }

  /** @param {string[]} messages */
  #showErrors(messages) {
    this.refs.errors.hidden = false;
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      const item = document.createElement('li');
      item.textContent = message;
      fragment.append(item);
    }
    this.refs.errorList.replaceChildren(fragment);
  }

  /** @param {ReturnType<typeof pricing>} price */
  #renderPreview(price) {
    const d = this.#design;
    const swatch = this.#catalog.swatches.find((s) => s.value === d.color);
    const addonKeys = price.selectedAddons.map((a) => a.key);
    renderPreview(/** @type {SVGSVGElement} */ (this.refs.preview), d, {
      swatch,
      addonKeys,
      placeholder: this.#strings.placeholder,
    });

    const parts = [d.color, d.style, d.size].filter(Boolean).join(' ');
    const extras = price.selectedAddons.map((a) => a.title).join(', ');
    const message = d.message.trim();
    const description = [parts, message ? `“${message}”` : '', extras].filter(Boolean).join(' · ');
    if (this.refs.previewDesc) this.refs.previewDesc.textContent = description;
    if (this.refs.previewCaption) this.refs.previewCaption.textContent = [d.color, d.style, d.size].filter(Boolean).join(' · ');
  }

  /** @param {import('@theme/pz-model').ValidationError} error */
  #errorText(error) {
    const e = this.#strings.errors ?? {};
    if (error.code === 'message_long') {
      const count = Number(error.values?.count ?? 0);
      return count === 1 ? e.message_long_one : fill(e.message_long_other, { count });
    }
    return fill(e[error.code] ?? e.generic, error.values ?? {});
  }

  /** @param {string} field */
  #fieldControl(field) {
    if (field === 'message') return this.refs.messageInput;
    if (field === 'quantity') return this.refs.quantityInput;
    const inputs = this.refs[`${field}Inputs`] ?? [];
    return inputs.find((i) => i.checked) ?? inputs.find((i) => !i.disabled) ?? null;
  }

  #hideSuccess() {
    if (this.refs.success) this.refs.success.hidden = true;
  }

  /** @param {string} message */
  #announce(message) {
    const announcer = this.refs.announcer;
    if (!announcer) return;
    announcer.textContent = '';
    requestAnimationFrame(() => (announcer.textContent = message));
  }

  /** @param {number} cents */
  #money(cents) {
    return formatMoney(cents, this.dataset.moneyFormat || '${{amount}}', this.dataset.currency || 'USD');
  }
}

/** @param {Element | undefined} element */
function readJson(element) {
  try {
    return JSON.parse(element?.textContent || '{}');
  } catch {
    return {};
  }
}

/**
 * @param {string | undefined} template
 * @param {Record<string, string | number>} values
 */
function fill(template, values) {
  if (!template) return '';
  return template.replace(/\[(\w+)\]/g, (match, key) => (key in values ? String(values[key]) : match));
}

function createBundleId() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? Date.now();
  return `PZ-${random.toString(36).toUpperCase().slice(0, 6)}`;
}

if (!customElements.get('pz-customizer-component')) {
  customElements.define('pz-customizer-component', PzCustomizerComponent);
}
