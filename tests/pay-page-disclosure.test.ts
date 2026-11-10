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
// Step 0 Q16: no draft:<id> claim behind an unknown id (tests/pay-page-draft-relink.test.ts covers it).
vi.mock('@/lib/pay-link', () => ({ transferMintedFromDraft: async () => null }));
// Program-Fix 45: the limiter-down ops signal stays hermetic (never the real outbox).
const raiseLimiterDownAlert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/limiter-alert', () => ({ raiseLimiterDownAlert }));
// Fix pack 4 (T11): `editable.value` lets a case make the row payout-editable;
// like the repo's payoutEditable it is never true for a b2b row.
const editable = vi.hoisted(() => ({ value: false }));
vi.mock('@/db/repos/transfer-repo', () => ({
  createTransferRepo: () => ({
    isPayoutEditable: async () => editable.value && current.transferType !== 'b2b',
    isPaymentLinkTransfer: async () => false,
    // Fix pack 4 (T16): read only by the real readLegalNameView (legalView.real).
    isPartnerApiMinted: async () => false,
    recipientIdentityMissing: async () => false,
  }),
}));
// Fix pack 4 (T11): the real form renders; its props are recorded (as tests/payment-link-page.test.ts does).
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

// Fix pack 4 (T16, C18): the account-holder view. `legalView.value` answers per
// case (default: no field, today's page); `legalView.real` runs the real helper
// over the mocked repos below, whose book read returns a unique marker name.
const legalView = vi.hoisted(() => ({
  value: { legalNameRequired: false, legalNameOnFile: true } as { legalNameRequired: boolean; legalNameOnFile: boolean },
  real: false,
}));
vi.mock('@/lib/recipient-legal-name', async (orig) => {
  const real = await orig<typeof import('@/lib/recipient-legal-name')>();
  return {
    ...real,
    readLegalNameView: async (...a: Parameters<typeof real.readLegalNameView>) =>
      legalView.real ? real.readLegalNameView(...a) : legalView.value,
  };
});
const STORED_LEGAL_NAME = 'Qx Storedmarker Legalname';
vi.mock('@/db/repos/aux-repos', () => ({
  createRecipientRepo: () => ({ getRecipientLegalName: async () => STORED_LEGAL_NAME }),
}));

// B3 rewards v1: the minted transfer's reward row (none unless a test sets it).
const transferReward = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@/lib/rewards/read', () => ({ transferRewardOrNull: transferReward }));

import PayPage from '@/app/pay/[transferId]/page';
import { PAY_PAGE_IP_LIMIT, PAY_PAGE_SCOPE } from '@/lib/ip-rate-limit';
import { disclosureHash } from '@/lib/disclosure-hash';

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
  editable.value = false;
  payFormProps.last = null;
  legalView.value = { legalNameRequired: false, legalNameOnFile: true };
  legalView.real = false;
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
    expect(html).toContain('data-disclosure-version="disclosure-draft-2026-09-23b"');
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

  it('B3: a reward shows one note ABOVE the legal disclosure (draft and minted transfer)', async () => {
    expect(await render()).not.toContain('data-reward-note');
    transferReward.mockResolvedValueOnce({ kind: 'nth_transfer', discountUsd: 2.99, detail: { nth: 5 } });
    const html = await render();
    expect(transferReward).toHaveBeenCalledWith(expect.anything(), 'p_acme', ID);
    const note = html.indexOf('Reward: your 5th transfer this month (you save $2.99).');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(html.indexOf('Before you pay'));

    getTransfer.mockResolvedValue(null);
    getTransferDecrypted.mockResolvedValue(null);
    getDraft.mockResolvedValue({
      senderPhone: '15551234567',
      partnerId: 'p_acme',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 84.5, amountInr: 8450, feeSource: 0, totalChargeSource: 100 },
      reward: { kind: 'festival', discountUsd: 1.99, detail: { festivalName: 'Diwali' } },
    } as unknown as Draft);
    expect(await render()).toContain('Reward: Diwali offer (you save $1.99).');
  });

  it('B3: a paid transfer shows no reward note', async () => {
    current = { status: 'paid' };
    transferReward.mockResolvedValue({ kind: 'first_transfer', discountUsd: 2.99, detail: {} });
    expect(await render()).not.toContain('data-reward-note');
    transferReward.mockResolvedValue(null);
  });
});

