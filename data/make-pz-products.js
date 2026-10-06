// Generates data/pz-products.csv: the "Custom Gift Box" (box style × color × size)
// and its three add-on products for the Product Personalizer demo.
// Usage: node data/make-pz-products.js
const fs = require('fs');
const path = require('path');

const cols = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Policy',
  'Variant Fulfillment Service', 'Variant Price', 'Variant Requires Shipping', 'Variant Taxable', 'Status',
];

const styles = [['Keepsake Box', 0], ['Drawer Box', 6]];
const colors = ['Classic', 'Rose', 'Midnight', 'Cream', 'Forest'];
const sizes = [['Small', 24, 300], ['Medium', 32, 450], ['Large', 42, 650]];

const addons = [
  ['pz-addon-premium-ribbon', 'Premium Ribbon', '3.00', 'ribbon', 'Hand-tied satin ribbon and bow in a matching tone.'],
  ['pz-addon-gift-card', 'Gift Card', '2.00', 'card', 'A printed card tucked under the ribbon.'],
  ['pz-addon-premium-packaging', 'Premium Packaging', '5.00', 'packaging', 'Tissue wrap and a gold-edged outer sleeve.'],
];

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = [];
const row = (o) => rows.push(cols.map((c) => esc(o[c])).join(','));

let first = true;
for (const [style, extra] of styles) {
  for (const color of colors) {
    for (const [size, base, grams] of sizes) {
      const variant = {
        Handle: 'custom-gift-box',
        'Option1 Value': style, 'Option2 Value': color, 'Option3 Value': size,
        'Variant SKU': `PZ-${style.split(' ')[0].toUpperCase()}-${color.toUpperCase()}-${size[0]}`,
        'Variant Grams': grams, 'Variant Inventory Policy': 'deny', 'Variant Fulfillment Service': 'manual',
        'Variant Price': (base + extra).toFixed(2), 'Variant Requires Shipping': 'TRUE', 'Variant Taxable': 'TRUE',
      };
      if (first) {
        Object.assign(variant, {
          Title: 'Custom Gift Box',
          'Body (HTML)': '<p>A rigid gift box you design yourself: choose the style, colour and size, then add a personal message printed on the lid.</p>',
          Vendor: 'Yasir Demo Lab', Type: 'Gift Box', Tags: 'pz-product', Published: 'TRUE',
          'Option1 Name': 'Box style', 'Option2 Name': 'Color', 'Option3 Name': 'Size', Status: 'active',
        });
        first = false;
      }
      row(variant);
    }
  }
}

for (const [handle, title, price, key, desc] of addons) {
  row({
    Handle: handle, Title: title, 'Body (HTML)': `<p>${desc}</p>`, Vendor: 'Yasir Demo Lab', Type: 'Gift Box Add-on',
    Tags: `pz-addon, pz-addon:${key}`, Published: 'TRUE', 'Option1 Name': 'Title', 'Option1 Value': 'Default Title',
    'Variant SKU': `PZ-ADDON-${key.toUpperCase()}`, 'Variant Grams': 20, 'Variant Inventory Policy': 'deny',
    'Variant Fulfillment Service': 'manual', 'Variant Price': price, 'Variant Requires Shipping': 'TRUE',
    'Variant Taxable': 'TRUE', Status: 'active',
  });
}

const out = path.join(__dirname, 'pz-products.csv');
fs.writeFileSync(out, [cols.join(','), ...rows].join('\n') + '\n');
console.log(`wrote ${rows.length} rows to ${out}`);
