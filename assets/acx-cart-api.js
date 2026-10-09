/**
 * Cart transport for the Advanced Cart demo. Every mutation goes through the
 * Shopify AJAX Cart API, one request at a time, and is mirrored to Horizon's
 * standard cart events so the header cart count and the theme's own cart
 * section stay in sync. Subscribers receive the authoritative cart JSON in an
 * `acx:cart-updated` event on `document`; nothing is simulated client-side.
 * @module acx-cart-api
 */

import { CartLinesUpdateEvent, CartDiscountUpdateEvent, CartErrorEvent } from '@shopify/events';

export const CART_UPDATED = 'acx:cart-updated';
export const CART_BUSY = 'acx:cart-busy';

/**
 * @typedef {{ id: number, quantity: number, properties?: Record<string, string> }} AddItem
 * @typedef {{ item: AddItem, message: string }} FailedItem
 * @typedef {Record<string, any>} AjaxCart - Cart JSON as returned by `/cart.js`
 */

export class CartApiError extends Error {
  /**
   * @param {string} message - Shopify's description, or empty when unknown
   * @param {{ status?: number, code?: 'INVALID' | 'NETWORK' | 'SERVICE_UNAVAILABLE' }} [options]
   */
  constructor(message, { status = 0, code = 'SERVICE_UNAVAILABLE' } = {}) {
    super(message);
    this.name = 'CartApiError';
    this.status = status;
    this.code = code;
  }
}

/** Serializes cart mutations so requests never overlap or race. */
let queue = Promise.resolve();
let pending = 0;
/** @type {AjaxCart | null} */
let current = null;

/** @returns {AjaxCart | null} The last cart received from Shopify */
export function lastCart() {
  return current;
}

/** @returns {boolean} Whether a cart request is queued or in flight */
export function isBusy() {
  return pending > 0;
}

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueue(task) {
  pending += 1;
  announceBusy();
  const run = queue.then(task, task).finally(() => {
    pending -= 1;
    announceBusy();
  });
  queue = run.catch(() => {});
  return run;
}

function announceBusy() {
  document.dispatchEvent(new CustomEvent(CART_BUSY, { detail: { busy: pending > 0 } }));
}

function routes() {
  const fallback = { cart_url: '/cart', cart_add_url: '/cart/add.js', cart_change_url: '/cart/change', cart_update_url: '/cart/update' };
  return { ...fallback, ...(window.Theme?.routes ?? {}) };
}

/**
 * @param {string} url
 * @param {object} [body] - POSTed as JSON when present, otherwise GET
 * @returns {Promise<AjaxCart>}
 */
async function send(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new CartApiError('', { code: 'NETWORK' });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new CartApiError(data?.description || data?.message || '', {
      status: response.status,
      code: response.status === 422 || response.status === 400 || response.status === 404 ? 'INVALID' : 'SERVICE_UNAVAILABLE',
    });
  }
  return data;
}

const fetchCart = () => send(`${routes().cart_url}.js`);

/**
 * Section IDs of Horizon's cart sections, so their HTML comes back with our
 * mutation. An empty Horizon drawer is left out: given HTML it starts a view
 * transition, which our modal drawer opening at the same moment would abort.
 * Without HTML it refreshes itself instead.
 */
function themeSections() {
  return [...document.querySelectorAll('cart-items-component')]
    .filter((element) => !element.querySelector('[data-cart-drawer-empty]'))
    .map((element) => (element instanceof HTMLElement ? element.dataset.sectionId : ''))
    .filter(Boolean)
    .join(',');
}

/**
 * @param {AjaxCart} cart
 * @param {string} reason
 * @param {object} [extra]
 */
function publish(cart, reason, extra = {}) {
  current = cart;
  document.dispatchEvent(new CustomEvent(CART_UPDATED, { detail: { cart, reason, ...extra } }));
}

/**
 * Starts a Horizon `CartLinesUpdateEvent` and returns a settle function. The
 * event is always resolved (never rejected) so theme listeners don't log noise
 * for an error we already present to the shopper.
 * @param {EventTarget} source
 * @param {'add' | 'update' | 'remove'} action
 * @param {any[]} lines
 */
function mirrorLines(source, action, lines) {
  const deferred = CartLinesUpdateEvent.createPromise();
  source.dispatchEvent(
    new CartLinesUpdateEvent(/** @type {any} */ ({ action, context: 'cart', lines, promise: deferred.promise }))
  );
  /**
   * @param {AjaxCart | null} cart
   * @param {{ sections?: Record<string, string>, didError?: boolean }} [detail]
   */
  return (cart, { sections, didError = false } = {}) => {
    if (!cart) return deferred.reject(new DOMException('Cart unavailable', 'AbortError'));
    deferred.resolve({
      cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
      detail: { items: cart.items, source: 'acx-cart', itemCount: cart.item_count, sections, didError },
    });
  };
}

/**
 * @param {EventTarget} source
 * @param {unknown} error
 */
