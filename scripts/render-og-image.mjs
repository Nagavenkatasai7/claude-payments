// Renders the static share image, public/brand/og-image.png (1200x630), with
// next/og's ImageResponse (Satori + Resvg). The PNG is committed, so the build
// never generates it and no font is fetched at build time. Re-run after a brand
// change:
//
//   node scripts/render-og-image.mjs
//
// Needs network once: Inter (SIL OFL) 500 + 800 TTFs from Google Fonts, since
// Satori only reads ttf/otf/woff (next/dist/docs .../image-response.md).
//
// Why public/ + page-level openGraph.images, NOT the app/opengraph-image.png
// file convention: a file-based image in app/ is inherited by EVERY route
// segment below it, including the white-label, partner-branded /pay/** pages,
// whose shared links must never preview as SmartRemit. Config metadata on
// app/page.tsx and app/about/page.tsx applies to those pages only.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { createRequire } from 'node:module';

// next/og is CommonJS with no ESM export map; load it via require.
const { ImageResponse } = createRequire(import.meta.url)('next/og');

const root = process.cwd();

async function interTtf(weight) {
  const css = await (
    await fetch(`https://fonts.googleapis.com/css2?family=Inter:wght@${weight}`)
  ).text();
  const url = css.match(/src: url\((https:[^)]+\.ttf)\)/)?.[1];
  if (!url) throw new Error(`no Inter ${weight} ttf in the Google Fonts CSS`);
  return (await fetch(url)).arrayBuffer();
}

const logo = await readFile(join(root, 'public/brand/smartremit-logo.png'));
const logoSrc = `data:image/png;base64,${logo.toString('base64')}`;
const [inter500, inter800] = await Promise.all([interTtf(500), interTtf(800)]);

const NAVY = '#0b1b3f';

const image = new ImageResponse(
  h(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f5f9ff',
        backgroundImage:
          'radial-gradient(circle at 88% 8%, rgba(72,179,245,0.30), rgba(245,249,255,0) 45%), radial-gradient(circle at 6% 96%, rgba(52,211,153,0.24), rgba(245,249,255,0) 42%)',
        fontFamily: 'Inter',
      },
    },
    h('img', { src: logoSrc, width: 270, height: 140, style: { marginBottom: 30 } }),
    h(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          fontSize: 72,
          fontWeight: 800,
          letterSpacing: '-0.035em',
          color: NAVY,
          lineHeight: 1.06,
        },
      },
      h('span', null, 'Global money transfers,'),
      h(
        'span',
        {
          style: {
            backgroundImage: 'linear-gradient(95deg, #0e7490, #0d9488 45%, #059669)',
            backgroundClip: 'text',
            color: 'transparent',
          },
        },
        'made simpler.',
      ),
    ),
    h('div', {
      style: {
        width: 72,
        height: 6,
        borderRadius: 3,
        marginTop: 26,
        backgroundImage: 'linear-gradient(90deg, #0c5bd2, #48b3f5, #34d399)',
      },
    }),
    h(
      'div',
      { style: { display: 'flex', marginTop: 24, fontSize: 32, fontWeight: 500, color: NAVY } },
      'Powered through\u00a0',
      h('span', { style: { fontWeight: 800 } }, 'WhatsApp.'),
    ),
  ),
  {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Inter', data: inter500, weight: 500, style: 'normal' },
      { name: 'Inter', data: inter800, weight: 800, style: 'normal' },
    ],
  },
);

const out = join(root, 'public/brand/og-image.png');
await writeFile(out, Buffer.from(await image.arrayBuffer()));
console.log(`wrote ${out}`);
