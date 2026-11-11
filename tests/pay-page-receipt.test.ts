import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, Partner, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { approvedDisclosureConfig } from './helpers-live';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import {
  buildDisclosureSnapshot,
  buildReceiptDisclosure,
  type DisclosureSnapshotV1,
} from '@/lib/remittance-disclosure';
import {
  PAY_RECEIPT_CANCELLED_CHARGED_COPY,
  PAY_RECEIPT_NOT_COMPLETED_COPY,
  PAY_RECEIPT_PRINT_HINT,
  PAY_RECEIPT_REFUNDED_COPY,
} from '@/lib/pay-outcome';
import { DISCLOSURE_LABELS } from '@/lib/legal/disclosure-drafts';

/**
 * Fix pack 6 T11 (P11): /pay/<22-char id> once the row is no longer awaiting payment. The
 * status table (src/lib/pay-receipt-state.ts) picks the sheet; paid and delivered rows gain a
 * printable Reg E receipt (snapshot first, else the live owner configuration), held rows show
 * the neutral 'Processing' label. Same harness as tests/pay-page-provider-line.test.ts.
 */

const T0 = Date.now();
const LIVE_LINE = 'Payments by Acme Money Services LLC, licensed by State Department of Financial Services';
const SNAP_LINE = 'Payments by Snapshot Money LLC, licensed by Snapshot Banking Department';

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
const getDisclosureSnapshot = vi.hoisted(() => vi.fn<(id: string, partnerId: string) => Promise<unknown>>());
const isPaymentLinkTransfer = vi.hoisted(() => vi.fn<(id: string) => Promise<boolean>>());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@/lib/store', () => ({
  getStore: () => ({ getTransfer, getTransferDecrypted, legacyTenantOf: async () => null }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft }) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner }) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/log', async (o) => ({ ...(await o<typeof import('@/lib/log')>()), logWarn }));
// consent on file (pack 6 P8): the E-SIGN tick is tested in pay-page-esign.test.ts
vi.mock('@/lib/esign', async (o) => ({ ...(await o<typeof import('@/lib/esign')>()), readEsignConsentNeeded: async () => false }));
vi.mock('@/lib/pay-link', () => ({ transferMintedFromDraft: async () => null }));
const raiseLimiterDownAlert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/limiter-alert', () => ({ raiseLimiterDownAlert }));
vi.mock('@/lib/originator-info', async (orig) => {
  const real = await orig<typeof import('@/lib/originator-info')>();
  return { ...real, readOriginatorView: async () => real.NO_ORIGINATOR_FIELDS };
});
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({
    isPayoutEditable: async () => false,
    isPaymentLinkTransfer,
    isPartnerApiMinted: async () => false,
    recipientIdentityMissing: async () => false,
    getDisclosureSnapshot,
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
// The props PayForm receives (the real form still renders).
const payFormProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('@/app/pay/[transferId]/pay-form', async (orig) => {
  const real = await orig<typeof import('@/app/pay/[transferId]/pay-form')>();
  return {
    ...real,
    PayForm: (props: Parameters<typeof real.PayForm>[0]) => {
      payFormProps.last = props as unknown as Record<string, unknown>;
      return real.PayForm(props);
    },
  };
});

import PayPage from '@/app/pay/[transferId]/page';

// A function, so the reads after a render are not narrowed to the null assigned before it.
const lastProps = (): Record<string, unknown> | null => payFormProps.last;

const partner = (id: string, disclosure?: unknown): Partner =>
  ({ id, displayName: `Partner ${id}`, ...(disclosure ? { supportConfig: { disclosure } } : {}) }) as unknown as Partner;

const ID = 'Ab_9-Cd_E-fG0hIjKlMnOp';
const LEGACY_ID = 'ab12cd34';
const PAID_AT = new Date(T0 - 5 * 60_000).toISOString();
const SENDER = '15551234567';
const RECIPIENT_PHONE = '919876543210';
let current: Partial<Transfer> = {};
let partners: Record<string, Partner | Error> = {};

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER, amountUsd: 200, feeUsd: 2.99, totalChargeUsd: 202.99, fxRate: 83.23456,
    amountInr: 16646.91, recipientName: 'Mom', recipientPhone: RECIPIENT_PHONE,
    payoutMethod: 'bank', payoutDestination: '', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'paid', paidAt: PAID_AT,
    createdAt: new Date(T0 - 60 * 60_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'p_acme',
    amountSource: 200, feeSource: 2.99, totalChargeSource: 202.99, ...o,
  };
}

/** A snapshot built by the REAL writer, with figures different from the row's. */
function snapshotOf(o: { surface?: 'transfer' | 'link'; approved?: boolean } = {}): DisclosureSnapshotV1 {
  const cfg = approvedDisclosureConfig({ entity: 'Snapshot Money LLC', regulator: 'Snapshot Banking Department' });
  const resolved = resolvePartnerDisclosure(partner('p_acme', cfg));
  const t = makeTransfer({ id: ID, amountSource: 150, feeSource: 4.5, totalChargeSource: 154.5, amountInr: 12345.67, fxRate: 82.3 });
  const snap = buildDisclosureSnapshot({
    transfer: t,
    disclosure: resolved,
    input: { version: 'v', shownHash: null, acknowledgedAt: T0 - 6 * 60_000, surface: o.surface ?? 'transfer' },
    now: T0,
  });
  return o.approved === false ? { ...snap, provider: { ...snap.provider, approved: false } } : snap;
}

async function render(transferId = ID): Promise<string> {
  currentHeaders = new Headers({ 'x-forwarded-for': '198.51.100.9' });
  return renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId }) }));
}

