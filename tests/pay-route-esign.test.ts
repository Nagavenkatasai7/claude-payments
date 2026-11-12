/**
 * Fix pack 6 T5 (R46, P5, P7 steps 9 and 11): the E-SIGN consent gate of the
 * transfer pay route (existing transfer and draft branches).
 *   - asked AFTER the originator rule and BEFORE the code is checked, on every
 *     tenant, for every payment that is not an ACH debit (b2c and non-ACH b2b);
 *   - an old tab or a stale version -> 409 reload_required (funded-aware); an
 *     unreadable consent or an unresolved draft owner -> 503
 *     temporarily_unavailable; neither spends the code or writes anything;
 *   - the current version posted and no consent on file -> the evidence carries
 *     it and the evidence commit records it (customers row + one
 *     customer.consent.esign row) in the same transaction as otp.verified;
 *   - never at request_otp (P0 rule 12).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';
import { certifyPartnerForTest } from './helpers-live';
import { okVerify, realMoneyPayBody } from './helpers-pay-evidence';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { readEsignConsent as realReadEsignConsent } from '@/db/repos/customer-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import {
  PAY_APPROVAL_NOT_RECORDED_COPY,
  PAY_RELOAD_REQUIRED_COPY,
  PAY_RELOAD_REQUIRED_FUNDED_COPY,
} from '@/lib/pay-outcome';
import type { Draft, Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

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
    issue: async () => ({ ok: true, code: '000000', issuedAt: Date.now() }),
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
// The consent read (counted, may throw) and the consent write (may miss).
const fault = vi.hoisted(() => ({ reads: 0, esignReadThrows: false, recordMiss: false, recordCalls: 0 }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    readEsignConsent: async (...a: Parameters<typeof real.readEsignConsent>) => {
      fault.reads += 1;
      if (fault.esignReadThrows) throw new TypeError('esign-read-secret');
      return real.readEsignConsent(...a);
    },
    recordEsignConsent: async (...a: Parameters<typeof real.recordEsignConsent>) => {
      fault.recordCalls += 1;
      if (fault.recordMiss) return false;
      return real.recordEsignConsent(...a);
    },
  };
});
const fin = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/pay-finalize', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-finalize')>();
  return {
    ...real,
    finalizeDraftPayment: async (...a: Parameters<typeof real.finalizeDraftPayment>) => {
      fin.calls += 1;
      return real.finalizeDraftPayment(...a);
    },
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';

const SENDER = '15551234567';
const RP = '919876543210';
const ACCOUNT = '123456789012|HDFC0001234';
const H = 3_600_000;
const HTTP_RAIL: PartnerIntegrations['payment'] = {
  providerType: 'http',
  credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' },
};
const V = ESIGN_CONSENT_VERSION;

const consoleLines: string[] = [];

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: RP, recipientLegalName: 'Anita Legal',
    payoutMethod: 'bank', payoutDestination: ACCOUNT, fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}
const B2B: Partial<Transfer> = {
  transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
  senderBusinessName: 'Buyer LLC', recipientBusinessName: 'Acme Supplies Pvt Ltd', recipientName: 'Acme Supplies',
};
const ACH = { routingNumber: '021000021', accountNumber: '1234567890', accountType: 'checking' };

function post(id: string, body: unknown) {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<Response>;
}

async function seedCustomer(partnerId: string) {
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: SENDER, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso, fullName: 'Alex Sender',
  });
}

/** 'acme': certified with an approved provider block, on an http rail, live OFAC list; NO consent on file. */
async function liveOwner(o: { approvedDisclosure?: boolean } = {}) {
  await seedPartner(db, 'acme', 'Acme');
  await certifyPartnerForTest(db, 'acme', { approvedDisclosure: o.approvedDisclosure ?? true });
  await setRailProviderType(db, 'acme', 'http');
  rails.byPartner.acme = HTTP_RAIL;
  primeOfacSource({ checkedAgoMs: H });
  await seedCustomer('acme');
}

