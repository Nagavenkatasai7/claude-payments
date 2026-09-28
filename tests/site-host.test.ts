import { describe, it, expect } from 'vitest';
import { parseSiteHost, stripSiteHeaders, SITE_HEADERS, isValidSiteSlug, RESERVED_SLUGS } from '@/lib/site-host';
import { SITE_HOSTS, APEX_HOSTS, REFUSED_HOSTS } from './site-host-corpus';

describe('parseSiteHost', () => {
  it.each(SITE_HOSTS)('%s → site %s', (h, slug) => expect(parseSiteHost(h)).toEqual({ kind: 'site', slug }));
  it.each(APEX_HOSTS)('%j → apex', (h) => expect(parseSiteHost(h)).toEqual({ kind: 'apex' }));
  it.each(REFUSED_HOSTS)('%j → refused (a smartremit.ai subdomain that is not a valid slug and not www)', (h) =>
    expect(parseSiteHost(h)).toEqual({ kind: 'refused' }));
  it('null/undefined → apex', () => {
    expect(parseSiteHost(null)).toEqual({ kind: 'apex' });
    expect(parseSiteHost(undefined)).toEqual({ kind: 'apex' });
  });
  it('the reserved list is exactly spec §1.8 + the Q5 additions', () => {
    expect([...RESERVED_SLUGS].sort()).toEqual([
      'abuse', 'account', 'admin', 'api', 'app', 'auth', 'autoconfig', 'autodiscover', 'billing', 'cdn', 'dashboard', 'demo',
      'dev', 'docs', 'help', 'login', 'm', 'mail', 'mta-sts', 'ops', 'partner', 'pay', 'portal', 'postmaster', 'preview',
      'sandbox', 'security', 'smartremit', 'sso', 'staging', 'static', 'status', 'support', 'trust', 'webhooks', 'www', 'www2',
    ]);
  });
  it('every reserved label is refused, except www which is the apex', () => {
    for (const r of RESERVED_SLUGS) expect(parseSiteHost(`${r}.smartremit.ai`), r).toEqual({ kind: r === 'www' ? 'apex' : 'refused' });
  });
  it('isValidSiteSlug mirrors the 0026 CHECKs (format + no ??-- label) plus the reserved list', () => {
    expect(isValidSiteSlug('acme')).toBe(true);
    expect(isValidSiteSlug('a'.repeat(30))).toBe(true);
    for (const s of ['www', 'pay', 'login', 'mta-sts', 'www2', 'xn--abc', 'ab--cd', 'zz--', 'Acme', 'ab', 'a'.repeat(31), 'a_b', '-ab', 'ab-', '', 'acme.x'])
      expect(isValidSiteSlug(s), s).toBe(false);
  });
  it('isValidSiteSlug rejects non-strings', () => {
    for (const s of [null, undefined, 42, {}] as unknown[]) expect(isValidSiteSlug(s as string)).toBe(false);
  });
});

describe('stripSiteHeaders', () => {
  it('removes both tenant headers, in any case, and keeps the rest (on a copy)', () => {
    const h = new Headers({ 'X-SR-Site-Partner': 'evil', 'x-sr-site-slug': 'evil', cookie: 'a=b' });
    const out = stripSiteHeaders(h);
    expect(out.get(SITE_HEADERS.partner)).toBeNull();
    expect(out.get(SITE_HEADERS.slug)).toBeNull();
    expect(out.get('cookie')).toBe('a=b');
    expect(h.get(SITE_HEADERS.partner)).toBe('evil'); // input untouched
  });
});
