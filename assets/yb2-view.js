/**
 * Rendering helpers for the Build Your Own Box 2 builder. Each function takes the
 * current view model and updates only the DOM it owns, so the controller stays
 * focused on behaviour.
 * @module yb2-view
 */

import { canVisit, findVariant, pricing, sleeveSurcharge } from '@theme/yb2-model';

/**
 * @typedef {object} ViewModel
 * @property {import('@theme/yb2-model').Catalog} catalog
 * @property {import('@theme/yb2-model').BoxState} state
 * @property {ReturnType<typeof import('@theme/yb2-model').validate>} validation
 * @property {Record<string, any>} strings
 * @property {(cents: number | null) => string} money
 * @property {Map<string, { title: string, shell: string, accent: string }>} flavorMeta
 * @property {string} flash - Transient warning shown in the counter (e.g. box full)
 */

/**
 * Replaces `[key]` placeholders produced by the Liquid `t` filter.
 * @param {string | undefined} template
 * @param {Record<string, string | number>} values
 */
export function fill(template, values = {}) {
  if (!template) return '';
  return template.replace(/\[(\w+)\]/g, (match, key) => (key in values ? String(values[key]) : match));
}

/**
 * A step shows as complete when it is valid and not the current step. Review is
 * the final action, so it never shows a completed check.
 * @param {import('@theme/yb2-model').StepId} step
 * @param {import('@theme/yb2-model').StepId} current
 * @param {ViewModel['validation']} validation
 */
function isStepComplete(step, current, validation) {
  return step !== current && step !== 'review' && validation.steps[step];
}

/**
 * @param {HTMLElement} root
 * @param {ViewModel} vm
 */
