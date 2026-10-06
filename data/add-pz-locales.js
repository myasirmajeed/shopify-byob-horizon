// Appends the `pz` (Product Personalizer) namespace to Horizon's default locale
// files as text, because they contain comments. Refuses to run twice.
// Usage: node data/add-pz-locales.js
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

append('en.default.json', 'pz', {
  eyebrow: 'Personalize it',
  preview_label: 'Live preview of your gift box',
  preview_placeholder: 'Your message here',
  style_label: 'Box style',
  color_label: 'Color',
  size_label: 'Size',
  message_heading: 'Add a personal message',
  message_label: 'Message printed on the lid',
  message_placeholder: 'e.g. Happy Birthday Sarah!',
  message_help: 'Optional. Up to {{ max }} characters, printed on the lid.',
  counter: '{{ count }} / {{ max }}',
  lettering_label: 'Lettering',
  lettering: { script: 'Script', serif: 'Classic serif', modern: 'Modern sans' },
  motif_label: 'Design',
  motif: { none: 'Plain', hearts: 'Hearts', stars: 'Stars', floral: 'Floral' },
  addons_heading: 'Add-ons',
  addons_help: 'Optional extras, added for every box.',
  quantity_label: 'Quantity',
  decrease: 'Decrease quantity',
  increase: 'Increase quantity',
  selected: 'Selected',
  summary_heading: 'Your gift box',
  price_box: 'Gift box',
  price_addons: 'Add-ons',
  price_each: 'Per box',
  price_quantity: 'Quantity',
  price_total: 'Total',
  price_from: 'From {{ price }}',
  none: 'None',
  add_to_cart: 'Add to cart',
  adding: 'Adding…',
  added_title: 'Added to your cart',
  view_cart: 'View cart',
  sold_out: 'Sold out',
  errors_heading: 'Please check the following:',
  error_style: 'Choose a box style.',
  error_color: 'Choose a color.',
  error_size: 'Choose a size.',
  error_unavailable: 'This combination is sold out. Please choose another option.',
  error_message_long: {
    one: 'Your message is 1 character too long.',
    other: 'Your message is {{ count }} characters too long.',
  },
  error_message_chars: 'Please remove these characters from your message: {{ chars }}',
  error_quantity: 'Quantity must be a whole number from 1 to {{ max }}.',
  error_generic: 'We couldn’t add this to your cart. Please try again.',
  restored: 'We restored your last design.',
  reset: 'Start again',
  property_message: 'Personal message',
  property_lettering: 'Lettering',
  property_design: 'Design',
  property_addons: 'Add-ons',
  property_for: 'Added to',
  no_product: 'Select the gift box product in the theme editor.',
  no_js: 'Turn on JavaScript to personalize this product.',
});

append('en.default.schema.json', 'pz', {
  name: 'Product personalizer',
  product: 'Product',
  product_info: 'Options must be: 1 box style, 2 color, 3 size.',
  addons: 'Add-on products',
  addons_info: 'Tag add-ons "pz-addon:ribbon", "pz-addon:card" or "pz-addon:packaging" to show them in the preview.',
  heading: 'Heading',
  intro: 'Introduction',
  max_chars: 'Message character limit',
  max_quantity: 'Maximum quantity',
  swatch_block: 'Color swatch',
  option_value: 'Color option value',
  swatch_color: 'Swatch color',
  ink_color: 'Lettering color on this box',
});

console.log('pz locales added');
