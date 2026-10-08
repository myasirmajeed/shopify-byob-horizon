/**
 * Cart integration for Shop the Look. Adds lines through the AJAX Cart API and
 * dispatches Horizon's standard cart events so the cart drawer and cart count
 * refresh like the theme's own add-to-cart.
 * @module stl-cart
 */

import { CartLinesUpdateEvent, CartErrorEvent } from '@shopify/events';

/**
 * @typedef {{ id: number, quantity: number }} CartItem
 * @typedef {{ added: CartItem[], failed: Array<{ item: CartItem, message: string }> }} AddResult
 */

/**
 * Adds items in a single request. If Shopify rejects the batch (one line out of
 * stock, for example), it retries each item on its own so everything that can
 * be added still is, and reports exactly which items failed.
 * @param {HTMLElement} source - Element that dispatches the bubbling cart events
 * @param {CartItem[]} items
 * @param {AbortSignal} signal
 * @returns {Promise<AddResult>}
 */
export async function addToCart(source, items, signal) {
  const sections = sectionIds();
  const deferred = CartLinesUpdateEvent.createPromise();
  source.dispatchEvent(
    new CartLinesUpdateEvent({
      action: 'add',
      context: 'product',
      lines: items.map((item) => ({ merchandiseId: String(item.id), quantity: item.quantity })),
      promise: deferred.promise,
    })
  );

  /** @type {AddResult} */
  const result = { added: [], failed: [] };
  let renderedSections = null;

  try {
    const batch = await post(items, sections, signal);
    if (batch.ok) {
      result.added = items;
      renderedSections = batch.body.sections;
    } else if (items.length === 1) {
      result.failed = [{ item: items[0], message: batch.message }];
    } else {
      for (const item of items) {
        const single = await post([item], sections, signal);
        if (single.ok) {
          result.added.push(item);
          renderedSections = single.body.sections;
        } else {
          result.failed.push({ item, message: single.message });
        }
      }
    }

    const cart = await fetch(`${Theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' }, signal }).then(
      (r) => r.json()
    );
    deferred.resolve({
      cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
      detail: {
        items: cart.items,
        source: 'stl-looks-component',
        itemCount: result.added.reduce((sum, item) => sum + item.quantity, 0),
        sections: renderedSections,
        didError: result.added.length === 0,
      },
    });

    if (result.failed.length) {
      source.dispatchEvent(new CartErrorEvent({ error: result.failed[0].message || 'Add to cart failed', code: 'INVALID' }));
    }
    return result;
  } catch (error) {
    deferred.reject(error);
    if (!signal.aborted) {
      source.dispatchEvent(new CartErrorEvent({ error: 'Network error during add to cart', code: 'SERVICE_UNAVAILABLE' }));
    }
    throw error;
  }
}

/**
 * @param {CartItem[]} items
 * @param {string} sections
 * @param {AbortSignal} signal
 */
async function post(items, sections, signal) {
  const response = await fetch(Theme.routes.cart_add_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ items, sections }),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  const ok = response.ok && !body.status;
  return { ok, body, message: ok ? '' : body.description || body.message || '' };
}

function sectionIds() {
  return [...document.querySelectorAll('cart-items-component')]
    .map((element) => (element instanceof HTMLElement ? element.dataset.sectionId : ''))
    .filter(Boolean)
    .join(',');
}
