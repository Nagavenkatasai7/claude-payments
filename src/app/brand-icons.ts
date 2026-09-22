import type { Metadata } from 'next';

// The SmartRemit.ai browser-tab and home-screen icons, set per route on the
// SmartRemit-owned surfaces only: / and /about, /docs, /login, /account/**,
// /admin-dashboard/**. NOT the app/icon.png file convention: a file in app/ is
// inherited by every route below it, including the white-label, partner-branded
// /pay/** pages, which must never show the SmartRemit mark.
//
// Config `icons` (generate-metadata.md "icons") is a top-level metadata key,
// and segments merge SHALLOWLY with later segments replacing duplicate keys
// (generate-metadata.md "Merging"), so a layout that sets it covers its whole
// subtree unless a page overrides `icons`; pages that only set `title` keep it.
// Type: next/dist/lib/metadata/types/metadata-interface.d.ts (`icons?:`).
export const SMARTREMIT_ICONS: NonNullable<Metadata['icons']> = {
  icon: [{ url: '/brand/smartremit-mark.png', type: 'image/png', sizes: '512x512' }],
  apple: [{ url: '/brand/apple-icon.png', type: 'image/png', sizes: '180x180' }],
};
