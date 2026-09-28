import { describe, it, expect, vi, beforeEach } from 'vitest';
let hdrs = new Headers();
vi.mock('next/headers', () => ({ headers: async () => hdrs }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
const { resolveSiteSlug } = vi.hoisted(() => ({ resolveSiteSlug: vi.fn() }));
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug }));
import { getSiteTenant, requireSiteTenant } from '@/lib/site-tenant';

describe('getSiteTenant (re-checks Host AND re-resolves the slug; the header alone is never trusted)', () => {
  beforeEach(() => { hdrs = new Headers(); resolveSiteSlug.mockReset(); resolveSiteSlug.mockResolvedValue('pa'); });
  it('apex or refused host + forged headers → null, and the resolver is never called on apex', async () => {
    for (const host of ['smartremit.ai', 'www.smartremit.ai', 'pay.smartremit.ai', 'xn--abc.smartremit.ai', 'acme.smartremit.ai.', 'login.smartremit.ai']) {
      hdrs = new Headers({ host, 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'acme' });
      expect(await getSiteTenant(), host).toBeNull();
    }
    expect(resolveSiteSlug).not.toHaveBeenCalled();
  });
  it('a self-consistent forged pair naming ANOTHER partner → null (the proxy may not have run)', async () => {
    hdrs = new Headers({ host: 'acme.smartremit.ai', 'x-sr-site-partner': 'pb', 'x-sr-site-slug': 'acme' });
    expect(await getSiteTenant()).toBeNull(); // resolver says 'pa'
  });
  it('the resolver says unknown/disabled/error (null) → null even with a consistent header pair', async () => {
    resolveSiteSlug.mockResolvedValue(null);
    hdrs = new Headers({ host: 'acme.smartremit.ai', 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'acme' });
    expect(await getSiteTenant()).toBeNull();
  });
  it('a throwing resolver → null (fail closed)', async () => {
    resolveSiteSlug.mockImplementation(async () => { throw new Error('boom'); });
    hdrs = new Headers({ host: 'acme.smartremit.ai', 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'acme' });
    expect(await getSiteTenant()).toBeNull();
  });
  it('the reader never counts the IP a second time (no-op limiter)', async () => {
    hdrs = new Headers({ host: 'acme.smartremit.ai', 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'acme' });
    await getSiteTenant();
    const [slug, , deps] = resolveSiteSlug.mock.lastCall as [string, Headers, { limited?: (h: Headers) => Promise<boolean> }];
    expect(slug).toBe('acme');
    expect(await deps?.limited?.(new Headers())).toBe(false);
  });
  it('preview/localhost + forged headers → null', async () => {
    for (const host of ['claude-payments.vercel.app', 'localhost:3000']) {
      hdrs = new Headers({ host, 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'acme' });
      expect(await getSiteTenant(), host).toBeNull();
    }
  });
  it('site host whose header slug ≠ host slug → null (cross-subdomain confusion)', async () => {
    hdrs = new Headers({ host: 'acme.smartremit.ai', 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'other' });
    expect(await getSiteTenant()).toBeNull();
  });
  it('site host without the proxy headers → null', async () => {
    hdrs = new Headers({ host: 'acme.smartremit.ai' });
    expect(await getSiteTenant()).toBeNull();
    hdrs = new Headers({ host: 'acme.smartremit.ai', 'x-sr-site-slug': 'acme' });
    expect(await getSiteTenant()).toBeNull();
  });
  it('a consistent proxy-set pair that equals the resolver → the tenant (host case and port normalised)', async () => {
    hdrs = new Headers({ host: 'ACME.smartremit.ai:443', 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'acme' });
    expect(await getSiteTenant()).toEqual({ partnerId: 'pa', slug: 'acme' });
  });
  it('requireSiteTenant → notFound() on apex, the tenant on a site', async () => {
    hdrs = new Headers({ host: 'smartremit.ai' });
    await expect(requireSiteTenant()).rejects.toThrow('NOT_FOUND');
    hdrs = new Headers({ host: 'acme.smartremit.ai', 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'acme' });
    expect(await requireSiteTenant()).toEqual({ partnerId: 'pa', slug: 'acme' });
  });
});
