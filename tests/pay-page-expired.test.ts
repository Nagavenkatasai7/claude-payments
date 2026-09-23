import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, Partner, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';

/**
 * Program-Fix 32 — an expired (cancelled) pay link must never read "Payment
 * complete — money sent!". /pay/[transferId] renders fix 23's generic
 * "This link is no longer active" sheet with DEFAULT branding for a cancelled
 * transfer, byte-equal to the not-found render, and never touches the
 * decrypted payout read. Mock pattern: tests/pay-page-guard.test.ts.
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

vi.mock('@/lib/store', () => ({
  getStore: () => ({ getTransfer, getTransferDecrypted, legacyTenantOf: async () => null }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft }) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner }) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({ isPayoutEditable }),
}));

import PayPage from '@/app/pay/[transferId]/page';

const PARTNER: Partner = { id: 'p_acme', displayName: 'Acme Money Co' } as unknown as Partner;
const EXPIRED_ID = 'Ex_9-Cd_E-fG0hIjKlMnOp';
const LIVE_ID = 'Lv_9-Cd_E-fG0hIjKlMnOp';

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'p_acme',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

async function render(transferId: string): Promise<string> {
  return renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId }) }));
}

beforeEach(() => {
  limiter.dump.clear();
  getTransfer.mockReset();
  getTransferDecrypted.mockReset();
  getDraft.mockReset();
  getPartner.mockReset();
  isPayoutEditable.mockClear();
  const rows: Record<string, Transfer> = {
    [EXPIRED_ID]: makeTransfer({ id: EXPIRED_ID, status: 'cancelled' }),
    [LIVE_ID]: makeTransfer({ id: LIVE_ID }),
  };
  getTransfer.mockImplementation(async (id) => rows[id] ?? null);
  getTransferDecrypted.mockImplementation(async (id) => rows[id] ?? null);
  getDraft.mockResolvedValue(null);
  getPartner.mockImplementation(async (id) => (id === 'p_acme' ? PARTNER : null));
});

describe('/pay/[transferId] — an expired (cancelled) link (Program-Fix 32)', () => {
  it('renders "This link is no longer active" with default branding — never "Payment complete"', async () => {
    const html = await render(EXPIRED_ID);
    expect(html).toContain('This link is no longer active');
    expect(html).toContain('SmartRemit');
    expect(html).not.toContain('Payment complete');
    expect(html).not.toContain('Acme Money Co');
    expect(html).not.toContain('Mom');
    expect(html).not.toContain('Total charge');
    // No decrypted payout read and no editability probe for a dead link.
    expect(getTransferDecrypted).not.toHaveBeenCalled();
    expect(isPayoutEditable).not.toHaveBeenCalled();
  });

  it('its markup is byte-equal to the not-found render', async () => {
    expect(await render(EXPIRED_ID)).toBe(await render('doesnotexist'));
  });

  it('a live awaiting_payment link still renders the payment sheet', async () => {
    const html = await render(LIVE_ID);
    expect(html).toContain('Secure payment');
    expect(html).toContain('Acme Money Co');
  });
});
