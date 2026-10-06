/**
 * Live preview renderer for the Product Personalizer. The SVG's look is driven by
 * data attributes and CSS custom properties (see snippets/pz-preview.liquid), so an
 * update is a handful of attribute writes plus fitting the message text.
 * @module pz-preview
 */

const MAX_FONT = 26;
const MIN_FONT = 11;
const MESSAGE_WIDTH = 168;

/**
 * @param {SVGSVGElement} svg
 * @param {import('@theme/pz-model').Design} design
 * @param {{ swatch?: { hex: string, ink: string }, addonKeys: string[], placeholder: string }} context
 */
export function renderPreview(svg, design, { swatch, addonKeys, placeholder }) {
  const set = (name, value) => {
    if (svg.getAttribute(name) !== value) svg.setAttribute(name, value);
  };

  set('data-style', design.style === 'Drawer Box' ? 'drawer' : 'keepsake');
  set('data-size', (design.size ?? 'Medium').toLowerCase());
  set('data-motif', design.motif);
  set('data-lettering', design.lettering);
  set('data-ribbon', String(addonKeys.includes('ribbon')));
  set('data-card', String(addonKeys.includes('card')));
  set('data-packaging', String(addonKeys.includes('packaging')));

  if (swatch) {
    svg.style.setProperty('--pz-box', swatch.hex);
    svg.style.setProperty('--pz-ink', swatch.ink);
  }

  const text = svg.querySelector('[data-pz-message]');
  if (text instanceof SVGTextElement) {
    const message = design.message.trim();
    set('data-has-message', String(Boolean(message)));
    const content = message || placeholder;
    // Re-fit when the text or the lettering changes (fonts have different widths).
    const fitKey = `${design.lettering}|${content}`;
    if (text.dataset.fitKey !== fitKey) {
      text.textContent = content;
      fitText(text);
      // Only cache once the SVG is rendered; a hidden preview measures 0.
      if (text.getComputedTextLength() > 0) text.dataset.fitKey = fitKey;
    }
  }
}

/**
 * Shrinks the font until the message fits the lid plate.
 * @param {SVGTextElement} text
 */
function fitText(text) {
  let size = MAX_FONT;
  text.setAttribute('font-size', String(size));
  // getComputedTextLength needs a rendered element; guard for hidden previews.
  if (!text.getComputedTextLength) return;
  while (size > MIN_FONT && text.getComputedTextLength() > MESSAGE_WIDTH) {
    size -= 1;
    text.setAttribute('font-size', String(size));
  }
  if (text.getComputedTextLength() > MESSAGE_WIDTH) {
    text.setAttribute('textLength', String(MESSAGE_WIDTH));
    text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
  } else {
    text.removeAttribute('textLength');
    text.removeAttribute('lengthAdjust');
  }
}
