import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PayableLink } from '@/lib/payment-link-finalize';
import type { Partner } from '@/lib/types';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { approvedDisclosureConfig } from './helpers-live';

/**
 * Fix pack 6 T7b (R46, P5, P8): the payment-link page asks for E-SIGN consent
 * when the link payer (the link owner + the link's customer phone) has no current
 * consent on file: LinkPayForm gets esignVersion and renders the consent block
 * directly above the chosen way to pay's Reg E disclosure. Links are never
 * exempt. Consent on file leaves the page byte-identical; the dead-link sheet
 * never reads it. Mocks copied from tests/payment-link-page.test.ts.
 */

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.9' }) }));
vi.mock('@/lib/ip-rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/ip-rate-limit')>()),
  isIpRateLimited: async () => false,
}));
vi.mock('@/lib/store', () => ({ getStore: () => ({}) }));
const fakeDb = vi.hoisted(() => ({ marker: 'link-page-db' }));
vi.mock('@/db/client', () => ({ getDb: () => fakeDb }));
const owner = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner: async () => owner.value }) }));
const resolvePayableLink = vi.hoisted(() => vi.fn<() => Promise<PayableLink | null>>());
vi.mock('@/lib/payment-link-finalize', () => ({ resolvePayableLink }));
vi.mock('@/lib/payment-link-quote', () => ({
  getLinkQuoteStore: () => ({}),
  lockedOrFreshLinkRate: async () => ({ toInr: 85, fetchedAt: Date.now(), lockedAt: '2026-10-08T12:00:00.000Z' }),
}));
const formProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('@/app/pay/l/[token]/link-pay-form', async (orig) => {
  const real = await orig<typeof import('@/app/pay/l/[token]/link-pay-form')>();
  return {
    ...real,
    LinkPayForm: (props: Parameters<typeof real.LinkPayForm>[0]) => {
      formProps.last = props as unknown as Record<string, unknown>;
      return real.LinkPayForm(props);
    },
  };
});
vi.mock('@/lib/originator-info', async (orig) => {
  const real = await orig<typeof import('@/lib/originator-info')>();
  return { ...real, readOriginatorView: async () => real.NO_ORIGINATOR_FIELDS };
});
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: () => {} }),
}));
// The consent read: toggled, and its arguments recorded.
const esign = vi.hoisted(() => ({ needed: false, calls: [] as unknown[][] }));
vi.mock('@/lib/esign', async (orig) => ({
  ...(await orig<typeof import('@/lib/esign')>()),
  readEsignConsentNeeded: async (...args: unknown[]) => {
    esign.calls.push(args);
    return esign.needed;
  },
}));

import PaymentLinkPage from '@/app/pay/l/[token]/page';

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const render = async () =>
  renderToStaticMarkup((await PaymentLinkPage({ params: Promise.resolve({ token: TOKEN }) })) as React.ReactElement);

const payable = (): PayableLink =>
  ({
    link: {
      id: 'pl_1', partnerId: 'acme', payeeId: 'pye_1', token: TOKEN, reference: 'INV-2026-001', customerName: 'Asha',
      customerPhone: '14155550100', amountInr: 25000, purpose: 'education', status: 'open', transferId: null,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    payee: { id: 'pye_1', partnerId: 'acme', legalName: 'Sunrise Public School', status: 'approved' },
    payability: 'open',
    transfer: null,
  }) as unknown as PayableLink;

const DISCLOSURE = 'aria-labelledby="reg-e-disclosure-heading"';
const BLOCK = 'data-testid="esign-consent"';

beforeEach(() => {
  // An approved owner, so the chosen way to pay has a Reg E disclosure to sit above.
  owner.value = { id: 'acme', displayName: 'Acme', supportConfig: { disclosure: approvedDisclosureConfig() } } as unknown as Partner;
  formProps.last = null;
  esign.needed = false;
  esign.calls = [];
  resolvePayableLink.mockReset();
});

describe('/pay/l/[token] page: the E-SIGN consent tick (pack 6 T7b, P8)', () => {
  it('needed -> LinkPayForm gets esignVersion and the HTML shows the block above the disclosure', async () => {
    esign.needed = true;
    resolvePayableLink.mockResolvedValue(payable());
    const html = await render();
    expect(formProps.last?.esignVersion).toBe(ESIGN_CONSENT_VERSION);
    expect(html.split(BLOCK)).toHaveLength(2);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="esignConsent"/);
    const block = html.indexOf(BLOCK);
    const disclosure = html.indexOf(DISCLOSURE);
    expect(disclosure).toBeGreaterThan(-1);
    expect(block).toBeLessThan(disclosure);
    // Directly above: nothing but the block sits between the money panel and it.
    expect(html.indexOf('Paying with')).toBeLessThan(block);
  });

  it('not needed -> esignVersion null, markup as today (byte-identical to a form given no esignVersion)', async () => {
    resolvePayableLink.mockResolvedValue(payable());
    const html = await render();
    expect(formProps.last?.esignVersion).toBeNull();
    expect(html).not.toContain('esign-consent');
    expect(html).not.toContain('name="esignConsent"');
    expect(html).toContain(DISCLOSURE);
    // The same form with the prop left out renders the same bytes.
    const { LinkPayForm } = await import('@/app/pay/l/[token]/link-pay-form');
    const props = { ...(formProps.last as Parameters<typeof LinkPayForm>[0]) };
    const withNull = renderToStaticMarkup(createElement(LinkPayForm, props));
    expect(withNull).toBe(html.slice(html.indexOf('<form'), html.indexOf('</form>') + '</form>'.length));
    delete (props as { esignVersion?: unknown }).esignVersion;
    expect(renderToStaticMarkup(createElement(LinkPayForm, props))).toBe(withNull);
  });

  it('the dead-link sheet never reads it', async () => {
    esign.needed = true;
    resolvePayableLink.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain('This link is no longer active');
    expect(html).not.toContain('esign-consent');
    expect(esign.calls).toEqual([]);
  });

  it('the read is keyed on (link.partnerId, link.customerPhone)', async () => {
    resolvePayableLink.mockResolvedValue(payable());
    await render();
    expect(esign.calls).toEqual([[fakeDb, 'acme', '14155550100']]);
  });

  it('a resumed link (transfer minted) is asked too: links are never exempt', async () => {
    esign.needed = true;
    resolvePayableLink.mockResolvedValue({
      ...payable(),
      payability: 'resume',
      transfer: { id: 'tx_1', fxRate: 84, fundingMethod: 'debit_card', amountUsd: 297.62, feeUsd: 2.99, totalChargeUsd: 300.61 },
    } as unknown as PayableLink);
    const html = await render();
    expect(formProps.last?.esignVersion).toBe(ESIGN_CONSENT_VERSION);
    expect(html.indexOf(BLOCK)).toBeLessThan(html.indexOf(DISCLOSURE));
  });
});
