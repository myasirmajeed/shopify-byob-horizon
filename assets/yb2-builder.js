import { Component } from '@theme/component';
import { formatMoney } from '@theme/money-formatting';
import { STEPS, buildCartItem, canVisit, emptyState, sanitize, validate } from '@theme/yb2-model';
import { createStore, loadSaved, clearSaved } from '@theme/yb2-store';
import { addBoxToCart, openCart, CartAddError } from '@theme/yb2-cart';
import {
  fill,
  flavorMessage,
  renderCards,
  renderCounter,
  renderProgress,
  renderReview,
  renderSleevePrices,
  renderStats,
  renderTray,
} from '@theme/yb2-view';

const FLASH_DURATION = 3500;
const SEARCH_DEBOUNCE = 150;
const DESKTOP_LAYOUT = '(min-width: 990px)';

/**
 * Build Your Own Box 2 — four-step chocolate box builder.
 *
 * State (size, flavors, sleeve, step) lives in a small store that persists to
 * localStorage; this component turns user events into state updates and asks the
 * view helpers to re-render. Filtering/search are view-only and never touch state.
 *
 * @extends {Component}
 */
class Yb2BuilderComponent extends Component {
  requiredRefs = ['catalog', 'strings', 'stepPanels', 'tray', 'nextButton', 'announcer'];

  /** @type {import('@theme/yb2-model').Catalog} */
  #catalog = { product: { id: 0, title: '' }, variants: [], sizes: [], sleeves: [], flavors: [] };

  /** @type {Record<string, any>} */
  #strings = {};

  /** @type {Map<string, { title: string, shell: string, accent: string }>} */
  #flavorMeta = new Map();

  /** @type {ReturnType<typeof createStore<import('@theme/yb2-model').BoxState>> | null} */
  #store = null;

  #filter = 'all';
  #query = '';
  #flash = '';
  #isSubmitting = false;
  /** @type {import('@theme/yb2-model').StepId | null} */
  #renderedStep = null;

  /** @type {number | undefined} */ #flashTimer;
  /** @type {number | undefined} */ #searchTimer;
  /** @type {AbortController | null} */ #request = null;
  /** @type {(() => void) | null} */ #unsubscribe = null;

  connectedCallback() {
    super.connectedCallback();
    if (this.#store) return; // Re-connect after a DOM move: keep existing state.

    this.#catalog = readJson(this.refs.catalog, this.#catalog);
    this.#strings = readJson(this.refs.strings, {});

    for (const card of this.querySelectorAll('[data-flavor-card]')) {
      if (!(card instanceof HTMLElement)) continue;
      const id = card.dataset.flavorCard ?? '';
      const flavor = this.#catalog.flavors.find((item) => String(item.id) === id);
      this.#flavorMeta.set(id, {
        title: flavor?.title ?? '',
        shell: card.dataset.shell ?? 'dark',
        accent: card.dataset.accent ?? 'caramel',
      });
    }

    const storageKey = this.dataset.storageKey;
    const saved = storageKey ? loadSaved(storageKey) : null;
    const initial = sanitize(this.#catalog, /** @type {any} */ (saved));
    const restored = Boolean(initial.size || Object.keys(initial.flavors).length);
    if (this.refs.restored) this.refs.restored.hidden = !restored;

    this.#store = createStore(initial, { storageKey });
    this.#unsubscribe = this.#store.subscribe(() => this.#render());
    this.#syncInputs();
    this.#render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#unsubscribe?.();
    this.#request?.abort();
    clearTimeout(this.#flashTimer);
    clearTimeout(this.#searchTimer);
  }

  /* ---------------- Event handlers (routed via on:* attributes) ---------------- */

  /** @param {Event} event */
  selectSize(event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const size = event.target.value;
    this.#update((state) => ({ ...state, size }));
    this.#announce(this.#capacityMessage());
  }

  /** @param {Event} event */
  addFlavor(event) {
    const id = flavorIdFrom(event.target);
    if (!id) return;
    const { capacity, count } = this.#validation();

    if (!capacity) {
      this.#showFlash(this.#strings.chooseSizeFirst);
      return;
    }
    if (count >= capacity) {
      this.#showFlash(fill(this.#strings.boxFull, { capacity }));
      return;
    }
    this.#update((state) => ({ ...state, flavors: { ...state.flavors, [id]: (state.flavors[id] ?? 0) + 1 } }));
    this.#announce(this.#quantityMessage(id));
  }

  /** @param {Event} event */
  removeFlavor(event) {
    const id = flavorIdFrom(event.target);
    if (!id) return;
    const fromTray = event.target instanceof HTMLElement && event.target.classList.contains('yb2-tray__piece');

    this.#update((state) => {
      const quantity = (state.flavors[id] ?? 0) - 1;
      const flavors = { ...state.flavors };
      if (quantity > 0) flavors[id] = quantity;
      else delete flavors[id];
      return { ...state, flavors };
    });
    this.#clearFlash();
    this.#announce(this.#quantityMessage(id));
    // The clicked tray piece was re-rendered away; keep focus in the tray.
    if (fromTray) this.refs.tray.querySelector('button')?.focus();
  }

