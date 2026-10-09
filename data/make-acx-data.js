// Single source of truth for the "Advanced Cart" demo (Brew Bar).
// Generates data/acx-products.csv (products + variants + images) and
// templates/page.acx.json (products grid, bought together, cart drawer).
// Usage: node data/make-acx-data.js [--confirm-shipping] [--discount-hint]
const fs = require('fs');
const path = require('path');

const confirmShipping = process.argv.includes('--confirm-shipping');
const discountHint = process.argv.includes('--discount-hint');

// Free Unsplash photos (unsplash.com/license), cropped square by imgix.
const photo = (id) => `https://images.unsplash.com/${id}?w=1000&h=1000&fit=crop&crop=entropy&fm=jpg&q=80`;

// price(values) returns the variant price; soldOut(values) marks tracked variants
// that should import with zero stock (Shopify imports tracked variants at 0).
const products = [
  {
    handle: 'acx-house-blend-beans', title: 'House Blend Coffee Beans', type: 'Coffee',
    body: 'A balanced medium roast with notes of cocoa, caramel and orange. Roasted weekly.',
    options: [['Size', ['250 g', '1 kg']], ['Grind', ['Whole bean', 'Espresso', 'Filter']]],
    price: (o) => (o[0] === '1 kg' ? 48 : 16),
    images: [['photo-1562051036-e0eea191d42f', 'Coffee beans in an open paper bag']],
  },
  {
    handle: 'acx-ceramic-dripper', title: 'Ceramic Pour-Over Dripper', type: 'Brewers',
    body: 'A fluted porcelain dripper for a clean, bright cup. Fits most mugs and carafes.',
    options: [['Color', ['White', 'Charcoal']]], price: () => 34,
    images: [
      ['photo-1774296478874-13f2c1514ef9', 'White fluted ceramic pour-over dripper'],
      ['photo-1783206695207-aa4deabafa7b', 'Charcoal pour-over dripper on a glass carafe', 'Charcoal'],
    ],
  },
  {
    handle: 'acx-paper-filters', title: 'Paper Filters, 100 Pack', type: 'Accessories',
    body: 'Unbleached paper filters that fit our pour-over dripper.', price: () => 8,
    images: [['photo-1521677446241-d182a96ec49f', 'Paper filter with ground coffee in a dripper']],
  },
  {
    handle: 'acx-glass-carafe', title: 'Glass Coffee Carafe', type: 'Brewers',
    body: 'A 600 ml heat-resistant borosilicate server with a pouring spout.', price: () => 29,
    images: [['photo-1574359172160-c7ae4fadcacc', 'Glass carafe filled with coffee']],
  },
  {
    handle: 'acx-gooseneck-kettle', title: 'Gooseneck Pour-Over Kettle', type: 'Kettles',
    body: 'Precise, steady pours from a slim spout. Works on gas, electric and induction.', price: () => 79, compare: 95,
    images: [['photo-1592417766326-088bf3da80c5', 'Black gooseneck kettle on a wooden table']],
  },
  {
    handle: 'acx-hand-grinder', title: 'Hand Burr Grinder', type: 'Grinders',
    body: 'Conical steel burrs with stepped grind settings, from espresso to French press.', price: () => 119,
    images: [['photo-1573066380308-24ff4c273dbc', 'Wooden hand coffee grinder']],
  },
  {
    handle: 'acx-coffee-scale', title: 'Digital Coffee Scale', type: 'Accessories',
    body: 'Weighs to 0.1 g with a built-in timer for repeatable recipes.', price: () => 45,
    tracked: true, // stock is set to a small number after import to demo quantity limits
    images: [['photo-1753091122032-ddfb454849cc', 'Coffee beans weighed on a digital scale']],
  },
  {
    handle: 'acx-stoneware-mug', title: 'Stoneware Mug', type: 'Mugs',
    body: 'A hand-glazed 350 ml mug that keeps coffee warm.',
    options: [['Color', ['Sand', 'Slate', 'Moss']]], price: () => 22, soldOut: (o) => o[0] === 'Moss',
    images: [['photo-1570784332176-fdd73da66f03', 'White stoneware mug on a blue background']],
  },
  {
    handle: 'acx-travel-tumbler', title: 'Insulated Travel Tumbler', type: 'Mugs',
    body: 'Double-walled steel keeps drinks hot for six hours. Back soon.', price: () => 32, soldOut: () => true,
    images: [['photo-1604713055037-ef1ec567a47b', 'Steel travel tumbler held in two hands']],
  },
  {
    handle: 'acx-cold-brew-bottle', title: 'Cold Brew Bottle', type: 'Brewers',
    body: 'Steep overnight in the fridge for smooth, low-acid cold brew. Makes 1 litre.', price: () => 39,
    images: [['photo-1591933940638-d253adcdcb98', 'Cold brew bottle beside two glasses of iced coffee']],
  },
  {
    handle: 'acx-bean-sampler', title: 'Mini Bean Sampler', type: 'Gift', gift: true,
    body: 'A 50 g tasting jar of our current roast. Free with qualifying orders.',
    options: [['Roast', ['Light roast', 'Dark roast']]], price: () => 0,
    images: [['photo-1550608751-d38ee4dd799a', 'Glass jars filled with coffee beans']],
  },
];

/* ---------------- CSV ---------------- */
const cols = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy',
  'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable',
  'Image Src', 'Image Position', 'Image Alt Text', 'Variant Image', 'Status',
];
const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const combos = (options) =>
  options.reduce((acc, [, values]) => acc.flatMap((prefix) => values.map((v) => [...prefix, v])), [[]]);

