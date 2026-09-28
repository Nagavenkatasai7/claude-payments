import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

// UI redesign M4 PR-3: next.config.ts is wrapped with @next/mdx so the partner guides
// (src/content/docs/*.mdx) compile at build. The wrap changes the build for every route, so
// this pins that it ONLY adds the .mdx loader: headers (incl. the enforced CSP), redirects and
// every other config key are unchanged, and pageExtensions is NOT touched (no .mdx routes).
// @next/mdx behaviour read from node_modules/@next/mdx/index.js (16.3.5).

const loadConfig = async () => (await import('../next.config')).default;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('next.config after the MDX wrap', () => {
  it('still sends the enforced CSP and security headers on every path', async () => {
    const cfg = await loadConfig();
    const { buildCsp } = await import('@/lib/csp');
    const headers = await cfg.headers!();
    expect(headers).toHaveLength(1);
    expect(headers[0].source).toBe('/:path*');
    expect(headers[0].headers.map((h) => h.key)).toEqual([
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Content-Security-Policy',
    ]);
    const csp = headers[0].headers.find((h) => h.key === 'Content-Security-Policy');
    expect(csp?.value).toBe(buildCsp({ isDev: false }));
  });

  it('keeps the redirects and the other settings', async () => {
    const cfg = await loadConfig();
    expect(await cfg.redirects!()).toEqual([
      { source: '/dashboard', destination: '/admin-dashboard', permanent: true },
      { source: '/dashboard/:path*', destination: '/admin-dashboard/:path*', permanent: true },
    ]);
    expect(cfg.poweredByHeader).toBe(false);
    expect(cfg.serverExternalPackages).toEqual(['nodemailer']);
  });

  it('adds only the MDX loader hook: no pageExtensions change, no other key', async () => {
    const cfg = await loadConfig();
    expect(cfg.pageExtensions).toBeUndefined();
    expect(Object.keys(cfg).sort()).toEqual(['headers', 'poweredByHeader', 'redirects', 'serverExternalPackages', 'webpack']);
    expect(readFileSync('next.config.ts', 'utf8')).toMatch(/createMDX\(/);
  });

  it('the webpack hook adds one .mdx rule with remark-gfm and resolves src/mdx-components first', async () => {
    const cfg = await loadConfig();
    const wp = { resolve: { alias: {} as Record<string, unknown> }, module: { rules: [] as Array<{ test: RegExp; use: unknown[] }> } };
    // A minimal stand-in for webpack's config and options (only the fields @next/mdx touches).
    (cfg.webpack as unknown as (c: typeof wp, o: { defaultLoaders: { babel: string } }) => unknown)(wp, { defaultLoaders: { babel: 'babel' } });
    expect(wp.module.rules).toHaveLength(1);
    const rule = wp.module.rules[0];
    expect(rule.test.test('guide.mdx')).toBe(true);
    for (const f of ['page.tsx', 'README.md', 'route.ts']) expect(rule.test.test(f)).toBe(false);
    const loader = rule.use[1] as { options: { remarkPlugins: unknown[] } };
    expect(loader.options.remarkPlugins).toEqual(['remark-gfm']);
    expect((wp.resolve.alias['next-mdx-import-source-file'] as string[])[0]).toBe('private-next-root-dir/src/mdx-components');
  });

  it('under Turbopack (the `next build` default) it adds one .mdx rule with remark-gfm by name', async () => {
    vi.stubEnv('TURBOPACK', '1');
    const cfg = await loadConfig();
    const rules = cfg.turbopack?.rules ?? {};
    expect(Object.keys(rules)).toEqual(['{*,next-mdx-rule}']);
    const [rule] = rules['{*,next-mdx-rule}'] as Array<{ condition: { path: RegExp }; loaders: Array<{ options: { remarkPlugins: unknown[] } }> }>;
    expect(rule.condition.path.test('guide.mdx')).toBe(true);
    expect(rule.condition.path.test('page.tsx')).toBe(false);
    expect(rule.loaders[0].options.remarkPlugins).toEqual(['remark-gfm']);
    expect(cfg.pageExtensions).toBeUndefined();
  });
});
