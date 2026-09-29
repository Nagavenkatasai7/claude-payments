import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Metadata } from 'next';

// UI redesign M2 follow-up L8 (the #394 review): on the apex every portal route is a 404, but its
// head still carried the page's own metadata (/portal/login's RSC payload said "Sign in", the others
// "SmartRemit" and an extra robots tag), so the portal's structure was visible on the apex. Every
// portal page and the layout now resolve their metadata through portalMetadata(): the page's own
// metadata on a portal site, the root 404's on the apex; the portal not-found carries the root 404's title.

const h = vi.hoisted(() => ({ site: null as null | Record<string, unknown>, dataRights: true }));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/env', async (orig) => {
  const real = await orig<typeof import('@/lib/env')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get: (target, key) => (key === 'customerDataRightsEnabled' ? h.dataRights : Reflect.get(target, key)),
    }),
  };
});

import { portalMetadata, portalNotFoundMetadata } from '@/lib/portal-metadata';
import { NOT_FOUND_METADATA } from '@/lib/not-found-metadata';
import { metadata as rootNotFoundMetadata } from '@/app/not-found';

const SITE = { partnerId: 'pa', slug: 'acme', brand: 'Acme Remit', logo: null, theme: {} };

beforeEach(() => {
  h.site = null;
  h.dataRights = true;
});

describe('portalMetadata()', () => {
  // Not {}: a page returning {} leaves the root layout's "SmartRemit" in the RSC head, while an
  // unmatched URL's says "Page not found" (seen on `next start`), which still marks the route.
  it('apex (no portal site) → exactly the root 404 metadata, nothing page-specific', async () => {
    expect(await portalMetadata('portal.login.title')).toEqual(NOT_FOUND_METADATA);
    expect(await portalMetadata('portal.detail.title', { referrer: 'no-referrer' })).toEqual(NOT_FOUND_METADATA);
    expect(await portalMetadata(null, { robots: { index: false, follow: false } })).toEqual(NOT_FOUND_METADATA);
  });
  it('portal site → the page title plus the extra fields', async () => {
    h.site = SITE;
    expect(await portalMetadata('portal.login.title')).toEqual({ title: 'Sign in' });
    expect(await portalMetadata('portal.detail.title', { referrer: 'no-referrer' })).toMatchObject({ referrer: 'no-referrer' });
    expect(await portalMetadata(null, { robots: { index: false, follow: false } })).toEqual({ robots: { index: false, follow: false } });
  });
});

describe('portalNotFoundMetadata()', () => {
  it('apex → exactly the root 404 metadata (same title as an unmatched URL)', async () => {
    expect(await portalNotFoundMetadata()).toEqual(rootNotFoundMetadata);
    expect(rootNotFoundMetadata).toEqual(NOT_FOUND_METADATA);
    expect(NOT_FOUND_METADATA.title).toBe('Page not found');
  });
  it('portal site → {} (unchanged partner-site behaviour)', async () => {
    h.site = SITE;
    expect(await portalNotFoundMetadata()).toEqual({});
  });
});

