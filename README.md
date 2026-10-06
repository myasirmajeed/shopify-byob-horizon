# Build Your Own Box — Shopify Horizon customizations

This repo contains two independent BYOB demos on the Horizon theme:

| Demo | URL | Files |
| --- | --- | --- |
| **BYOB 2** — four-step chocolate box builder | `/pages/build-your-own-box-2` | `yb2-*` |
| **BYOB 1** — single-page box builder | `/products/build-your-own-box` | `byob-*` |
| **Product Personalizer** — custom gift box with live preview | `/pages/custom-gift-box` | `pz-*` |

## Product Personalizer — custom gift box

Customers design a gift box: **box style**, **color** (swatches), **size**, a **personal message**
(live counter, character limit, unsupported-character check), **lettering** and **design** motif,
**add-ons** and **quantity** — with an original SVG preview that updates instantly.

**Honest pricing.** The product has three real options (Box style × Color × Size = 30 variants), so
the box price is the variant price. Add-ons (Premium Ribbon $3, Gift Card $2, Premium Packaging $5)
are real products added as extra cart lines at the same quantity. The displayed total
`(variant + add-ons) × quantity` is therefore exactly what the cart charges.

**Cart.** One `/cart/add.js` request adds the box and its add-ons. The box line carries
`Personal message`, `Lettering`, `Design` and `Add-ons` properties (color/size show as variant
options); add-on lines carry `Added to: Custom Gift Box (Rose / Large)`; every line shares a hidden
`_pz_bundle` ID. Horizon's `CartLinesUpdateEvent` refreshes the drawer and cart count.

**Validation.** Size must be chosen; message length and characters are checked live; quantity must be
a whole number between 1 and the configured maximum. Errors appear inline and in a focused summary
whose items jump to the field.

| File | Responsibility |
| --- | --- |
| `assets/pz-model.js` | Pure logic: variant lookup, option availability, pricing, validation, cart items |
| `assets/pz-preview.js` | Updates the SVG preview (data attributes, colours, text fitting) |
| `assets/pz-cart.js` | AJAX Cart API + Horizon cart events |
| `assets/pz-customizer.js` | `<pz-customizer-component>` controller, rendering and persistence |
| `sections/pz-customizer.liquid` | Layout, design tokens, schema (product, add-ons, limits, swatch blocks) |
| `snippets/pz-*.liquid` | Preview, options, message, add-ons, purchase panel, data, icons |
| `templates/page.pz.json` | Page template with swatch colours and add-on products |
| `data/pz-products.csv` | Recreates the gift box and add-on products (`node data/make-pz-products.js`) |

**Limitations.** Add-ons are separate lines a customer could remove in the cart (a Cart Transform
function could merge them into one bundle line). The design is a preview, not a print-proof.

## BYOB 2 — four-step chocolate box builder

Choose a box (6/12/16/24) → choose flavors → choose a sleeve → review → add to cart.

**Data model.** The box product has two options, *Box size* × *Sleeve* (16 variants), and each
variant's price is the full box price. The builder adds that variant, so the price shown is always
the price Shopify charges — no front-end price manipulation. Flavors are products selected in a
`product_list` setting (type = category; "Vegan" / "Best Seller" tags add filters; `yb2-shell:`,
`yb2-top:`, `yb2-accent:` tags drive the original SVG illustrations).

**Cart line.** One `/cart/add.js` call with properties `Total pieces`, `Flavor 1…n` (e.g.
"Dark Sea Salt Caramel × 3") and a hidden `_yb2_config` JSON with product IDs for fulfilment.
Horizon's `CartLinesUpdateEvent` refreshes the cart drawer and count.

**Code layout.**

| File | Responsibility |
| --- | --- |
| `assets/yb2-model.js` | Pure logic: variant lookup, pricing, step validation, restore sanitising, cart payload |
| `assets/yb2-store.js` | Observable state with guarded localStorage persistence |
| `assets/yb2-view.js` | DOM rendering for progress, counter, cards, tray, stats, review |
| `assets/yb2-cart.js` | AJAX Cart API + Horizon cart events |
| `assets/yb2-builder.js` | `<yb2-builder-component>` controller (Horizon `Component`) |
| `sections/yb2-builder.liquid` | Section, design tokens, schema ("size" and "sleeve" blocks) |
| `snippets/yb2-*.liquid` | One snippet per step, card, summary, art, icons and JSON data |
| `templates/page.yb2.json` | Page template with sizes, sleeves and flavor list |

Shared files touched (additive only): four `@theme/yb2-*` import-map entries in
`snippets/scripts.liquid`, and a `yb2` namespace in the `en.default` locale files.

**UX details.** Desktop step bar and mobile numbered markers (completed steps are clickable);
sticky summary sidebar on desktop and sticky bottom bar with expandable box preview on mobile;
"8 / 16 selected" counter with remaining count; capacity guard with a friendly message; filters and
search that never touch selections; tray slots you can click to remove a piece; state restored after a
refresh with a "Start over" option; focus moves to each step heading; one polite live region.

**Demo data.** `data/yb2-products.csv` recreates the box product (16 variants) and the 12 flavor
products via *Products → Import*. Then create a page with the `yb2` template. (`data/` is listed in
`.shopifyignore`, so theme pushes skip it.)

**Images.** Flavor product photos and sleeve photos are free stock images from
[Unsplash](https://unsplash.com/license) (free for commercial use; credit is courtesy):
Rosemary Williams, Ilya Mashkov, Massimo Adami, Jana Ohajdova, Monika Grabkowska,
amirali mirhashemian, Ediglecio Lêla, Tetiana Bykovets, Büşra Salkım, Ioana Enescu, Hannah Dodwell,
Elena Leya (flavors); Wijdan Mq, Ekaterina Shevchenko, Anastasiia Chepinska, Shamblen Studios
(sleeves). Sleeve images live in Shopify Files and are referenced from `templates/page.yb2.json`.
Original SVG illustrations remain as the fallback when a flavor or sleeve has no image.

**Limitations.** Flavor inventory isn't decremented (flavors are properties, not lines) — a
production build would use a Cart Transform bundle function. Flavor products are also purchasable on
their own. Only English strings are included.

---

## BYOB 1 — single-page box builder

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
