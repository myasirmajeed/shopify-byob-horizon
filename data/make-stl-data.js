// Single source of truth for the "Shop the Look" demo.
// Generates data/stl-products.csv (products + variants + scene-crop images) and
// templates/page.stl.json (section → look blocks → hotspot blocks).
// Usage: node data/make-stl-data.js
const fs = require('fs');
const path = require('path');

// Free Unsplash photos (unsplash.com/license). `file` is the Shopify Files name used by the template.
const scenes = {
  living: { raw: 'https://images.unsplash.com/photo-1550581190-9c1c48d21d6c', w: 4025, h: 2886, file: 'stl-look-living.jpg' },
  bedroom: { raw: 'https://images.unsplash.com/photo-1600210491305-7396500b5b31', w: 4000, h: 3000, file: 'stl-look-bedroom.jpg' },
  outdoor: { raw: 'https://images.unsplash.com/photo-1762608675427-09ac2dbd1540', w: 6000, h: 4000, file: 'stl-look-outdoor.jpg' },
  office: { raw: 'https://images.unsplash.com/photo-1633789638578-eef0da1dc063', w: 4415, h: 3311, file: 'stl-look-office.jpg' },
};

// crop: [x%, y%, w%, h%] of the scene used as the product image.
// options: [[name, [values]], ...]; price(optionValues) returns the variant price.
// soldOut(optionValues) marks tracked variants with 0 stock.
const looks = [
  {
    key: 'living', title: 'Modern Living Room', alt: 'Living room with a charcoal corner sofa, floor lamp, nesting coffee tables and a chevron rug',
    description: 'A relaxed corner sofa, nesting tables and soft texture underfoot.',
    products: [
      { handle: 'stl-harbor-corner-sofa', title: 'Harbor Corner Sofa', type: 'Sofas', label: 'Sofa', x: 42, y: 52, crop: [8, 36, 72, 40],
        body: 'A deep-seated corner sofa with a reversible chaise and feather-wrapped cushions.',
        options: [['Color', ['Charcoal', 'Oat', 'Sage']], ['Orientation', ['Left chaise', 'Right chaise']]], price: () => 1299, compare: 1499 },
      { handle: 'stl-linen-throw-cushion', title: 'Linen Throw Cushion', type: 'Cushions', label: 'Cushion', x: 56, y: 46, crop: [48, 37, 15, 18],
        body: 'Stonewashed linen cover with a plump recycled-fibre insert. 50 × 50 cm.',
        options: [['Color', ['Seafoam', 'Mustard', 'Botanical']]], price: () => 39 },
      { handle: 'stl-arc-floor-lamp', title: 'Arc Floor Lamp', type: 'Lighting', label: 'Floor lamp', x: 10, y: 16, crop: [0, 3, 18, 70],
        body: 'Matte black steel with a tilting shade and a warm dimmable glow.', price: () => 149 },
      { handle: 'stl-nesting-coffee-tables', title: 'Nesting Coffee Tables', type: 'Tables', label: 'Coffee tables', x: 47, y: 67, crop: [35, 55, 27, 31],
        body: 'A pair of white-topped tables on solid oak legs that tuck neatly together.', price: () => 249, compare: 289 },
      { handle: 'stl-chevron-wool-rug', title: 'Chevron Wool Rug', type: 'Rugs', label: 'Rug', x: 62, y: 86, crop: [20, 72, 62, 27],
        body: 'Hand-woven wool and cotton in a soft sage chevron.',
        options: [['Size', ['160 × 230 cm', '200 × 290 cm']]], price: (o) => (o[0].startsWith('160') ? 199 : 279) },
      { handle: 'stl-macrame-plant-hanger', title: 'Macramé Plant Hanger', type: 'Decor', label: 'Plant hanger', x: 19, y: 18, crop: [12, 0, 15, 34],
        body: 'Hand-knotted cotton cord with a matte black pot.', price: () => 29 },
    ],
  },
  {
    key: 'bedroom', title: 'Minimal Bedroom', alt: 'Bright bedroom with a linen-dressed bed, patterned throw, rattan pendant, globe lamp and woven pouf',
    description: 'Washed linen, natural rattan and calm, sculptural shapes.',
    products: [
      { handle: 'stl-rattan-dome-pendant', title: 'Rattan Dome Pendant', type: 'Lighting', label: 'Pendant', x: 57, y: 16, crop: [45, 0, 24, 31],
        body: 'Hand-woven rattan that casts a soft patterned light.', price: () => 129 },
      { handle: 'stl-washed-linen-duvet-set', title: 'Washed Linen Duvet Set', type: 'Bedding', label: 'Duvet set', x: 29, y: 66, crop: [15, 48, 50, 40],
        body: 'Duvet cover and two pillowcases in breathable pre-washed linen.',
        options: [['Size', ['Queen', 'King']], ['Color', ['Cloud', 'Stone']]], price: (o) => (o[0] === 'Queen' ? 189 : 229) },
      { handle: 'stl-geometric-knit-throw', title: 'Geometric Knit Throw', type: 'Throws', label: 'Throw', x: 41, y: 75, crop: [26, 58, 26, 32],
        body: 'A soft cotton-blend throw with a bold triangle pattern.', price: () => 79, compare: 99 },
      { handle: 'stl-opal-globe-table-lamp', title: 'Opal Globe Table Lamp', type: 'Lighting', label: 'Table lamp', x: 80, y: 59, crop: [73, 51, 15, 15],
        body: 'Mouth-blown opal glass on a slim brass base.', price: () => 89 },
      { handle: 'stl-pedestal-side-table', title: 'Pedestal Side Table', type: 'Tables', label: 'Side table', x: 81, y: 78, crop: [71, 60, 19, 31],
        body: 'A sculptural side table in matte white composite.', price: () => 159 },
      { handle: 'stl-woven-floor-pouf', title: 'Woven Floor Pouf', type: 'Decor', label: 'Pouf', x: 40, y: 92, crop: [27, 81, 26, 19],
        body: 'Braided jute pouf for extra seating or a footrest.',
        options: [['Color', ['Natural', 'Charcoal']]], price: () => 69, soldOut: (o) => o[0] === 'Charcoal' },
    ],
  },
  {
    key: 'outdoor', title: 'Outdoor Lounge', alt: 'Covered garden patio with a white loveseat, lounge chair, slatted coffee table and cube side table',
    description: 'Weather-ready seating for long evenings in the garden.',
    products: [
      { handle: 'stl-coastline-outdoor-loveseat', title: 'Coastline Outdoor Loveseat', type: 'Outdoor', label: 'Loveseat', x: 57, y: 53, crop: [43, 43, 27, 24],
        body: 'Powder-coated aluminium frame with quick-dry, all-weather cushions.',
        options: [['Color', ['Stone', 'Graphite']]], price: () => 749 },
      { handle: 'stl-coastline-lounge-chair', title: 'Coastline Lounge Chair', type: 'Outdoor', label: 'Lounge chair', x: 78, y: 63, crop: [67, 50, 21, 31],
        body: 'The matching lounge chair with a gently reclined back.',
        options: [['Color', ['Stone', 'Graphite']]], price: () => 399, soldOut: (o) => o[0] === 'Graphite' },
      { handle: 'stl-slatted-outdoor-coffee-table', title: 'Slatted Outdoor Coffee Table', type: 'Outdoor', label: 'Coffee table', x: 49, y: 66, crop: [36, 56, 26, 21],
        body: 'Slatted aluminium top that drains quickly after rain.', price: () => 329 },
      { handle: 'stl-concrete-cube-side-table', title: 'Concrete Cube Side Table', type: 'Outdoor', label: 'Side table', x: 31, y: 66, crop: [24, 55, 15, 19],
        body: 'Light-weight fibre-concrete cube. Back in stock soon.', price: () => 129, soldOut: () => true },
    ],
  },
  {
    key: 'office', title: 'Home Office', alt: 'Attic home office with a mesh task chair, sit-stand desk, framed print and a snake plant on a walnut stand',
    description: 'An ergonomic set-up under the eaves, warmed by walnut and greenery.',
    products: [
      { handle: 'stl-mesh-task-chair', title: 'Mesh Task Chair', type: 'Office', label: 'Task chair', x: 31, y: 50, crop: [17, 38, 31, 60],
        body: 'Breathable mesh back, adjustable lumbar support and 4D armrests.',
        options: [['Color', ['Black', 'Grey']]], price: () => 349, compare: 399 },
      { handle: 'stl-sit-stand-desk', title: 'Sit-Stand Desk', type: 'Office', label: 'Desk', x: 68, y: 54, crop: [16, 46, 66, 42],
        body: 'Dual-motor height adjustment from 65 to 128 cm with a solid oak top.',
        options: [['Width', ['120 cm', '140 cm', '160 cm']]], price: (o) => ({ '120 cm': 549, '140 cm': 599, '160 cm': 649 })[o[0]] },
      { handle: 'stl-botanical-framed-print', title: 'Botanical Framed Print', type: 'Wall art', label: 'Framed print', x: 51, y: 12, crop: [43, 2, 16, 15],
        body: 'Archival giclée print in a slim natural oak frame.',
        options: [['Size', ['A3', 'A2']]], price: (o) => (o[0] === 'A3' ? 59 : 79) },
      { handle: 'stl-snake-plant-ceramic-pot', title: 'Snake Plant in Ceramic Pot', type: 'Plants', label: 'Plant', x: 83, y: 34, crop: [76, 21, 15, 24],
        body: 'An easy-care snake plant in a speckled ceramic pot.', price: () => 45 },
      { handle: 'stl-walnut-plant-stand', title: 'Walnut Plant Stand', type: 'Furniture', label: 'Plant stand', x: 84, y: 63, crop: [75, 44, 17, 38],
        body: 'Solid walnut stand with a lower shelf for books.', price: () => 119 },
    ],
  },
];

