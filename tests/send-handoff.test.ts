import { describe, it, expect } from 'vitest';
import { buildSendHandoffUrl, isHandoffSlug, CALCULATOR_DESTINATIONS } from '@/lib/send-handoff';

// Home-Send H1: the home-page "Send with <partner>" link. Parameters are only a
// pre-fill hint (the portal re-validates), so anything doubtful is DROPPED, never
// coerced — and nothing but slug, amount and ISO2 destination ever reaches the URL.

describe('isHandoffSlug', () => {
  it('accepts the partner_sites slug shape', () => {
    for (const s of ['abc', 'acme-pay', 'a1b', '0ab', 'a'.repeat(30)]) expect(isHandoffSlug(s)).toBe(true);
  });
  it('rejects every other shape, including the DNS-reserved ??-- prefix', () => {
    for (const s of [
      '', 'ab', 'a'.repeat(31), '-abc', 'abc-', 'Acme', 'ac_me', 'ac.me', 'ac me', 'xn--abc', 'ab--c',
      'acme/evil', 'acme.evil.com', 'acme?x=1', 'acme#x', '@evil', 'acme\n',
    ]) {
      expect({ s, ok: isHandoffSlug(s) }).toEqual({ s, ok: false });
    }
  });
  it('rejects non-strings', () => {
    for (const s of [null, undefined, 42, {}, ['acme']]) expect(isHandoffSlug(s as unknown)).toBe(false);
  });
});

describe('buildSendHandoffUrl', () => {
  it('builds the partner portal send link with a 2-decimal amount and the ISO2 destination', () => {
    expect(buildSendHandoffUrl({ slug: 'acme-pay', amount: 1000, to: 'IN' })).toBe(
      'https://acme-pay.smartremit.ai/portal/send?amount=1000.00&to=IN',
    );
    expect(buildSendHandoffUrl({ slug: 'acme', amount: 12.5, to: 'IN' })).toBe(
      'https://acme.smartremit.ai/portal/send?amount=12.50&to=IN',
    );
  });
  it('accepts the exact amount bounds', () => {
    expect(buildSendHandoffUrl({ slug: 'acme', amount: 1, to: 'IN' })).toBe('https://acme.smartremit.ai/portal/send?amount=1.00&to=IN');
    expect(buildSendHandoffUrl({ slug: 'acme', amount: 10000, to: 'IN' })).toBe(
      'https://acme.smartremit.ai/portal/send?amount=10000.00&to=IN',
    );
  });
  it('drops an amount that is not a finite number within 1..10000 (checked on the emitted value)', () => {
    for (const amount of [NaN, Infinity, -Infinity, 0, -5, 0.999, 0.994, 10000.001, 10000.01, 20000, undefined, null, '100']) {
      expect({ amount, url: buildSendHandoffUrl({ slug: 'acme', amount: amount as unknown as number, to: 'IN' }) }).toEqual({
        amount,
        url: 'https://acme.smartremit.ai/portal/send?to=IN',
      });
    }
  });
  it('drops a destination the calculator does not support', () => {
    for (const to of ['US', 'in', 'IND', 'MX', 'Other', '', 'IN&x=1', undefined, null, 5]) {
      expect({ to, url: buildSendHandoffUrl({ slug: 'acme', amount: 50, to: to as unknown as string }) }).toEqual({
        to,
        url: 'https://acme.smartremit.ai/portal/send?amount=50.00',
      });
    }
  });
  it('drops both parameters to a bare /portal/send link', () => {
    expect(buildSendHandoffUrl({ slug: 'acme', amount: NaN, to: 'XX' })).toBe('https://acme.smartremit.ai/portal/send');
    expect(buildSendHandoffUrl({ slug: 'acme' })).toBe('https://acme.smartremit.ai/portal/send');
  });
  it('returns null for a slug that is not a valid partner_sites slug', () => {
    for (const slug of ['', 'Acme', 'xn--abc', 'acme.evil.com', 'evil.com/x', 'a', '-ab', undefined, null]) {
      expect({ slug, url: buildSendHandoffUrl({ slug: slug as unknown as string, amount: 100, to: 'IN' }) }).toEqual({
        slug,
        url: null,
      });
    }
  });
  it('only ever carries amount and to (no PII, no ids)', () => {
    const url = new URL(buildSendHandoffUrl({ slug: 'acme', amount: 250, to: 'IN' })!);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('acme.smartremit.ai');
    expect(url.pathname).toBe('/portal/send');
    expect([...url.searchParams.keys()]).toEqual(['amount', 'to']);
  });
  it('supports exactly the calculator corridor (USD to India)', () => {
    expect([...CALCULATOR_DESTINATIONS]).toEqual(['IN']);
  });
});

describe('the handoff target stays on the partner-site allowlist', () => {
  it('the built path is ALLOWED on a partner subdomain (SITE_ROUTES), so the link can never drift to a denied path', async () => {
    const { classifySitePath } = await import('@/lib/site-routes');
    for (const input of [{ slug: 'acme', amount: 25, to: 'IN' }, { slug: 'acme' }]) {
      const url = new URL(buildSendHandoffUrl(input)!);
      expect(classifySitePath(url.pathname), url.pathname).toMatchObject({ kind: 'allow' });
      expect(url.pathname).toBe('/portal/send');
    }
  });
});
