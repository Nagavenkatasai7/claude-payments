/**
 * Fix pack 5 T21b (P19, P31, R38): the transfer pay PAGE asks the sender's home
 * address (always) and date of birth (DOB band) on a real-money b2c payment,
 * through readOriginatorView. Booleans only reach PayForm: a stored address or
 * DOB never appears in the HTML. Rendered through the real page over PGlite
 * (real store, repos and view), as the sender's browser would receive it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createDraftStore } from '@/lib/draft-store';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { CountryCode, Draft, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { seedOriginatorForTest } from './helpers-live';
import { setRailProviderType } from './helpers-sanctions';

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
// The value seedOriginatorForTest stores (tests/helpers-live.ts).
const STORED_ADDRESS_MARK = 'Test Street';

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

const asksAddress = (html: string) => html.includes('name="senderAddress"');
const asksDob = (html: string) => html.includes('name="senderDob"');

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  draftStore = createDraftStore(fakeRedis());
  await seedPartner(db, OWNER, 'Acme');
  await setRailProviderType(db, OWNER, 'http');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pay page: the originator fields of a minted transfer (P19)', () => {
  it('real money, nothing on file, under the DOB band -> the address field only; PayForm gets the four booleans', async () => {
    await store.saveTransfer(makeTransfer({ id: 'pv-addr' }));
    const html = await render('pv-addr');
    expect(asksAddress(html)).toBe(true);
    expect(asksDob(html)).toBe(false);
    expect(payFormProps.last?.originator).toEqual({
      addressRequired: true, addressOnFile: false, dobRequired: false, dobOnFile: false,
    });
  });

  it('real money, DOB band (>= $3,000) -> address and date of birth fields', async () => {
    await store.saveTransfer(makeTransfer({ id: 'pv-dob', amountUsd: 3500, amountSource: 3500, totalChargeUsd: 3500, totalChargeSource: 3500 }));
    const html = await render('pv-dob');
    expect(asksAddress(html)).toBe(true);
    expect(asksDob(html)).toBe(true);
    expect(html).toContain('placeholder="YYYY-MM-DD"');
  });

  it('address on file, DOB band -> only the DOB field, and the stored address never reaches the HTML', async () => {
    await seedOriginatorForTest(db, OWNER, SENDER, { address: true });
    await store.saveTransfer(makeTransfer({ id: 'pv-onfile', amountUsd: 3500, amountSource: 3500 }));
    const html = await render('pv-onfile');
    expect(asksAddress(html)).toBe(false);
    expect(asksDob(html)).toBe(true);
    expect(html).not.toContain(STORED_ADDRESS_MARK);
    expect(JSON.stringify(payFormProps.last)).not.toContain(STORED_ADDRESS_MARK);
  });

  it('both on file -> no field', async () => {
    await seedOriginatorForTest(db, OWNER, SENDER, { address: true, dob: true });
    await store.saveTransfer(makeTransfer({ id: 'pv-both', amountUsd: 3500, amountSource: 3500 }));
    const html = await render('pv-both');
    expect(asksAddress(html)).toBe(false);
    expect(asksDob(html)).toBe(false);
    expect(html).not.toContain(STORED_ADDRESS_MARK);
  });

  it('the default owner (mock rail) -> no field', async () => {
    await store.saveTransfer(makeTransfer({ id: 'pv-default', partnerId: DEFAULT_PARTNER_ID, amountUsd: 3500 }));
    const html = await render('pv-default');
    expect(asksAddress(html)).toBe(false);
    expect(asksDob(html)).toBe(false);
  });

  it('a non-default owner on the mock rail -> no field', async () => {
    await db.execute(sql`DELETE FROM partner_integrations WHERE partner_id = ${OWNER}`);
    await store.saveTransfer(makeTransfer({ id: 'pv-mock', amountUsd: 3500 }));
    expect(asksAddress(await render('pv-mock'))).toBe(false);
  });

  it('a sandbox (test) row -> no field', async () => {
    await store.saveTransfer(makeTransfer({ id: 'pv-test', environment: 'test', amountUsd: 3500 }));
    const html = await render('pv-test');
    expect(asksAddress(html)).toBe(false);
    expect(asksDob(html)).toBe(false);
  });

  it('an exempt (Partner-API-minted) row -> no field', async () => {
    await store.saveTransfer(makeTransfer({ id: 'pv-api', amountUsd: 3500 }));
    await createIdempotencyRepo(db).claim(OWNER, 'order-1', 'pv-api');
    const html = await render('pv-api');
    expect(asksAddress(html)).toBe(false);
    expect(asksDob(html)).toBe(false);
  });

  it('a ROUTED row (settlementPartnerId set, the rail also real money) -> no field', async () => {
    await seedPartner(db, 'beta', 'Beta');
    await setRailProviderType(db, 'beta', 'http');
    await store.saveTransfer(makeTransfer({ id: 'pv-routed', settlementPartnerId: 'beta', amountUsd: 3500 }));
    const html = await render('pv-routed');
    expect(asksAddress(html)).toBe(false);
    expect(asksDob(html)).toBe(false);
  });

  it('a b2b row -> no field (the ACH form never asks)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'pv-b2b', transferType: 'b2b', fundingMethod: 'ach_pull', amountUsd: 3500 }));
    const html = await render('pv-b2b');
    expect(asksAddress(html)).toBe(false);
    expect(asksDob(html)).toBe(false);
  });

  it('a paid row -> no form, no field', async () => {
    await store.saveTransfer(makeTransfer({ id: 'pv-paid', status: 'paid', amountUsd: 3500 }));
    const html = await render('pv-paid');
    expect(asksAddress(html)).toBe(false);
    expect(payFormProps.last).toBeNull();
  });
});

describe('pay page: the originator fields of a draft (P19, the draft amount and destination)', () => {
  it('a $200 IN draft -> the address field only', async () => {
    const id = await makeDraft();
    const html = await render(id);
    expect(asksAddress(html)).toBe(true);
    expect(asksDob(html)).toBe(false);
  });

  it('a $1,500 GB draft (DOB destination) -> address and DOB', async () => {
    const id = await makeDraft({ amountUsd: 1500, amountSource: 1500, destinationCountry: 'GB' as CountryCode });
    const html = await render(id);
    expect(asksAddress(html)).toBe(true);
    expect(asksDob(html)).toBe(true);
  });

  it('a $1,500 IN draft -> no DOB (IN is not a DOB destination under $3,000)', async () => {
    const id = await makeDraft({ amountUsd: 1500, amountSource: 1500 });
    expect(asksDob(await render(id))).toBe(false);
  });

  it('a cold-start draft (bank details step) asks on step 1 as well', async () => {
    const id = await makeDraft({
      amountUsd: 3500, amountSource: 3500,
      recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: '' },
    });
    const html = await render(id);
    expect(html).toContain('Step 1 of 2');
    expect(asksAddress(html)).toBe(true);
    expect(asksDob(html)).toBe(true);
  });

  it('a routed draft -> no field', async () => {
    await seedPartner(db, 'beta', 'Beta');
    await setRailProviderType(db, 'beta', 'http');
    const id = await makeDraft({ settlementPartnerId: 'beta', amountUsd: 3500, amountSource: 3500 });
    expect(asksAddress(await render(id))).toBe(false);
  });

  it('a draft whose sender has both on file -> no field', async () => {
    await seedOriginatorForTest(db, OWNER, SENDER, { address: true, dob: true });
    const id = await makeDraft({ amountUsd: 3500, amountSource: 3500 });
    const html = await render(id);
    expect(asksAddress(html)).toBe(false);
    expect(asksDob(html)).toBe(false);
    expect(html).not.toContain(STORED_ADDRESS_MARK);
  });
});
