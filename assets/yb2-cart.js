/**
 * Cart integration for the Build Your Own Box 2 builder. Uses the AJAX Cart API
 * and Horizon's standard cart events so the cart drawer, cart count and cart page
 * refresh exactly as they do for the theme's own add-to-cart button.
 * @module yb2-cart
 */

import { CartLinesUpdateEvent, CartErrorEvent } from '@shopify/events';

export class CartAddError extends Error {}

/**
 * @param {HTMLElement} source - Element that dispatches the bubbling cart events
 * @param {{ id: number, quantity: number, properties: Record<string, string> }} item
 * @param {AbortSignal} signal
 */
export async function addBoxToCart(source, item, signal) {
  const sectionIds = [...document.querySelectorAll('cart-items-component')]
    .map((element) => (element instanceof HTMLElement ? element.dataset.sectionId : ''))
    .filter(Boolean);

  const deferred = CartLinesUpdateEvent.createPromise();
  source.dispatchEvent(
    new CartLinesUpdateEvent({
      action: 'add',
      context: 'product',
      lines: [{ merchandiseId: String(item.id), quantity: item.quantity }],
      promise: deferred.promise,
    })
  );

  try {
    const response = await fetch(Theme.routes.cart_add_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: [item], sections: sectionIds.join(',') }),
      signal,
    });
    const result = await response.json();
    if (!response.ok || result.status) {
      throw new CartAddError(result.description || result.message || '');
    }

    const cartResponse = await fetch(`${Theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' }, signal });
    if (!cartResponse.ok) throw new Error(`Cart request failed: ${cartResponse.status}`);
    const cart = await cartResponse.json();

    deferred.resolve({
      cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
      detail: {
        items: cart.items,
        source: 'yb2-builder-component',
        itemCount: item.quantity,
        sections: result.sections,
        didError: false,
      },
    });

    return { cart, line: result.items?.[0] ?? null };
  } catch (error) {
    deferred.reject(error);
    if (!signal.aborted) {
      source.dispatchEvent(
        new CartErrorEvent({
          error: error instanceof Error && error.message ? error.message : 'Add to cart failed',
          code: error instanceof CartAddError ? 'INVALID' : 'SERVICE_UNAVAILABLE',
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
  if (drawer?.open) {
    drawer.open();
  } else {
    window.location.href = Theme.routes.cart_url;
  }
}
