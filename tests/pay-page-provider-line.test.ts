import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, Partner, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { approvedDisclosureConfig } from './helpers-live';

/**
 * Fix pack 4 T18 (C22 a, R16): the one approved provider line on
 * /pay/[transferId]. Shown under the 'Secure payment' heading only when the
 * OWNER's (transfer owner or draft tenant) provider block is approved; every
 * other page (default tenant, pending, unapproved, no regulator, a value naming
 * the platform, a failed owner read) and every dead-link sheet carry no line.
 * Same harness as tests/pay-page-disclosure.test.ts.
 */

const T0 = Date.now();
const LINE = 'Payments by Acme Money Services LLC, licensed by State Department of Financial Services';

const limiter = fakeRedis();
let currentHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => currentHeaders }));
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
// consent on file (pack 6 P8): the E-SIGN tick is tested in pay-page-esign.test.ts
vi.mock('@/lib/esign', async (o) => ({ ...(await o<typeof import('@/lib/esign')>()), readEsignConsentNeeded: async () => false }));
vi.mock('@/lib/pay-link', () => ({ transferMintedFromDraft: async () => null }));
const raiseLimiterDownAlert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/limiter-alert', () => ({ raiseLimiterDownAlert }));
const linkTransfer = vi.hoisted(() => ({ value: false }));
// Fix pack 5 T32 (sweep): the fake db cannot answer the originator view (the transfer-repo mock
// has no originatorExempt, so the real view fell into its read-error branch with a TypeError).
// These cases are not about the travel rule: the page gets NO_ORIGINATOR_FIELDS.
vi.mock('@/lib/originator-info', async (orig) => {
  const real = await orig<typeof import('@/lib/originator-info')>();
  return { ...real, readOriginatorView: async () => real.NO_ORIGINATOR_FIELDS };
});
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({
    isPayoutEditable: async () => false,
    isPaymentLinkTransfer: async () => linkTransfer.value,
    getDisclosureSnapshot: async () => null, // pack 6 T11: the paid page's receipt read
    isPartnerApiMinted: async () => false,
    recipientIdentityMissing: async () => false,
  }),
}));
vi.mock('@/lib/recipient-legal-name', async (orig) => ({
  ...(await orig<typeof import('@/lib/recipient-legal-name')>()),
  readLegalNameView: async () => ({ legalNameRequired: false, legalNameOnFile: true }),
}));
vi.mock('@/lib/rewards/read', () => ({ transferRewardOrNull: vi.fn().mockResolvedValue(null) }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: () => {} }),
}));

import PayPage from '@/app/pay/[transferId]/page';

const partner = (id: string, disclosure?: unknown): Partner =>
  ({ id, displayName: `Partner ${id}`, ...(disclosure ? { supportConfig: { disclosure } } : {}) }) as unknown as Partner;

const ID = 'Ab_9-Cd_E-fG0hIjKlMnOp';
let current: Partial<Transfer> = {};
let partners: Record<string, Partner | Error> = {};

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 2.99, totalChargeUsd: 202.99, fxRate: 83.23456,
    amountInr: 16646.91, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date(T0 - 60_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'p_acme',
    amountSource: 200, feeSource: 2.99, totalChargeSource: 202.99, ...o,
  };
}

const draftOf = (partnerId: string): Draft =>
  ({
    senderPhone: '15551234567',
    partnerId,
    recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
    amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 84.5, amountInr: 8450, feeSource: 0, totalChargeSource: 100 },
  }) as unknown as Draft;

async function render(transferId = ID): Promise<string> {
  currentHeaders = new Headers({ 'x-forwarded-for': '198.51.100.9' });
  return renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId }) }));
}

const lineCount = (html: string) => html.split('data-testid="provider-line"').length - 1;
const lineText = (html: string) => html.match(/<p data-testid="provider-line"[^>]*>([^<]*)<\/p>/)?.[1];