async function makeDraft(o: Partial<Draft> & { partnerId?: string } = {}): Promise<string> {
  return draftStore.createDraft({
    senderPhone: SENDER,
    partnerId: 'default',
    recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: ACCOUNT },
    recipientLegalName: 'Anita Legal',
    amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    ...o,
  } as Omit<Draft, 'createdAt' | 'channel'> & { partnerId: string });
}

type AuditRow = { action: string; partner_id: string; subject_id: string; meta: Record<string, unknown> };
async function auditRows(): Promise<AuditRow[]> {
  const r = (await db.execute(
    sql`SELECT action, partner_id, subject_id, meta FROM audit_events ORDER BY id`,
  )) as unknown as { rows: AuditRow[] };
  return r.rows;
}
const consentRows = async () => (await auditRows()).filter((r) => r.action === 'customer.consent.esign');
async function outboxRows() {
  const r = (await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as {
    rows: Array<{ kind: string; dedupe_key: string | null }>;
  };
  return r.rows;
}
async function customerRow(partnerId: string) {
  const r = (await db.execute(
    sql`SELECT esign_consent_version, esign_consented_at, esign_withdrawn_at, updated_at FROM customers WHERE partner_id = ${partnerId} AND phone = ${SENDER}`,
  )) as unknown as { rows: Array<Record<string, unknown>> };
  return r.rows[0] ?? null;
}
const consentOnFile = async (partnerId: string) => (await realReadEsignConsent(db, partnerId, SENDER))?.version ?? null;

const originalList = process.env.SANCTIONS_LIST;
beforeEach(async () => {
  rails.byPartner = {};
  funding.refuse = false;
  fault.reads = 0;
  fault.esignReadThrows = false;
  fault.recordMiss = false;
  fault.recordCalls = 0;
  fin.calls = 0;
  otp.verify = vi.fn(async () => okVerify());
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  draftStore = createDraftStore(fakeRedis());
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  const keep = (...a: unknown[]) => { consoleLines.push(a.map(String).join(' ')); };
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  vi.spyOn(console, 'log').mockImplementation(keep);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreOfacSource(originalList);
});
afterAll(() => {
  for (const line of consoleLines) {
    expect(line).not.toContain(SENDER);
    expect(line).not.toContain('esign-read-secret');
    expect(line).not.toContain('legacy-reject-secret');
  }
});

describe('transfer pay route, existing b2c row: the E-SIGN gate before the code (P5, P7 step 9)', { retry: 0 }, () => {
  it('old tab (no esignConsentVersion), no consent on file -> 409 reload_required; the code is not checked; nothing written', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-old' }));
    const before = await customerRow('default');
    const res = await post('es-old', { otp: '000000' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(otp.verify).not.toHaveBeenCalled();
    expect(fault.reads).toBe(1);
    expect(await auditRows()).toEqual([]);
    expect(await outboxRows()).toEqual([]);
    expect(await customerRow('default')).toEqual(before);
    expect((await store.getTransfer('es-old'))?.status).toBe('awaiting_payment');
  });

  it.each([['a stale version', 'esign-2025-old'], ['an empty version', ''], ['a non-string', 42]])(
    '%s -> the same 409; the code is not checked',
    async (_l, esignConsentVersion) => {
      await seedCustomer('default');
      await store.saveTransfer(makeTransfer({ id: 'es-stale' }));
      const res = await post('es-stale', { otp: '000000', esignConsentVersion });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
      expect(otp.verify).not.toHaveBeenCalled();
      expect(await consentOnFile('default')).toBeNull();
    },
  );

  it('the current version -> paid; ONE customer.consent.esign row beside otp.verified; the customers row holds the version', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-ok' }));
    const res = await post('es-ok', { otp: '000000', esignConsentVersion: V });
    expect(await res.json()).toEqual({ ok: true, status: 'paid' });
    expect(otp.verify).toHaveBeenCalledOnce();
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['otp.verified', 'customer.consent.esign']));
    const consent = await consentRows();
    expect(consent).toHaveLength(1);
    expect(consent[0].partner_id).toBe('default');
    expect(consent[0].subject_id).toBe('es-ok');
    expect(consent[0].meta).toMatchObject({ version: V, surface: 'transfer', on: true, routeId: 'es-ok' });
    expect(typeof consent[0].meta.customerRef).toBe('string');
    expect(JSON.stringify(consent[0].meta)).not.toContain(SENDER);
    expect(await consentOnFile('default')).toBe(V);
  });

  it('consent already on file -> pays with no key; no new consent row; the customers row unchanged', async () => {
    await seedCustomer('default');
    await seedEsignConsentForTest(db, 'default', SENDER);
    fault.recordCalls = 0; // the seed itself wrote through the wrapped writer
    await store.saveTransfer(makeTransfer({ id: 'es-onfile' }));
    const before = await customerRow('default');
    const res = await post('es-onfile', { otp: '000000' });
    expect(await res.json()).toEqual({ ok: true, status: 'paid' });
    expect(await consentRows()).toEqual([]);
    const after = await customerRow('default');
    expect(after?.esign_consent_version).toEqual(before?.esign_consent_version);
    expect(after?.esign_consented_at).toEqual(before?.esign_consented_at);
    expect(after?.esign_withdrawn_at).toEqual(before?.esign_withdrawn_at);
    expect(fault.recordCalls).toBe(0);
  });

  it('consent withdrawn after it was given -> asked again (409 without the key)', async () => {
    await seedCustomer('default');
    await seedEsignConsentForTest(db, 'default', SENDER, { withdrawn: true });
    await store.saveTransfer(makeTransfer({ id: 'es-withdrawn' }));
    const res = await post('es-withdrawn', { otp: '000000' });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it('a consent on file for an OLDER version -> asked again', async () => {
    await seedCustomer('default');
    await seedEsignConsentForTest(db, 'default', SENDER, { version: 'esign-2025-old' });
    await store.saveTransfer(makeTransfer({ id: 'es-older' }));
    expect((await post('es-older', { otp: '000000' })).status).toBe(409);
    expect(await (await post('es-older', { otp: '000000', esignConsentVersion: V })).json()).toEqual({ ok: true, status: 'paid' });
    expect(await consentOnFile('default')).toBe(V);
  });

  it('the consent read throws -> 503 temporarily_unavailable; the code is not checked; the error name only in the log', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-readfail' }));
    fault.esignReadThrows = true;
    const before = consoleLines.length;
    const res = await post('es-readfail', { otp: '000000', esignConsentVersion: V });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable' });
    expect(otp.verify).not.toHaveBeenCalled();
    const lines = consoleLines.slice(before);
    expect(lines.some((l) => l.includes('pay.esign-gate') && l.includes('TypeError'))).toBe(true);
    for (const l of lines) expect(l).not.toContain('esign-read-secret');
    expect(await auditRows()).toEqual([]);
    expect(await outboxRows()).toEqual([]);
  });

  it('the consent write misses (both calls) -> 503 approval_not_recorded, never charged, ONE payevidence alert, no otp.verified and no consent row', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-miss' }));
    fault.recordMiss = true;
    // Review round 1 (RG2): the hour is read before and after the request; the key is one of them.
    const hourBefore = new Date().toISOString().slice(0, 13);
    const res = await post('es-miss', { otp: '000000', esignConsentVersion: V });
    const hourAfter = new Date().toISOString().slice(0, 13);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    expect(fault.recordCalls).toBe(2);
    const t = await store.getTransfer('es-miss');
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef).toBeFalsy();
    const alertRows = await outboxRows();
    expect(alertRows.map((r) => r.kind)).toEqual(['ops.alert']);
    expect([`payevidence:${hourBefore}`, `payevidence:${hourAfter}`]).toContain(alertRows[0].dedupe_key);
    // The evidence transaction rolled back whole (the pay-time re-screen's own row stays).
    expect((await auditRows()).map((r) => r.action).filter((a) => a === 'otp.verified' || a === 'customer.consent.esign')).toEqual([]);
    expect(await consentOnFile('default')).toBeNull();
  });

  it('a funded awaiting row with no key -> 409 with funded: true and the funded copy', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-funded' }));
    expect(await createTransferRepo(db).bindFundingIntent('es-funded', 'default', 'stripe', 'pi_es')).toBeTruthy();
    const res = await post('es-funded', { otp: '000000' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', funded: true, error: PAY_RELOAD_REQUIRED_FUNDED_COPY });
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it('a Partner-API-minted row opened on /pay is asked: no key -> 409; the version -> paid and recorded', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-api' }));
    await createIdempotencyRepo(db).claim('default', 'order-1', 'es-api');
    expect((await post('es-api', { otp: '000000' })).status).toBe(409);
    expect(otp.verify).not.toHaveBeenCalled();
    const res = await post('es-api', { otp: '000000', esignConsentVersion: V });
    expect(res.status).toBeLessThan(300);
    expect(await consentOnFile('default')).toBe(V);
    expect((await consentRows()).map((r) => r.subject_id)).toEqual(['es-api']);
  });

  it('request_otp with no consent on file -> 200 sent; the consent is never read (P0 rule 12)', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-otp' }));
    const res = await post('es-otp', { action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(fault.reads).toBe(0);
  });
});

describe('transfer pay route, b2b rows: only an ACH debit is exempt (D2)', { retry: 0 }, () => {
  it('a b2b ach_pull row: never asked, the consent never read', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-ach', ...B2B, fundingMethod: 'ach_pull', amountUsd: 5000 }));
    const res = await post('es-ach', { otp: '000000', ach: ACH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });
    expect(fault.reads).toBe(0);
    expect(await consentRows()).toEqual([]);
  });

  it('a b2b ach_pull draft: never asked', async () => {
    await seedCustomer('default');
    const draftId = await makeDraft({
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Buyer Co', recipientBusinessName: 'Seller Co', fundingMethod: 'ach_pull',
    });
    const res = await post(draftId, { otp: '000000', ach: ACH });
    expect((await res.json()).reason).not.toBe('reload_required');
    expect(res.status).not.toBe(503);
    expect(fault.reads).toBe(0);
    expect(otp.verify).toHaveBeenCalledOnce();
  });

  it('a b2b row that is NOT ach_pull (critic C2): no key -> 409; the version -> paid and recorded on (owner, the row phone)', async () => {
    await seedCustomer('default');
    await store.saveTransfer(makeTransfer({ id: 'es-b2b', ...B2B }));
    const refused = await post('es-b2b', { otp: '000000' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).reason).toBe('reload_required');
    expect(otp.verify).not.toHaveBeenCalled();
    const res = await post('es-b2b', { otp: '000000', esignConsentVersion: V });
    expect(res.status).toBeLessThan(300);
    expect(await consentOnFile('default')).toBe(V);
    const consent = await consentRows();
    expect(consent.map((r) => [r.partner_id, r.subject_id])).toEqual([['default', 'es-b2b']]);
  });

  it('a non-ACH b2b row whose sender has NO customers row, the version posted (critic C10) -> paid; the evidence commit created the row and recorded the consent', async () => {
    // No seedCustomer: the default tenant has no send gate and a b2b payer is not
    // asked for a sender name, so the row reaches the evidence commit without a customer.
    await store.saveTransfer(makeTransfer({ id: 'es-nocust', ...B2B }));
    expect(await customerRow('default')).toBeNull();
    const res = await post('es-nocust', { otp: '000000', esignConsentVersion: V });
    expect(res.status).toBeLessThan(300);
    expect(await consentOnFile('default')).toBe(V);
    expect(await consentRows()).toHaveLength(1);
    expect(fault.recordCalls).toBe(2); // the first write missed (no row), ensureCustomer, then written
  });

  it('a non-ACH b2b draft is asked the same way', async () => {
    await seedCustomer('default');
    const draftId = await makeDraft({
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Buyer Co', recipientBusinessName: 'Seller Co',
    });
    const res = await post(draftId, { otp: '000000' });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(otp.verify).not.toHaveBeenCalled();
    expect(fin.calls).toBe(0);
  });
});

