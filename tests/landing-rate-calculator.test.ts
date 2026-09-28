import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RateCalculator from '@/app/landing/RateCalculator';

// Home-Send H1: the landing calculator must render EXACTLY today's WhatsApp CTA
// when no featured send partner is configured. The snapshot was recorded from the
// component BEFORE the featured-partner button existed, so any drift in the
// no-partner markup fails here.

type Props = Parameters<typeof RateCalculator>[0];
const render = (p: Props) => renderToStaticMarkup(createElement(RateCalculator, p));

const CASES: Array<[string, Props]> = [
  ['live rate', { rate: 83.25, live: true, asOf: '2026-01-02' }],
  ['indicative rate', { rate: 83.25, live: false, asOf: null }],
  ['no rate', { rate: null, live: false, asOf: null }],
];

describe('RateCalculator — no featured partner', () => {
  for (const [name, props] of CASES) {
    it(`renders today's CTA unchanged (${name})`, () => {
      expect(render(props)).toMatchSnapshot();
    });
  }
});

describe('RateCalculator — featured send partner', () => {
  const BASE = { rate: 83.25, live: true, asOf: '2026-01-02' } as const;
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

  it('featured: null or undefined renders the exact no-partner markup', () => {
    for (const [, props] of CASES) {
      expect(render({ ...props, featured: null })).toBe(render(props));
      expect(render({ ...props, featured: undefined })).toBe(render(props));
    }
  });

  const WA_HREF =
    'https://api.whatsapp.com/send/?phone=15556298293&text=Hi%20SmartRemit%2C%20I%20want%20to%20send%201000%20USD%20to%20India.&type=phone_number&app_absent=0';

  it('test mode: a test-send button to the partner portal, a TEST badge and the test-mode note', () => {
    const html = render({ ...BASE, featured: { displayName: 'Acme Pay', slug: 'acme-pay', mode: 'test' } });
    expect(hrefs(html)).toEqual(['https://acme-pay.smartremit.ai/send?amount=1000.00&to=IN', WA_HREF]);
    expect(html).toContain('Try a test send with Acme Pay');
    expect(html).toContain('TEST — no real money');
    expect(html).toContain('Test mode — no money moves.');
    expect(html).not.toContain('licensed money transmitter');
    expect(html).not.toContain('wa.me');
  });

  it('live mode: "Send with", the licensed-transmitter disclosure naming the legal entity, no badge', () => {
    const html = render({
      ...BASE,
      featured: { displayName: 'Acme Pay', legalName: 'Acme Money Services LLC', slug: 'acme-pay', mode: 'live' },
    });
    expect(hrefs(html)).toEqual(['https://acme-pay.smartremit.ai/send?amount=1000.00&to=IN', WA_HREF]);
    expect(html).toContain('Send with Acme Pay');
    expect(html).not.toContain('Try a test send');
    expect(html).not.toContain('TEST — no real money');
    expect(html).toContain(
      'Money is handled by Acme Money Services LLC, a licensed money transmitter. SmartRemit provides the technology.',
    );
  });

  it('live mode WITHOUT a legal name never claims a licensed transmitter: it renders the test copy', () => {
    const html = render({ ...BASE, featured: { displayName: 'Acme Pay', slug: 'acme-pay', mode: 'live' } });
    expect(html).not.toContain('licensed money transmitter');
    expect(html).toContain('Try a test send with Acme Pay');
    expect(html).toContain('TEST — no real money');
    expect(html).toContain('Test mode — no money moves.');
  });

  it('keeps the WhatsApp CTA beside the partner button: partner first (primary), WhatsApp second', () => {
    const html = render({ ...BASE, featured: { displayName: 'Acme Pay', slug: 'acme-pay', mode: 'test' } });
    expect(html.indexOf('Try a test send with Acme Pay')).toBeLessThan(html.indexOf('Send $1,000 to India on WhatsApp'));
    // The e2e smoke's selector (tests/e2e/dashboard-smoke.spec.ts) still matches.
    expect(html).toContain('href="https://api.whatsapp.com/send/?phone=');
  });

  it('escapes partner-supplied names (React text, never HTML)', () => {
    const html = render({ ...BASE, featured: { displayName: '<b>x</b>', slug: 'acme-pay', mode: 'live' } });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('an unservable slug falls back to the exact no-partner markup', () => {
    const html = render({ ...BASE, featured: { displayName: 'Acme Pay', slug: 'Bad.Slug', mode: 'test' } });
    expect(html).toBe(render(BASE));
  });
});
