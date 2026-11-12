/**
 * Fix pack 6 T27 (R48, P4, P7 step 7, P19): the risk tick on the DRAFT pay POST.
 *   - a draft that carries riskSignals pays only with `riskAck: true`, checked
 *     pre-verify after the account-holder rule and before the originator rule
 *     and the E-SIGN gate: key absent -> 409 reload_required (an old tab); posted
 *     but not exactly true -> 400 risk_ack_required; no code spent, nothing written;
 *   - the tick reaches finalizeDraftPayment as opts.risk and the mint records it;
 *   - the finalizer's backstop 'risk_ack_required' -> the same 409;
 *   - a draft without signals, the transfer branch and a consumed draft continuing
 *     on its transfer never ask;
 *   - a configuration change between draft and pay never strands the link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';
import { certifyPartnerForTest } from './helpers-live';
import { okVerify, realMoneyPayBody } from './helpers-pay-evidence';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { draftWithRiskSignals, riskConfigFor } from './helpers-risk';
import { PAY_RELOAD_REQUIRED_COPY } from '@/lib/pay-outcome';
import { PAY_RISK_ACK_REQUIRED_COPY } from '@/lib/legal/risk-warning';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import type { Db } from '@/db/client';
import type { Draft, Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { FinalizeResult } from '@/lib/pay-finalize';

// The money gate's mock-funding refusal is off unless the order case turns it on.
const funding = vi.hoisted(() => ({ refuse: false }));
vi.mock('@/lib/funding-class', async (orig) => ({
  ...(await orig<typeof import('@/lib/funding-class')>()),
  payFundingRefusal: () => funding.refuse,
}));
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));
const otp = vi.hoisted(() => ({ verify: null as unknown as ReturnType<typeof import('vitest').vi.fn> }));
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: (...a: unknown[]) => otp.verify(...a),
  }),
}));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let draftStore: ReturnType<typeof createDraftStore>;
vi.mock('@/lib/draft-store', async (orig) => {
  const real = await orig<typeof import('@/lib/draft-store')>();
  return { ...real, getDraftStore: () => draftStore };
});
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => store };
});
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  return { ...real, getCustomerStore: () => customerStore };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  return { ...real, getPartnerStore: () => real.createPartnerStore(db) };
});
const rails = vi.hoisted(() => ({ byPartner: {} as Record<string, PartnerIntegrations['payment']> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (id: string) => ({ kyc: {}, payment: rails.byPartner[id] ?? {}, whatsapp: {} }),
  }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

// Delegating spies, only to observe the order and the finalizer's opts.
const seam = vi.hoisted(() => ({
  order: [] as string[],
  finalizeOpts: [] as unknown[],
  finalizeOnce: null as null | Record<string, unknown>,
}));
vi.mock('@/lib/pay-esign-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-esign-gate')>();
  return {
    ...real,
    payEsignGate: vi.fn(async (...a: Parameters<typeof real.payEsignGate>) => {
      seam.order.push('payEsignGate');
      return real.payEsignGate(...a);
    }),
  };
});
vi.mock('@/lib/originator-info', async (orig) => {
  const real = await orig<typeof import('@/lib/originator-info')>();
  return {
    ...real,
    originatorViewFor: async (...a: Parameters<typeof real.originatorViewFor>) => {
      seam.order.push('originatorViewFor');
      return real.originatorViewFor(...a);
    },
  };
});
vi.mock('@/lib/pay-finalize', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-finalize')>();
  return {
    ...real,
    finalizeDraftPayment: async (...a: Parameters<typeof real.finalizeDraftPayment>) => {
      seam.order.push('finalizeDraftPayment');
      seam.finalizeOpts.push(a[3]);
      if (seam.finalizeOnce) {
        const r = seam.finalizeOnce;
        seam.finalizeOnce = null;
        return r as unknown as FinalizeResult;
      }
      return real.finalizeDraftPayment(...a);
    },
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';
import { finalizeDraftPayment as realFinalize } from '@/lib/pay-finalize';

const OWNER = 'acme';
const SENDER = '15551234567';
const RP = '919876543210';
const ACCOUNT = '123456789012|HDFC0001234';
const H = 3_600_000;
const HTTP_RAIL: PartnerIntegrations['payment'] = {
  providerType: 'http',
  credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' },
};

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

function post(id: string, body: unknown) {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<Response>;
}

/** Write the US corridor's riskSignals entry, keeping the entry's other keys. */
async function setRisk(d: Db, partnerId: string, cfg: unknown) {
  await d.execute(sql`
    UPDATE partners SET corridor_compliance = jsonb_set(
      coalesce(corridor_compliance, '{}'::jsonb), '{US}',
      coalesce(corridor_compliance->'US', '{}'::jsonb) || jsonb_build_object('riskSignals', ${JSON.stringify(cfg)}::jsonb)
    ) WHERE id = ${partnerId}`);
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

/** A real draft carrying the signals the page warned about. */
async function riskDraft(o: Partial<Draft> = {}): Promise<string> {
  const draftId = await makeDraft(o);
  await draftWithRiskSignals(draftStore, { draftId, riskSignals: ['first_transfer'] });
  return draftId;
}

type RiskMeta = { shown: string[]; derived: string[]; acked: boolean; held: string[]; ackedAt: string | null };
async function riskRows(): Promise<RiskMeta[]> {
  const r = (await db.execute(sql`SELECT meta FROM audit_events WHERE action = 'risk.signals' ORDER BY id`)) as unknown as {
    rows: Array<{ meta: RiskMeta }>;
  };
  return r.rows.map((x) => x.meta);
}
async function counts() {
  const n = async (table: string) =>
    Number(((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0] as { n: number }).n);
  return { transfers: await n('transfers'), audit: await n('audit_events'), outbox: await n('outbox'), idem: await n('idempotency_keys') };
}

const originalList = process.env.SANCTIONS_LIST;
beforeEach(async () => {
  rails.byPartner = {};
  funding.refuse = false;
  seam.order = [];
  seam.finalizeOpts = [];
  seam.finalizeOnce = null;
  otp.verify = vi.fn(async () => okVerify());
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  draftStore = createDraftStore(fakeRedis());
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  // Partner acme on the mock rail, risk signals on for US, nothing held.
  await seedPartner(db, OWNER, 'Acme');
  await setRisk(db, OWNER, riskConfigFor({ hold: [] }));
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: SENDER, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: OWNER, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso, fullName: 'Alex Sender',
  });
  // consent on file (pack 6 P5): owner and sender
  await seedEsignConsentForTest(db, OWNER, SENDER);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreOfacSource(originalList);
});

