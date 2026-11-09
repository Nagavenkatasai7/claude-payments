import { describe, it, expect } from 'vitest';
import { SITE_SKINS, isSkinSlug, skinForSlug, siteSkinFor, skinLogoSrc, type SiteSkin } from '@/lib/site-skins';
import { isValidSiteSlug } from '@/lib/site-host';
import { validateThemeColor } from '@/lib/ui/theme';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';

// Site skins (owner go 2026-11-09): a partner-branded LOOK on a <slug>.smartremit.ai host that an
// EXISTING tenant serves. The list is code, so every entry is checked here, not at request time.

describe('SITE_SKINS', () => {
  it('holds the TGFL demo skin, served by SmartRemit\'s own tenant', () => {
    expect(Object.keys(SITE_SKINS)).toEqual(['tgfl']);
    expect(SITE_SKINS.tgfl).toMatchObject({ slug: 'tgfl', partnerId: DEFAULT_PARTNER_ID, name: 'TGFL', demo: true });
  });

  it.each(Object.entries(SITE_SKINS))('%s: a valid, unreserved site slug, keyed by its own slug, with a bounded name', (key, skin) => {
    expect(skin.slug).toBe(key);
    // A reserved or malformed slug would make the host "refused" in parseSiteHost and never reach the resolver.
    expect(isValidSiteSlug(skin.slug)).toBe(true);
    expect(skin.partnerId).not.toBe('');
    expect(skin.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9 .&-]{0,39}$/);
  });

  it.each(Object.entries(SITE_SKINS))('%s: colours (when set) pass the contrast rule, so none is dropped silently in production', (_key, skin) => {
    if (!skin.theme) return;
    expect(validateThemeColor(skin.theme.primary)).toMatchObject({ ok: true, value: skin.theme.primary });
    expect(validateThemeColor(skin.theme.accent)).toMatchObject({ ok: true, value: skin.theme.accent });
  });

  it.each(Object.entries(SITE_SKINS))('%s: the logo (when set) is a file under /brand/partners/', (_key, skin) => {
    if (skin.logoSrc === null) return;
    expect(skinLogoSrc(skin)).toBe(skin.logoSrc);
  });
});

describe('lookups', () => {
  it('isSkinSlug / skinForSlug: exact, own keys only', () => {
    expect(isSkinSlug('tgfl')).toBe(true);
    expect(skinForSlug('tgfl')?.name).toBe('TGFL');
    for (const s of ['', 'TGFL', 'tgfl2', 'send', 'acme', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isSkinSlug(s), s).toBe(false);
      expect(skinForSlug(s), s).toBeNull();
    }
  });

  it('siteSkinFor: the skin applies ONLY when the host resolved to the skin\'s own tenant', () => {
    expect(siteSkinFor('tgfl', DEFAULT_PARTNER_ID)?.name).toBe('TGFL');
    // A real partner that holds the slug wins: its portal never gets the skin.
    expect(siteSkinFor('tgfl', 'pa')).toBeNull();
    expect(siteSkinFor('send', DEFAULT_PARTNER_ID)).toBeNull();
    expect(siteSkinFor('acme', 'pa')).toBeNull();
  });
});

describe('skinLogoSrc', () => {
  const skin = (logoSrc: string | null): SiteSkin => ({ ...SITE_SKINS.tgfl, logoSrc });
  it('null → null (the header shows the name as text)', () => {
    expect(skinLogoSrc(skin(null))).toBeNull();
  });
  it('a same-origin file under /brand/partners/ → that path', () => {
    expect(skinLogoSrc(skin('/brand/partners/tgfl.png'))).toBe('/brand/partners/tgfl.png');
    expect(skinLogoSrc(skin('/brand/partners/tgfl-mark.webp'))).toBe('/brand/partners/tgfl-mark.webp');
  });
  it('anything else is dropped: a remote URL, a data URI, an SVG, a path outside the folder, a traversal', () => {
    for (const bad of [
      'https://tgfl.com/logo.png',
      '//tgfl.com/logo.png',
      'data:image/png;base64,AAAA',
      '/brand/partners/tgfl.svg',
      '/brand/smartremit-mark.png',
      '/brand/partners/../smartremit-mark.png',
      '/brand/partners/a/b.png',
      'brand/partners/tgfl.png',
      '/brand/partners/tgfl.png?x=1',
      '',
    ]) {
      expect(skinLogoSrc(skin(bad)), bad).toBeNull();
    }
  });
});
