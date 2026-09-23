import type { MetadataRoute } from 'next';

// /sitemap.xml (Program-Fix 41): the public, SmartRemit-owned pages only
// (Program-Fix 15 PR A adds the /terms, /privacy and /legal drafts)
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
    { url: 'https://smartremit.ai/terms' },
    { url: 'https://smartremit.ai/privacy' },
    { url: 'https://smartremit.ai/legal' },
  ];
}
