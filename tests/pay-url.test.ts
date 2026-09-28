import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { payUrlFor, portalPayUrl } from '@/lib/send-seam';

// UI redesign M2-4, Task 4.3: ONE pay-URL builder. The bot's approve card,
// generate_payment_link and (later) the portal all call it, so M1 H2 can move
// /pay onto partner subdomains by changing this one function.

const ORIGINAL = process.env.APP_BASE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = ORIGINAL;
});

describe('payUrlFor', () => {
  it('equals the old expression `${env.appBaseUrl}/pay/${id}` under a stubbed APP_BASE_URL', () => {
    process.env.APP_BASE_URL = 'https://pay.example.test/';
    expect(payUrlFor('abc')).toBe('https://pay.example.test/pay/abc');
  });

  it('portalPayUrl is the same builder until M1 H2', () => {
    expect(portalPayUrl).toBe(payUrlFor);
  });

  it('tools.ts builds no /pay/<id> URL of its own any more', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'tools.ts'), 'utf8');
    expect(src.split('/pay/${').length - 1).toBe(0);
  });
});