// Fix pack 4 (C15, C10): the 'Approving ...' line beside the code box and the
// disclosure hash the form posts. last4 only where the page shows the saved
// account label today, and only for a bank account.
describe('/pay/[transferId]: fix pack 4 Approving line and disclosure hash', { retry: 0 }, () => {
  const approvingLineOf = (html: string) => html.match(/<p data-testid="approving-line"[^>]*>([^<]*)<\/p>/)?.[1] ?? null;

  it('the single-step form shows the Approving line with the total, the first name and the saved last4', async () => {
    decryptedDest = 'IFSC:HDFC0001234|ACCT:123456789012';
    current = { payoutMethod: 'bank' };
    editable.value = true;
    const html = await render();
    expect(html).toContain('data-testid="approving-line"');
    expect(approvingLineOf(html)).toBe('Approving 202.99 USD to Mom, account ending 9012.');
  });

  it("a recipient 'Priya Sharma' shows only 'Priya'; the full destination never appears in the markup", async () => {
    decryptedDest = 'IFSC:HDFC0001234|ACCT:123456789012';
    current = { recipientName: 'Priya Sharma' };
    editable.value = true;
    const html = await render();
    expect(approvingLineOf(html)).toBe('Approving 202.99 USD to Priya, account ending 9012.');
    expect(html).not.toContain('123456789012');
    expect(html).not.toContain('HDFC0001234');
  });

  it("a minted b2b transfer shows no 'account ending'", async () => {
    decryptedDest = 'IFSC:HDFC0001234|ACCT:123456789012';
    current = { transferType: 'b2b' };
    editable.value = true; // the repo never calls a b2b row editable
    const html = await render();
    expect(approvingLineOf(html)).toBe('Approving 202.99 USD to Mom.');
    expect(html).not.toContain('account ending');
  });

  it("a NON-editable b2c transfer (Partner-API claim, or funded) shows no 'account ending'", async () => {
    decryptedDest = 'IFSC:HDFC0001234|ACCT:123456789012';
    editable.value = false;
    const html = await render();
    expect(approvingLineOf(html)).toBe('Approving 202.99 USD to Mom.');
    expect(html).not.toContain('account ending');
    expect((payFormProps.last?.approving as { accountLast4: unknown }).accountLast4).toBeNull();
  });

  it("a UPI destination with digits (a phone-number UPI id) never shows 'account ending' in the line", async () => {
    decryptedDest = '9876543210@ybl';
    current = { payoutMethod: 'upi' };
    editable.value = true;
    const html = await render();
    expect(approvingLineOf(html)).toBe('Approving 202.99 USD to Mom.');
    expect((payFormProps.last?.approving as { accountLast4: unknown }).accountLast4).toBeNull();
  });

  it('a draft with a stored bank account gets the last4; a b2b or UPI draft gets none', async () => {
    getTransfer.mockResolvedValue(null);
    getTransferDecrypted.mockResolvedValue(null);
    const draft = (o: Record<string, unknown>, r: Record<string, unknown>) => ({
      senderPhone: '15551234567',
      partnerId: 'p_acme',
      recipient: { name: 'Priya Sharma', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: 'IFSC:HDFC0001234|ACCT:123456789012', ...r },
      amountUsd: 1000, amountSource: 1000, sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 50, fxRate: 84.5, amountInr: 84500, feeSource: 50, totalChargeSource: 1050 },
      ...o,
    }) as unknown as Draft;
    getDraft.mockResolvedValue(draft({}, {}));
    expect(approvingLineOf(await render())).toBe('Approving 1,050.00 USD to Priya, account ending 9012.');
    getDraft.mockResolvedValue(draft({ transferType: 'b2b' }, {}));
    expect(approvingLineOf(await render())).toBe('Approving 1,050.00 USD to Priya.');
    getDraft.mockResolvedValue(draft({}, { payoutMethod: 'upi', payoutDestination: '9876543210@ybl' }));
    expect(approvingLineOf(await render())).toBe('Approving 1,050.00 USD to Priya.');
  });

  it('the cold-start form (no stored destination) shows no Approving line on step 1; a paid transfer shows none', async () => {
    decryptedDest = '';
    const cold = await render();
    expect(cold).toContain('Step 1 of 2');
    expect(cold).not.toContain('Approving');
    current = { status: 'paid' };
    decryptedDest = 'IFSC:HDFC0001234|ACCT:123456789012';
    expect(await render()).not.toContain('Approving');
  });

  it("the page hands PayForm the configured block's hash; the default tenant passes null", async () => {
    decryptedDest = 'IFSC:HDFC0001234|ACCT:123456789012';
    await render();
    expect(payFormProps.last?.disclosureHash).toBe(disclosureHash(FULL));
    expect(payFormProps.last?.approving).toEqual({ amountText: '202.99', currency: 'USD', recipientName: 'Mom', accountLast4: null });
    current = { partnerId: 'default' };
    await render();
    expect(payFormProps.last?.disclosureHash).toBeNull();
  });
});

