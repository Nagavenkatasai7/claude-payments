import { describe, it, expect } from 'vitest';
import nextConfig from '../next.config';

// The enforced CSP must keep allowing Vercel Speed Insights, which is fully
// same-origin: the Next component injects <script src="/_vercel/speed-insights/script.js">
// via document.createElement WITHOUT a nonce (node_modules/@vercel/speed-insights/
// dist/next/index.mjs:86,141-152; its props expose no nonce), and the hosted
// script POSTs beacons to /_vercel/speed-insights/vitals (fetch keepalive or
// sendBeacon, both governed by connect-src).
async function directives(): Promise<Map<string, string[]>> {
  const rules = await nextConfig.headers!();
  const csp = rules
    .flatMap((r) => r.headers)
    .find((h) => h.key.toLowerCase() === 'content-security-policy');
  expect(csp, 'CSP header must be set').toBeDefined();
  return new Map(
    csp!.value.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values] as [string, string[]];
    }),
  );
}

describe('CSP allows same-origin Vercel Speed Insights', () => {
  it("script-src allows 'self' with no nonce gate the injected script cannot pass", async () => {
    const scriptSrc = (await directives()).get('script-src') ?? [];
    expect(scriptSrc).toContain("'self'");
    // 'strict-dynamic' or a nonce would block the nonce-less injected script
    // unless its loader is itself nonced — revisit Speed Insights if this changes.
    expect(scriptSrc).not.toContain("'strict-dynamic'");
    expect(scriptSrc.some((s) => s.startsWith("'nonce-"))).toBe(false);
  });

  it("connect-src allows 'self' for the /_vercel/speed-insights/vitals beacon", async () => {
    expect((await directives()).get('connect-src')).toContain("'self'");
  });
});