describe('pay route, draft with risk signals: the tick before the code (P7 step 7)', { retry: 0 }, () => {
  it('no riskAck key -> 409 reload_required (no funded key); code not checked; E-SIGN gate and finalize not called; nothing written', async () => {
    const draftId = await riskDraft();
    const before = await counts();
    const res = await post(draftId, { otp: '000000' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(otp.verify).not.toHaveBeenCalled();
    expect(seam.order).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(before.transfers).toBe(0);
  });

  it.each([['yes'], [false], [1], [null]])('riskAck %j -> 400 risk_ack_required; code not checked; nothing written', async (riskAck) => {
    const draftId = await riskDraft();
    const before = await counts();
    const res = await post(draftId, { otp: '000000', riskAck });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: 'risk_ack_required', error: PAY_RISK_ACK_REQUIRED_COPY });
    expect(otp.verify).not.toHaveBeenCalled();
    expect(seam.order).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it('riskAck true -> 2xx; finalize gets opts.risk; one risk.signals row { shown, acked: true, ackedAt within the request }', async () => {
    const draftId = await riskDraft();
    const t0 = Date.now();
    const res = await post(draftId, { otp: '000000', riskAck: true });
    const t1 = Date.now();
    expect(res.status).toBe(200);
    expect(otp.verify).toHaveBeenCalledOnce();
    expect(seam.order).toEqual(['payEsignGate', 'finalizeDraftPayment']);
    const opts = seam.finalizeOpts[0] as { risk: { acked: boolean; ackedAt: string } };
    expect(opts).toEqual({ risk: { acked: true, ackedAt: expect.any(String) } });
    const rows = await riskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shown: ['first_transfer'], acked: true, held: [] });
    const at = Date.parse(rows[0].ackedAt ?? '');
    expect(at).toBeGreaterThanOrEqual(t0);
    expect(at).toBeLessThanOrEqual(t1);
    expect(rows[0].ackedAt).toBe(opts.risk.ackedAt);
  });

  it('nothing written before verify: a refusal writes no row; a ticked payment runs no INSERT/UPDATE before the code check', async () => {
    const draftId = await riskDraft();
    const writes = (qs: Array<{ sql: string }>) => qs.filter((q) => /^\s*(insert|update|delete)\b/i.test(q.sql));
    const stopRefused = captureQueries();
    const refused = await post(draftId, { otp: '000000', riskAck: 'x' });
    const refusedQs = stopRefused();
    expect(refused.status).toBe(400);
    expect(writes(refusedQs)).toEqual([]);

    // The capture stops inside verify: what it holds ran BEFORE the code check.
    let preVerify: Array<{ sql: string }> | null = null;
    const stop = captureQueries();
    otp.verify = vi.fn(async () => {
      preVerify = stop();
      return okVerify();
    });
    let res: Response;
    try {
      res = await post(draftId, { otp: '000000', riskAck: true });
    } finally {
      if (preVerify === null) stop();
    }
    expect(res.status).toBe(200);
    expect(preVerify).not.toBeNull();
    expect(writes(preVerify ?? [])).toEqual([]);
  });

  it('finalize returns risk_ack_required (the backstop) -> 409 reload_required, funded absent', async () => {
    const draftId = await riskDraft();
    seam.finalizeOnce = { ok: false, error: 'risk_ack_required' };
    const res = await post(draftId, { otp: '000000', riskAck: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(await draftStore.getDraft(draftId)).not.toBeNull();
  });
});

describe('pay route: who is never asked (P19 T27)', { retry: 0 }, () => {
  it.each([[true], ['x']])('a draft without riskSignals: riskAck %j is ignored and the payment goes through as before (opts undefined)', async (riskAck) => {
    const draftId = await makeDraft();
    const res = await post(draftId, { otp: '000000', riskAck });
    expect(res.status).toBe(200);
    expect(seam.finalizeOpts).toEqual([undefined]);
  });

  it.each([[undefined], ['x']])('the transfer branch (a minted row) never asks: riskAck %j -> pays', async (riskAck) => {
    await store.saveTransfer(makeTransfer({ id: 'ra-row' }));
    const res = await post('ra-row', riskAck === undefined ? { otp: '000000' } : { otp: '000000', riskAck });
    expect(res.status).toBe(200);
    expect(otp.verify).toHaveBeenCalledOnce();
    expect(seam.order).not.toContain('finalizeDraftPayment');
  });

  it('a consumed draft continuing on its transfer (transferMintedFromDraft) never asks', async () => {
    const draftId = await riskDraft();
    const stores = {
      store, customerStore, draftStore,
      partnerStore: createPartnerStore(db),
      monthlyVolumeStore: createMonthlyVolumeStore(store),
      dailyVolumeStore: createDailyVolumeStore(store),
      db,
    };
    const minted = await realFinalize(stores, draftId, undefined, { risk: { acked: true, ackedAt: new Date().toISOString() } });
    expect(minted.ok).toBe(true);
    expect(await draftStore.getDraft(draftId)).toBeNull();
    seam.order = [];
    const res = await post(draftId, { otp: '000000' });
    expect(res.status).toBe(200);
    expect(otp.verify).toHaveBeenCalledOnce();
    expect(seam.order).not.toContain('finalizeDraftPayment');
  });
});

describe('pay route, risk tick order on real money (P7)', { retry: 0 }, () => {
  async function liveOwner(o: { approvedDisclosure?: boolean } = {}) {
    await certifyPartnerForTest(db, OWNER, { approvedDisclosure: o.approvedDisclosure ?? true });
    await setRailProviderType(db, OWNER, 'http');
    rails.byPartner[OWNER] = HTTP_RAIL;
    primeOfacSource({ checkedAgoMs: H });
  }

  it('an R18 refusal and a money-gate refusal answer BEFORE the tick', async () => {
    await liveOwner({ approvedDisclosure: false });
    const draftId = await riskDraft();
    const r18 = await post(draftId, realMoneyPayBody({ originator: false }));
    expect(r18.status).toBe(409);
    expect((await r18.json()).reason).toBe('not_available');

    await certifyPartnerForTest(db, OWNER, { approvedDisclosure: true });
    funding.refuse = true;
    const money = await post(draftId, realMoneyPayBody({ originator: false }));
    expect(money.status).toBe(409);
    expect((await money.json()).reason).toBe('not_available');
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it('the tick answers before the originator rule and the E-SIGN gate (neither called)', async () => {
    await liveOwner();
    const draftId = await riskDraft();
    const absent = await post(draftId, realMoneyPayBody({ originator: false }));
    expect(absent.status).toBe(409);
    expect((await absent.json()).reason).toBe('reload_required');
    const bad = await post(draftId, { ...realMoneyPayBody({ originator: false }), riskAck: 'x' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).reason).toBe('risk_ack_required');
    expect(seam.order).toEqual([]);
    expect(otp.verify).not.toHaveBeenCalled();
  });
});

describe('pay route: a configuration change between draft and pay never strands the link (P19 T27)', { retry: 0 }, () => {
  it('(a) risk signals now off -> pays with the tick, no hold, risk.signals held []', async () => {
    const draftId = await riskDraft();
    await setRisk(db, OWNER, riskConfigFor({ enabled: false }));
    const res = await post(draftId, { otp: '000000', riskAck: true });
    expect(res.status).toBe(200);
    const [t] = await store.listTransfers();
    expect(t.complianceReasons).not.toContain(AML_HOLD_REASON);
    const rows = await riskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shown: ['first_transfer'], derived: [], acked: true, held: [] });
  });

  it('(b) new thresholds (amountUsd 10000, newAccountHours 1) -> pays; derived reflects the new thresholds', async () => {
    // A sender first seen 2 h ago is a new account under the draft-time 72 h, not under 1 h.
    const c = await customerStore.getCustomer(OWNER, SENDER);
    await customerStore.saveCustomer({ ...c!, firstSeenAt: new Date(Date.now() - 2 * H).toISOString() });
    const draftId = await riskDraft();
    await setRisk(db, OWNER, riskConfigFor({ amountUsd: 10000, newAccountHours: 1 }));
    const res = await post(draftId, { otp: '000000', riskAck: true });
    expect(res.status).toBe(200);
    const rows = await riskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].derived).toContain('first_transfer');
    expect(rows[0].derived).not.toContain('new_account');
    expect(rows[0].derived).not.toContain('amount_over_threshold');
    expect(rows[0].held).toEqual([]);
  });

  it('(c) the hold list now has first_transfer -> pays into in_review with AML_HOLD_REASON; the held 200', async () => {
    const draftId = await riskDraft();
    await setRisk(db, OWNER, riskConfigFor({ hold: ['first_transfer'] }));
    const res = await post(draftId, { otp: '000000', riskAck: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'in_review' });
    const [t] = await store.listTransfers();
    expect(t.status).toBe('in_review');
    expect(t.complianceReasons).toContain(AML_HOLD_REASON);
    expect((await riskRows())[0]).toMatchObject({ shown: ['first_transfer'], acked: true, held: ['first_transfer'] });
  });
});