// Fix pack 4 (T16, C18): the account-holder field. The page hands the form two
// booleans only; the single-step form asks when no name is on file for the
// stored account, and the bank-details step asks whenever the field counts
// (a name on file describes the stored account, not a typed one).
describe('/pay/[transferId]: fix pack 4 account-holder field', { retry: 0 }, () => {
  const LABEL = 'Account holder name';
  const HELP = 'As it appears on the recipient&#x27;s bank account.';
  const holderInput = (html: string) => html.match(/<input[^>]*name="accountHolder"[^>]*>/)?.[0] ?? null;
  const STORED = 'IFSC:HDFC0001234|ACCT:123456789012';

  it('required, none on file -> the label and help text render on the single-step form; the input is required', async () => {
    decryptedDest = STORED;
    editable.value = true;
    legalView.value = { legalNameRequired: true, legalNameOnFile: false };
    const html = await render();
    expect(html).not.toContain('Step 1 of 2');
    expect(html).toContain(LABEL);
    expect(html).toContain(HELP);
    const input = holderInput(html);
    expect(input).not.toBeNull();
    expect(input).toContain('required=""');
    expect(input).toContain('maxLength="80"');
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('value=""');
    // The page hands the form the two booleans, nothing else about the name.
    expect(payFormProps.last?.legalNameRequired).toBe(true);
    expect(payFormProps.last?.legalNameOnFile).toBe(false);
  });

  it('the field sits above the code box and does not move the Approving line', async () => {
    decryptedDest = STORED;
    editable.value = true;
    legalView.value = { legalNameRequired: true, legalNameOnFile: false };
    const html = await render();
    expect(html.indexOf(LABEL)).toBeGreaterThan(-1);
    expect(html.indexOf(LABEL)).toBeLessThan(html.indexOf('data-testid="approving-line"'));
    expect(html.indexOf('data-testid="approving-line"')).toBeLessThan(html.indexOf('Send confirmation code to WhatsApp'));
  });

  it('optional -> the field renders without required', async () => {
    decryptedDest = STORED;
    legalView.value = { legalNameRequired: false, legalNameOnFile: false };
    const input = holderInput(await render());
    expect(input).not.toBeNull();
    expect(input).not.toContain('required');
  });

  it('on file -> no field on the single-step form', async () => {
    decryptedDest = STORED;
    legalView.value = { legalNameRequired: true, legalNameOnFile: true };
    const html = await render();
    expect(html).not.toContain(LABEL);
    expect(holderInput(html)).toBeNull();
  });

  it('on file but the cold-start bank-details step -> the field renders (required when legalNameRequired)', async () => {
    decryptedDest = '';
    legalView.value = { legalNameRequired: true, legalNameOnFile: true };
    const html = await render();
    expect(html).toContain('Step 1 of 2');
    expect(html).toContain(LABEL);
    expect(holderInput(html)).toContain('required=""');
    // After the bank fields, before Continue.
    expect(html.indexOf(LABEL)).toBeLessThan(html.indexOf('>Continue<'));
    expect(html.indexOf('IFSC')).toBeLessThan(html.indexOf(LABEL));
  });

  it('the cold-start step with an optional field -> rendered, not required', async () => {
    decryptedDest = '';
    legalView.value = { legalNameRequired: false, legalNameOnFile: false };
    const input = holderInput(await render());
    expect(input).not.toBeNull();
    expect(input).not.toContain('required');
  });

  it('an exempt row (required false, on file true) -> no field anywhere', async () => {
    legalView.value = { legalNameRequired: false, legalNameOnFile: true };
    decryptedDest = STORED;
    expect(await render()).not.toContain(LABEL);
    decryptedDest = '';
    const cold = await render();
    expect(cold).toContain('Step 1 of 2');
    expect(cold).not.toContain(LABEL);
  });

  it('a paid transfer never reads the view and shows no field', async () => {
    legalView.value = { legalNameRequired: true, legalNameOnFile: false };
    current = { status: 'paid' };
    decryptedDest = STORED;
    const html = await render();
    expect(html).not.toContain(LABEL);
    expect(payFormProps.last).toBeNull();
  });

  it('the rendered HTML never contains a stored legal name (real helper, book read returns a marker)', async () => {
    legalView.real = true;
    getTransfer.mockResolvedValue(null);
    getTransferDecrypted.mockResolvedValue(null);
    getDraft.mockResolvedValue({
      senderPhone: '15551234567',
      partnerId: 'p_acme',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: STORED },
      recipientLegalName: STORED_LEGAL_NAME,
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 2.99, fxRate: 83.2, amountInr: 16640, feeSource: 2.99, totalChargeSource: 202.99 },
    } as unknown as Draft);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const html = await render();
      expect(html).not.toContain(STORED_LEGAL_NAME);
      expect(html).not.toContain('Storedmarker');
      expect(JSON.stringify(payFormProps.last)).not.toContain(STORED_LEGAL_NAME);
      expect(payFormProps.last?.legalNameOnFile).toBe(true);
      expect(Object.keys(payFormProps.last ?? {}).filter((k) => /legal|holder/i.test(k)).sort()).toEqual([
        'legalNameOnFile',
        'legalNameRequired',
      ]);
      // A minted transfer whose book read is not used: still no marker anywhere.
      getDraft.mockResolvedValue(null);
      getTransfer.mockImplementation(async (id) => (id === ID ? makeTransfer({ id }) : null));
      getTransferDecrypted.mockImplementation(async (id) => (id === ID ? makeTransfer({ id, payoutDestination: STORED }) : null));
      expect(await render()).not.toContain(STORED_LEGAL_NAME);
      for (const c of warn.mock.calls) expect(String(c[0])).not.toContain(STORED_LEGAL_NAME);
    } finally {
      warn.mockRestore();
    }
  });
});