describe('transfer pay route, draft branch (P5)', { retry: 0 }, () => {
  it('no key -> 409 (never funded); the code is not checked; nothing minted', async () => {
    await seedCustomer('default');
    const draftId = await makeDraft();
    const res = await post(draftId, { otp: '000000' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(otp.verify).not.toHaveBeenCalled();
    expect(fin.calls).toBe(0);
    expect(await store.listTransfers()).toEqual([]);
  });

  it('the version -> minted and paid; consent recorded for (draft tenant, sender); meta.routeId the DRAFT id, subject the minted transfer', async () => {
    await seedCustomer('default');
    const draftId = await makeDraft();
    const res = await post(draftId, { otp: '000000', esignConsentVersion: V });
    expect(res.status).toBe(200);
    const [created] = await store.listTransfers();
    expect(created).toBeDefined();
    expect(created.id).not.toBe(draftId);
    const consent = await consentRows();
    expect(consent).toHaveLength(1);
    expect(consent[0].subject_id).toBe(created.id);
    expect(consent[0].meta).toMatchObject({ version: V, surface: 'transfer', on: true, routeId: draftId });
    expect(await consentOnFile('default')).toBe(V);
  });

  it('a draft whose owner cannot be resolved -> 503 temporarily_unavailable; the code is not checked; finalize never runs; the rejection text never logged', async () => {
    const draftId = await makeDraft({ partnerId: undefined });
    vi.spyOn(store, 'legacyTenantOf').mockRejectedValue(new Error('legacy-reject-secret postgres://u:p@h/db'));
    const before = consoleLines.length;
    const res = await post(draftId, { otp: '000000', esignConsentVersion: V });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable' });
    expect(otp.verify).not.toHaveBeenCalled();
    expect(fin.calls).toBe(0);
    expect(fault.reads).toBe(0);
    for (const l of consoleLines.slice(before)) {
      expect(l).not.toContain('legacy-reject-secret');
      expect(l).not.toContain('postgres://');
    }
  });
});

describe('order (P7): every cheaper pre-verify check answers before the E-SIGN gate', { retry: 0 }, () => {
  it('an unapproved disclosure on a real-money owner -> the R18 answer; the consent never read', async () => {
    await liveOwner({ approvedDisclosure: false });
    await store.saveTransfer(makeTransfer({ id: 'es-r18', partnerId: 'acme' }));
    const res = await post('es-r18', realMoneyPayBody({ senderAddress: '42 Invented Lane, Fakeville 99999' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('not_available');
    expect(fault.reads).toBe(0);
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it('a mock-funded real-money row -> the money gate 409 not_available first', async () => {
    await liveOwner();
    funding.refuse = true;
    await store.saveTransfer(makeTransfer({ id: 'es-money', partnerId: 'acme' }));
    const res = await post('es-money', realMoneyPayBody({ senderAddress: '42 Invented Lane, Fakeville 99999' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('not_available');
    expect(fault.reads).toBe(0);
  });

  it('a bad accountHolder -> 400 first', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'es-holder', partnerId: 'acme', recipientLegalName: undefined }));
    const res = await post('es-holder', { ...realMoneyPayBody({ senderAddress: '42 Invented Lane, Fakeville 99999' }), accountHolder: 42 });
    expect(res.status).toBe(400);
    expect(fault.reads).toBe(0);
  });

  it('a bad senderAddress -> 400 originator_invalid first', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'es-addr', partnerId: 'acme' }));
    const res = await post('es-addr', realMoneyPayBody({ senderAddress: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('originator_invalid');
    expect(fault.reads).toBe(0);
  });

  it('every earlier check passes, no key -> the E-SIGN 409 (the consent read once); with the version -> paid on the real-money owner', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'es-live', partnerId: 'acme' }));
    const body = realMoneyPayBody({ senderAddress: '42 Invented Lane, Fakeville 99999' });
    const refused = await post('es-live', body);
    expect(refused.status).toBe(409);
    expect((await refused.json()).reason).toBe('reload_required');
    expect(fault.reads).toBe(1);
    expect(otp.verify).not.toHaveBeenCalled();
    const res = await post('es-live', { ...body, esignConsentVersion: V });
    expect(res.status).toBeLessThan(300);
    expect(await consentOnFile('acme')).toBe(V);
    expect(await consentOnFile('default')).toBeNull();
  });
});