  /** @param {Event} event */
  selectSleeve(event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const sleeve = event.target.value;
    this.#update((state) => ({ ...state, sleeve }));
  }

  /** @param {Event} event */
  goToStepFromEvent(event) {
    const target = event.target instanceof HTMLElement ? event.target.closest('[data-goto]') : null;
    const step = /** @type {import('@theme/yb2-model').StepId | undefined} */ (
      target instanceof HTMLElement ? target.dataset.goto : undefined
    );
    if (step) this.goToStep(step);
  }

  /**
   * Public: move to a step if every previous step is valid.
   * @param {import('@theme/yb2-model').StepId} step
   */
  goToStep(step) {
    if (!STEPS.includes(step) || !canVisit(this.#validation(), step)) return;
    this.#update((state) => ({ ...state, step }));
  }

  goNext() {
    const state = this.#state();
    const validation = this.#validation();
    if (state.step === 'review') {
      this.addToCart();
      return;
    }
    if (!validation.steps[state.step]) return;
    const next = STEPS[STEPS.indexOf(state.step) + 1];
    if (next) this.goToStep(next);
  }

  goBack() {
    const previous = STEPS[STEPS.indexOf(this.#state().step) - 1];
    if (previous) this.goToStep(previous);
  }

  toggleSummary() {
    const summary = this.refs.summary;
    const expanded = summary?.dataset.expanded !== 'true';
    if (summary) summary.dataset.expanded = String(expanded);
    this.refs.summaryToggle?.setAttribute('aria-expanded', String(expanded));
  }

  /** @param {Event} event */
  setFilter(event) {
    const chip = event.target instanceof HTMLElement ? event.target.closest('[data-filter]') : null;
    if (!(chip instanceof HTMLElement)) return;
    this.#filter = chip.dataset.filter ?? 'all';
    this.#applyFilters();
  }

  /** @param {Event} event */
  handleSearch(event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const value = event.target.value;
    clearTimeout(this.#searchTimer);
    this.#searchTimer = window.setTimeout(() => {
      this.#query = value.trim().toLowerCase();
      this.#applyFilters();
    }, SEARCH_DEBOUNCE);
  }

  clearFilters() {
    this.#filter = 'all';
    this.#query = '';
    if (this.refs.search instanceof HTMLInputElement) this.refs.search.value = '';
    this.#applyFilters();
  }

  async addToCart() {
    if (this.#isSubmitting) return;
    const state = this.#state();
    const item = buildCartItem(this.#catalog, state, {
      total: this.#strings.propertyTotal,
      flavor: this.#strings.propertyFlavor,
    });

    if (!item) {
      this.#setError(this.#strings.errorIncomplete);
      return;
    }

    this.#isSubmitting = true;
    this.#setError('');
    this.#render();

    this.#request?.abort();
    this.#request = new AbortController();

    try {
      await addBoxToCart(this, item, this.#request.signal);
      if (this.dataset.storageKey) clearSaved(this.dataset.storageKey);
      this.dataset.added = 'true';
      if (this.refs.success) {
        this.refs.success.hidden = false;
        this.refs.success.focus();
      }
      this.#announce(this.#strings.addedTitle);
    } catch (error) {
      if (this.#request?.signal.aborted) return;
      console.error(error);
      const message = error instanceof CartAddError && error.message ? error.message : this.#strings.errorGeneric;
      this.#setError(message);
    } finally {
      this.#isSubmitting = false;
      this.#render();
    }
  }

  viewCart() {
    openCart();
  }

  startOver() {
    if (this.dataset.storageKey) clearSaved(this.dataset.storageKey);
    delete this.dataset.added;
    if (this.refs.success) this.refs.success.hidden = true;
    if (this.refs.restored) this.refs.restored.hidden = true;
    this.#setError('');
    this.clearFilters();
    this.#update(() => emptyState());
    this.#syncInputs();
  }

  /* ---------------- State helpers ---------------- */

  #state() {
    return this.#store?.get() ?? emptyState();
  }

  #validation() {
    return validate(this.#catalog, this.#state());
  }

  /** @param {(state: import('@theme/yb2-model').BoxState) => import('@theme/yb2-model').BoxState} updater */
  #update(updater) {
    this.#store?.update(updater);
  }

  /** Reflects state into native radio inputs (after restore or reset). */
  #syncInputs() {
    const state = this.#state();
    for (const input of this.refs.sizeInputs ?? []) input.checked = input.value === state.size;
    for (const input of this.refs.sleeveInputs ?? []) input.checked = input.value === state.sleeve;
  }

  /** @param {string} message */
  #showFlash(message) {
    this.#flash = message;
    this.#announce(message);
    this.#render();
    clearTimeout(this.#flashTimer);
    this.#flashTimer = window.setTimeout(() => this.#clearFlash(), FLASH_DURATION);
  }

  #clearFlash() {
    if (!this.#flash) return;
    this.#flash = '';
    this.#render();
  }

  /** @param {string} message */
  #announce(message) {
    const announcer = this.refs.announcer;
    // Clearing first makes repeated identical messages announce again.
    announcer.textContent = '';
    window.requestAnimationFrame(() => {
      announcer.textContent = message;
    });
  }

  /** @param {string} message */
  #setError(message) {
    if (!this.refs.addError) return;
    this.refs.addError.textContent = message;
    this.refs.addError.hidden = !message;
  }

