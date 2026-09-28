import { describe, it, expect } from 'vitest';
import { isSameOrigin } from '@/lib/same-origin';

// M2-2 Task 2.4: the shared same-origin check for portal ROUTE HANDLERS (route
// handlers get no Next Origin check; server actions do). Same rule as the
// waitlist export route, fail-closed on a missing Origin.
const h = (o: Record<string, string>) => new Headers(o);

describe('isSameOrigin', () => {
  it('equal host → true', () => {
    expect(isSameOrigin(h({ origin: 'https://acme.smartremit.ai', host: 'acme.smartremit.ai' }))).toBe(true);
  });
  it('prefers x-forwarded-host over host', () => {
    expect(isSameOrigin(h({ origin: 'https://acme.smartremit.ai', host: 'internal:3000', 'x-forwarded-host': 'acme.smartremit.ai' }))).toBe(true);
    expect(isSameOrigin(h({ origin: 'https://internal:3000', host: 'internal:3000', 'x-forwarded-host': 'acme.smartremit.ai' }))).toBe(false);
  });
  it('a different partner subdomain → false', () => {
    expect(isSameOrigin(h({ origin: 'https://a.smartremit.ai', host: 'b.smartremit.ai' }))).toBe(false);
  });
  it('apex vs subdomain → false (both ways)', () => {
    expect(isSameOrigin(h({ origin: 'https://smartremit.ai', host: 'acme.smartremit.ai' }))).toBe(false);
    expect(isSameOrigin(h({ origin: 'https://acme.smartremit.ai', host: 'smartremit.ai' }))).toBe(false);
  });
  it('missing Origin → false (fail closed)', () => {
    expect(isSameOrigin(h({ host: 'acme.smartremit.ai' }))).toBe(false);
  });
  it('Origin: null → false', () => {
    expect(isSameOrigin(h({ origin: 'null', host: 'acme.smartremit.ai' }))).toBe(false);
  });
  it('a malformed Origin, or no host at all → false', () => {
    expect(isSameOrigin(h({ origin: 'not a url', host: 'acme.smartremit.ai' }))).toBe(false);
    expect(isSameOrigin(h({ origin: 'https://acme.smartremit.ai' }))).toBe(false);
  });
  it('compares the port and ignores case', () => {
    expect(isSameOrigin(h({ origin: 'https://ACME.smartremit.ai', host: 'acme.SMARTREMIT.ai' }))).toBe(true);
    expect(isSameOrigin(h({ origin: 'https://acme.smartremit.ai:8443', host: 'acme.smartremit.ai' }))).toBe(false);
  });
  it('uses the first x-forwarded-host of a list', () => {
    expect(isSameOrigin(h({ origin: 'https://acme.smartremit.ai', 'x-forwarded-host': 'acme.smartremit.ai, proxy.internal', host: 'x' }))).toBe(true);
    expect(isSameOrigin(h({ origin: 'https://proxy.internal', 'x-forwarded-host': 'acme.smartremit.ai, proxy.internal', host: 'x' }))).toBe(false);
  });
  it('a look-alike host (suffix or userinfo trick) → false', () => {
    expect(isSameOrigin(h({ origin: 'https://acme.smartremit.ai.evil.test', host: 'acme.smartremit.ai' }))).toBe(false);
    expect(isSameOrigin(h({ origin: 'https://acme.smartremit.ai@evil.test', host: 'acme.smartremit.ai' }))).toBe(false);
  });
});