export function renderProgress(root, vm) {
  const { state, validation, strings } = vm;

  for (const item of root.querySelectorAll('[data-step-item]')) {
    if (!(item instanceof HTMLElement)) continue;
    const step = /** @type {import('@theme/yb2-model').StepId} */ (item.dataset.stepItem);
    const isCurrent = step === state.step;
    const isComplete = isStepComplete(step, state.step, validation);
    const reachable = canVisit(validation, step);

    item.dataset.state = isCurrent ? 'current' : isComplete ? 'complete' : 'upcoming';
    const button = item.querySelector('button');
    if (button) {
      button.disabled = !reachable && !isCurrent;
      if (isCurrent) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    const status = item.querySelector('[data-step-state]');
    if (status) {
      status.textContent = `, ${isCurrent ? strings.stepCurrent : isComplete ? strings.stepCompleted : reachable ? '' : strings.stepLocked}`;
    }
  }

  for (const segment of root.querySelectorAll('[data-segment]')) {
    if (!(segment instanceof HTMLElement)) continue;
    const step = /** @type {import('@theme/yb2-model').StepId} */ (segment.dataset.segment);
    segment.dataset.state =
      step === state.step ? 'current' : isStepComplete(step, state.step, validation) ? 'complete' : 'upcoming';
  }
}

/**
 * Flavor counter: "8 / 16 selected", remaining, fill bar and validation message.
 * @param {Record<string, any>} refs
 * @param {ViewModel} vm
 */
export function renderCounter(refs, vm) {
  const { validation, strings } = vm;
  const { count, capacity, remaining, overBy } = validation;
  const counter = refs.counterValue?.closest('.yb2-counter');
  if (!counter) return;

  refs.counterValue.textContent = capacity ? fill(strings.counter, { count, capacity }) : strings.chooseSizeFirst;
  refs.counterRemaining.textContent = capacity ? fill(strings.remaining, { count: remaining }) : '';
  refs.counterBar.style.setProperty('--yb2-fill', String(capacity ? Math.min(count / capacity, 1) : 0));

  let state = 'under';
  let message = flavorMessage(vm);
  if (overBy > 0) state = 'over';
  else if (capacity && count === capacity) state = 'complete';
  if (vm.flash) {
    state = 'full-warning';
    message = vm.flash;
  }
  counter.setAttribute('data-counter-state', state);
  refs.counterMessage.textContent = message;
}

/** @param {ViewModel} vm */
export function flavorMessage(vm) {
  const { validation, strings } = vm;
  const { count, capacity, overBy } = validation;
  if (!capacity) return strings.chooseSizeFirst;
  if (overBy > 0) return overBy === 1 ? fill(strings.tooManyOne, { capacity }) : fill(strings.tooManyOther, { count: overBy, capacity });
  if (count === capacity) return strings.complete;
  const needed = capacity - count;
  return needed === 1 ? strings.needMoreOne : fill(strings.needMoreOther, { count: needed });
}

/**
 * Card selected states. Only touches cards whose quantity or fullness changed.
 * @param {HTMLElement} root
 * @param {ViewModel} vm
 */
export function renderCards(root, vm) {
  const { state, validation, strings } = vm;
  const isFull = validation.capacity > 0 && validation.count >= validation.capacity;

  for (const card of root.querySelectorAll('[data-flavor-card]')) {
    if (!(card instanceof HTMLElement)) continue;
    const id = card.dataset.flavorCard ?? '';
    const quantity = state.flavors[id] ?? 0;
    const signature = `${quantity}:${isFull}`;
    if (card.dataset.rendered === signature) continue;
    card.dataset.rendered = signature;

    card.toggleAttribute('data-selected', quantity > 0);
    const addButton = card.querySelector('[data-add-button]');
    const group = card.querySelector('[data-qty-group]');
    const value = card.querySelector('[data-qty-value]');
    const badge = card.querySelector('[data-selected-badge]');
    const badgeCount = card.querySelector('[data-selected-count]');
    const increase = card.querySelector('[data-increase]');
    const title = vm.flavorMeta.get(id)?.title ?? '';

    if (addButton instanceof HTMLElement) {
      addButton.hidden = quantity > 0;
      addButton.setAttribute('aria-disabled', String(isFull));
    }
    if (group instanceof HTMLElement) {
      group.hidden = quantity === 0;
      group.setAttribute('aria-label', fill(strings.quantityInBox, { flavor: title, count: quantity }));
    }
    if (value) value.textContent = String(quantity);
    if (badge instanceof HTMLElement) badge.hidden = quantity === 0;
    if (badgeCount) badgeCount.textContent = `× ${quantity}`;
    // Kept focusable (aria-disabled, not disabled) so a click explains why it is full.
    if (increase) increase.setAttribute('aria-disabled', String(isFull));
  }
}

/**
 * Box preview tray: one slot per piece, filled slots are buttons that remove one.
 * @param {Record<string, any>} refs
 * @param {ViewModel} vm
 */
export function renderTray(refs, vm) {
  const { catalog, state, validation, strings } = vm;
  const tray = /** @type {HTMLElement} */ (refs.tray);
  const capacity = validation.capacity;
  const signature = `${capacity}|${JSON.stringify(state.flavors)}`;
  if (tray.dataset.rendered === signature) return;
  tray.dataset.rendered = signature;

  const columns = capacity > 16 ? 6 : capacity > 6 ? 4 : 3;
  // Set on the wrapper too so it can size itself to the column count.
  (tray.parentElement ?? tray).style.setProperty('--yb2-tray-cols', String(columns));

  const pieces = [];
  for (const flavor of catalog.flavors) {
    const quantity = state.flavors[String(flavor.id)] ?? 0;
    for (let i = 0; i < quantity; i++) pieces.push(String(flavor.id));
  }

  const fragment = document.createDocumentFragment();
  if (!capacity) {
    const note = document.createElement('li');
    note.className = 'yb2-tray__empty-note';
    note.textContent = strings.chooseSizeFirst;
    fragment.append(note);
  }
  const slots = Math.max(capacity, pieces.length);
  for (let i = 0; i < slots; i++) {
    const slot = document.createElement('li');
    slot.className = 'yb2-tray__slot';
    const id = pieces[i];
    if (id) {
      const meta = vm.flavorMeta.get(id);
      const piece = document.createElement('button');
      piece.type = 'button';
      piece.className = `yb2-tray__piece yb2-shell--${meta?.shell ?? 'dark'} yb2-accent--${meta?.accent ?? 'caramel'}`;
      piece.dataset.flavorId = id;
      piece.setAttribute('on:click', '/removeFlavor');
      piece.setAttribute('aria-label', fill(strings.removeOne, { flavor: meta?.title ?? '' }));
      piece.title = meta?.title ?? '';
      slot.append(piece);
    } else {
      slot.setAttribute('aria-label', strings.trayEmpty);
    }
    fragment.append(slot);
  }
  tray.replaceChildren(fragment);

  if (refs.trayLabel) {
    refs.trayLabel.textContent = capacity
      ? `${strings.trayLabel}: ${fill(strings.counter, { count: validation.count, capacity })}`
      : strings.trayLabel;
  }
}

/**
 * Sidebar / bottom bar statistics.
 * @param {Record<string, any>} refs
 * @param {ViewModel} vm
 */
export function renderStats(refs, vm) {
  const { state, validation, strings, money, catalog } = vm;
  const price = pricing(catalog, state);
  const counter = validation.capacity ? fill(strings.counter, { count: validation.count, capacity: validation.capacity }) : '—';

  refs.statSize.textContent = state.size ?? strings.notSelected;
  refs.statSelected.textContent = validation.capacity ? `${validation.count} / ${validation.capacity}` : '—';
  refs.statRemaining.textContent = validation.capacity ? String(validation.remaining) : '—';
  refs.statSleeve.textContent = state.sleeve ?? strings.notSelected;
  refs.statPrice.textContent = price.total === null ? '—' : money(price.total);
  refs.barCount.textContent = counter;
  refs.barPrice.textContent = price.total === null ? '' : money(price.total);
}

/**
 * Sleeve prices depend on the chosen size: "Included" or "+$4.00".
 * @param {Record<string, any>} refs
 * @param {ViewModel} vm
 */
export function renderSleevePrices(refs, vm) {
  const { catalog, state, strings, money } = vm;
  for (const input of refs.sleeveInputs ?? []) {
    const label = input.closest('label')?.querySelector('[data-sleeve-price]');
    if (!label) continue;
    const surcharge = sleeveSurcharge(catalog, state.size, input.value);
    input.disabled = state.size !== null && surcharge === null;
    label.toggleAttribute('data-included', surcharge === 0);
    label.textContent =
      surcharge === null ? (state.size ? '—' : '') : surcharge === 0 ? strings.included : fill(strings.extraPrice, { price: money(surcharge) });
  }
}

/**
 * Review step contents.
 * @param {Record<string, any>} refs
 * @param {ViewModel} vm
 */
export function renderReview(refs, vm) {
  const { catalog, state, validation, strings, money } = vm;
  const price = pricing(catalog, state);

  refs.reviewSize.textContent = state.size ?? strings.notSelected;
  refs.reviewSleeve.textContent = state.sleeve ?? strings.notSelected;
  refs.reviewBoxPrice.textContent = price.box === null ? '—' : money(price.box);
  refs.reviewSleevePrice.textContent =
    price.sleeve === null ? '—' : price.sleeve === 0 ? strings.included : `+${money(price.sleeve)}`;
  refs.reviewTotal.textContent = price.total === null ? '—' : money(price.total);

  const fragment = document.createDocumentFragment();
  for (const flavor of catalog.flavors) {
    const quantity = state.flavors[String(flavor.id)] ?? 0;
    if (!quantity) continue;
    const meta = vm.flavorMeta.get(String(flavor.id));
    const item = document.createElement('li');
    item.className = 'yb2-review__flavor';
    const dot = document.createElement('span');
    dot.className = `yb2-review__dot yb2-shell--${meta?.shell ?? 'dark'} yb2-accent--${meta?.accent ?? 'caramel'}`;
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'yb2-review__flavor-name';
    name.textContent = flavor.title;
    const qty = document.createElement('span');
    qty.className = 'yb2-review__flavor-qty';
    qty.textContent = `× ${quantity}`;
    item.append(dot, name, qty);
    fragment.append(item);
  }
  refs.reviewFlavors.replaceChildren(fragment);

  const unavailable = state.size && state.sleeve && !findVariant(catalog, state.size, state.sleeve)?.available;
  if (unavailable && refs.addError) {
    refs.addError.textContent = strings.errorUnavailable;
    refs.addError.hidden = false;
  }
}