// Every portal page / layout, and the metadata it must carry on a portal site. Keep in step with
// the source scan below: a new page without an entry here fails that scan.
type GenMeta = () => Promise<Metadata>;
const PAGES: ReadonlyArray<[string, () => Promise<{ generateMetadata?: GenMeta }>, Metadata]> = [
  ['layout.tsx', () => import('@/app/portal/layout'), { robots: { index: false, follow: false } }],
  ['page.tsx', () => import('@/app/portal/page'), { title: 'Welcome back' }],
  ['login/page.tsx', () => import('@/app/portal/login/page'), { title: 'Sign in' }],
  ['verify/page.tsx', () => import('@/app/portal/verify/page'), {}],
  ['transfers/page.tsx', () => import('@/app/portal/transfers/page'), { title: 'Transfers' }],
  ['transfers/[id]/page.tsx', () => import('@/app/portal/transfers/[id]/page'), { referrer: 'no-referrer' }],
  ['transfers/[id]/receipt/page.tsx', () => import('@/app/portal/transfers/[id]/receipt/page'), { referrer: 'no-referrer' }],
  ['recipients/page.tsx', () => import('@/app/portal/recipients/page'), {}],
  ['recipients/new/page.tsx', () => import('@/app/portal/recipients/new/page'), {}],
  ['recipients/[rid]/edit/page.tsx', () => import('@/app/portal/recipients/[rid]/edit/page'), {}],
  ['profile/page.tsx', () => import('@/app/portal/profile/page'), { referrer: 'no-referrer' }],
  ['notifications/page.tsx', () => import('@/app/portal/notifications/page'), { referrer: 'no-referrer' }],
  ['notifications/verify/page.tsx', () => import('@/app/portal/notifications/verify/page'), { referrer: 'no-referrer' }],
  ['devices/page.tsx', () => import('@/app/portal/devices/page'), {}],
  ['help/page.tsx', () => import('@/app/portal/help/page'), {}],
  ['help/tickets/page.tsx', () => import('@/app/portal/help/tickets/page'), {}],
  ['help/tickets/new/page.tsx', () => import('@/app/portal/help/tickets/new/page'), {}],
  ['help/tickets/[id]/page.tsx', () => import('@/app/portal/help/tickets/[id]/page'), {}],
  ['chat/page.tsx', () => import('@/app/portal/chat/page'), {}],
  ['privacy/page.tsx', () => import('@/app/portal/privacy/page'), {}],
  ['privacy/export/page.tsx', () => import('@/app/portal/privacy/export/page'), {}],
  ['privacy/delete/page.tsx', () => import('@/app/portal/privacy/delete/page'), {}],
  ['send/page.tsx', () => import('@/app/portal/send/page'), { referrer: 'no-referrer' }],
  ['send/review/page.tsx', () => import('@/app/portal/send/review/page'), { referrer: 'no-referrer' }],
  ['schedules/page.tsx', () => import('@/app/portal/schedules/page'), {}],
  ['schedules/new/page.tsx', () => import('@/app/portal/schedules/new/page'), {}],
];

describe('every portal page and the layout', () => {
  it.each(PAGES)('%s: generateMetadata is the root 404 metadata on the apex, its own on a portal site', async (_name, load, expected) => {
    const mod = await load();
    expect(typeof mod.generateMetadata).toBe('function');
    h.site = null;
    expect(await mod.generateMetadata!()).toEqual(rootNotFoundMetadata);
    h.site = SITE;
    const onSite = await mod.generateMetadata!();
    expect(onSite).toMatchObject(expected);
    if (_name !== 'layout.tsx') expect(typeof onSite.title).toBe('string');
  }, 30_000);

  it('the privacy pages carry the root 404 metadata while their flag is off (they 404 then too)', async () => {
    h.site = SITE;
    h.dataRights = false;
    const mod = (await import('@/app/portal/privacy/export/page')) as { generateMetadata: GenMeta };
    expect(await mod.generateMetadata()).toEqual(rootNotFoundMetadata);
  });

  it('the portal not-found: the root 404 title on the apex, nothing on a portal site', async () => {
    const mod = (await import('@/app/portal/not-found')) as { generateMetadata?: GenMeta };
    expect(typeof mod.generateMetadata).toBe('function');
    expect(await mod.generateMetadata!()).toEqual(rootNotFoundMetadata);
    h.site = SITE;
    expect(await mod.generateMetadata!()).toEqual({});
  });
});

describe('source scan', () => {
  const root = join(process.cwd(), 'src/app/portal');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const files = walk(root).filter((f) => /\/(page|layout|not-found)\.tsx$/.test(f));

  it('no portal page, layout or not-found exports a static `metadata` (it would leak on the apex 404)', () => {
    const offenders = files.filter((f) => /export const metadata\b/.test(readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });
  it('every portal page and layout is in the table above', () => {
    const listed = new Set(PAGES.map(([n]) => n));
    const missing = files.map((f) => relative(root, f)).filter((f) => !f.endsWith('not-found.tsx') && !listed.has(f));
    expect(missing).toEqual([]);
  });
});
