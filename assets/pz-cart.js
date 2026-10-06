/**
 * Cart integration for the Product Personalizer. One AJAX Cart API request adds
 * every line; Horizon's standard cart events refresh the drawer and cart count.
 * @module pz-cart
 */

import { CartLinesUpdateEvent, CartErrorEvent } from '@shopify/events';

export class PzCartError extends Error {}

/**
 * @param {HTMLElement} source - Element that dispatches the bubbling cart events
 * @param {Array<{ id: number, quantity: number, properties: Record<string, string> }>} items
 * @param {AbortSignal} signal
 */
export async function addItemsToCart(source, items, signal) {
  const sectionIds = [...document.querySelectorAll('cart-items-component')]
    .map((element) => (element instanceof HTMLElement ? element.dataset.sectionId : ''))
    .filter(Boolean);

  const deferred = CartLinesUpdateEvent.createPromise();
  source.dispatchEvent(
    new CartLinesUpdateEvent({
      action: 'add',
      context: 'product',
      lines: items.map((item) => ({ merchandiseId: String(item.id), quantity: item.quantity })),
      promise: deferred.promise,
    })
  );

  try {
    const response = await fetch(Theme.routes.cart_add_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items, sections: sectionIds.join(',') }),
      signal,
    });
    const result = await response.json();
    if (!response.ok || result.status) throw new PzCartError(result.description || result.message || '');

    const cartResponse = await fetch(`${Theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' }, signal });
    if (!cartResponse.ok) throw new Error(`Cart request failed: ${cartResponse.status}`);
    const cart = await cartResponse.json();

    deferred.resolve({
      cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
      detail: {
        items: cart.items,
        source: 'pz-customizer-component',
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        sections: result.sections,
        didError: false,
      },
    });
    return cart;
  } catch (error) {
    deferred.reject(error);
    if (!signal.aborted) {
      source.dispatchEvent(
        new CartErrorEvent({
          error: error instanceof Error && error.message ? error.message : 'Add to cart failed',
          code: error instanceof PzCartError ? 'INVALID' : 'SERVICE_UNAVAILABLE',
        })
      );
    }
    throw error;
  }
}

/** Opens Horizon's cart drawer when present, otherwise goes to the cart page. */
export function openCart() {
  /** @type {(HTMLElement & { open?: () => void }) | null} */
  const drawer = document.querySelector('theme-drawer#cart-drawer');
  if (drawer?.open) drawer.open();
  else window.location.href = Theme.routes.cart_url;
}