const rows = [];
for (const p of products) {
  const options = p.options ?? [['Title', ['Default Title']]];
  const variants = combos(options);
  const lines = Math.max(variants.length, p.images.length);
  for (let index = 0; index < lines; index++) {
    const values = variants[index];
    const row = { Handle: p.handle };
    if (values) {
      const tracked = Boolean(p.soldOut || p.tracked);
      const variantImage = p.images.find(([, , value]) => value && values.includes(value));
      Object.assign(row, {
        'Option1 Value': values[0],
        'Option2 Value': values[1] ?? '',
        'Variant SKU': `${p.handle.toUpperCase()}-${index + 1}`,
        'Variant Grams': p.gift ? 60 : 500,
        'Variant Inventory Tracker': tracked ? 'shopify' : '',
        'Variant Inventory Qty': tracked ? (p.soldOut?.(values) ? 0 : 5) : '',
        'Variant Inventory Policy': 'deny',
        'Variant Fulfillment Service': 'manual',
        'Variant Price': p.price(values).toFixed(2),
        'Variant Compare At Price': p.compare ? p.compare.toFixed(2) : '',
        'Variant Requires Shipping': 'TRUE',
        'Variant Taxable': p.gift ? 'FALSE' : 'TRUE',
        'Variant Image': variantImage ? photo(variantImage[0]) : '',
      });
    }
    const image = p.images[index];
    if (image) Object.assign(row, { 'Image Src': photo(image[0]), 'Image Position': index + 1, 'Image Alt Text': image[1] });
    if (index === 0) {
      Object.assign(row, {
        Title: p.title, 'Body (HTML)': `<p>${p.body}</p>`, Vendor: 'Yasir Demo Lab', Type: p.type,
        Tags: p.gift ? 'acx-product, acx-gift' : 'acx-product', Published: 'TRUE',
        'Option1 Name': options[0][0], 'Option2 Name': options[1]?.[0] ?? '', Status: 'active',
      });
    }
    rows.push(cols.map((c) => esc(row[c])).join(','));
  }
}
fs.writeFileSync(path.join(__dirname, 'acx-products.csv'), [cols.join(','), ...rows].join('\n') + '\n');

/* ---------------- Page template ---------------- */
const h = (suffix) => `acx-${suffix}`;
const rules = [
  ['ceramic-dripper', ['paper-filters', 'glass-carafe', 'gooseneck-kettle']],
  ['gooseneck-kettle', ['ceramic-dripper', 'coffee-scale']],
  ['hand-grinder', ['house-blend-beans', 'coffee-scale']],
  ['house-blend-beans', ['hand-grinder', 'ceramic-dripper']],
  ['glass-carafe', ['ceramic-dripper', 'stoneware-mug']],
  ['cold-brew-bottle', ['house-blend-beans', 'travel-tumbler']],
];
const blocks = {};
const blockOrder = [];
for (const [trigger, suggestions] of rules) {
  const id = `rule_${trigger.replace(/-/g, '_')}`;
  blocks[id] = { type: 'upsell_rule', settings: { trigger: h(trigger), products: suggestions.map(h) } };
  blockOrder.push(id);
}

const template = {
  sections: {
    products: {
      type: 'acx-products',
      settings: {
        eyebrow: 'Advanced cart demo',
        heading: 'Brew Bar',
        intro:
          '<p>A small coffee shop built to show an advanced AJAX cart. Add anything and the cart drawer opens with live totals, offers and suggestions — every change is a real Shopify cart update.</p>',
        products: ['house-blend-beans', 'ceramic-dripper', 'gooseneck-kettle', 'hand-grinder', 'coffee-scale', 'stoneware-mug', 'cold-brew-bottle', 'travel-tumbler'].map(h),
        hint_1: confirmShipping ? 'Free shipping on orders over $100' : '',
        hint_2: 'Free bean sampler on orders over $150',
        hint_3: discountHint ? 'Try code BREW10 for 10% off' : '',
      },
    },
    bought_together: {
      type: 'acx-fbt',
      settings: {
        heading: 'Frequently bought together',
        text: 'Everything you need for your first pour-over.',
        product: h('ceramic-dripper'),
        companions: ['paper-filters', 'glass-carafe', 'house-blend-beans'].map(h),
      },
    },
    cart_drawer: {
      type: 'acx-cart-drawer',
      blocks,
      block_order: blockOrder,
      settings: {
        intercept_header: true,
        free_shipping_enabled: true,
        free_shipping_threshold: 100,
        free_shipping_confirmed: confirmShipping,
        gift_enabled: true,
        gift_threshold: 150,
        gift_product: h('bean-sampler'),
        upsell_heading: 'Pairs well with',
        use_recommendations: true,
        recommendation_tag: 'acx-product',
        upsell_limit: 3,
        upsell_products: ['coffee-scale', 'paper-filters', 'stoneware-mug', 'house-blend-beans'].map(h),
        show_discount: true,
        empty_heading: 'Your cart is empty',
        empty_text: 'Good coffee starts here. Pick a brewer, beans or a mug to begin.',
        continue_url: '/collections/all',
        empty_featured_heading: 'Popular right now',
        empty_products: ['house-blend-beans', 'ceramic-dripper', 'stoneware-mug'].map(h),
      },
    },
  },
  order: ['products', 'bought_together', 'cart_drawer'],
};
fs.writeFileSync(path.join(__dirname, '..', 'templates', 'page.acx.json'), JSON.stringify(template, null, 2) + '\n');

console.log(`wrote ${rows.length} CSV rows for ${products.length} products and templates/page.acx.json`);
module.exports = { products };