beforeEach(() => {
  current = {};
  linkTransfer.value = false;
  partners = { p_acme: partner('p_acme', approvedDisclosureConfig()) };
  limiter.dump.clear();
  getTransfer.mockReset();
  getTransferDecrypted.mockReset();
  getDraft.mockReset();
  getPartner.mockReset();
  getTransfer.mockImplementation(async (id) => (id === ID ? makeTransfer({ id, ...current }) : null));
  getTransferDecrypted.mockImplementation(async (id) => (id === ID ? makeTransfer({ id, ...current }) : null));
  getDraft.mockResolvedValue(null);
  getPartner.mockImplementation(async (id) => {
    const p = partners[id];
    if (p instanceof Error) throw p;
    return p ?? null;
  });
});
afterAll(() => vi.restoreAllMocks());

describe('/pay/[transferId] provider line (pack 4 T18, C22 a)', { retry: 0 }, () => {
  it('approved owner, awaiting transfer -> exactly one provider-line right after the Secure payment h1', async () => {
    const html = await render();
    expect(lineCount(html)).toBe(1);
    expect(lineText(html)).toBe(LINE);
    const h1Close = html.indexOf('Secure payment</h1>');
    const line = html.indexOf('data-testid="provider-line"');
    expect(h1Close).toBeGreaterThan(-1);
    expect(h1Close).toBeLessThan(line);
    expect(line).toBeLessThan(html.indexOf('Recipient'));
    // Nothing but the line sits between the heading and it.
    expect(html.slice(h1Close + 'Secure payment</h1>'.length, line)).toBe('<p ');
    expect(html).not.toContain('sh-page-sub');
  });

  it('approved draft tenant -> the line names the draft tenant', async () => {
    partners = {
      p_acme: partner('p_acme'),
      p_draft: partner('p_draft', approvedDisclosureConfig({ entity: 'Draft Tenant Money LLC', regulator: 'Draft State Banking Department' })),
    };
    getTransfer.mockResolvedValue(null);
    getTransferDecrypted.mockResolvedValue(null);
    getDraft.mockResolvedValue(draftOf('p_draft'));
    const html = await render();
    expect(lineCount(html)).toBe(1);
    expect(lineText(html)).toBe('Payments by Draft Tenant Money LLC, licensed by Draft State Banking Department');
  });

  it('a paid transfer of an approved owner -> the line still shows on the Secure payment sheet', async () => {
    current = { status: 'paid' };
    const html = await render();
    expect(html).toContain('Payment complete');
    expect(lineCount(html)).toBe(1);
    expect(lineText(html)).toBe(LINE);
  });

  it('configured but unapproved, pending, demo/default, no regulator, a platform name, owner read throws -> no line', async () => {
    const stampless = { ...approvedDisclosureConfig() } as Record<string, unknown>;
    delete stampless.approval;
    const cases: Array<[string, Record<string, Partner | Error>, Partial<Transfer>]> = [
      ['unapproved', { p_acme: partner('p_acme', stampless) }, {}],
      ['pending', { p_acme: partner('p_acme') }, {}],
      ['default', { default: { id: 'default', name: 'SmartRemit Default' } as unknown as Partner }, { partnerId: 'default' }],
      ['no regulator', { p_acme: partner('p_acme', approvedDisclosureConfig({ regulator: '' })) }, {}],
      ['platform name', { p_acme: partner('p_acme', approvedDisclosureConfig({ entity: 'SmartRemit Payments LLC' })) }, {}],
      ['read throws', { p_acme: Object.assign(new Error('connect'), { code: 'ECONNRESET' }) }, {}],
    ];
    for (const [name, ps, t] of cases) {
      partners = ps;
      current = t;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = await render();
      warn.mockRestore();
      expect(html, name).not.toContain('provider-line');
      expect(html, name).not.toContain('Payments by');
    }
  });

  it('a cancelled transfer or a payment-link transfer (dead-link sheet) of an approved owner -> no line', async () => {
    current = { status: 'cancelled' };
    const cancelled = await render();
    expect(cancelled).toContain('This link is no longer active');
    expect(cancelled).not.toContain('provider-line');
    current = {};
    linkTransfer.value = true;
    const link = await render();
    expect(link).toContain('This link is no longer active');
    expect(link).not.toContain('Payments by');
    // Byte-equal to the not-found sheet.
    linkTransfer.value = false;
    expect(await render('unknown-id-0000000000')).toBe(link);
  });
});
