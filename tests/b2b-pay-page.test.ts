import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { B2bInvoice, Partner, Seller } from '@/lib/types';
import { countryForPhone } from '@/lib/partner-currency';
import { fakeRedis } from './helpers';

/**
 * Program-Fix 23 — /pay/b2b/[invoiceId]. A sibling of b2b-crossborder-pay.test.ts
 * so these hoisted vi.mocks never touch that PGlite suite.
 *
 * Every non-payable state renders ONE generic message with DEFAULT branding, so
 * a dead link reveals neither the partner nor the bill's state. The FX-down
 * catch is the one exception: it serves a live, payable bill, so it keeps the
 * partner's branding (review amendment, SHOULD). The per-IP guard runs before
 * the invoice read and fails open.
 */

const THROTTLED_IP = '203.0.113.7';
const FRESH_IP = '198.51.100.9';
const DOWN_IP = '192.0.2.44';
const T0 = 1_750_000_000_000;
const INACTIVE = 'This bill is no longer active';

const limiter = fakeRedis();
const realIncr = limiter.incr.bind(limiter);
limiter.incr = async (key: string) => {
  if (key.includes(`|${DOWN_IP}|`)) throw new Error('upstash down');
  return realIncr(key);
};

let currentHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => currentHeaders }));
vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor() {
      return limiter;
    }
  },
}));

const getB2bInvoice = vi.fn<(id: string) => Promise<B2bInvoice | null>>();
const getSellerById = vi.fn<(id: string) => Promise<Seller | null>>();
const getPartner = vi.fn<(id: string) => Promise<Partner | null>>();
const getFxRates = vi.fn();
const resolveCheckoutBillQuote = vi.fn();

vi.mock('@/lib/store', () => ({ getStore: () => ({ getB2bInvoice, getSellerById }) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner }) }));
vi.mock('@/lib/rate', () => ({ getFxRates: (...a: unknown[]) => getFxRates(...a) }));
vi.mock('@/lib/b2b-quote-store', () => ({
  getB2bQuoteStore: () => ({}),
  resolveCheckoutBillQuote: (...a: unknown[]) => resolveCheckoutBillQuote(...a),
}));

import BillPage from '@/app/pay/b2b/[invoiceId]/page';
import { PAY_PAGE_IP_LIMIT, PAY_PAGE_SCOPE } from '@/lib/ip-rate-limit';

const PARTNER: Partner = { id: 'p_acme', displayName: 'Acme Money Co' } as unknown as Partner;

function invoice(o: Partial<B2bInvoice> = {}): B2bInvoice {
  return {
    id: 'inv_Ab_9-Cd_E-fG0hIjKlMnOp', partnerId: 'p_acme', businessName: 'Seller Ltd',
    buyerPhone: '15551234567', // US buyer ⇒ USD, BANK_FIELDS_BY_COUNTRY.US exists
    lineItems: [], amountUsd: 12, currency: 'USD',
    sellerId: 's_1', invoicedAmount: 1000, invoicedCurrency: 'INR',
    status: 'unpaid', createdAt: '2026-06-01T00:00:00Z', ...o,
  };
}
function seller(o: Partial<Seller> = {}): Seller {
  return {
    id: 's_1', partnerId: 'p_acme', phone: '919876543210', businessName: 'Seller Ltd',
    country: 'IN', currency: 'INR', payoutMethod: 'bank', status: 'active',
    kycReviewState: 'cleared', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...o,
  } as Seller;
}

async function render(invoiceId: string, ip: string | null): Promise<string> {
  currentHeaders = ip ? new Headers({ 'x-forwarded-for': ip }) : new Headers();
  return renderToStaticMarkup(await BillPage({ params: Promise.resolve({ invoiceId }) }));
}

const LIVE = 'inv_Ab_9-Cd_E-fG0hIjKlMnOp';

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
  for (const m of [getB2bInvoice, getSellerById, getPartner, getFxRates, resolveCheckoutBillQuote]) m.mockReset();
  getB2bInvoice.mockImplementation(async (id) => (id === LIVE ? invoice() : null));
  getSellerById.mockImplementation(async (id) => (id === 's_1' ? seller() : null));
  getPartner.mockImplementation(async (id) => (id === 'p_acme' ? PARTNER : null));
  getFxRates.mockResolvedValue({ toUsd: 1, rates: {} });
  resolveCheckoutBillQuote.mockResolvedValue({
    buyerCurrency: 'USD', sellerCurrency: 'INR', buyerPrincipal: 12, sellerAmount: 1000,
    fxRate: 83.3, feeBuyer: 1, buyerTotal: 13,
  });
  limiter.dump.clear();
  limiter.dump.set(`iprl|${PAY_PAGE_SCOPE}|${THROTTLED_IP}|${Math.floor(T0 / 60_000)}`, String(PAY_PAGE_IP_LIMIT));
});
afterAll(() => vi.useRealTimers());

const OLD_MESSAGES = ['already been settled', 'accept a payment from your country', 'no longer payable'];