function reportError(source, error) {
  const isApi = error instanceof CartApiError;
  source.dispatchEvent(
    new CartErrorEvent({
      error: (isApi && error.message) || 'Cart request failed',
      code: isApi && error.code === 'INVALID' ? 'INVALID' : 'SERVICE_UNAVAILABLE',
    })
  );
}

/** After a failed mutation, re-read the cart so the UI never shows a guess. */
async function resync() {
  const fresh = await fetchCart().catch(() => null);
  if (fresh) publish(fresh, 'resync');
  return fresh;
}

/**
 * Reads the cart and publishes it.
 * @returns {Promise<AjaxCart>}
 */
export function refreshCart() {
  return enqueue(async () => {
    const cart = await fetchCart();
    publish(cart, 'refresh');
    return cart;
  });
}

/**
 * Adds items in one `/cart/add.js` request. If Shopify rejects the batch (one
 * line sold out, for example) each item is retried on its own, so everything
 * that can be added still is, and the failures are reported individually.
 * @param {EventTarget} source - Dispatches the bubbling theme events
 * @param {AddItem[]} items
 * @param {{ reason?: string, open?: boolean }} [options]
 * @returns {Promise<{ cart: AjaxCart, added: AddItem[], failed: FailedItem[] }>}
 */
export function addItems(source, items, { reason = 'add', open = true } = {}) {
  return enqueue(async () => {
    const settle = mirrorLines(
      source,
      'add',
      items.map((item) => ({ merchandiseId: String(item.id), quantity: item.quantity }))
    );
    const sections = themeSections();
    /** @type {AddItem[]} */
    const added = [];
    /** @type {FailedItem[]} */
    const failed = [];
    let rendered;

    try {
      try {
        const body = await send(routes().cart_add_url, { items, sections });
        added.push(...items);
        rendered = body.sections;
      } catch (error) {
        if (!(error instanceof CartApiError) || error.code === 'NETWORK') throw error;
        if (items.length === 1) {
          failed.push({ item: items[0], message: error.message });
        } else {
          for (const item of items) {
            try {
              const body = await send(routes().cart_add_url, { items: [item], sections });
              added.push(item);
              rendered = body.sections;
            } catch (single) {
              if (!(single instanceof CartApiError) || single.code === 'NETWORK') throw single;
              failed.push({ item, message: single.message });
            }
          }
        }
      }

      const cart = await fetchCart();
      settle(cart, { sections: rendered, didError: added.length === 0 });
      publish(cart, reason, { added, failed, open: open && added.length > 0 });
      if (failed.length) reportError(source, new CartApiError(failed[0].message, { code: 'INVALID' }));
      return { cart, added, failed };
    } catch (error) {
      settle(current, { didError: true });
      reportError(source, error);
      throw error;
    }
  });
}

/**
 * Sets a line's quantity by its line key, which keeps the line's properties
 * (BYOB contents, personalization) intact. Quantity 0 removes the line.
 * @param {EventTarget} source
 * @param {string} key - Line item key from the cart JSON
 * @param {number} quantity
 * @param {{ reason?: string }} [options]
 * @returns {Promise<AjaxCart>}
 */
export function changeLine(source, key, quantity, { reason = 'change' } = {}) {
  return enqueue(async () => {
    const settle = mirrorLines(source, quantity === 0 ? 'remove' : 'update', [{ id: key, quantity }]);
    try {
      const cart = await send(`${routes().cart_change_url}.js`, { id: key, quantity, sections: themeSections() });
      settle(cart, { sections: cart.sections });
      publish(cart, reason, { key, quantity });
      return cart;
    } catch (error) {
      reportError(source, error);
      const fresh = await resync();
      settle(fresh ?? current, { didError: true });
      throw error;
    }
  });
}

/**
 * Replaces the cart's discount codes through `/cart/update.js`. Shopify decides
 * whether each code applies; the caller reads `discount_codes` on the result.
 * @param {EventTarget} source
 * @param {string[]} codes
 * @returns {Promise<AjaxCart>}
 */
export function setDiscountCodes(source, codes) {
  return enqueue(async () => {
    const deferred = CartDiscountUpdateEvent.createPromise();
    source.dispatchEvent(
      new CartDiscountUpdateEvent({ discountCodes: codes.map((code) => ({ code })), promise: deferred.promise })
    );
    try {
      const cart = await send(`${routes().cart_update_url}.js`, { discount: codes.join(','), sections: themeSections() });
      deferred.resolve({ cart: CartDiscountUpdateEvent.createCartFromAjaxResponse(cart), detail: { sections: cart.sections } });
      publish(cart, 'discount', { codes });
      return cart;
    } catch (error) {
      reportError(source, error);
      const fresh = await resync();
      if (fresh) deferred.resolve({ cart: CartDiscountUpdateEvent.createCartFromAjaxResponse(fresh) });
      else deferred.reject(new DOMException('Cart unavailable', 'AbortError'));
      throw error;
    }
  });
}
