import { describe, it, expect, vi, beforeEach } from 'vitest';
let hdrs = new Headers();
vi.mock('next/headers', () => ({ headers: async () => hdrs }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
const { resolveSiteSlug, resolveSkinHost } = vi.hoisted(() => ({ resolveSiteSlug: vi.fn(), resolveSkinHost: vi.fn() }));
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug, resolveSkinHost }));
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
    expect(await getSiteTenant()).toEqual({ partnerId: 'pa', slug: 'acme', host: 'acme.smartremit.ai', custom: false });
  });
  it('requireSiteTenant → notFound() on apex, the tenant on a site', async () => {
    hdrs = new Headers({ host: 'smartremit.ai' });
    await expect(requireSiteTenant()).rejects.toThrow('NOT_FOUND');
    hdrs = new Headers({ host: 'acme.smartremit.ai', 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'acme' });
    expect(await requireSiteTenant()).toEqual({ partnerId: 'pa', slug: 'acme', host: 'acme.smartremit.ai', custom: false });
  });
});

describe('getSiteTenant on the custom skin host (skin-only re-resolve)', () => {
  beforeEach(() => {
    hdrs = new Headers(); resolveSiteSlug.mockReset(); resolveSkinHost.mockReset();
    resolveSiteSlug.mockResolvedValue('default'); resolveSkinHost.mockResolvedValue('default');
  });
  it('a consistent proxy-set pair → the tenant with the canonical custom host (case and port normalised)', async () => {
    hdrs = new Headers({ host: 'SmartRemitAI.tgfl.org:443', 'x-sr-site-partner': 'default', 'x-sr-site-slug': 'tgfl' });
    expect(await getSiteTenant()).toEqual({ partnerId: 'default', slug: 'tgfl', host: 'smartremitai.tgfl.org', custom: true });
    const [slug, , deps] = resolveSkinHost.mock.lastCall as [string, Headers, { limited?: (h: Headers) => Promise<boolean> }];
    expect(slug).toBe('tgfl');
    expect(await deps?.limited?.(new Headers())).toBe(false);
    expect(resolveSiteSlug).not.toHaveBeenCalled();
  });
  it('the skin resolver says null (switch off, held, inactive) → null, and resolveSiteSlug is never asked', async () => {
    resolveSkinHost.mockResolvedValue(null);
    hdrs = new Headers({ host: 'smartremitai.tgfl.org', 'x-sr-site-partner': 'default', 'x-sr-site-slug': 'tgfl' });
    expect(await getSiteTenant()).toBeNull();
    expect(resolveSkinHost).toHaveBeenCalledWith('tgfl', expect.any(Headers), expect.anything());
    expect(resolveSiteSlug).not.toHaveBeenCalled();
  });
  it('header slug mismatch → null; a forged partner header → null', async () => {
    hdrs = new Headers({ host: 'smartremitai.tgfl.org', 'x-sr-site-partner': 'default', 'x-sr-site-slug': 'acme' });
    expect(await getSiteTenant()).toBeNull();
    hdrs = new Headers({ host: 'smartremitai.tgfl.org', 'x-sr-site-partner': 'pa', 'x-sr-site-slug': 'tgfl' });
    expect(await getSiteTenant()).toBeNull();
    expect(resolveSiteSlug).not.toHaveBeenCalled();
  });
  it('a throwing skin resolver → null', async () => {
    resolveSkinHost.mockImplementation(async () => { throw new Error('boom'); });
    hdrs = new Headers({ host: 'smartremitai.tgfl.org', 'x-sr-site-partner': 'default', 'x-sr-site-slug': 'tgfl' });
    expect(await getSiteTenant()).toBeNull();
  });
  it('trailing-dot or sub-label forms and apex look-alikes with forged headers → null, no resolver call', async () => {
    for (const host of ['smartremitai.tgfl.org.', 'x.smartremitai.tgfl.org', 'tgfl.org', 'evil-tgfl.org']) {
      hdrs = new Headers({ host, 'x-sr-site-partner': 'default', 'x-sr-site-slug': 'tgfl' });
      expect(await getSiteTenant(), host).toBeNull();
    }
    expect(resolveSkinHost).not.toHaveBeenCalled();
    expect(resolveSiteSlug).not.toHaveBeenCalled();
  });
  it('tgfl.smartremit.ai still re-resolves through resolveSiteSlug, with custom false', async () => {
    hdrs = new Headers({ host: 'tgfl.smartremit.ai', 'x-sr-site-partner': 'default', 'x-sr-site-slug': 'tgfl' });
    expect(await getSiteTenant()).toEqual({ partnerId: 'default', slug: 'tgfl', host: 'tgfl.smartremit.ai', custom: false });
    expect(resolveSkinHost).not.toHaveBeenCalled();
  });
});
