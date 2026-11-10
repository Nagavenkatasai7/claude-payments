import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_SKINS, CUSTOM_SKIN_HOSTS, customHostBinding, isSkinSlug, skinForSlug, siteSkinFor, skinLogoSrc, type SiteSkin } from '@/lib/site-skins';
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

  it('TGFL shows its emblem (150 x 100 PNG) in SmartRemit\'s colours', () => {
    expect(SITE_SKINS.tgfl).toMatchObject({ logoSrc: '/brand/partners/tgfl.png', logoSize: { width: 150, height: 100 }, theme: null });
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

  it.each(Object.entries(SITE_SKINS))('%s: a logo has its natural size, and a size has a logo', (_key, skin) => {
    expect(skin.logoSize === null).toBe(skin.logoSrc === null);
    if (!skin.logoSize) return;
    expect(Number.isInteger(skin.logoSize.width) && skin.logoSize.width > 0).toBe(true);
    expect(Number.isInteger(skin.logoSize.height) && skin.logoSize.height > 0).toBe(true);
  });

  // A missing image would ship a broken header: the file must be in public/ (served same-origin).
  it.each(Object.entries(SITE_SKINS))('%s: the logo file (when set) exists under public/, and a PNG matches logoSize', (_key, skin) => {
    if (skin.logoSrc === null) return;
    const file = join(process.cwd(), 'public', skin.logoSrc);
    expect(existsSync(file), file).toBe(true);
    if (!skin.logoSrc.endsWith('.png')) return;
    const png = readFileSync(file);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    // IHDR: width and height are the big-endian uint32s at bytes 16 and 20.
    expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual(skin.logoSize);
  });
});

describe('custom skin hosts (smartremitai.tgfl.org)', () => {
  // One DNS name: labels of [a-z0-9-] without edge hyphens, at least two labels, no port, no trailing dot.
  const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
  const all = Object.values(SITE_SKINS).flatMap((s) => s.hosts.map((h) => [h, s] as const));

  it('CUSTOM_SKIN_HOSTS maps exactly smartremitai.tgfl.org to the tgfl skin', () => {
    expect([...CUSTOM_SKIN_HOSTS.entries()]).toEqual([['smartremitai.tgfl.org', 'tgfl']]);
    expect(SITE_SKINS.tgfl.hosts).toEqual(['smartremitai.tgfl.org']);
  });

  it.each(all)('%s: lowercase, no port, no trailing dot, a DNS name, outside smartremit.ai', (host) => {
    expect(host).toBe(host.toLowerCase());
    expect(host).not.toContain(':');
    expect(host.endsWith('.')).toBe(false);
    expect(host).toMatch(DNS_NAME);
    expect(host.length).toBeLessThanOrEqual(253);
    expect(host === 'smartremit.ai' || host.endsWith('.smartremit.ai')).toBe(false);
  });

  it('every custom host is unique across skins, and its slug is a valid site slug and a skin slug', () => {
    expect(new Set(all.map(([h]) => h)).size).toBe(all.length);
    expect(CUSTOM_SKIN_HOSTS.size).toBe(all.length);
    for (const [host, slug] of CUSTOM_SKIN_HOSTS) {
      expect(isValidSiteSlug(slug), host).toBe(true);
      expect(isSkinSlug(slug), host).toBe(true);
    }
  });

  it.each(Object.entries(SITE_SKINS))('%s: credentialEpoch is a positive integer', (_key, skin) => {
    expect(Number.isInteger(skin.credentialEpoch)).toBe(true);
    expect(skin.credentialEpoch).toBeGreaterThan(0);
  });
});

describe('customHostBinding (D8: credentials minted on a custom host are bound to it)', () => {
  it('a custom skin host binds to `${host}#${credentialEpoch}`', () => {
    expect(customHostBinding('smartremitai.tgfl.org')).toBe('smartremitai.tgfl.org#1');
    expect(customHostBinding('smartremitai.tgfl.org')).toBe(`smartremitai.tgfl.org#${SITE_SKINS.tgfl.credentialEpoch}`);
  });

  it.each([
    'send.smartremit.ai',
    'tgfl.smartremit.ai',
    'SMARTREMITAI.TGFL.ORG',
    'smartremitai.tgfl.org.',
    'smartremitai.tgfl.org:443',
    'x.smartremitai.tgfl.org',
    'tgfl.org',
    'smartremit.ai',
    '',
    'constructor',
    '__proto__',
  ])('%j has no binding (byte-identical hashes for every smartremit.ai host)', (host) => {
    expect(customHostBinding(host)).toBeNull();
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
      'https://tgfl.org/logo.png',
      '//tgfl.org/logo.png',
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