function expectGenericDead(html: string) {
  expect(html).toContain(INACTIVE);
  expect(html).toContain('SmartRemit');
  expect(html).not.toContain('Acme Money Co');
  expect(html).not.toContain('Seller Ltd');
  expect(html).not.toContain('Pay your bill');
  for (const m of OLD_MESSAGES) expect(html).not.toContain(m);
}

describe('/pay/b2b/[invoiceId] — payable bill (sanity for the mocks)', () => {
  it('renders "Pay your bill" with the PARTNER brand and the seller name', async () => {
    const html = await render(LIVE, FRESH_IP);
    expect(html).toContain('Pay your bill');
    expect(html).toContain('Acme Money Co');
    expect(html).toContain('Seller Ltd');
    expect(getPartner).toHaveBeenCalledWith('p_acme');
    // Program-Fix 15 PR B: a B2B bill is not a consumer remittance (§1005.30) — no Reg E card or acknowledgement.
    expect(html).not.toContain('Before you pay');
    expect(html).not.toContain('I have read this disclosure.');
  });
});

describe('/pay/b2b/[invoiceId] — one message for every dead bill (Program-Fix 23)', () => {
  it('missing invoice', async () => {
    expectGenericDead(await render('inv_doesnotexist', FRESH_IP));
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('not a cross-border bill (no sellerId)', async () => {
    getB2bInvoice.mockResolvedValue(invoice({ sellerId: undefined }));
    expectGenericDead(await render(LIVE, FRESH_IP));
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('settled invoice (status paid) — no longer says "already been settled"', async () => {
    getB2bInvoice.mockResolvedValue(invoice({ status: 'paid' }));
    expectGenericDead(await render(LIVE, FRESH_IP));
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('voided invoice', async () => {
    getB2bInvoice.mockResolvedValue(invoice({ status: 'voided' }));
    expectGenericDead(await render(LIVE, FRESH_IP));
  });

  it('unsupported buyer country — no longer says "can\'t accept a payment from your country"', async () => {
    expect(countryForPhone('99900000000')).toBeUndefined();
    getB2bInvoice.mockResolvedValue(invoice({ buyerPhone: '99900000000' }));
    expectGenericDead(await render(LIVE, FRESH_IP));
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('inactive seller — no longer says "no longer payable"', async () => {
    getSellerById.mockResolvedValue(seller({ status: 'suspended' }));
    expectGenericDead(await render(LIVE, FRESH_IP));
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('seller from another tenant', async () => {
    getSellerById.mockResolvedValue(seller({ partnerId: 'p_other' }));
    expectGenericDead(await render(LIVE, FRESH_IP));
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('third-currency bill (neither seller nor buyer currency)', async () => {
    getB2bInvoice.mockResolvedValue(invoice({ invoicedCurrency: 'GBP' })); // seller INR, buyer USD
    expectGenericDead(await render(LIVE, FRESH_IP));
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('every dead sheet is byte-identical', async () => {
    const missing = await render('inv_doesnotexist', FRESH_IP);
    getB2bInvoice.mockResolvedValue(invoice({ status: 'paid' }));
    const settled = await render(LIVE, FRESH_IP);
    getB2bInvoice.mockResolvedValue(invoice());
    getSellerById.mockResolvedValue(seller({ status: 'suspended' }));
    const inactiveSeller = await render(LIVE, FRESH_IP);
    expect(settled).toBe(missing);
    expect(inactiveSeller).toBe(missing);
  });
});

describe('/pay/b2b/[invoiceId] — FX down keeps the partner brand (a live, payable bill)', () => {
  it('renders the distinct retry message WITH partner branding', async () => {
    getFxRates.mockRejectedValue(new Error('provider down'));
    const html = await render(LIVE, FRESH_IP);
    expect(html).toContain('please try again shortly');
    expect(html).toContain('Acme Money Co');
    expect(html).not.toContain(INACTIVE);
    expect(html).not.toContain('Pay your bill');
  });
});

describe('/pay/b2b/[invoiceId] — per-IP guard before the invoice read', () => {
  it('throttled: generic sheet, default brand, getB2bInvoice never called, byte-equal to missing', async () => {
    const throttled = await render(LIVE, THROTTLED_IP);
    expectGenericDead(throttled);
    expect(getB2bInvoice).not.toHaveBeenCalled();
    expect(getSellerById).not.toHaveBeenCalled();
    expect(getPartner).not.toHaveBeenCalled();
    const missing = await render('inv_doesnotexist', FRESH_IP);
    expect(throttled).toBe(missing);
  });

  it('limiter down (Redis throws): the payable bill still renders — fail open', async () => {
    const html = await render(LIVE, DOWN_IP);
    expect(html).toContain('Pay your bill');
    expect(html).toContain('Acme Money Co');
  });

  it('no forwarded header (IP unknown): renders normally', async () => {
    expect(await render(LIVE, null)).toContain('Pay your bill');
  });
});
