import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// UI redesign M4 PR-3: next.config.ts is wrapped with @next/mdx so the partner guides
// (src/content/docs/*.mdx) compile at build. The wrap changes the build for every route, so
// this pins that it ONLY adds the .mdx loader: headers (incl. the enforced CSP), redirects and
// every other config key are unchanged, and pageExtensions is NOT touched (no .mdx routes).
// @next/mdx behaviour read from node_modules/@next/mdx/index.js (16.3.5).

// The remark plugins, in order: GFM (tables, task lists) by package name, then the local guard that
// refuses MDX expressions / ESM / unknown components (PR #385 review round 1), by absolute path.
const REMARK = ['remark-gfm', resolve('src/lib/mdx/remark-no-mdx-expressions.mjs')];

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
    expect(headers).toHaveLength(2);
    expect(headers[0].source).toBe('/:path((?!oauth/authorize$).*)');
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

  // Stage C1: /oauth/authorize sends its own CSP (src/lib/agent-auth/authorize-csp.ts: the site
  // policy plus the validated redirect origin in form-action). Two CSP headers would both be
  // enforced, so EXACTLY that path is left out of the site CSP; it keeps every other header.
  it('exactly /oauth/authorize is left out of the site CSP header and keeps the others', async () => {
    const cfg = await loadConfig();
    const headers = await cfg.headers!();
    expect(headers[1]).toEqual({ source: '/oauth/authorize', headers: headers[0].headers.filter((h) => h.key !== 'Content-Security-Policy') });
    // Next's own matcher, with the options it builds header routes with
    // (node_modules/next/dist/server/lib/router-utils/filesystem.js:99-110; caseSensitiveRoutes off).
    const { getPathMatch } = await import('next/dist/shared/lib/router/utils/path-match');
    const site = getPathMatch(headers[0].source, { strict: true, removeUnnamedParams: true, sensitive: false });
    const authz = getPathMatch(headers[1].source, { strict: true, removeUnnamedParams: true, sensitive: false });
    for (const p of ['/', '/portal', '/portal/login', '/oauth/token', '/oauth/register', '/oauth/authorize/x', '/oauth/authorizex', '/api/mcp',
      '/.well-known/oauth-authorization-server', '/pay/abc', '/admin-dashboard', '/x/oauth/authorize']) {
      expect({ p, csp: site(p) !== false, authz: authz(p) !== false }).toEqual({ p, csp: true, authz: false });
    }
    expect({ csp: site('/oauth/authorize') !== false, authz: authz('/oauth/authorize') !== false }).toEqual({ csp: false, authz: true });
  });

  it('the authorize route sends a CSP on every response (its own 404 included)', () => {
    const src = readFileSync('src/app/oauth/authorize/route.ts', 'utf8');
    expect(src).toMatch(/'Content-Security-Policy': buildCsp\(/);
    const flow = readFileSync('src/lib/agent-auth/authorize-flow.ts', 'utf8');
    // Every Response the flow builds goes through html() or see(), and both set the CSP.
    expect(flow.match(/new Response\(/g)).toHaveLength(2);
    expect(flow.match(/'Content-Security-Policy':/g)).toHaveLength(2);
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

  it('the webpack hook adds one .mdx rule with remark-gfm + the expression guard and resolves src/mdx-components first', async () => {
    const cfg = await loadConfig();
    const wp = { resolve: { alias: {} as Record<string, unknown> }, module: { rules: [] as Array<{ test: RegExp; use: unknown[] }> } };
    // A minimal stand-in for webpack's config and options (only the fields @next/mdx touches).
    (cfg.webpack as unknown as (c: typeof wp, o: { defaultLoaders: { babel: string } }) => unknown)(wp, { defaultLoaders: { babel: 'babel' } });
    expect(wp.module.rules).toHaveLength(1);
    const rule = wp.module.rules[0];
    expect(rule.test.test('guide.mdx')).toBe(true);
    for (const f of ['page.tsx', 'README.md', 'route.ts']) expect(rule.test.test(f)).toBe(false);
    const loader = rule.use[1] as { options: { remarkPlugins: unknown[] } };
    expect(loader.options.remarkPlugins).toEqual(REMARK);
    expect((wp.resolve.alias['next-mdx-import-source-file'] as string[])[0]).toBe('private-next-root-dir/src/mdx-components');
  });

  it('under Turbopack (the `next build` default) it adds one .mdx rule with remark-gfm + the expression guard', async () => {
    vi.stubEnv('TURBOPACK', '1');
    const cfg = await loadConfig();
    const rules = cfg.turbopack?.rules ?? {};
    expect(Object.keys(rules)).toEqual(['{*,next-mdx-rule}']);
    const [rule] = rules['{*,next-mdx-rule}'] as Array<{ condition: { path: RegExp }; loaders: Array<{ options: { remarkPlugins: unknown[] } }> }>;
    expect(rule.condition.path.test('guide.mdx')).toBe(true);
    expect(rule.condition.path.test('page.tsx')).toBe(false);
    expect(rule.loaders[0].options.remarkPlugins).toEqual(REMARK);
    expect(cfg.pageExtensions).toBeUndefined();
  });
});

describe('the expression-guard plugin path in next.config resolves to the tested module', () => {
  it('is an absolute path to an existing file the loader can import', async () => {
    const { existsSync } = await import('node:fs');
    const { isAbsolute } = await import('node:path');
    expect(isAbsolute(REMARK[1])).toBe(true);
    expect(existsSync(REMARK[1])).toBe(true);
    const mod = await import(REMARK[1]);
    expect(typeof mod.default).toBe('function');
  });
});
