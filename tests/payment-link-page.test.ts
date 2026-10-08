import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PayableLink } from '@/lib/payment-link-finalize';

/**
 * Batch B2: /pay/l/[token]. Every unpayable link renders the SAME sheet; a
 * payable one shows the company, reference, exact rupees, the locked rate, both
 * fees with their USD totals and the Reg E disclosure, under SmartRemit only.
 */

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.9' }) }));
const limited = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/ip-rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/ip-rate-limit')>()),
  isIpRateLimited: async () => limited.value,
}));
vi.mock('@/lib/store', () => ({ getStore: () => ({}) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner: async () => null }) }));
const resolvePayableLink = vi.hoisted(() => vi.fn<() => Promise<PayableLink | null>>());
vi.mock('@/lib/payment-link-finalize', () => ({ resolvePayableLink }));
vi.mock('@/lib/payment-link-quote', () => ({
  getLinkQuoteStore: () => ({}),
  lockedOrFreshLinkRate: async () => ({ toInr: 85, fetchedAt: Date.now(), lockedAt: new Date().toISOString() }),
}));

import PaymentLinkPage from '@/app/pay/l/[token]/page';

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const render = async (token = TOKEN) =>
  renderToStaticMarkup((await PaymentLinkPage({ params: Promise.resolve({ token }) })) as React.ReactElement);

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

beforeEach(() => {
  limited.value = false;
  resolvePayableLink.mockReset();
});

describe('/pay/l/[token] page', () => {
  it('an unpayable link and a throttled request render the identical dead-link sheet', async () => {
    resolvePayableLink.mockResolvedValue(null);
    const dead = await render();
    expect(dead).toContain('This link is no longer active');
    expect(dead).not.toContain('Sunrise');
    limited.value = true;
    resolvePayableLink.mockResolvedValue(payable());
    expect(await render()).toBe(dead);
  });

  it('a payable link shows the company, reference, rupees, rate, both fees and totals, and the disclosure', async () => {
    resolvePayableLink.mockResolvedValue(payable());
    const html = await render();
    expect(html).toContain('Sunrise Public School');
    expect(html).toContain('INV-2026-001');
    expect(html).toContain('₹25,000');
    expect(html).toContain('1 USD = 85.00 INR');
    expect(html).toContain('$1.99');
    expect(html).toContain('$2.99');
    expect(html).toContain('$296.11'); // 294.12 + 1.99, the default (bank) choice
    expect(html).toContain('Send confirmation code to WhatsApp');
    expect(html).toContain('SmartRemit');
  });
});
