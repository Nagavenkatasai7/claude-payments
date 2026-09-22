// The marketing share image (og:image / twitter:image), a static PNG rendered by
// scripts/render-og-image.mjs. Referenced from the metadata of / and /about
// only. Deliberately NOT the app/opengraph-image file convention: that is
// inherited by every route below app/, including the white-label /pay/** pages,
// whose links must never preview as SmartRemit.
export const SHARE_IMAGE = {
  url: '/brand/og-image.png',
  width: 1200,
  height: 630,
  alt: 'SmartRemit.ai logo above the headline "Global money transfers, made simpler." and the line "Powered through WhatsApp."',
};
