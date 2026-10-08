// Appends the `stl` (Shop the Look) namespace to Horizon's default locale files as
// text, because they contain comments. Refuses to run twice.
// Usage: node data/add-stl-locales.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function append(file, key, value) {
  const full = path.join(root, 'locales', file);
  const raw = fs.readFileSync(full, 'utf8');
  if (raw.includes(`"${key}": {`)) throw new Error(`${file} already has ${key}`);
  const end = raw.lastIndexOf('}');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const body = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
  const insert = `,\n  "${key}": ${body}\n`.replace(/\n/g, eol);
  fs.writeFileSync(full, raw.slice(0, end).replace(/\s+$/, '') + insert + raw.slice(end));
}

append('en.default.json', 'stl', {
  looks_label: 'Choose a look',
  look_count: { one: '1 piece', other: '{{ count }} pieces' },
  hotspot_label: 'Show {{ product }}',
  list_heading: 'Shop the look',
  list_label: 'Products in this look',
  include: 'Include {{ product }} in Add all',
  view: 'View',
  view_product: 'View details for {{ product }}',
  add: 'Add',
  add_product: 'Add {{ product }} to cart',
  added: 'Added',
  sold_out: 'Sold out',
  unavailable: 'Unavailable',
  sale: 'Sale',
  regular_price: 'Regular price',
  sale_price: 'Sale price',
  rating: 'Rated {{ rating }} out of 5',
  rating_count: { one: '1 review', other: '{{ count }} reviews' },
  quantity: 'Quantity',
  decrease: 'Decrease quantity',
  increase: 'Increase quantity',
  add_to_cart: 'Add to cart',
  adding: 'Adding…',
  added_to_cart: 'Added to cart',
  view_cart: 'View cart',
  full_details: 'View full details',
  close: 'Close',
  error: 'Couldn’t add this item. Please try again.',
  add_all: 'Add all to cart',
  add_all_selected: { one: 'Add 1 item to cart', other: 'Add {{ count }} items to cart' },
  nothing_selected: 'Select at least one available item.',
  adding_all: 'Adding the look…',
  added_all: { one: 'Added 1 item to your cart', other: 'Added {{ count }} items to your cart' },
  skipped: 'Not added: {{ items }}',
  look_total: 'Look total',
  placeholder_product: 'Choose a product for this hotspot',
  no_looks: 'Add a look block in the theme editor.',
});

append('en.default.schema.json', 'stl', {
  name: 'Shop the look',
  look: 'Look',
  hotspot: 'Hotspot',
  heading: 'Heading',
  intro: 'Introduction',
  show_add_all: 'Show "Add all to cart"',
  title: 'Look title',
  description: 'Look description',
  image: 'Lifestyle image',
  image_info: 'Use a landscape image. Hotspot positions are percentages of this image.',
  product: 'Product',
  x_position: 'Horizontal position',
  y_position: 'Vertical position',
  label: 'Label',
  label_info: 'Short name shown next to the hotspot on desktop, for example "Sofa".',
});

console.log('stl locales added');