const lineCount = (html: string) => html.split('data-testid="provider-line"').length - 1;
const lineText = (html: string) => html.match(/<p data-testid="provider-line"[^>]*>([^<]*)<\/p>/)?.[1];
// React escapes the apostrophe in text.
const HINT_HTML = PAY_RECEIPT_PRINT_HINT.replace(/'/g, '&#x27;');
const receiptOf = (html: string) => {
  const i = html.indexOf('data-testid="pay-receipt"');
  return i === -1 ? '' : html.slice(i, html.indexOf('</section>', i));
};

beforeEach(() => {
  current = {};
  partners = { p_acme: partner('p_acme', approvedDisclosureConfig()) };
  limiter.dump.clear();
  getTransfer.mockReset();
  getTransferDecrypted.mockReset();
  getDraft.mockReset();
  getPartner.mockReset();
  getDisclosureSnapshot.mockReset();
  isPaymentLinkTransfer.mockReset();
  logWarn.mockReset();
  payFormProps.last = null;
  getTransfer.mockImplementation(async (id) => (id === ID || id === LEGACY_ID ? makeTransfer({ id, ...current }) : null));
  getTransferDecrypted.mockImplementation(async (id) => (id === ID || id === LEGACY_ID ? makeTransfer({ id, ...current }) : null));
  getDraft.mockResolvedValue(null);
  getPartner.mockImplementation(async (id) => {
    const p = partners[id];
    if (p instanceof Error) throw p;
    return p ?? null;
  });
  getDisclosureSnapshot.mockResolvedValue(null);
  isPaymentLinkTransfer.mockResolvedValue(false);
});
afterAll(() => vi.restoreAllMocks());

// The pre-T11 markup of a paid legacy-id row and of a paid sandbox row (captured on the red
// run against the unchanged page): the success sheet, no receipt.
const LEGACY_PAID_HTML =
  "<link rel=\"preload\" as=\"image\" href=\"/brand/smartremit-mark.png\"/><main class=\"flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 font-[-apple-system,BlinkMacSystemFont,&#x27;Segoe_UI&#x27;,sans-serif] text-[#e9edef]\"><div class=\"w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7\"><div class=\"mb-1 flex items-center gap-2 text-xl leading-normal font-extrabold text-[#25d366]\"><img src=\"/brand/smartremit-mark.png\" alt=\"\" width=\"26\" height=\"26\" class=\"h-[26px] w-[26px] flex-none\"/>SmartRemit</div><h1 class=\"mb-5 text-lg leading-normal font-semibold\">Secure payment</h1><p data-testid=\"provider-line\" class=\"-mt-3 mb-4 text-[13px] leading-normal text-[#8696a0]\">Payments by Acme Money Services LLC, licensed by State Department of Financial Services</p><div class=\"mb-5 rounded-xl bg-[#202c33] p-3.5\"><div class=\"flex justify-between py-1.5 text-sm leading-normal\"><span class=\"text-[#8696a0]\">Recipient</span><span>Mom</span></div><div class=\"flex justify-between py-1.5 text-sm leading-normal\"><span class=\"text-[#8696a0]\">They receive</span><span>₹16,646.91</span></div><div class=\"flex justify-between py-1.5 text-sm leading-normal\"><span class=\"text-[#8696a0]\">Amount</span><span>$200</span></div><div class=\"flex justify-between py-1.5 text-sm leading-normal\"><span class=\"text-[#8696a0]\">Fee</span><span>$2.99</span></div><div class=\"flex justify-between py-1.5 text-sm leading-normal\" style=\"font-weight:700\"><span class=\"text-[#8696a0]\">Total charge</span><span>$202.99</span></div><div class=\"flex justify-between py-1.5 text-sm leading-normal\"><span class=\"text-[#8696a0]\">Paying with</span><span>Bank transfer</span></div></div><p class=\"flex items-center justify-center gap-2 font-semibold text-[#25d366]\"><svg class=\"shrink-0\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M8 12.5l2.5 2.5L16 9\"></path></svg>Payment complete — money sent!</p></div></main>";
const TEST_ENV_PAID_HTML = LEGACY_PAID_HTML; // the same markup (the id is not rendered)

describe('/pay/[transferId] receipt states (pack 6 T11, P11)', { retry: 0 }, () => {
  it('paid with a parsed transfer snapshot -> Payment complete + the receipt with the SNAPSHOT figures', async () => {
    getDisclosureSnapshot.mockResolvedValue(snapshotOf());
    const html = await render();
    expect(html).toContain('Payment complete');
    const r = receiptOf(html);
    expect(r).not.toBe('');
    expect(r).toContain(DISCLOSURE_LABELS.receiptHeading);
    expect(r).toContain('$154.50');
    expect(r).not.toContain('$202.99');
    expect(r).toContain('Snapshot Money LLC');
    expect(r).toContain(ID);
    expect(getDisclosureSnapshot).toHaveBeenCalledWith(ID, 'p_acme');
    expect(html).toContain(HINT_HTML);
  });

  it('paid, no snapshot -> the receipt from the live owner config (same lines as buildReceiptDisclosure)', async () => {
    const html = await render();
    const r = receiptOf(html);
    const live = buildReceiptDisclosure(
      {
        transferType: 'b2c', status: 'paid', amountSource: 200, feeSource: 2.99, totalChargeSource: 202.99,
        sourceCurrency: 'USD', amountInr: 16646.91, destinationCurrency: 'INR', fxRate: 83.23456, paidAt: PAID_AT,
      },
      resolvePartnerDisclosure(partner('p_acme', approvedDisclosureConfig())),
      Date.now(),
    )!;
    for (const l of live.lines) {
      expect(r).toContain(l.label);
      expect(r).toContain(l.value.replace(/&/g, '&amp;'));
    }
    expect(r).toContain('Acme Money Services LLC');
    expect(r).toContain('$202.99');
  });

  it("snapshot surface 'link' -> the live receipt", async () => {
    getDisclosureSnapshot.mockResolvedValue(snapshotOf({ surface: 'link' }));
    const r = receiptOf(await render());
    expect(r).toContain('$202.99');
    expect(r).not.toContain('Snapshot Money LLC');
  });

  it('getDisclosureSnapshot throws -> live receipt, one logWarn with the error name, page still renders', async () => {
    getDisclosureSnapshot.mockRejectedValue(Object.assign(new Error('boom secret'), { name: 'NeonDbError' }));
    const html = await render();
    expect(receiptOf(html)).toContain('$202.99');
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith('pay.receipt-snapshot', 'NeonDbError', { transferId: ID });
  });

  it('provider line: snapshot approved -> the snapshot line (one); unapproved -> live; neither -> none', async () => {
    getDisclosureSnapshot.mockResolvedValue(snapshotOf());
    let html = await render();
    expect(lineCount(html)).toBe(1);
    expect(lineText(html)).toBe(SNAP_LINE);

    getDisclosureSnapshot.mockResolvedValue(snapshotOf({ approved: false }));
    html = await render();
    expect(lineCount(html)).toBe(1);
    expect(lineText(html)).toBe(LIVE_LINE);

    partners = { p_acme: partner('p_acme') };
    html = await render();
    expect(lineCount(html)).toBe(0);
  });

  it("in_review -> 'Processing' and the receipt; no completion or hold wording", async () => {
    current = { status: 'in_review', complianceStatus: 'flagged' };
    const html = await render();
    expect(html).toContain('Processing');
    expect(receiptOf(html)).not.toBe('');
    expect(html).toContain(HINT_HTML);
    for (const w of ['Payment complete', 'money sent', 'sent!', 'review', 'held', 'compliance']) expect(html, w).not.toContain(w);
  });

  it('blocked (no paidAt) -> the not-completed copy, no receipt, no Payment complete', async () => {
    current = { status: 'blocked', paidAt: undefined, complianceStatus: 'blocked' };
    const html = await render();
    expect(html).toContain(PAY_RECEIPT_NOT_COMPLETED_COPY);
    expect(html).not.toContain('pay-receipt');
    expect(html).not.toContain('Payment complete');
    expect(html).not.toContain(HINT_HTML);
    expect(getDisclosureSnapshot).not.toHaveBeenCalled();
  });

  it("refundStatus 'completed' -> the refunded copy, no receipt", async () => {
    current = { refundStatus: 'completed' };
    const html = await render();
    expect(html).toContain(PAY_RECEIPT_REFUNDED_COPY);
    expect(html).not.toContain('pay-receipt');
    expect(html).not.toContain('Payment complete');
  });

  it("in_review with complianceStatus 'blocked' -> 'Processing' only, no receipt, no hint", async () => {
    current = { status: 'in_review', complianceStatus: 'blocked' };
    const html = await render();
    expect(html).toContain('Processing');
    expect(html).not.toContain('pay-receipt');
    expect(html).not.toContain(HINT_HTML);
    expect(html).not.toContain('Payment complete');
  });

  it("paid with fundingState 'returned' -> 'Processing' only, never 'Nothing was charged'", async () => {
    current = { fundingState: 'returned' };
    const html = await render();
    expect(html).toContain('Processing');
    expect(html).not.toContain('pay-receipt');
    expect(html).not.toContain('Nothing was charged');
    expect(html).not.toContain('Payment complete');
  });

  it('cancelled 22-char row with paidAt -> the cancelled-charged copy, no receipt, no form, no Payment complete', async () => {
    current = { status: 'cancelled' };
    const html = await render();
    expect(html).toContain(PAY_RECEIPT_CANCELLED_CHARGED_COPY);
    expect(html).not.toContain('pay-receipt');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Payment complete');
    expect(html).not.toContain('provider-line');
    expect(getDisclosureSnapshot).not.toHaveBeenCalled();
  });

  it("cancelled with refundStatus 'completed' -> the refunded copy", async () => {
    current = { status: 'cancelled', refundStatus: 'completed' };
    const html = await render();
    expect(html).toContain(PAY_RECEIPT_REFUNDED_COPY);
    expect(getDisclosureSnapshot).not.toHaveBeenCalled();
  });

  it('cancelled, never charged -> the dead-link sheet byte-equal to not-found, no link query', async () => {
    current = { status: 'cancelled', paidAt: undefined };
    const html = await render();
    expect(html).toBe(await render('unknown-id-0000000000'));
    expect(isPaymentLinkTransfer).not.toHaveBeenCalled();
    expect(getDisclosureSnapshot).not.toHaveBeenCalled();
  });

  it('a cancelled payment-link transfer that was charged -> the dead-link sheet', async () => {
    current = { status: 'cancelled' };
    isPaymentLinkTransfer.mockResolvedValue(true);
    const html = await render();
    expect(html).toBe(await render('unknown-id-0000000000'));
    expect(getDisclosureSnapshot).not.toHaveBeenCalled();
  });

  it("environment 'test' paid 22-char row -> today's sheet byte-identical, no snapshot read", async () => {
    current = { environment: 'test' };
    const html = await render();
    expect(html).toBe(TEST_ENV_PAID_HTML);
    expect(getDisclosureSnapshot).not.toHaveBeenCalled();
  });

  it('a legacy 8-char paid id -> byte-identical to the pre-T11 render, no snapshot read', async () => {
    const html = await render(LEGACY_ID);
    expect(html).toBe(LEGACY_PAID_HTML);
    expect(html).toContain('Payment complete — money sent!');
    expect(html).not.toContain('pay-receipt');
    expect(getDisclosureSnapshot).not.toHaveBeenCalled();
  });

  it('b2b paid 22-char row -> success line, no receipt card and no print hint', async () => {
    current = { transferType: 'b2b' };
    const html = await render();
    expect(html).toContain('Payment complete');
    expect(html).not.toContain('pay-receipt');
    expect(html).not.toContain(HINT_HTML);
  });

  it('print: the receipt sheet carries print: classes, the hint is print:hidden, no script handler', async () => {
    const html = await render();
    expect(html).toMatch(/<main class="[^"]*print:bg-white[^"]*print:text-black/);
    expect(html).toMatch(/<div class="[^"]*print:bg-white[^"]*">/);
    expect(html).toMatch(/<section data-testid="pay-receipt"[^>]*class="[^"]*print:bg-white[^"]*print:text-black/);
    const hint = html.match(/<p class="([^"]*)">([^<]*)<\/p>/g)?.find((p) => p.includes(HINT_HTML));
    expect(hint).toBeDefined();
    expect(hint).toContain('print:hidden');
    expect(html).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('onclick');
    expect(html).not.toContain('window.print');
  });

  it('the receipt holds no phone, legal name or full account number', async () => {
    current = { recipientLegalName: 'Secret Legal Name' } as Partial<Transfer>;
    getTransferDecrypted.mockImplementation(async (id) =>
      id === ID ? makeTransfer({ id, ...current, payoutDestination: '123456789012|HDFC0001234' }) : null,
    );
    const html = await render();
    expect(html).not.toContain(SENDER);
    expect(html).not.toContain(RECIPIENT_PHONE);
    expect(html).not.toContain('Secret Legal Name');
    expect(html).not.toContain('123456789012');
  });
});

describe('/pay/[transferId] receiptOnReload (pack 6 T11, P11)', { retry: 0 }, () => {
  const draftOf = (partnerId: string, o: Partial<Draft> = {}): Draft =>
    ({
      senderPhone: SENDER,
      partnerId,
      recipient: { name: 'Mom', recipientPhone: RECIPIENT_PHONE, payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 84.5, amountInr: 8450, feeSource: 0, totalChargeSource: 100 },
      ...o,
    }) as unknown as Draft;

  it('true for a b2c 22-char live row and for a b2c draft', async () => {
    current = { status: 'awaiting_payment', paidAt: undefined };
    await render();
    expect(lastProps()?.receiptOnReload).toBe(true);

    payFormProps.last = null;
    getTransfer.mockResolvedValue(null);
    getTransferDecrypted.mockResolvedValue(null);
    getDraft.mockResolvedValue(draftOf('p_acme'));
    await render('draft-id-1');
    expect(lastProps()?.receiptOnReload).toBe(true);
  });

  it("absent for a 'test' row, a legacy id, a b2b row and a b2b draft", async () => {
    for (const [name, o, id] of [
      ['test', { environment: 'test' }, ID],
      ['legacy', {}, LEGACY_ID],
      ['b2b', { transferType: 'b2b' }, ID],
    ] as const) {
      current = { status: 'awaiting_payment', paidAt: undefined, ...o };
      payFormProps.last = null;
      await render(id);
      expect(lastProps(), name).not.toBeNull();
      expect('receiptOnReload' in (lastProps() ?? {}), name).toBe(false);
    }
    getTransfer.mockResolvedValue(null);
    getTransferDecrypted.mockResolvedValue(null);
    getDraft.mockResolvedValue(draftOf('p_acme', { transferType: 'b2b' } as Partial<Draft>));
    payFormProps.last = null;
    await render('draft-id-2');
    expect('receiptOnReload' in (lastProps() ?? {})).toBe(false);
  });
});
