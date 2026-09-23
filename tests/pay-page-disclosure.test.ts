import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, Partner, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';

/**
 * Program-Fix 15 PR B — the Reg E pre-payment disclosure (12 CFR
 * 1005.31(b)(1)) on /pay/[transferId]. Same harness as pay-page-guard. The
 * disclosure is ADDED under the existing summary (whose rows are unchanged),
 * names the licensed partner from its own config, shows the demo note on the
 * default tenant (never SmartRemit as the transmitter), and is absent for B2B
 * and for a transfer that is no longer awaiting payment.
 */

const THROTTLED_IP = '203.0.113.7';
const FRESH_IP = '198.51.100.9';
const DOWN_IP = '192.0.2.44';
const T0 = 1_750_000_000_000;

const limiter = fakeRedis();
const realIncr = limiter.incr.bind(limiter);
limiter.incr = async (key: string) => {
  if (key.includes(`|${DOWN_IP}|`)) throw new Error('upstash down');
  return realIncr(key);
};

let currentHeaders = new Headers();
vi.mock('next/headers', () => ({
  headers: async () => currentHeaders,
}));
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

vi.mock('@/lib/store', () => ({
  getStore: () => ({ getTransfer, getTransferDecrypted, legacyTenantOf: async () => null }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft }) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner }) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
// Program-Fix 45: the limiter-down ops signal stays hermetic (never the real outbox).
const raiseLimiterDownAlert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/limiter-alert', () => ({ raiseLimiterDownAlert }));
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({ isPayoutEditable: async () => false }),
}));

import PayPage from '@/app/pay/[transferId]/page';
import { PAY_PAGE_IP_LIMIT, PAY_PAGE_SCOPE } from '@/lib/ip-rate-limit';

const FULL = {
  licensedEntity: 'Acme Money Services LLC',
  licenseIds: ['NMLS 000000'],
  phone: '+1 800 555 0100',
  website: 'https://acme.example',
  stateRegulator: { name: 'State Department of Financial Services' },
};
const CONFIGURED: Partner = { id: 'p_acme', displayName: 'Acme Money Co', supportConfig: { disclosure: FULL } } as unknown as Partner;
const BARE: Partner = { id: 'p_bare', displayName: 'Bare Remit' } as unknown as Partner;
const DEFAULT: Partner = { id: 'default', name: 'SmartRemit Default' } as unknown as Partner;
const PARTNERS: Record<string, Partner> = { p_acme: CONFIGURED, p_bare: BARE, default: DEFAULT };

const ID = 'Ab_9-Cd_E-fG0hIjKlMnOp';
let current: Partial<Transfer> = {};
let decryptedDest = '';

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 2.99, totalChargeUsd: 202.99, fxRate: 83.23456,
    amountInr: 16646.91, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: '2026-05-30T00:00:00Z', sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'p_acme',
    amountSource: 200, feeSource: 2.99, totalChargeSource: 202.99, ...o,
  };
}

async function render(transferId = ID): Promise<string> {
  currentHeaders = new Headers({ 'x-forwarded-for': '198.51.100.9' });
  return renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId }) }));
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
  current = {};
  decryptedDest = '';
  limiter.dump.clear();
  getTransfer.mockReset();
  getTransferDecrypted.mockReset();
  getDraft.mockReset();
  getPartner.mockReset();
  getTransfer.mockImplementation(async (id) => (id === ID ? makeTransfer({ id, ...current }) : null));
  getTransferDecrypted.mockImplementation(async (id) =>
    id === ID ? makeTransfer({ id, ...current, payoutDestination: decryptedDest }) : null,
  );
  getDraft.mockResolvedValue(null);
  getPartner.mockImplementation(async (id) => PARTNERS[id] ?? null);
});
afterAll(() => vi.useRealTimers());

describe('/pay/[transferId] — Reg E pre-payment disclosure', { retry: 0 }, () => {
  it('a configured partner: every (b)(1) field, the provider identity, the rights links and the draft badge', async () => {
    const html = await render();
    expect(html).toContain('Before you pay');
    expect(html).toContain('Draft disclosure — for counsel review');
    expect(html).toContain('Transfer amount');
    expect(html).toContain('Transfer fees');
    expect(html).toContain('$2.99');
    expect(html).toContain('1 USD = 83.2346 INR');
    expect(html).toContain('Total to recipient');
    expect(html).toContain('₹16,646.91');
    expect(html).toContain('Within 1 business day of payment (estimate)');
    expect(html).toContain('fees charged by the recipient’s bank and foreign taxes');
    expect(html).toContain('Acme Money Services LLC');
    expect(html).toContain('NMLS 000000');
    expect(html).toContain('href="https://acme.example"');
    expect(html).toContain('State Department of Financial Services');
    expect(html).toContain('href="/legal#remittance-rights"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('data-disclosure-version="disclosure-draft-2026-09-23"');
  });

  it('the existing summary is unchanged (same rows and values)', async () => {
    const html = await render();
    for (const s of ['Secure payment', 'Recipient', 'They receive', 'Amount', 'Fee', 'Total charge', 'Paying with', 'Bank transfer', '$202.99']) {
      expect(html).toContain(s);
    }
  });

  it('the default (demo) tenant: the demo note, never SmartRemit as the provider', async () => {
    current = { partnerId: 'default' };
    const html = await render();
    expect(html).toContain('Before you pay');
    expect(html).toContain('(Demonstration: no licensed partner is attached and no real money moves.)');
    expect(html).not.toContain('>Provider<');
  });

  it('an unconfigured real partner: its brand and the pending line', async () => {
    current = { partnerId: 'p_bare' };
    const html = await render();
    expect(html).toContain('>Provider<');
    expect(html).toContain('Bare Remit');
    expect(html).toContain('Partner licensing details pending (draft).');
  });

  it('B2B: no Reg E disclosure', async () => {
    current = { transferType: 'b2b' };
    const html = await render();
    expect(html).toContain('Secure payment');
    expect(html).not.toContain('Before you pay');
    expect(html).not.toContain('I have read this disclosure.');
  });

  it('a transfer no longer awaiting payment shows no pre-payment disclosure', async () => {
    current = { status: 'paid' };
    const html = await render();
    expect(html).not.toContain('Before you pay');
  });

  it('the single-step form carries the acknowledgement checkbox (unticked)', async () => {
    decryptedDest = 'IFSC:HDFC0001234|ACCT:123456789012';
    const html = await render();
    expect(html).toContain('I have read this disclosure.');
    const box = html.match(/<input[^>]*name="disclosureAck"[^>]*>/)?.[0] ?? '';
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain('checked');
  });

  it('a draft link uses the quote rate', async () => {
    getTransfer.mockResolvedValue(null);
    getTransferDecrypted.mockResolvedValue(null);
    getDraft.mockResolvedValue({
      senderPhone: '15551234567',
      partnerId: 'p_acme',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 84.5, amountInr: 8450, feeSource: 0, totalChargeSource: 100 },
    } as unknown as Draft);
    const html = await render();
    expect(html).toContain('1 USD = 84.50 INR');
    expect(html).toContain('₹8,450.00');
  });
});