/* ---------------- CSV ---------------- */
const cols = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy',
  'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable',
  'Image Src', 'Image Position', 'Image Alt Text', 'Status',
];
const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const cropUrl = (scene, [x, y, w, h]) => {
  const px = (pct, total) => Math.round((pct / 100) * total);
  const rect = [px(x, scene.w), px(y, scene.h), px(w, scene.w), px(h, scene.h)].join(',');
  return `${scene.raw}?rect=${rect}&w=900&h=900&fit=clip&fm=jpg&q=80`;
};
const combos = (options) =>
  options.reduce((acc, [, values]) => acc.flatMap((prefix) => values.map((v) => [...prefix, v])), [[]]);

const rows = [];
for (const look of looks) {
  const scene = scenes[look.key];
  for (const p of look.products) {
    const options = p.options ?? [['Title', ['Default Title']]];
    combos(options).forEach((values, index) => {
      const tracked = Boolean(p.soldOut);
      const row = {
        Handle: p.handle,
        'Option1 Value': values[0],
        'Option2 Value': values[1] ?? '',
        'Variant SKU': `${p.handle.toUpperCase()}-${index + 1}`,
        'Variant Grams': 1000,
        'Variant Inventory Tracker': tracked ? 'shopify' : '',
        'Variant Inventory Qty': tracked ? (p.soldOut(values) ? 0 : 25) : '',
        'Variant Inventory Policy': 'deny',
        'Variant Fulfillment Service': 'manual',
        'Variant Price': p.price(values).toFixed(2),
        'Variant Compare At Price': p.compare ? p.compare.toFixed(2) : '',
        'Variant Requires Shipping': 'TRUE',
        'Variant Taxable': 'TRUE',
      };
      if (index === 0) {
        Object.assign(row, {
          Title: p.title, 'Body (HTML)': `<p>${p.body}</p>`, Vendor: 'Yasir Demo Lab', Type: p.type,
          Tags: `stl-product, stl-look:${look.key}`, Published: 'TRUE',
          'Option1 Name': options[0][0], 'Option2 Name': options[1]?.[0] ?? '',
          'Image Src': cropUrl(scene, p.crop), 'Image Position': 1, 'Image Alt Text': `${p.title} from the ${look.title} look`,
          Status: 'active',
        });
      }
      rows.push(cols.map((c) => esc(row[c])).join(','));
    });
  }
}
fs.writeFileSync(path.join(__dirname, 'stl-products.csv'), [cols.join(','), ...rows].join('\n') + '\n');

