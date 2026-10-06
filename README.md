# Build Your Own Box — Shopify Horizon customization

A working **Build Your Own Box (BYOB)** experience built as a native Shopify Online Store 2.0
customization on top of Shopify's [Horizon](https://themes.shopify.com/themes/horizon) theme (v4.2.0).
No apps, no external libraries — Liquid, the theme's own component framework, and the AJAX Cart API.

Shoppers pick a box size, fill it with products, see live progress and pricing, and add the whole
box to the cart in a single request. The box can't be added until it meets the size's item limits.

## Features

- **Box sizes as product variants** — each variant of the box product is a size; its price is the box fee.
- **Min / max item limits per size**, configured in the theme editor ("Box size" blocks).
- **Product picker** from any collection, with variant selection and per-variant quantity steppers.
- **Inventory aware** — steppers respect tracked stock; sold-out products and variants are disabled.
- **Live progress bar and status** — "Add 2 more items", "Ready!", "Remove 1 item to fit this box".
- **Dynamic pricing** — box fee + items subtotal = total, formatted with the shop's money format.
- **Add-to-cart gating** — the button is disabled until the selection is valid.
- **One AJAX request** (`/cart/add.js` with an `items` array) adds the box and its contents. Every line
  shares a hidden `_byob_id` property; contents lines show "Packed in: Medium · BOX-XXXX" and the box
  line lists its contents, so the grouping is visible in the cart and on the order.
- **Integrates with Horizon's cart** — dispatches the standard `CartLinesUpdateEvent`, so the cart
  drawer, cart count and cart page refresh exactly as with the theme's own add-to-cart.
- **Responsive** — sticky sidebar summary on desktop, compact sticky bottom bar on mobile.
- **Accessible** — native radio inputs for sizes, labelled steppers, a single polite live region for
  status, visible focus states, reduced-motion support.
- **Translatable** — all storefront and editor text lives in `locales/`.

## Files added

| File | Purpose |
| --- | --- |
| `sections/byob-builder.liquid` | Section markup, scoped CSS (`{% stylesheet %}`), schema with settings and "Box size" blocks |
| `snippets/byob-product-card.liquid` | Selectable product card with variant select and quantity stepper |
| `snippets/byob-variant-option.liquid` | Variant `<option>` carrying price and stock data |
| `assets/byob-builder.js` | `<byob-builder-component>` — state, rendering, validation and cart request |
| `templates/product.byob.json` | Product template that renders the builder with three preset sizes |
| `locales/en.default.json`, `locales/en.default.schema.json` | `byob` translation keys (appended) |

No existing Horizon files were modified apart from appending the `byob` locale namespaces.

## How it works

```
Liquid (server)                         JavaScript (client)
────────────────────────────────        ─────────────────────────────────────────
box product variants  → size radios     handleSizeChange   → read min/max/fee
"Box size" blocks     → data-min/max    increase/decrease  → update Map<variantId, line>
collection products   → product cards   #render()          → progress, status, totals,
variant price/stock   → data-* attrs                          card states, button state
                                        addToCart()        → POST /cart/add.js (items[])
                                                           → CartLinesUpdateEvent → drawer/count
```

- Initial UI is rendered in Liquid; JavaScript only owns interaction state.
- The component extends Horizon's `Component` class (`@theme/component`), using `ref`/`on:` attributes
  for element references and declarative event handling.
- Pricing is computed in minor units (cents) and formatted with Horizon's `formatMoney`.
- A request is guarded against double submission and can be aborted if the element disconnects.

## Setup

1. Create a product (e.g. "Build Your Own Box") with one option, **Box size**, and variants such as
   `Small`, `Medium`, `Large`. Set each variant's price to the box fee. Inventory tracking off.
2. Push the theme:
   ```bash
   shopify theme push --store <your-store>.myshopify.com
   ```
3. In the product admin, set **Theme template** to `byob`.
4. In the theme editor, open the template and adjust the collection, heading and the "Box size" blocks.
   Each block's *Variant title* must match a variant title exactly.

The section can also be added to any page; select a box product in its settings.

## Testing performed

Tested on the live development store (desktop 1280px and mobile 375px):

- Below minimum → button disabled with "Add N more" message
- Reaching minimum enables the button; at maximum every "+" is disabled
- Switching to a smaller size with too many items → over-limit state, red progress, button disabled
- Removing items from the card stepper and from the summary list
- Multi-variant product: separate lines per variant, product badge shows combined quantity
- Totals verified manually against item prices + box fee
- Add to cart: 6 lines added in one request, shared `_byob_id`, cart total equals builder total,
  cart count refreshed, cart page shows "Packed in" / "Contents" properties
- Theme Check: no offenses in the added files

## Known limitations / next steps

- Lines can be edited individually in the cart after adding. A production build would enforce the
  bundle server-side with a **Cart Transform** or **Cart and Checkout Validation** Shopify Function.
- Box pricing is box fee + item prices; tiered box discounts would be implemented with an automatic
  discount (Discount Function) rather than in theme code.
- Only English strings are provided; other locales fall back to English.

## Credits

Base theme: Horizon © Shopify. The BYOB feature (files listed above) was written specifically for this
demo store.
