import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, Partner, Transfer } from '@/lib/types';
import { RISK_ACK_LABEL, RISK_WARNING_TEXT } from '@/lib/legal/risk-warning';
import { fakeRedis } from './helpers';

/**
 * Fix pack 6 T28 (R48, P19): the pay page shows the fixed risk warning and its tick
 * ONLY for a draft that carries a known risk signal. A minted transfer (awaiting,
 * paid or cancelled) never shows it. Mock pattern: tests/pay-page-draft-relink.test.ts.
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
// consent on file (pack 6 P8): the E-SIGN tick is tested in pay-page-esign.test.ts
vi.mock('@/lib/esign', async (o) => ({ ...(await o<typeof import('@/lib/esign')>()), readEsignConsentNeeded: async () => false }));
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({ isPayoutEditable, isPaymentLinkTransfer: async () => false, getDisclosureSnapshot: async () => null }),
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

function makeDraft(o: Record<string, unknown> = {}): Draft {
  return {
    senderPhone: '15551234567', partnerId: 'default',
    recipient: { name: 'Dad', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
    amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 8500 },
    ...o,
  } as unknown as Draft;
}

async function render(id: string): Promise<string> {
  return renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId: id }) }));
}

// React escapes apostrophes and quotes in text; compare against the escaped form.
const esc = (s: string) => renderToStaticMarkup(createElement('span', null, s)).slice(6, -7);

function expectNoWarning(html: string): void {
  expect(html).not.toContain('data-testid="risk-ack"');
  expect(html).not.toContain('name="riskAck"');
  expect(html).not.toContain(esc(RISK_WARNING_TEXT));
  expect(html).not.toContain(esc(RISK_ACK_LABEL));
}

let minted: Transfer;
beforeEach(() => {
  limiter.dump.clear();
  claims.clear();
  getTransfer.mockReset();
  getTransferDecrypted.mockReset();
  getDraft.mockReset().mockResolvedValue(null);
  getPartner.mockReset().mockResolvedValue(null);
  minted = makeTransfer();
  getTransfer.mockImplementation(async (id) => (id === MINTED_ID ? minted : null));
  getTransferDecrypted.mockImplementation(async (id) =>
    id === MINTED_ID ? { ...minted, payoutDestination: '123456781234|HDFC0001234' } : null);
});

describe('pay page risk warning (pack 6 T28, P19)', () => {
  it("a draft with riskSignals ['first_transfer'] renders the warning and the tick", async () => {
    getDraft.mockResolvedValue(makeDraft({ riskSignals: ['first_transfer'] }));
    const html = await render(DRAFT_ID);
    expect(html).toContain('data-testid="risk-ack"');
    expect(html).toContain(esc(RISK_WARNING_TEXT));
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="riskAck"/);
    expect(html).toContain(esc(RISK_ACK_LABEL));
  });

  it("a draft without riskSignals, a draft with only unknown values (['bogus']), and a minted transfer render no warning", async () => {
    getDraft.mockResolvedValue(makeDraft());
    const plain = await render(DRAFT_ID);
    expect(plain).toContain('Dad');
    expectNoWarning(plain);
    getDraft.mockResolvedValue(makeDraft({ riskSignals: ['bogus'] }));
    const bogus = await render(DRAFT_ID);
    expectNoWarning(bogus);
    expect(bogus).toBe(plain);
    getDraft.mockResolvedValue(makeDraft({ riskSignals: [] }));
    expect(await render(DRAFT_ID)).toBe(plain);
    getDraft.mockResolvedValue(null);
    const transfer = await render(MINTED_ID);
    expect(transfer).toContain('Secure payment');
    expectNoWarning(transfer);
  });

  it('a paid or cancelled row never shows it', async () => {
    for (const status of ['paid', 'cancelled'] as const) {
      minted = makeTransfer({ status });
      expectNoWarning(await render(MINTED_ID));
      // The draft link of a minted draft renders the transfer it became: no warning either.
      claims.set(`default|draft:${DRAFT_ID}`, MINTED_ID);
      expectNoWarning(await render(DRAFT_ID));
      claims.clear();
    }
  });
});
