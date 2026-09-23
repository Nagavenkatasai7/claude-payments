import { describe, it, expect } from 'vitest';

// Program-Fix 47 (PR1) — the one Content-Security-Policy builder. next.config.ts
// uses it WITHOUT a nonce for the enforced policy on every route; the middleware
// uses it WITH a per-request nonce for the report-only policy on the dynamic
// trees. Imported dynamically so the suite fails on its own while red.

function directives(policy: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of policy.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [name, ...rest] = part.split(/\s+/);
    expect(out.has(name)).toBe(false); // no directive appears twice
    out.set(name, rest.join(' '));
  }
  return out;
}

describe('buildCsp', () => {
  it('production, no nonce: script-src keeps unsafe-inline and drops unsafe-eval', async () => {
    const { buildCsp } = await import('@/lib/csp');
    const d = directives(buildCsp({ isDev: false }));
    expect(d.get('script-src')).toBe("'self' 'unsafe-inline'");
    expect(buildCsp({ isDev: false })).not.toContain('unsafe-eval');
    expect(buildCsp({ isDev: false })).not.toContain('nonce-');
  });

  it('development adds unsafe-eval (React uses eval for dev stacks)', async () => {
    const { buildCsp } = await import('@/lib/csp');
    expect(directives(buildCsp({ isDev: true })).get('script-src')).toBe(
      "'self' 'unsafe-inline' 'unsafe-eval'",
    );
    expect(directives(buildCsp({ nonce: 'abc', isDev: true })).get('script-src')).toBe(
      "'self' 'nonce-abc' 'strict-dynamic' 'unsafe-eval'",
    );
  });

  it('with a nonce: script-src is self + nonce + strict-dynamic, no unsafe-inline', async () => {
    const { buildCsp } = await import('@/lib/csp');
    const policy = buildCsp({ nonce: 'bm9uY2U=', isDev: false });
    expect(directives(policy).get('script-src')).toBe("'self' 'nonce-bm9uY2U=' 'strict-dynamic'");
    expect(policy).not.toContain('unsafe-eval');
  });

  it('img-src admits https: so partner https logos render (sanitizeLogoValue accepts them)', async () => {
    const { buildCsp } = await import('@/lib/csp');
    for (const p of [buildCsp({ isDev: false }), buildCsp({ nonce: 'n', isDev: false })]) {
      expect(directives(p).get('img-src')).toBe("'self' data: blob: https:");
    }
  });

  it("adds object-src 'none' and keeps style-src and every other directive unchanged", async () => {
    const { buildCsp } = await import('@/lib/csp');
    for (const p of [buildCsp({ isDev: false }), buildCsp({ nonce: 'n', isDev: false })]) {
      const d = directives(p);
      expect(d.get('object-src')).toBe("'none'");
      // A style nonce would block inline style= attributes: keep unsafe-inline.
      expect(d.get('style-src')).toBe("'self' 'unsafe-inline'");
      expect(d.get('default-src')).toBe("'self'");
      expect(d.get('media-src')).toBe("'self' https://*.public.blob.vercel-storage.com");
      expect(d.get('font-src')).toBe("'self' data:");
      expect(d.get('connect-src')).toBe("'self'");
      expect(d.get('frame-ancestors')).toBe("'none'");
      expect(d.get('base-uri')).toBe("'self'");
      expect(d.get('form-action')).toBe("'self'");
      // Not copied from the guide: in a report-only policy Chrome logs that it
      // ignores this directive, which the pay-page console collector would see.
      expect(d.has('upgrade-insecure-requests')).toBe(false);
    }
  });

  it("produces a nonce Next's own extractor accepts (base64 of a UUID)", async () => {
    const { buildCsp, makeNonce } = await import('@/lib/csp');
    const { getScriptNonceFromHeader } = await import(
      'next/dist/server/app-render/get-script-nonce-from-header'
    );
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(getScriptNonceFromHeader(buildCsp({ nonce, isDev: false }))).toBe(nonce);
    expect(makeNonce()).not.toBe(nonce);
  });
});
