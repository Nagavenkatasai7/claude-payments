/**
 * Fix pack 5 T21a (R38, P19, P21): the transfer pay route asks the sender's
 * home address (always) and date of birth (in the DOB band) ONCE on a
 * real-money b2c payment.
 *   - pre-verify, after R18 and the T13b money gate and the account-holder
 *     rule: a field asked with its key absent -> 409 reload; a bad value ->
 *     400 originator_invalid on that field; the code is not checked;
 *   - after the code: written set-if-unset on the OWNER's customer row (one
 *     customer.travel_rule_set audit row) BEFORE the re-screen; a throw ->
 *     503 approval_not_recorded + the payevidence alert, never charged;
 *   - draft branch: the finalizer writes them before its claim;
 *   - exempt, routed, b2b, default-tenant and on-file payments are never asked.
 * The typed values never reach a log line, an outbox payload or an audit meta.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, seedOriginatorForTest } from './helpers-live';
import { okVerify, realMoneyPayBody } from './helpers-pay-evidence';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import {
  PAY_APPROVAL_NOT_RECORDED_COPY,
  PAY_RELOAD_REQUIRED_COPY,
  PAY_SENDER_ADDRESS_INVALID_COPY,
  PAY_SENDER_DOB_INVALID_COPY,
} from '@/lib/pay-outcome';
import { ORIGINATOR_INFO_MISSING_REASON } from '@/lib/compliance-config';
import type { CountryCode, Draft, Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

// Fix pack 5 T13a: this file tests the originator rule, not the funding rule; stands in for a
// Stripe-funded row (the mock-funding refusal is pinned in tests/pay-funding-refusal.test.ts).
// `funding.refuse` turns the real refusal back on for the order case.
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
// The call order of the write and the re-screen, and a write fault.
const seam = vi.hoisted(() => ({ order: [] as string[], writeThrows: false, finalizeOpts: [] as unknown[] }));
vi.mock('@/lib/originator-info', async (orig) => {
  const real = await orig<typeof import('@/lib/originator-info')>();
  return {
    ...real,
    writeOriginatorInfo: async (...a: Parameters<typeof real.writeOriginatorInfo>) => {
      seam.order.push('writeOriginatorInfo');
      if (seam.writeThrows) throw new TypeError('originator-write-secret');
      return real.writeOriginatorInfo(...a);
    },
  };
});
vi.mock('@/lib/pay-rescreen', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-rescreen')>();
  return {
    ...real,
    rescreenBeforePay: async (...a: Parameters<typeof real.rescreenBeforePay>) => {
      seam.order.push('rescreenBeforePay');
      return real.rescreenBeforePay(...a);
    },
  };
});
vi.mock('@/lib/pay-finalize', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-finalize')>();
  return {
    ...real,
    finalizeDraftPayment: async (...a: Parameters<typeof real.finalizeDraftPayment>) => {
      seam.finalizeOpts.push(a[3]);
      return real.finalizeDraftPayment(...a);
    },
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';

const OWNER = 'acme';
const SENDER = '15551234567';
const RP = '919876543210';
const ACCOUNT = '123456789012|HDFC0001234';
const H = 3_600_000;
const HTTP_RAIL: PartnerIntegrations['payment'] = {
  providerType: 'http',
  credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' },
};
const ADDRESS = '42 Invented Lane, Fakeville 99999';
const yearsAgo = (y: number, extraDays = 0) =>
  new Date(Date.now() - (y * 365.25 + extraDays) * 86_400_000).toISOString().slice(0, 10);
const DOB = yearsAgo(41, 30);
const MINOR_DOB = yearsAgo(16);

const consoleLines: string[] = [];
const PII = [ADDRESS, DOB, '42 Invented', SENDER];

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

/** The real-money body without the originator keys (an old tab). */
const oldTab = () => realMoneyPayBody({ originator: false });

