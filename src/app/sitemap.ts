import type { MetadataRoute } from 'next';

// /sitemap.xml (Program-Fix 41): the three public, SmartRemit-owned pages only
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// 01-metadata/sitemap.md, "Generating a sitemap using code"). No lastModified:
// a hardcoded date goes stale, and a build-time date would claim every deploy
// changed every page. Nothing capability-bearing or signed-in belongs here
// (robots.ts disallows those).
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://smartremit.ai/' },
    { url: 'https://smartremit.ai/about' },
    { url: 'https://smartremit.ai/docs' },
  ];
}
