import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, Partner, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';

/**
 * Step 0 Q16 (build-changes B.2): /pay/<draftId> after the draft was minted
 * and consumed renders the transfer it BECAME (followed through the
 * `draft:<draftId>` idempotency claim), exactly as that transfer's own link
 * would: a live row shows the payment sheet, a cancelled one the dead-link
 * sheet. Mock pattern: tests/pay-page-expired.test.ts.
 */

const limiter = fakeRedis();
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.9' }) }));
vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor() {
      return limiter;
    }
  },
}));

const getTransfer = vi.fn<(id: string) => Promise<Transfer | null>>();
const getTransferDecrypted = vi.fn<(id: string) => Promise<Transfer | null>>();
const getDraft = vi.fn<(id: string) => Promise<Draft | null>>();
const getPartner = vi.fn<(id: string) => Promise<Partner | null>>();
const isPayoutEditable = vi.fn(async () => false);
const claims = new Map<string, string>();
const find = vi.fn(async (partnerId: string, key: string) => claims.get(`${partnerId}|${key}`) ?? null);

vi.mock('@/lib/store', () => ({
  getStore: () => ({ getTransfer, getTransferDecrypted, legacyTenantOf: async () => null }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft }) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner }) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({ isPayoutEditable, isPaymentLinkTransfer: async () => false }),
}));
vi.mock('@/db/repos/aux-repos', () => ({ createIdempotencyRepo: () => ({ find }) }));

import PayPage from '@/app/pay/[transferId]/page';

const DRAFT_ID = 'Dr_9-Cd_E-fG0hIjKlMnOp';
const MINTED_ID = 'Mt_9-Cd_E-fG0hIjKlMnOp';

function makeTransfer(o: Partial<Transfer> = {}): Transfer {
  return {
    id: MINTED_ID, phone: '15551234567', amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '****1234', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

async function render(id: string): Promise<string> {
  return renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId: id }) }));
}

let minted: Transfer;
beforeEach(() => {
  limiter.dump.clear();
  claims.clear();
  find.mockClear();
  getTransfer.mockReset();
  getTransferDecrypted.mockReset();
  getDraft.mockReset().mockResolvedValue(null); // the draft was consumed after the mint
  getPartner.mockReset().mockResolvedValue(null);
  isPayoutEditable.mockClear();
  minted = makeTransfer();
  getTransfer.mockImplementation(async (id) => (id === MINTED_ID ? minted : null));
  getTransferDecrypted.mockImplementation(async (id) =>
    id === MINTED_ID ? { ...minted, payoutDestination: '123456781234|HDFC0001234' } : null);
});

describe('/pay/<draftId> after the draft became a transfer (Step 0 Q16)', () => {
  it('renders the transfer\'s payment sheet (was: "no longer active")', async () => {
    claims.set(`default|draft:${DRAFT_ID}`, MINTED_ID);
    const html = await render(DRAFT_ID);
    expect(find).toHaveBeenCalledWith('default', `draft:${DRAFT_ID}`);
    expect(html).toContain('Secure payment');
    expect(html).toContain('Mom');
    expect(html).not.toContain('This link is no longer active');
    // Every read is on the TRANSFER's id, never the draft id.
    expect(getTransferDecrypted).toHaveBeenCalledWith(MINTED_ID);
    expect(isPayoutEditable).toHaveBeenCalledWith(MINTED_ID, 'default');
  });

  it('renders byte-identical to the transfer\'s own link', async () => {
    claims.set(`default|draft:${DRAFT_ID}`, MINTED_ID);
    expect(await render(DRAFT_ID)).toBe(await render(MINTED_ID));
  });

  it('a cancelled transfer behind the claim is the dead-link sheet, byte-equal to not-found', async () => {
    claims.set(`default|draft:${DRAFT_ID}`, MINTED_ID);
    minted = makeTransfer({ status: 'cancelled' });
    expect(await render(DRAFT_ID)).toBe(await render('doesnotexist'));
  });

  it('a paid transfer behind the claim shows the completed state', async () => {
    claims.set(`default|draft:${DRAFT_ID}`, MINTED_ID);
    minted = makeTransfer({ status: 'paid' });
    expect(await render(DRAFT_ID)).toContain('Payment complete');
  });

  it('no claim (an expired, never-paid draft) is still the dead-link sheet', async () => {
    expect(await render(DRAFT_ID)).toContain('This link is no longer active');
  });

  it('a live draft never consults the claim', async () => {
    getDraft.mockResolvedValue({
      senderPhone: '15551234567', partnerId: 'default',
      recipient: { name: 'Dad', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 8500 },
    } as unknown as Draft);
    const html = await render(DRAFT_ID);
    expect(html).toContain('Dad');
    expect(find).not.toHaveBeenCalled();
  });
});