async function seedOwner(partnerId: string) {
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: SENDER, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso, fullName: 'Alex Sender',
  });
}

/** OWNER: certified with an approved provider block, on an http rail, live OFAC list; nothing on file. */
async function liveOwner(o: { approvedDisclosure?: boolean } = {}) {
  await seedPartner(db, OWNER, 'Acme');
  await certifyPartnerForTest(db, OWNER, { approvedDisclosure: o.approvedDisclosure ?? true });
  await setRailProviderType(db, OWNER, 'http');
  rails.byPartner[OWNER] = HTTP_RAIL;
  primeOfacSource({ checkedAgoMs: H });
  await seedOwner(OWNER);
}

const onFile = (partnerId = OWNER) => createCustomerRepo(db, async () => null).originatorOnFile(partnerId, SENDER);

async function travelRuleRows() {
  const r = (await db.execute(
    sql`SELECT partner_id, actor, meta FROM audit_events WHERE action = 'customer.travel_rule_set' ORDER BY id`,
  )) as unknown as { rows: Array<{ partner_id: string; actor: string; meta: unknown }> };
  return r.rows;
}
async function outboxRows() {
  const r = (await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox ORDER BY id`)) as unknown as {
    rows: Array<{ kind: string; dedupe_key: string | null; payload: unknown }>;
  };
  return r.rows;
}
async function allAuditMeta(): Promise<string> {
  const r = (await db.execute(sql`SELECT meta FROM audit_events`)) as unknown as { rows: Array<{ meta: unknown }> };
  return JSON.stringify(r.rows);
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

const originalList = process.env.SANCTIONS_LIST;
beforeEach(async () => {
  rails.byPartner = {};
  funding.refuse = false;
  seam.order = [];
  seam.writeThrows = false;
  seam.finalizeOpts = [];
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
  // The typed address and DOB (and the phone) never reach a console line in this file.
  for (const line of consoleLines) {
    for (const p of PII) expect(line).not.toContain(p);
  }
});

describe('pay route, existing transfer, real money: the originator rule before the code (P21)', { retry: 0 }, () => {
  it('no address on file, body without senderAddress -> 409 reload_required; the code is not checked', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'or-old-tab' }));
    const res = await post('or-old-tab', oldTab());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(otp.verify).not.toHaveBeenCalled();
    expect(await travelRuleRows()).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['a non-string', 42],
    ['301 characters', 'A'.repeat(301)],
    ['a web address', '1 Main St, see https://example.test'],
  ])('senderAddress %s -> 400 originator_invalid on senderAddress; the code is not checked', async (_l, senderAddress) => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'or-bad' }));
    const res = await post('or-bad', { ...oldTab(), senderAddress });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'originator_invalid', fieldErrors: { senderAddress: PAY_SENDER_ADDRESS_INVALID_COPY } });
    expect(otp.verify).not.toHaveBeenCalled();
    expect((await onFile()).address).toBe(false);
  });

  it('DOB band ($1,500 to DE): senderDob missing -> 409 (before the address 400); a bad date or an age under 18 -> 400 on senderDob', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'or-dob', amountUsd: 1500, destinationCountry: 'DE' as CountryCode }));
    const missing = await post('or-dob', { ...oldTab(), senderAddress: '' });
    expect(missing.status).toBe(409);
    expect((await missing.json()).reason).toBe('reload_required');
    for (const senderDob of ['1990-02-30', MINOR_DOB, 19900101]) {
      const res = await post('or-dob', { ...oldTab(), senderAddress: ADDRESS, senderDob });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'originator_invalid', fieldErrors: { senderDob: PAY_SENDER_DOB_INVALID_COPY } });
    }
    expect(otp.verify).not.toHaveBeenCalled();
    expect(await onFile()).toEqual({ address: false, dateOfBirth: false });
  });

  it('valid values -> 2xx; the OWNER customer row has the address; ONE customer.travel_rule_set row; written before the re-screen', async () => {
    await liveOwner();
    await seedPartner(db, 'beta');
    await store.saveTransfer(makeTransfer({ id: 'or-ok' }));
    const res = await post('or-ok', realMoneyPayBody({ senderAddress: `  ${ADDRESS} ` }));
    expect(await res.json()).toEqual({ ok: true, status: 'processing' });
    expect(await onFile()).toEqual({ address: true, dateOfBirth: false });
    expect(await onFile('beta')).toEqual({ address: false, dateOfBirth: false });
    expect(await travelRuleRows()).toEqual([
      { partner_id: OWNER, actor: 'pay-page', meta: { source: 'pay_page', fields: ['address'], transferId: 'or-ok' } },
    ]);
    expect(seam.order).toEqual(['writeOriginatorInfo', 'rescreenBeforePay']);
    const t = await store.getTransfer('or-ok');
    expect(t?.status).toBe('paid');
    expect(t?.complianceReasons).not.toContain(ORIGINATOR_INFO_MISSING_REASON);
    // The sealed value is the trimmed one.
    const customer = await customerStore.getCustomer(OWNER, SENDER);
    expect(customer?.residentialAddress).toBe(ADDRESS);
  });

  it('DOB band: valid address and DOB -> both sealed columns and fields [address, date_of_birth]', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'or-both', amountUsd: 3000 }));
    const res = await post('or-both', realMoneyPayBody({ senderAddress: ADDRESS, senderDob: DOB }));
    expect(res.status).toBeLessThan(300);
    expect(await onFile()).toEqual({ address: true, dateOfBirth: true });
    const customer = await customerStore.getCustomer(OWNER, SENDER);
    expect(customer?.dateOfBirth).toBe(DOB);
    expect((await travelRuleRows()).map((r) => r.meta)).toEqual([
      { source: 'pay_page', fields: ['address', 'date_of_birth'], transferId: 'or-both' },
    ]);
  });

  it('an address already on file: the key may be absent; a typed value is ignored (no write, no audit row)', async () => {
    await liveOwner();
    await seedOriginatorForTest(db, OWNER, SENDER, { address: true });
    await store.saveTransfer(makeTransfer({ id: 'or-onfile-1' }));
    expect(await (await post('or-onfile-1', oldTab())).json()).toEqual({ ok: true, status: 'processing' });
    await store.saveTransfer(makeTransfer({ id: 'or-onfile-2' }));
    expect(await (await post('or-onfile-2', realMoneyPayBody({ senderAddress: 'x' }))).json()).toEqual({ ok: true, status: 'processing' });
    expect(seam.order).not.toContain('writeOriginatorInfo');
    expect(await travelRuleRows()).toEqual([]);
    expect((await customerStore.getCustomer(OWNER, SENDER))?.residentialAddress).toBe('1 Test Street, Testville');
  });

  it('writeOriginatorInfo throws -> 503 approval_not_recorded, never charged, still awaiting, ONE payevidence alert, the error name only', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'or-throw' }));
    seam.writeThrows = true;
    const before = consoleLines.length;
    const res = await post('or-throw', realMoneyPayBody({ senderAddress: ADDRESS }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    expect(otp.verify).toHaveBeenCalledOnce();
    const t = await store.getTransfer('or-throw');
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef).toBeFalsy();
    expect(seam.order).toEqual(['writeOriginatorInfo']); // never re-screened or charged
    const rows = await outboxRows();
    expect(rows.map((r) => [r.kind, r.dedupe_key])).toEqual([['ops.alert', `payevidence:${new Date().toISOString().slice(0, 13)}`]]);
    const lines = consoleLines.slice(before);
    expect(lines.filter((l) => l.includes('pay.originator_write'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('pay.originator_write'))).toContain('TypeError');
    for (const l of lines) {
      expect(l).not.toContain('originator-write-secret');
      expect(l).not.toContain('pay.route');
    }
  });

  it('a funded row: the write 503 carries funded: true (payFunded)', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'or-funded' }));
    expect(await createTransferRepo(db).bindFundingIntent('or-funded', OWNER, 'stripe', 'pi_or')).toBeTruthy();
    seam.writeThrows = true;
    const res = await post('or-funded', realMoneyPayBody({ senderAddress: ADDRESS }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'approval_not_recorded', funded: true });
  });

  it('the typed address and DOB never appear in an outbox payload or an audit meta', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'or-nopii', amountUsd: 3000 }));
    await post('or-nopii', realMoneyPayBody({ senderAddress: ADDRESS, senderDob: DOB }));
    const outbox = JSON.stringify(await outboxRows());
    const meta = await allAuditMeta();
    for (const p of [ADDRESS, DOB, '42 Invented']) {
      expect(outbox).not.toContain(p);
      expect(meta).not.toContain(p);
    }
  });

  it('a Partner-API-minted real-money row with no key -> pays (exempt), nothing written', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'or-api' }));
    await createIdempotencyRepo(db).claim(OWNER, 'order-1', 'or-api');
    expect(await (await post('or-api', oldTab())).json()).toEqual({ ok: true, status: 'processing' });
    expect(await travelRuleRows()).toEqual([]);
  });

  it('a routed real-money row with nothing on file and no keys -> not refused by this rule (never asked); held at settle (T20b)', async () => {
    await liveOwner();
    await seedPartner(db, 'beta', 'Beta');
    await certifyPartnerForTest(db, 'beta', { approvedDisclosure: true });
    await setRailProviderType(db, 'beta', 'http');
    rails.byPartner.beta = HTTP_RAIL;
    await store.saveTransfer(makeTransfer({ id: 'or-routed', settlementPartnerId: 'beta' }));
    const res = await post('or-routed', oldTab());
    const body = (await res.json()) as { reason?: string; fieldErrors?: unknown };
    expect(body.reason).not.toBe('reload_required');
    expect(body.fieldErrors).toBeUndefined();
    expect(otp.verify).toHaveBeenCalledOnce();
    expect(await travelRuleRows()).toEqual([]);
    expect((await store.getTransfer('or-routed'))?.complianceReasons).toContain(ORIGINATOR_INFO_MISSING_REASON);
  });

  it('order: an unapproved disclosure gets the R18 answer, a mock-funded real-money row the T13b 409, before this rule', async () => {
    await liveOwner({ approvedDisclosure: false });
    await store.saveTransfer(makeTransfer({ id: 'or-r18' }));
    const r18 = await post('or-r18', { ...oldTab(), senderAddress: '' });
    expect(r18.status).toBe(409);
    expect((await r18.json()).reason).toBe('not_available');

    await certifyPartnerForTest(db, OWNER, { approvedDisclosure: true });
    funding.refuse = true;
    const money = await post('or-r18', { ...oldTab(), senderAddress: '' });
    expect(money.status).toBe(409);
    expect((await money.json()).reason).toBe('not_available');
    expect(otp.verify).not.toHaveBeenCalled();
  });
});

describe('pay route, not real money: no field, no read (P0 rule 3)', { retry: 0 }, () => {
  it('default tenant, old tab without the keys -> pays as before and makes NO originator read', async () => {
    await seedOwner('default');
    await store.saveTransfer(makeTransfer({ id: 'or-def', partnerId: 'default' }));
    const stop = captureQueries();
    let qs: Array<{ sql: string }> = [];
    try {
      expect(await (await post('or-def', { otp: '000000' })).json()).toEqual({ ok: true, status: 'paid' });
    } finally {
      qs = stop();
    }
    expect(qs.filter((q) => /"residential_address_enc" IS NOT NULL/i.test(q.sql))).toEqual([]);
    expect(await travelRuleRows()).toEqual([]);
  });

  it('default tenant: a typed value is ignored (never validated, never written)', async () => {
    await seedOwner('default');
    await store.saveTransfer(makeTransfer({ id: 'or-def-typed', partnerId: 'default' }));
    expect(await (await post('or-def-typed', { otp: '000000', senderAddress: 'x', senderDob: 'bad' })).json()).toEqual({ ok: true, status: 'paid' });
    expect(await travelRuleRows()).toEqual([]);
  });

  it('simulator rail of a non-default owner -> no field, no read', async () => {
    await seedPartner(db, 'simco', 'Simco');
    await setRailProviderType(db, 'simco', 'simulator');
    await seedOwner('simco');
    await store.saveTransfer(makeTransfer({ id: 'or-sim', partnerId: 'simco' }));
    const stop = captureQueries();
    let qs: Array<{ sql: string }> = [];
    let res: Response;
    try {
      res = await post('or-sim', { otp: '000000' });
    } finally {
      qs = stop();
    }
    const body = (await res.json()) as { reason?: string; fieldErrors?: unknown };
    expect(body.reason).not.toBe('reload_required');
    expect(body.fieldErrors).toBeUndefined();
    expect(otp.verify).toHaveBeenCalledOnce();
    expect(qs.filter((q) => /"residential_address_enc" IS NOT NULL/i.test(q.sql))).toEqual([]);
  });
});

describe('pay route, draft branch, real money (P21)', { retry: 0 }, () => {
  it('the values reach finalizeDraftPayment opts.originator; the owner customer has them; the mint follows', async () => {
    await liveOwner();
    const draftId = await makeDraft({ amountUsd: 200 });
    const res = await post(draftId, realMoneyPayBody({ senderAddress: ADDRESS }));
    expect(res.status).toBe(200);
    // The draft carries its own legal name, so no account-holder name rides along.
    expect(seam.finalizeOpts).toEqual([{ originator: { address: ADDRESS } }]);
    expect(await onFile()).toEqual({ address: true, dateOfBirth: false });
    const [created] = await store.listTransfers();
    expect(created).toBeDefined();
    expect((await travelRuleRows()).map((r) => r.meta)).toEqual([{ source: 'pay_page', fields: ['address'], routeId: draftId }]);
    expect(seam.order.indexOf('writeOriginatorInfo')).toBe(0);
  });

  it('a draft with no key -> 409 reload; the code is not checked, nothing minted', async () => {
    await liveOwner();
    const draftId = await makeDraft();
    const res = await post(draftId, oldTab());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(otp.verify).not.toHaveBeenCalled();
    expect(await store.listTransfers()).toEqual([]);
  });

  it("the finalizer's write throws -> 'originator_not_recorded' -> 503 + the payevidence alert; nothing minted", async () => {
    await liveOwner();
    const draftId = await makeDraft();
    seam.writeThrows = true;
    const res = await post(draftId, realMoneyPayBody({ senderAddress: ADDRESS }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    expect(await store.listTransfers()).toEqual([]);
    const rows = await outboxRows();
    expect(rows.map((r) => r.kind)).toEqual(['ops.alert']);
    expect(rows[0].dedupe_key).toMatch(/^payevidence:/);
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM idempotency_keys`)) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows[0].n).toBe(0); // nothing claimed
  });

  it('a b2b draft is never asked: the absent keys go through to the code and the finalizer', async () => {
    await liveOwner();
    const draftId = await makeDraft({
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Buyer Co', recipientBusinessName: 'Seller Co',
    });
    const res = await post(draftId, oldTab());
    const body = (await res.json()) as { reason?: string; fieldErrors?: Record<string, string> };
    expect(body.reason).not.toBe('reload_required');
    expect(body.fieldErrors?.senderAddress).toBeUndefined();
    expect(otp.verify).toHaveBeenCalledTimes(1);
    expect(seam.finalizeOpts).toEqual([undefined]);
  });
});
