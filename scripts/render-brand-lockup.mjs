// Builds the horizontal logo lockup, public/brand/smartremit-lockup.png: the
// mark on the left, the "SmartRemit.ai" wordmark on the right, both cropped
// from the stacked logo (public/brand/smartremit-logo.png) so the artwork is
// the brand's own, not a re-typeset approximation. Rendered at 4x the 40px nav
// height, so next/image serves crisp 1x/2x candidates. Re-run after a brand
// change:
//
//   node scripts/render-brand-lockup.mjs
//
// sharp ships with Next (image optimisation); nothing new is installed.

import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = process.cwd();
const src = join(root, 'public/brand/smartremit-logo.png');
const out = join(root, 'public/brand/smartremit-lockup.png');

// The stacked logo is 1028x533: the mark sits above y=352, the wordmark in
// the band below y=396 (transparent rows between them).
const MARK_BAND = { left: 0, top: 0, width: 1028, height: 352 };
const WORD_BAND = { left: 0, top: 396, width: 1028, height: 533 - 396 };

const H = 160; // lockup height in px (4x of 40)
const MARK_H = H; // the mark fills the height
const WORD_H = Math.round(H * 0.46); // wordmark band height relative to the mark
const GAP = Math.round(H * 0.2);

async function cropTrim(region, height) {
  // One operation per pipeline: sharp runs trim before extract when chained.
  const band = await sharp(src).extract(region).png().toBuffer();
  const trimmed = await sharp(band).trim({ threshold: 1 }).png().toBuffer();
  return sharp(trimmed).resize({ height, kernel: 'lanczos3' }).png().toBuffer({ resolveWithObject: true });
}

const mark = await cropTrim(MARK_BAND, MARK_H);
const word = await cropTrim(WORD_BAND, WORD_H);
// Round the canvas up to a multiple of H/40 so the 40px nav size has an
// integer width (next/image warns when CSS changes one dimension only).
const STEP = H / 40;
const width = Math.ceil((mark.info.width + GAP + word.info.width) / STEP) * STEP;

await sharp({
  create: { width, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([
    { input: mark.data, left: 0, top: 0 },
    // Optical centre: the wordmark sits a touch below the geometric middle,
    // level with the mark's heavy lower half.
    { input: word.data, left: mark.info.width + GAP, top: Math.round((H - WORD_H) / 2 + H * 0.04) },
  ])
  .png({ compressionLevel: 9 })
  .toFile(out);

console.log(`wrote ${out} (${width}x${H}); mark ${mark.info.width}x${MARK_H}, wordmark ${word.info.width}x${WORD_H}`);