  /** @param {string} id */
  #quantityMessage(id) {
    const title = this.#flavorMeta.get(id)?.title ?? '';
    const quantity = this.#state().flavors[id] ?? 0;
    return `${fill(this.#strings.quantityInBox, { flavor: title, count: quantity })}. ${flavorMessage(this.#viewModel())}`;
  }

  #capacityMessage() {
    return flavorMessage(this.#viewModel());
  }

  /** @param {number | null} cents */
  #money = (cents) =>
    cents === null ? '—' : formatMoney(cents, this.dataset.moneyFormat || '${{amount}}', this.dataset.currency || 'USD');

  /** @returns {import('@theme/yb2-view').ViewModel} */
  #viewModel() {
    const state = this.#state();
    return {
      catalog: this.#catalog,
      state,
      validation: validate(this.#catalog, state),
      strings: this.#strings,
      money: this.#money,
      flavorMeta: this.#flavorMeta,
      flash: this.#flash,
    };
  }

  /* ---------------- Rendering ---------------- */

  #render() {
    const vm = this.#viewModel();
    const { state, validation } = vm;
    this.dataset.step = state.step;

    renderProgress(this, vm);
    if (this.refs.compactStep) {
      this.refs.compactStep.textContent = `${fill(this.#strings.stepOf, {
        current: STEPS.indexOf(state.step) + 1,
        total: STEPS.length,
      })} · ${this.#strings.steps?.[state.step] ?? ''}`;
    }

    this.#renderPanels(state.step);
    renderCounter(this.refs, vm);
    renderCards(this, vm);
    renderTray(this.refs, vm);
    renderStats(this.refs, vm);
    renderSleevePrices(this.refs, vm);
    if (state.step === 'review') renderReview(this.refs, vm);
    this.#renderNav(vm);
  }

  /** @param {import('@theme/yb2-model').StepId} step */
  #renderPanels(step) {
    if (this.#renderedStep === step) return;
    const isFirstRender = this.#renderedStep === null;
    this.#renderedStep = step;

    for (const panel of this.refs.stepPanels) {
      panel.hidden = panel.dataset.stepPanel !== step;
    }
    if (this.refs.success && step !== 'review') this.refs.success.hidden = true;

    // Move focus to the new step's heading so keyboard and screen reader users follow along.
    if (!isFirstRender) {
      const heading = this.querySelector(`[data-step-panel="${step}"] .yb2-step__title`);
      if (heading instanceof HTMLElement) {
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
      if (!matchMedia(DESKTOP_LAYOUT).matches && this.refs.summary?.dataset.expanded === 'true') this.toggleSummary();
    }
  }

  /** @param {import('@theme/yb2-view').ViewModel} vm */
  #renderNav(vm) {
    const { state, validation, strings } = vm;
    const isReview = state.step === 'review';
    const added = this.dataset.added === 'true';

    if (this.refs.backButton) this.refs.backButton.hidden = state.step === 'size';
    this.refs.nextButton.disabled = this.#isSubmitting || !validation.steps[state.step] || (isReview && added);
    if (this.refs.nextLabel) {
      this.refs.nextLabel.textContent = isReview ? (this.#isSubmitting ? strings.adding : strings.addToCart) : strings.continue;
    }
    if (this.refs.addButton) this.refs.addButton.disabled = this.#isSubmitting || !validation.steps.review || added;
    if (this.refs.addLabel) this.refs.addLabel.textContent = this.#isSubmitting ? strings.adding : strings.addToCart;
    if (this.refs.reviewCta) this.refs.reviewCta.hidden = added;

    let hint = '';
    if (state.step === 'size' && !state.size) hint = strings.chooseSizeFirst;
    else if (state.step === 'flavors' && !validation.steps.flavors) hint = flavorMessage(vm);
    else if (state.step === 'sleeve' && !validation.steps.sleeve) hint = strings.chooseSleeve;
    if (this.refs.nextHint) this.refs.nextHint.textContent = hint;
  }

  #applyFilters() {
    let visible = 0;
    for (const item of this.querySelectorAll('[data-flavor-item]')) {
      if (!(item instanceof HTMLElement)) continue;
      const categories = (item.dataset.categories ?? '').split(' ');
      const matchesFilter = this.#filter === 'all' || categories.includes(this.#filter);
      const matchesQuery = !this.#query || (item.dataset.search ?? '').includes(this.#query);
      item.hidden = !(matchesFilter && matchesQuery);
      if (!item.hidden) visible++;
    }

    for (const chip of this.refs.filterChips ?? []) {
      chip.setAttribute('aria-pressed', String(chip.dataset.filter === this.#filter));
    }
    if (this.refs.emptyState) this.refs.emptyState.hidden = visible > 0;
    if (this.refs.resultsCount) {
      const filtered = this.#filter !== 'all' || this.#query;
      this.refs.resultsCount.textContent = filtered
        ? visible === 1
          ? this.#strings.resultsOne
          : fill(this.#strings.resultsOther, { count: visible })
        : '';
    }
  }
}

/**
 * @template T
 * @param {Element | undefined} element
 * @param {T} fallback
 * @returns {T}
 */
function readJson(element, fallback) {
  try {
    return JSON.parse(element?.textContent || '');
  } catch {
    return fallback;
  }
}

/** @param {EventTarget | null} target */
function flavorIdFrom(target) {
  const element = target instanceof HTMLElement ? target.closest('[data-flavor-id]') : null;
  return element instanceof HTMLElement ? element.dataset.flavorId ?? '' : '';
}

function prefersReducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

if (!customElements.get('yb2-builder-component')) {
  customElements.define('yb2-builder-component', Yb2BuilderComponent);
}
