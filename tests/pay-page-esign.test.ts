/**
 * Fix pack 6 T7a (R46, P5, P8): the transfer and draft pay PAGE asks for E-SIGN
 * consent when the payer (the OWNER tenant + sender phone) has no current consent
 * on file: PayForm gets esignVersion and the Reg E disclosure as its slot, and the
 * consent block renders above the disclosure. Consent on file, an ACH-debit row
 * and a row no longer awaiting payment leave the page as it was (no consent read).
 * Rendered through the real page over PGlite (real store, repos and reader).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStore } from '@/lib/store';
import { createDraftStore } from '@/lib/draft-store';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import type { Draft, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let draftStore: ReturnType<typeof createDraftStore>;

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.9' }) }));
vi.mock('@/lib/ip-rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/ip-rate-limit')>()),
  isIpRateLimited: async () => false,
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/draft-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/draft-store')>()),
  getDraftStore: () => draftStore,
}));
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  return { ...real, getPartnerStore: () => real.createPartnerStore(db) };
});
// The consent read: counted, and made to throw on demand.
const fault = vi.hoisted(() => ({ reads: 0, throws: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    readEsignConsent: async (...args: Parameters<typeof real.readEsignConsent>) => {
      fault.reads += 1;
      if (fault.throws) throw new Error('read failed');
      return real.readEsignConsent(...args);
    },
  };
});
const logs = vi.hoisted(() => ({ warns: [] as Array<{ scope: string; err: unknown }> }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (scope: string, err: unknown, ...rest: unknown[]) => {
      logs.warns.push({ scope, err });
      return (real.logWarn as (...a: unknown[]) => void)(scope, err, ...rest);
    },
  };
});
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

const OWNER = 'acme';
const SENDER = '15551234567';
const RP = '919876543210';
const ACCOUNT = '123456789012|HDFC0001234';
const BLOCK = 'data-testid="esign-consent"';
const REG_E = 'id="reg-e-disclosure-heading"';

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: RP, recipientLegalName: 'Anita Legal',
    payoutMethod: 'bank', payoutDestination: ACCOUNT, fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: OWNER,
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

async function makeDraft(o: Partial<Draft> = {}): Promise<string> {
  return draftStore.createDraft({
    senderPhone: SENDER,
    partnerId: OWNER,
    recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: ACCOUNT },
    recipientLegalName: 'Anita Legal',
    amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    ...o,
  } as Omit<Draft, 'createdAt' | 'channel'> & { partnerId: string });
}

async function render(id: string): Promise<string> {
  payFormProps.last = null;
  return renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId: id }) }));
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  draftStore = createDraftStore(fakeRedis());
  await seedPartner(db, OWNER, 'Acme');
  fault.reads = 0;
  fault.throws = false;
  logs.warns = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pay page: the E-SIGN tick on a minted transfer (P8)', () => {
  it('an awaiting b2c transfer, no consent on file -> esignVersion and the disclosure slot; the block above the disclosure, which renders once', async () => {
    await store.saveTransfer(makeTransfer({ id: 'es-b2c' }));
    const html = await render('es-b2c');
    expect(payFormProps.last?.esignVersion).toBe(ESIGN_CONSENT_VERSION);
    expect(payFormProps.last?.disclosureSlot).toBeTruthy();
    expect(html).toContain(BLOCK);
    expect(count(html, REG_E)).toBe(1);
    expect(html.indexOf(BLOCK)).toBeLessThan(html.indexOf(REG_E));
    expect(fault.reads).toBe(1);
  });

  it('an awaiting non-ACH b2b transfer, no consent on file -> asked too (P5)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'es-b2b', transferType: 'b2b', fundingMethod: 'bank_transfer' }));
    const html = await render('es-b2b');
    expect(payFormProps.last?.esignVersion).toBe(ESIGN_CONSENT_VERSION);
    expect(html).toContain(BLOCK);
  });

  it('consent on file -> esignVersion null, no block, the disclosure rendered by the page as before (once, before the form)', async () => {
    await seedEsignConsentForTest(db, OWNER, SENDER);
    await store.saveTransfer(makeTransfer({ id: 'es-onfile' }));
    const html = await render('es-onfile');
    expect(payFormProps.last?.esignVersion ?? null).toBeNull();
    expect('disclosureSlot' in (payFormProps.last ?? {})).toBe(false);
    expect('esignVersion' in (payFormProps.last ?? {})).toBe(false);
    expect(html).not.toContain(BLOCK);
    expect(count(html, REG_E)).toBe(1);
    expect(html.indexOf(REG_E)).toBeLessThan(html.indexOf('Pay now'));
  });

  it('a withdrawn consent -> asked again', async () => {
    await seedEsignConsentForTest(db, OWNER, SENDER, { withdrawn: true });
    await store.saveTransfer(makeTransfer({ id: 'es-withdrawn' }));
    expect(await render('es-withdrawn')).toContain(BLOCK);
  });

  it('a consent on file for ANOTHER tenant does not count (the owner is the key)', async () => {
    await seedEsignConsentForTest(db, DEFAULT_PARTNER_ID, SENDER);
    await store.saveTransfer(makeTransfer({ id: 'es-other' }));
    expect(await render('es-other')).toContain(BLOCK);
  });

  it('an ach_pull row -> no consent read and no block', async () => {
    await store.saveTransfer(makeTransfer({ id: 'es-ach', transferType: 'b2b', fundingMethod: 'ach_pull' }));
    const stop = captureQueries();
    const html = await render('es-ach');
    const statements = stop();
    expect(statements.some((q) => /^select "esign_consent_version"/.test(q.sql))).toBe(false);
    expect(fault.reads).toBe(0);
    expect(html).not.toContain(BLOCK);
    expect(html).toContain('Authorize ACH bank debit');
  });

  it('a paid row -> no consent read, no form, no block', async () => {
    await store.saveTransfer(makeTransfer({ id: 'es-paid', status: 'paid' }));
    const stop = captureQueries();
    const html = await render('es-paid');
    const statements = stop();
    expect(statements.some((q) => /^select "esign_consent_version"/.test(q.sql))).toBe(false);
    expect(fault.reads).toBe(0);
    expect(payFormProps.last).toBeNull();
    expect(html).not.toContain(BLOCK);
  });

  it('the consent read fails -> the block shows, the page still renders, pay.esign-read is logged', async () => {
    fault.throws = true;
    await store.saveTransfer(makeTransfer({ id: 'es-fail' }));
    const html = await render('es-fail');
    expect(html).toContain('Secure payment');
    expect(html).toContain(BLOCK);
    expect(payFormProps.last?.esignVersion).toBe(ESIGN_CONSENT_VERSION);
    expect(logs.warns.map((w) => w.scope)).toContain('pay.esign-read');
  });
});

describe('pay page: the E-SIGN tick on a draft (P8: owner = draftTenant, phone = senderPhone)', () => {
  it('asked when nothing is on file for THAT owner; not asked once it is', async () => {
    await seedEsignConsentForTest(db, DEFAULT_PARTNER_ID, SENDER);
    const id = await makeDraft();
    const html = await render(id);
    expect(payFormProps.last?.esignVersion).toBe(ESIGN_CONSENT_VERSION);
    expect(html).toContain(BLOCK);
    expect(html.indexOf(BLOCK)).toBeLessThan(html.indexOf(REG_E));
    expect(count(html, REG_E)).toBe(1);

    await seedEsignConsentForTest(db, OWNER, SENDER);
    const again = await render(id);
    expect(again).not.toContain(BLOCK);
    expect(count(again, REG_E)).toBe(1);
  });

  it('a cold-start draft (bank details step) asks on step 1, Continue waits for the tick', async () => {
    const id = await makeDraft({ recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: '' } });
    const html = await render(id);
    expect(html).toContain('Step 1 of 2');
    expect(html).toContain(BLOCK);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Continue<\/button>/);
  });

  it('an ach_pull draft -> no consent read and no block', async () => {
    const id = await makeDraft({ fundingMethod: 'ach_pull', transferType: 'b2b' });
    const html = await render(id);
    expect(fault.reads).toBe(0);
    expect(html).not.toContain(BLOCK);
  });
});