/* ---------------- Page template ---------------- */
const blocks = {};
const blockOrder = [];
for (const look of looks) {
  const id = `look_${look.key}`;
  const children = {};
  const childOrder = [];
  for (const p of look.products) {
    const hid = `hotspot_${p.handle.replace(/^stl-/, '').replace(/-/g, '_')}`;
    children[hid] = { type: '_stl-hotspot', settings: { product: p.handle, x_position: p.x, y_position: p.y, label: p.label } };
    childOrder.push(hid);
  }
  blocks[id] = {
    type: '_stl-look',
    settings: { title: look.title, description: look.description, image_alt: look.alt, image: `shopify://shop_images/${scenes[look.key].file}` },
    blocks: children,
    block_order: childOrder,
  };
  blockOrder.push(id);
}
const template = {
  sections: {
    shop_the_look: {
      type: 'stl-shop-the-look',
      blocks,
      block_order: blockOrder,
      settings: {
        heading: 'Shop the look',
        intro: '<p>Explore real rooms, tap a hotspot to see each piece, then add one item or the whole look to your cart.</p>',
        show_add_all: true,
      },
    },
  },
  order: ['shop_the_look'],
};
fs.writeFileSync(path.join(__dirname, '..', 'templates', 'page.stl.json'), JSON.stringify(template, null, 2) + '\n');

const count = looks.reduce((n, l) => n + l.products.length, 0);
console.log(`wrote ${rows.length} CSV rows for ${count} products and templates/page.stl.json (${looks.length} looks)`);
module.exports = { scenes, looks };
