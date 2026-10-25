import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RateCalculator from '@/app/landing/RateCalculator';
import type { CalcDestination } from '@/app/landing/calc-destinations';

// Raj's website brief (Oct 25), widget step 2: the "to" picker. Without `destinations` the
// calculator is unchanged (tests/landing-rate-calculator.test.ts pins that snapshot).

type Props = Parameters<typeof RateCalculator>[0];
const render = (p: Props) => renderToStaticMarkup(createElement(RateCalculator, p));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));

const DESTS: CalcDestination[] = [
  { code: 'IN', name: 'India', currency: 'INR', rate: 94.96, launch: true },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', rate: 0.75, launch: false },
  { code: 'MX', name: 'Mexico', currency: 'MXN', rate: null, launch: false },
];
const BASE: Props = { rate: 94.96, live: true, asOf: '2026-10-24', destinations: DESTS };

describe('RateCalculator — the "to" picker', () => {
  it('shows a labelled picker: India first as the launch corridor, the rest under "Coming next"', () => {
    const html = render(BASE);
    expect(html).toContain('From the United States (USD)');
    expect(html).toMatch(/<label[^>]*for="calc-to"[^>]*>Send to<\/label>/);
    expect(html).toMatch(/<select[^>]*id="calc-to"/);
    const india = html.indexOf('>India (INR)');
    const group = html.indexOf('<optgroup label="Coming next">');
    expect(india).toBeGreaterThan(-1);
    expect(group).toBeGreaterThan(india);
    expect(html.indexOf('>United Kingdom (GBP)')).toBeGreaterThan(group);
  });

  it('India (the default) keeps the WhatsApp send button and the rupee figure', () => {
    const html = render(BASE);
    expect(html).toContain('Send $1,000 to India on WhatsApp');
    expect(html).toContain('₹94,960');
    expect(hrefs(html).some((h) => h.startsWith('https://api.whatsapp.com/send/'))).toBe(true);
  });

  it('a coming-next country shows its figure and points at the waitlist, never a send', () => {
    const html = render({ ...BASE, initialTo: 'GB' });
    expect(html).toContain('£750.00');
    expect(html).toContain('United Kingdom is coming next.');
    expect(html).toContain('Join the waitlist');
    expect(hrefs(html)).toEqual(['#waitlist']);
    expect(html).not.toContain('on WhatsApp');
  });

  it('a coming-next country without a rate shows no figure', () => {
    const html = render({ ...BASE, initialTo: 'MX' });
    expect(html).toMatch(/aria-live="polite">—</);
  });

  it('a featured partner button is offered only for India', () => {
    const featured = { slug: 'acme-pay', displayName: 'Acme Pay', mode: 'test' as const };
    expect(render({ ...BASE, featured })).toContain('Try a test send with Acme Pay');
    expect(render({ ...BASE, featured, initialTo: 'GB' })).not.toContain('Acme Pay');
  });
});
