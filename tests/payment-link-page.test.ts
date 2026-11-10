import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PayableLink } from '@/lib/payment-link-finalize';
import type { Partner } from '@/lib/types';
import { approvedDisclosureConfig } from './helpers-live';

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
// Fix pack 4 (T18): `owner.value` is the link owner's read (null: today's spec).
const owner = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner: async () => owner.value }) }));
const resolvePayableLink = vi.hoisted(() => vi.fn<() => Promise<PayableLink | null>>());
vi.mock('@/lib/payment-link-finalize', () => ({ resolvePayableLink }));
const LOCKED_AT = '2026-10-08T12:00:00.000Z';
vi.mock('@/lib/payment-link-quote', () => ({
  getLinkQuoteStore: () => ({}),
  lockedOrFreshLinkRate: async () => ({ toInr: 85, fetchedAt: Date.now(), lockedAt: LOCKED_AT }),
}));
// The real form renders; its props are recorded so the lock identity it posts back is checked.
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
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: () => {} }),
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
  owner.value = null;
  formProps.last = null;
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

  it('hands the form the identity of the rate lock it rendered (the pay route refuses any other lock)', async () => {
    resolvePayableLink.mockResolvedValue(payable());
    await render();
    expect(formProps.last?.quoteLockedAt).toBe(LOCKED_AT);
  });

  it('a resumed link (transfer already minted) shows its fixed figures and needs no lock', async () => {
    resolvePayableLink.mockResolvedValue({
      ...payable(),
      payability: 'resume',
      transfer: { id: 'tx_1', fxRate: 84, fundingMethod: 'debit_card', amountUsd: 297.62, feeUsd: 2.99, totalChargeUsd: 300.61 },
    } as unknown as PayableLink);
    const html = await render();
    expect(html).toContain('1 USD = 84.00 INR');
    expect(formProps.last?.quoteLockedAt).toBeNull();
  });

  // Fix pack 4 (C15, C10; critic P13): the line beside the code box names the
  // WHOLE payee and no account; the form posts the block hash it was rendered with.
  it('the link form gets the payee name and the block hash, and shows the Approving line for the first option', async () => {
    resolvePayableLink.mockResolvedValue(payable());
    const html = await render();
    expect(formProps.last?.approvingName).toBe('Sunrise Public School');
    expect(formProps.last?.disclosureHash).toBeNull(); // the spec's partner read gives no block
    const line = html.match(/<p data-testid="approving-line"[^>]*>([^<]*)<\/p>/)?.[1];
    expect(line).toBe('Approving 296.11 USD to Sunrise Public School.');
    expect(html).not.toContain('account ending');
  });

  // Fix pack 4 T18 (C22 a): the owner's approved provider line, once, right under the heading.
  it('an approved link owner -> one provider-line under Secure payment', async () => {
    owner.value = { id: 'acme', displayName: 'Acme', supportConfig: { disclosure: approvedDisclosureConfig() } } as unknown as Partner;
    resolvePayableLink.mockResolvedValue(payable());
    const html = await render();
    expect(html.split('data-testid="provider-line"')).toHaveLength(2);
    const h1Close = html.indexOf('Secure payment</h1>');
    expect(html.slice(h1Close + 'Secure payment</h1>'.length)).toMatch(
      /^<p data-testid="provider-line"[^>]*>Payments by Acme Money Services LLC, licensed by State Department of Financial Services<\/p>/,
    );
    expect(html.indexOf('data-testid="provider-line"')).toBeLessThan(html.indexOf('Pay to'));
  });

  it('getPartner null (no approved block) -> no provider-line', async () => {
    resolvePayableLink.mockResolvedValue(payable());
    const html = await render();
    expect(html).not.toContain('provider-line');
    expect(html).not.toContain('Payments by');
  });

  it('an unpayable link of an approved owner -> the dead-link sheet has no line', async () => {
    owner.value = { id: 'acme', displayName: 'Acme', supportConfig: { disclosure: approvedDisclosureConfig() } } as unknown as Partner;
    resolvePayableLink.mockResolvedValue(null);
    const dead = await render();
    expect(dead).toContain('This link is no longer active');
    expect(dead).not.toContain('provider-line');
  });
});
