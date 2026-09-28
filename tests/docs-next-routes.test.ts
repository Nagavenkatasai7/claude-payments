import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GUIDES, guideStaticParams } from '@/content/docs/registry';

// UI redesign M4 PR-3: /docs-next (index) and /docs-next/[slug] (one prerendered page per
// guide). The page modules are NOT imported here: their template-literal .mdx import would go
// through Vite's transform. The route contract is pinned from the registry and by source grep.

const PAGE = 'src/app/docs-next/[slug]/page.tsx';

describe('/docs-next/[slug] static params', () => {
  it('one param per registered guide, in registry order', () => {
    expect(guideStaticParams()).toEqual(GUIDES.map((g) => ({ slug: g.slug })));
    expect(guideStaticParams()).toHaveLength(11);
  });
  it('every slug has its .mdx file (a missing one would fail the prerender)', () => {
    for (const { slug } of guideStaticParams()) expect({ slug, file: existsSync(`src/content/docs/${slug}.mdx`) }).toEqual({ slug, file: true });
  });
});

describe('/docs-next/[slug] page contract (source)', () => {
  const src = readFileSync(PAGE, 'utf8');
  it('404s any slug outside the registry (dynamicParams = false) and prerenders from guideStaticParams', () => {
    expect(src).toMatch(/export const dynamicParams = false;/);
    expect(src).toMatch(/export function generateStaticParams\(\)\s*\{\s*return guideStaticParams\(\);/);
    expect(src).toMatch(/notFound\(\)/);
  });
  it('imports only registry-validated guides from src/content/docs', () => {
    expect(src).toMatch(/await import\(`@\/content\/docs\/\$\{guide\.slug\}\.mdx`\)/);
  });
  it('uses the ds PageHeader (keeps the .sh-page-title smoke hook)', () => {
    expect(src).toMatch(/PageHeader/);
  });
});

describe('/docs-next segment states', () => {
  it('every segment is state-exempt and has NO loading.tsx (it would hide the prerendered page behind a skeleton)', async () => {
    const { STATE_EXEMPT_DIRS } = await import('@/lib/ui/new-ui-roots');
    for (const dir of ['src/app/docs-next', 'src/app/docs-next/[slug]', 'src/app/docs-next/api']) {
      expect(STATE_EXEMPT_DIRS).toContain(dir);
      expect({ dir, loading: existsSync(`${dir}/loading.tsx`) }).toEqual({ dir, loading: false });
    }
  });
  it('every segment has error.tsx, the shared digest-only boundary', () => {
    for (const dir of ['src/app/docs-next', 'src/app/docs-next/[slug]', 'src/app/docs-next/api']) {
      const err = readFileSync(`${dir}/error.tsx`, 'utf8');
      expect(err).toMatch(/^'use client';/);
      expect(err).toMatch(/export \{ SegmentError as default \} from '@\/components\/ds\/segment-error';/);
    }
    expect(readFileSync('src/app/docs-next/not-found.tsx', 'utf8')).toMatch(/href="\/docs-next"/);
  });
});

describe('the route-mode baseline pins /docs-next as prerendered', () => {
  it('index static, guides ssg (ErrorStatusTable reads openapi.yaml with fs at BUILD time)', () => {
    const b = JSON.parse(readFileSync('scripts/route-modes.baseline.json', 'utf8')) as Record<string, string>;
    expect(b['/docs-next']).toBe('static');
    expect(b['/docs-next/[slug]']).toBe('ssg');
  });
  it('the API reference is static (openapi.yaml is read with fs at BUILD time, never at runtime)', () => {
    const b = JSON.parse(readFileSync('scripts/route-modes.baseline.json', 'utf8')) as Record<string, string>;
    expect(b['/docs-next/api']).toBe('static');
  });
});

describe('/docs-next/api page contract (source)', () => {
  const files = ['page.tsx', 'Operation.tsx'].map((f) => readFileSync(`src/app/docs-next/api/${f}`, 'utf8'));
  it('is force-static (caching-without-cache-components.md:88,104; cacheComponents is off)', () => {
    expect(files[0]).toMatch(/^export const dynamic = 'force-static';$/m);
  });
  it('is server-only: no client directive, no inline script, no raw HTML', () => {
    for (const src of files) {
      expect(src).not.toMatch(/['"]use client['"]/);
      expect(src).not.toMatch(/dangerouslySetInnerHTML|<script/);
    }
  });
  it('uses the ds PageHeader (keeps the .sh-page-title smoke hook)', () => {
    expect(files[0]).toMatch(/PageHeader/);
  });
});

describe('the docs nav and index link the API reference', () => {
  it('DocsNav and the index page link /docs-next/api', () => {
    expect(readFileSync('src/app/docs-next/DocsNav.tsx', 'utf8')).toMatch(/href="\/docs-next\/api"/);
    expect(readFileSync('src/app/docs-next/page.tsx', 'utf8')).toMatch(/href="\/docs-next\/api"/);
  });
});
