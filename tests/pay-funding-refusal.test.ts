/**
 * Fix pack 5 T13a (P12, P13 step 7): no mock charge on real money.
 * payFundingRefusal (pure, funding-class.ts) and processTransferPayment's step
 * 7: a real-money payment whose funding would be the mock (not Stripe, not a
 * B2B partner pull) is refused with PAY_NOT_AVAILABLE 409 after the live gate
 * (6) and before R18 (8) and the evidence commit (9): nothing is written or
 * captured. This file pins the refusal WITHOUT the funding-class mock that the
 * other real-money pay tests use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { approveDisclosureForTest, certifyPartnerForTest } from './helpers-live';
import { testEvidence } from './helpers-pay-evidence';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { PAY_NOT_AVAILABLE } from '@/lib/pay-not-available';
import { payFundingRefusal } from '@/lib/funding-class';
import type { Transfer } from '@/lib/types';
import type { PartnerFundingConfig, PartnerIntegrations } from '@/lib/partner-integrations';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: () => {} };
});
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      requireKycBeforeSend: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));

const rails = vi.hoisted(() => ({
  byPartner: {} as Record<string, PartnerIntegrations['payment']>,
  fundingReads: [] as string[],
  fundingConfig: null as PartnerFundingConfig | null,
  fundingThrows: false,
}));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (id: string) => ({ kyc: {}, whatsapp: {}, payment: rails.byPartner[id] ?? {} }),
    getFundingConfig: async (id: string) => {
      rails.fundingReads.push(id);
      if (rails.fundingThrows) throw new Error('funding-read-leak postgres://user:pw@host/db');
      return rails.fundingConfig;
    },
  }),
}));

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return {
    ...real,
    getFundingProvider: () => ({ capture: (...a: unknown[]) => capture(...a), refund: vi.fn(), handleWebhook: vi.fn() }),
  };
});

import { processTransferPayment } from '@/lib/pay-process';

const SENDER = '15551234567';
function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

const STRIPE: PartnerFundingConfig = { providerType: 'stripe', secretKey: 'rk_test_x' };

describe('payFundingRefusal (pure)', () => {
  const t = (o: Partial<Transfer> = {}) => makeTransfer({ id: 'p1', partnerId: 'acme', ...o });
  const off = { realMoney: true, stripeEnabled: false, config: null };

  it('false: not real money', () => {
    expect(payFundingRefusal(t(), { ...off, realMoney: false })).toBe(false);
  });
  it('false: a B2B partner-pulled row (ach_pull, bank_pull)', () => {
    expect(payFundingRefusal(t({ transferType: 'b2b', fundingMethod: 'ach_pull' }), off)).toBe(false);
    expect(payFundingRefusal(t({ transferType: 'b2b', fundingMethod: 'bank_pull' }), off)).toBe(false);
  });
  it('false: a Stripe-bound row (fundTransfer decides)', () => {
    expect(payFundingRefusal(t({ fundingProvider: 'stripe' }), off)).toBe(false);
    expect(payFundingRefusal(t({ fundingIntentRef: 'pi_1' }), off)).toBe(false);
  });
  it('false: flag on + a Stripe config with a key, non-default, unrouted', () => {
    expect(payFundingRefusal(t(), { realMoney: true, stripeEnabled: true, config: STRIPE })).toBe(false);
  });
  it('true: a consumer row with the flag off', () => {
    expect(payFundingRefusal(t(), off)).toBe(true);
  });
  it('true: flag on with no config', () => {
    expect(payFundingRefusal(t(), { realMoney: true, stripeEnabled: true, config: null })).toBe(true);
  });
  it('true: flag on + Stripe config but routed, or the default tenant (refused selection)', () => {
    expect(payFundingRefusal(t({ settlementPartnerId: 'railp' }), { realMoney: true, stripeEnabled: true, config: STRIPE })).toBe(true);
    expect(payFundingRefusal(t({ partnerId: 'default' }), { realMoney: true, stripeEnabled: true, config: STRIPE })).toBe(true);
  });
  it('true: a B2B card-funded row', () => {
    expect(payFundingRefusal(t({ transferType: 'b2b', fundingMethod: 'debit_card' }), off)).toBe(true);
    expect(payFundingRefusal(t({ transferType: 'b2b', fundingMethod: 'debit_card' }), { realMoney: true, stripeEnabled: true, config: STRIPE })).toBe(true);
  });
  it('a draft passes its own fields with fundingProvider / fundingIntentRef undefined', () => {
    const draft = { transferType: 'b2c' as const, fundingMethod: 'bank_transfer' as const, partnerId: 'acme', settlementPartnerId: undefined, environment: 'live' as const, fundingProvider: undefined, fundingIntentRef: undefined };
    expect(payFundingRefusal(draft, off)).toBe(true);
  });
});

type Row = { action: string };
const evidenceRows = async (): Promise<Row[]> =>
  ((await db.execute(sql`SELECT action FROM audit_events
    WHERE action IN ('otp.verified', 'remittance.disclosure_ack') ORDER BY id`)) as unknown as { rows: Row[] }).rows;
const outboxCount = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;
const warnLines = (spy: ReturnType<typeof vi.spyOn>, scope: string) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(`"scope":"${scope}"`));

const PUBLIC_RAIL = { providerType: 'http', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } } as const;

/** acme: certified, block approved, a certified http rail (real money). */
async function acmeLive(): Promise<void> {
  await seedPartner(db, 'acme');
  await certifyPartnerForTest(db, 'acme');
  await approveDisclosureForTest(db, 'acme');
  rails.byPartner.acme = { ...PUBLIC_RAIL, credentials: { ...PUBLIC_RAIL.credentials } };
}
async function pay(t: Transfer, ev?: Parameters<typeof processTransferPayment>[2]) {
  const res = await processTransferPayment(store, t, ev);
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  rails.byPartner = {};
  rails.fundingReads = [];
  rails.fundingConfig = null;
  rails.fundingThrows = false;
  capture.mockReset();
  capture.mockResolvedValue({ fundingRef: 'fund-abc' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  delete process.env.STRIPE_FUNDING_ENABLED;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('processTransferPayment step 7: no mock funding on real money', () => {
  it('a mock-funded payment on a certified http rail answers PAY_NOT_AVAILABLE and writes nothing', async () => {
    await acmeLive();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'm1', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'm1' }))).toEqual({ status: PAY_NOT_AVAILABLE.status, body: PAY_NOT_AVAILABLE.body });
    expect(capture).not.toHaveBeenCalled();
    expect(await evidenceRows()).toEqual([]);
    expect(await createTransferRepo(db).getDisclosureSnapshot('m1', 'acme')).toBeNull();
    const row = await store.getTransfer('m1');
    expect(row?.status).toBe('awaiting_payment');
    expect(row?.fundingRef).toBeUndefined();
    expect(await outboxCount()).toBe(0);
    const lines = warnLines(warn, 'pay.funding-refused');
    expect(lines).toHaveLength(1);
    const { level, scope, msg, at, ...fields } = JSON.parse(lines[0]);
    expect({ level, scope, msg, atIsString: typeof at === 'string' }).toEqual({
      level: 'warn', scope: 'pay.funding-refused', msg: 'mock funding refused on a real-money rail', atIsString: true,
    });
    expect(fields).toEqual({ transferId: 'm1', code: 'mock_on_real_money' });
  });

  it('step 7 comes before R18: a mandatory row with no acknowledgement gets 409 not_available, not reload_required', async () => {
    await acmeLive();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'm2', partnerId: 'acme' });
    await store.saveTransfer(t);
    const res = await pay(t, testEvidence({ routeId: 'm2', ack: false }));
    expect(res).toEqual({ status: 409, body: PAY_NOT_AVAILABLE.body });
    expect(res.body.reason).toBe('not_available');
    expect(capture).not.toHaveBeenCalled();
  });

  it('step 6 comes before step 7: an uncertified http rail gets the 409 with the pay.live-refused log only', async () => {
    await seedPartner(db, 'beta');
    rails.byPartner.beta = { ...PUBLIC_RAIL, credentials: { ...PUBLIC_RAIL.credentials } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'm3', partnerId: 'beta' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'm3' }))).toEqual({ status: 409, body: PAY_NOT_AVAILABLE.body });
    expect(warnLines(warn, 'pay.live-refused')).toHaveLength(1);
    expect(warnLines(warn, 'pay.funding-refused')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it('the funding config is read only on real money with the flag on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // simulator rail + flag on -> no read (not real money)
    process.env.STRIPE_FUNDING_ENABLED = 'true';
    rails.byPartner.default = { providerType: 'simulator', credentials: { signingSecret: 's' } };
    const sim = makeTransfer({ id: 'f1' });
    await store.saveTransfer(sim);
    expect((await pay(sim)).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    // ONE read: fundTransfer's own (flag on); step 7 made none (not real money).
    expect(rails.fundingReads).toEqual(['default']);
    rails.fundingReads = [];

    // http + flag off -> no read; refused
    delete process.env.STRIPE_FUNDING_ENABLED;
    await acmeLive();
    const t2 = makeTransfer({ id: 'f2', partnerId: 'acme' });
    await store.saveTransfer(t2);
    expect((await pay(t2, testEvidence({ routeId: 'f2' }))).status).toBe(409);
    expect(rails.fundingReads).toEqual([]);
  });

  it('http + flag on: ONE read at step 7; a Stripe config passes step 7', async () => {
    process.env.STRIPE_FUNDING_ENABLED = 'true';
    await acmeLive();
    rails.fundingConfig = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'f3', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect((await pay(t, testEvidence({ routeId: 'f3' }))).status).toBe(409);
    expect(rails.fundingReads).toEqual(['acme']);
  });

  it('a funding config read that throws counts as no config: refused, logged by the error name only', async () => {
    process.env.STRIPE_FUNDING_ENABLED = 'true';
    await acmeLive();
    rails.fundingThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'f4', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'f4' }))).toEqual({ status: 409, body: PAY_NOT_AVAILABLE.body });
    const lines = warnLines(warn, 'pay.funding-config');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe('Error');
    expect(lines[0]).not.toContain('postgres://');
    expect(lines[0]).not.toContain('funding-read-leak');
    expect(warnLines(warn, 'pay.funding-refused')).toHaveLength(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it('demo unchanged: a simulator rail and the default tenant pay with a mock capture, as today', async () => {
    rails.byPartner.default = { providerType: 'simulator', credentials: { signingSecret: 's' } };
    const sim = makeTransfer({ id: 'd1' });
    await store.saveTransfer(sim);
    expect(await pay(sim)).toEqual({ status: 200, body: { ok: true, status: 'processing' } }); // webhook-driven, as today
    expect(capture).toHaveBeenCalledTimes(1);

    rails.byPartner = {};
    const def = makeTransfer({ id: 'd2' });
    await store.saveTransfer(def);
    expect(await pay(def, testEvidence({ routeId: 'd2' }))).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(rails.fundingReads).toEqual([]);
  });
});
