import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, Partner, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';

/**
 * Program-Fix 23 — /pay/[transferId] is guarded by a fail-open per-IP throttle
 * that runs BEFORE any ledger read. Over budget ⇒ the generic "inactive" sheet
 * with default branding, byte-equal to the not-found render, and the stores
 * are never touched. Limiter down ⇒ the page renders normally. Legacy 8-char
 * ids still resolve (no shape check on the read path).
 *
 * One mocked Upstash client per file (ip-rate-limit.ts caches it), so the
 * fake keys its behaviour off the IP inside the key: THROTTLED_IP is over
 * budget, FRESH_IP has a full budget, DOWN_IP makes incr throw.
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
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({ isPayoutEditable: async () => false }),
}));

import PayPage from '@/app/pay/[transferId]/page';
import { PAY_PAGE_IP_LIMIT, PAY_PAGE_SCOPE } from '@/lib/ip-rate-limit';

const PARTNER: Partner = { id: 'p_acme', displayName: 'Acme Money Co' } as unknown as Partner;

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: '2026-05-30T00:00:00Z', sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'p_acme',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

async function render(transferId: string, ip: string | null): Promise<string> {
  currentHeaders = ip ? new Headers({ 'x-forwarded-for': ip }) : new Headers();
  return renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId }) }));
}

const NEW_ID = 'Ab_9-Cd_E-fG0hIjKlMnOp'; // 22-char base64url shape
const LEGACY_ID = 'k3j9x2q1'; // pre-fix 8-char base36 shape

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
  getTransfer.mockReset();
  getTransferDecrypted.mockReset();
  getDraft.mockReset();
  getPartner.mockReset();
  getTransfer.mockImplementation(async (id) => (id === NEW_ID || id === LEGACY_ID ? makeTransfer({ id }) : null));
  getTransferDecrypted.mockImplementation(async (id) => (id === NEW_ID || id === LEGACY_ID ? makeTransfer({ id }) : null));
  getDraft.mockResolvedValue(null);
  getPartner.mockImplementation(async (id) => (id === 'p_acme' ? PARTNER : null));
  // Put THROTTLED_IP exactly at the limit: the NEXT render is the 61st in the window.
  limiter.dump.clear();
  const window = Math.floor(T0 / 60_000);
  limiter.dump.set(`iprl|${PAY_PAGE_SCOPE}|${THROTTLED_IP}|${window}`, String(PAY_PAGE_IP_LIMIT));
});
afterAll(() => vi.useRealTimers());

describe('/pay/[transferId] — guard runs before any read (Program-Fix 23)', () => {
  it('a known transfer renders "Secure payment" with its amounts and the PARTNER brand from a fresh IP', async () => {
    const html = await render(NEW_ID, FRESH_IP);
    expect(html).toContain('Secure payment');
    expect(html).toContain('Total charge');
    expect(html).toContain('Acme Money Co');
    expect(html).not.toContain('This link is no longer active');
    expect(getTransfer).toHaveBeenCalledWith(NEW_ID);
  });

  it('over budget: renders the generic sheet with DEFAULT branding and never reads the ledger or the draft store', async () => {
    const html = await render(NEW_ID, THROTTLED_IP);
    expect(html).toContain('This link is no longer active');
    expect(html).toContain('SmartRemit');
    expect(html).not.toContain('Acme Money Co');
    expect(html).not.toContain('Total charge');
    expect(html).not.toContain('Mom');
    expect(getTransfer).not.toHaveBeenCalled();
    expect(getTransferDecrypted).not.toHaveBeenCalled();
    expect(getDraft).not.toHaveBeenCalled();
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('the throttled sheet is byte-equal to the not-found sheet', async () => {
    const throttled = await render(NEW_ID, THROTTLED_IP);
    const notFound = await render('zzzzzzzz', FRESH_IP);
    expect(notFound).toContain('This link is no longer active');
    expect(throttled).toBe(notFound);
  });

  it('a throttled IP is still throttled for a dead id (no oracle: same sheet either way)', async () => {
    const dead = await render('doesnotexist', THROTTLED_IP);
    const live = await render(NEW_ID, THROTTLED_IP);
    expect(dead).toBe(live);
  });

  it('limiter down (Redis throws): a known transfer still renders "Secure payment" — the guard failed open', async () => {
    const html = await render(NEW_ID, DOWN_IP);
    expect(html).toContain('Secure payment');
    expect(html).toContain('Total charge');
    expect(html).toContain('Acme Money Co');
  });

  it('no forwarded header (IP unknown): renders normally, fail-open', async () => {
    const html = await render(NEW_ID, null);
    expect(html).toContain('Secure payment');
  });

  it('a legacy 8-character id that exists renders the payment sheet (no shape check)', async () => {
    const html = await render(LEGACY_ID, FRESH_IP);
    expect(html).toContain('Secure payment');
    expect(html).toContain('Total charge');
    expect(getTransfer).toHaveBeenCalledWith(LEGACY_ID);
  });

  it('a fresh IP stays under budget across 60 renders, and the 61st is throttled', async () => {
    const ip = '198.51.100.200';
    for (let i = 0; i < 60; i++) expect(await render(NEW_ID, ip)).toContain('Secure payment');
    expect(await render(NEW_ID, ip)).toContain('This link is no longer active');
  });
});
