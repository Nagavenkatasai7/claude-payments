import { describe, it, expect, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Program-Fix 41 — the public surface: robots + sitemap, the header config,
// the brand-neutral root error/404 boundaries (they also render under the
// white-label /pay/** pages, so no SmartRemit name, mark or home link), the
// staff error boundary inside the dashboard grid, and the portal brand scope.
// Every import is dynamic so each test fails on its own while red.

const SITE = 'https://smartremit.ai';

// Every capability-URL or signed-in tree: crawlers must stay out of all of them.
const PRIVATE_PATHS = ['/pay', '/onboard', '/partners/apply', '/account', '/admin-dashboard', '/login', '/api'];

// The enforced CSP, pinned byte-for-byte: any CSP change must be a deliberate,
// reviewed edit. Program-Fix 47: adds https: images (partner logos) and
// object-src 'none'; PR2 drops 'unsafe-eval' outside `next dev`.
const PINNED_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "media-src 'self' https://*.public.blob.vercel-storage.com; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

function expectBrandNeutral(html: string) {
  expect(html).not.toMatch(/smartremit/i);
  expect(html).not.toContain('/brand/');
  expect(html).not.toContain('href="/"');
}

describe('robots.txt (robots.ts)', () => {
  it('disallows every capability and signed-in path and names the sitemap', async () => {
    const { default: robots } = await import('@/app/robots');
    const out = robots();
    const rules = Array.isArray(out.rules) ? out.rules : [out.rules];
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule.userAgent).toBe('*');
    expect(rule.allow).toBe('/');
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    for (const p of PRIVATE_PATHS) expect(disallow).toContain(p);
    expect(out.sitemap).toBe(`${SITE}/sitemap.xml`);
  });
});

describe('sitemap.xml (sitemap.ts)', () => {
  // Program-Fix 15 PR A adds the three legal drafts (/terms, /privacy, /legal).
  it('lists exactly the six public pages on the canonical host, with no hardcoded dates', async () => {
    const { default: sitemap } = await import('@/app/sitemap');
    const entries = sitemap();
    expect(entries.map((e) => e.url)).toEqual([
      `${SITE}/`,
      `${SITE}/about`,
      `${SITE}/docs`,
      `${SITE}/terms`,
      `${SITE}/privacy`,
      `${SITE}/legal`,
    ]);
    for (const e of entries) {
      expect(e.lastModified).toBeUndefined();
      for (const p of PRIVATE_PATHS) expect(e.url).not.toContain(p);
    }
  });
});

describe('next.config.ts headers', () => {
  it('turns off x-powered-by and keeps the enforced CSP byte-for-byte', async () => {
    const { default: config } = await import('../next.config');
    expect(config.poweredByHeader).toBe(false);
    const routes = await config.headers!();
    expect(routes).toHaveLength(1);
    expect(routes[0].source).toBe('/:path*');
    const csp = routes[0].headers.find((h) => h.key === 'Content-Security-Policy');
    expect(csp?.value).toBe(PINNED_CSP);
  });

  // Program-Fix 47 PR2: next.config reads NODE_ENV once, at load. A production
  // build ships no 'unsafe-eval'; only `next dev` (HMR / React refresh) keeps it.
  it.each([
    ['production', false],
    ['development', true],
  ] as const)('NODE_ENV=%s: unsafe-eval present = %s', async (env, expected) => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', env);
    try {
      const { default: config } = await import('../next.config');
      const routes = await config.headers!();
      const csp = routes[0].headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp.includes('unsafe-eval')).toBe(expected);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('root boundaries are brand-neutral (they render under /pay/**)', () => {
  const secretError = () => Object.assign(new Error('secret'), { digest: 'd1' });

  it('not-found: a neutral "Page not found" with a neutral tab title', async () => {
    const mod = await import('@/app/not-found');
    const html = renderToStaticMarkup(createElement(mod.default));
    expectBrandNeutral(html);
    expect(html).toContain('Page not found');
    expect(html).toContain('id="main"');
    expect(String(mod.metadata?.title ?? '')).not.toMatch(/smartremit/i);
    expect(String(mod.metadata?.title ?? '')).toMatch(/not found/i);
  });

  it('error: shows the digest as a reference, never the message', async () => {
    const { default: RootError } = await import('@/app/error');
    const retry = vi.fn();
    const html = renderToStaticMarkup(createElement(RootError, { error: secretError(), retry }));
    expectBrandNeutral(html);
    expect(html).toContain('Something went wrong');
    expect(html).toContain('Try again');
    expect(html).toContain('d1');
    expect(html).not.toContain('secret');
  });

  it('error: no reference line when there is no digest', async () => {
    const { default: RootError } = await import('@/app/error');
    const html = renderToStaticMarkup(
      createElement(RootError, { error: new Error('secret'), retry: vi.fn() }),
    );
    expect(html).not.toContain('Reference');
    expect(html).not.toContain('secret');
  });

  it('global-error: its own <html>/<body> and <title>, neutral, digest only', async () => {
    const { default: GlobalError } = await import('@/app/global-error');
    const html = renderToStaticMarkup(
      createElement(GlobalError, { error: secretError(), retry: vi.fn() }),
    );
    expectBrandNeutral(html);
    expect(html).toMatch(/^<html lang="en"/);
    expect(html).toContain('<body');
    expect(html).toContain('<title>Something went wrong</title>');
    expect(html).toContain('Try again');
    expect(html).toContain('d1');
    expect(html).not.toContain('secret');
  });
});

describe('admin-dashboard error boundary', () => {
  it('stays in the dashboard grid, on the scaffold classes, with a way back', async () => {
    const { default: AdminError } = await import('@/app/admin-dashboard/error');
    const html = renderToStaticMarkup(
      createElement(AdminError, {
        error: Object.assign(new Error('secret'), { digest: 'd2' }),
        retry: vi.fn(),
      }),
    );
    for (const cls of ['sh-main', 'min-[1025px]:col-start-2', 'sh-page-head', 'sh-page-title', 'sh-page-sub']) {
      expect(html).toContain(cls);
    }
    expect(html).toContain('href="/admin-dashboard"');
    expect(html).toContain('Try again');
    expect(html).toContain('d2');
    expect(html).not.toContain('secret');
  });
});

describe('customer portal brand scope', () => {
  it('the account layout wraps every portal page in .account-brand, skip link first', async () => {
    const { default: AccountLayout } = await import('@/app/account/layout');
    const html = renderToStaticMarkup(
      AccountLayout({ children: createElement('p', null, 'child') as ReactNode }) as ReactElement,
    );
    expect(html).toMatch(/^<div class="account-brand"><a href="#main"[^>]*>Skip to content<\/a><p>child<\/p><\/div>$/);
  });

  it('tailwind.css scopes the brand tokens to .account-brand only', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/app/tailwind.css', import.meta.url)), 'utf8');
    const block = css.match(/\.account-brand\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).toMatch(/--primary:\s*#0c5bd2;/);
    expect(block).toMatch(/--ring:\s*#0c5bd2;/);
    // The staff surfaces keep the shadcn indigo: :root is untouched.
    expect(css).toMatch(/:root\s*\{[^}]*--primary:\s*#533afd;/);
  });
});
