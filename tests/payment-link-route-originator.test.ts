/**
 * Fix pack 5 T22 (R38, P19, P21): the payment-link route asks the paying
 * customer's home address (always) and date of birth (in the DOB band) on a
 * real-money link, exactly like the transfer pay route.
 *   - pre-verify, after the R18 refusals and the T13b money gate: a field asked
 *     with its key absent -> 409 reload; a bad value -> 400 originator_invalid
 *     on that field; the code is not checked, nothing minted;
 *   - after the code: finalizeLinkPayment writes the values on the link owner's
 *     customer (one customer.travel_rule_set row, source 'payment_link') before
 *     the mint (fresh) or the re-screen (resume); a throw -> 503
 *     approval_not_recorded + the payevidence alert (surface 'link');
 *   - the default owner and the simulator rail are never asked and make no read.
 * The typed values never reach a log line, an outbox payload or an audit meta.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { createLinkQuoteStore } from '@/lib/payment-link-quote';
import { invalidateFlagCache } from '@/lib/flags';
import { DISCLOSURE_DRAFT_VERSION } from '@/lib/legal/disclosure-drafts';
import { linkExpiresAt, newLinkToken } from '@/lib/payment-links';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import {
  PAY_APPROVAL_NOT_RECORDED_COPY,
  PAY_RELOAD_REQUIRED_COPY,
  PAY_SENDER_ADDRESS_INVALID_COPY,
  PAY_SENDER_DOB_INVALID_COPY,
} from '@/lib/pay-outcome';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, seedOriginatorForTest } from './helpers-live';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import type { Customer } from '@/lib/types';

// Fix pack 5 T13a: this file tests the originator rule, not the funding rule; stands in for a
// Stripe-funded row (the mock-funding refusal is pinned in tests/pay-funding-refusal.test.ts).
vi.mock('@/lib/funding-class', async (orig) => ({
  ...(await orig<typeof import('@/lib/funding-class')>()),
  payFundingRefusal: () => false,
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

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let partnerStore: ReturnType<typeof createPartnerStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
let quotes: ReturnType<typeof createLinkQuoteStore>;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => partnerStore }));
vi.mock('@/lib/monthly-volume-store', async (orig) => ({ ...(await orig<typeof import('@/lib/monthly-volume-store')>()), getMonthlyVolumeStore: () => createMonthlyVolumeStore(store) }));
vi.mock('@/lib/daily-volume-store', async (orig) => ({ ...(await orig<typeof import('@/lib/daily-volume-store')>()), getDailyVolumeStore: () => createDailyVolumeStore(store) }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
vi.mock('@/lib/payment-link-quote', async (orig) => ({ ...(await orig<typeof import('@/lib/payment-link-quote')>()), getLinkQuoteStore: () => quotes }));
const linkRails = vi.hoisted(() => ({ byPartner: {} as Record<string, unknown> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (id: string) => ({ kyc: {}, payment: linkRails.byPartner[id] ?? {}, whatsapp: {} }),
    getFundingConfig: async () => null,
  }),
}));
const funding = vi.hoisted(() => ({ decline: false }));
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return {
    ...real,
    getFundingProvider: () => {
      const p = real.getFundingProvider();
      const capture = p.capture.bind(p);
      p.capture = async (t) => {
        if (funding.decline) throw new Error('card declined');
        return capture(t);
      };
      return p;
    },
  };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
// A certified owner never sends codes on the shared number; 'acme' is given it here.
vi.mock('@/lib/direct-otp-channel', async (orig) => ({
  ...(await orig<typeof import('@/lib/direct-otp-channel')>()),
  resolveDirectOtpChannel: () => Promise.resolve({ ok: true as const, creds: undefined }),
}));
// The order of the write, the mint and the re-screen, and a write fault.
const seam = vi.hoisted(() => ({ order: [] as string[], writeThrows: false }));
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
vi.mock('@/lib/transfer-create', async (orig) => {
  const real = await orig<typeof import('@/lib/transfer-create')>();
  return {
    ...real,
    createTransfer: async (...a: Parameters<typeof real.createTransfer>) => {
      seam.order.push('createTransfer');
      return real.createTransfer(...a);
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

import { POST } from '@/app/api/pay/l/[token]/route';

const OWNER = 'acme';
const PHONE = '14155550100';
const LINK_ID = 'pl_orig1';
const H = 3_600_000;
const HTTP_RAIL = { providerType: 'http', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } };
const ADDRESS = '7 Invented Close, Mockford 11111';
const yearsAgo = (y: number, extraDays = 0) =>
  new Date(Date.now() - (y * 365.25 + extraDays) * 86_400_000).toISOString().slice(0, 10);
const DOB = yearsAgo(39, 20);
const PII = [ADDRESS, DOB, '7 Invented', PHONE];
const consoleLines: string[] = [];

let token: string;
let lockedAt: string;

const call = (b: object, t = token) =>
  POST(
    new NextRequest(`http://x/api/pay/l/${t}`, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ token: t }) },
  );
const count = async (q: string) => Number(((await db.execute(sql.raw(q))) as unknown as { rows: Array<{ n: number }> }).rows[0].n);
const transfersN = () => count('SELECT count(*)::int AS n FROM transfers');
const linkStatus = async () =>
  ((await db.execute(sql.raw(`SELECT status FROM payment_links WHERE id = '${LINK_ID}'`))) as unknown as { rows: Array<{ status: string }> }).rows[0].status;
const onFile = (partnerId = OWNER) => createCustomerRepo(db, async () => null).originatorOnFile(partnerId, PHONE);
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
const disclosureHash = async (partnerId = OWNER) => resolvePartnerDisclosure(await createPartnerRepo(db).getPartner(partnerId)).hash ?? undefined;

/** The complete pay body of a real-money link, with the originator keys given (or none: an old tab). */
async function payBody(o: { senderAddress?: unknown; senderDob?: unknown } = {}) {
  return {
    otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt,
    disclosureVersion: DISCLOSURE_DRAFT_VERSION, disclosureHash: await disclosureHash(), ...o,
  };
}

async function seedLink(partnerId: string) {
  const now = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: now, kycStatus: 'verified', fullName: 'Asha Patel', senderCountry: 'US',
    partnerId, createdAt: now, updatedAt: now,
  } as Customer);
  const payees = createPayeeRepo(db);
  await payees.insert({
    id: `pye_${partnerId}`, partnerId, legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
    payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
  });
  await payees.decide(`pye_${partnerId}`, ['pending'], 'approved', 'admin');
  token = newLinkToken();
  await createPaymentLinkRepo(db).insertLinks([{
    id: LINK_ID, partnerId, payeeId: `pye_${partnerId}`, token, reference: 'INV-5', customerName: 'Asha Patel',
    customerPhone: PHONE, amountInr: 25000, purpose: 'education', expiresAt: linkExpiresAt(), createdBy: 'pa',
  }]);
  lockedAt = (await quotes.lock(LINK_ID, { toInr: 85, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' })).lockedAt;
}

/** A fresh code for the link (a fresh OTP store: no issue cooldown, the last code was spent). */
async function freshCode() {
  txOtp = createTransactionOtpStore(fakeRedis(), { randomInt: () => 654321 });
  await txOtp.issue(`paylink:${LINK_ID}`, PHONE);
}

/** OWNER: certified with an approved block, on a signed http rail, a live OFAC list; nothing on file. */
async function liveOwner() {
  await seedPartner(db, OWNER, 'Acme');
  await certifyPartnerForTest(db, OWNER, { approvedDisclosure: true });
  await setRailProviderType(db, OWNER, 'http');
  linkRails.byPartner[OWNER] = HTTP_RAIL;
  primeOfacSource({ checkedAgoMs: H });
  await seedLink(OWNER);
  await freshCode();
}

/** A first attempt whose charge is declined: a minted, unpaid link transfer. */
async function mintedUnpaid(): Promise<string> {
  funding.decline = true;
  const first = await call(await payBody({ senderAddress: ADDRESS }));
  expect(first.status).toBe(402);
  funding.decline = false;
  seam.order = [];
  await freshCode();
  return ((await db.execute(sql.raw('SELECT id FROM transfers'))) as unknown as { rows: Array<{ id: string }> }).rows[0].id;
}

const originalList = process.env.SANCTIONS_LIST;
beforeEach(async () => {
  vi.stubEnv('DEMO_PHONES', '*');
  linkRails.byPartner = {};
  funding.decline = false;
  seam.order = [];
  seam.writeThrows = false;
  const r = fakeRedis();
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(r, db);
  customerStore = createCustomerStore(db, store);
  partnerStore = createPartnerStore(db);
  txOtp = createTransactionOtpStore(r, { randomInt: () => 654321 });
  quotes = createLinkQuoteStore(r);
  await createFeatureFlagRepo(db).upsert({ key: 'paylinks.enabled', scopeType: 'global', scopeId: '', enabled: true, reason: 't', updatedBy: 'admin' });
  invalidateFlagCache(db);
  const keep = (...a: unknown[]) => { consoleLines.push(a.map(String).join(' ')); };
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  vi.spyOn(console, 'log').mockImplementation(keep);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  restoreOfacSource(originalList);
});
afterAll(() => {
  // The typed address and DOB (and the phone) never reach a console line in this file.
  for (const line of consoleLines) {
    for (const p of PII) expect(line).not.toContain(p);
  }
});

describe('link route, real money: the originator rule before the code (P21)', { retry: 0 }, () => {
  it('no address on file, body without senderAddress -> 409 reload_required, the code not checked, nothing minted, the link stays open', async () => {
    await liveOwner();
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await call(await payBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(verify).not.toHaveBeenCalled();
    expect(await transfersN()).toBe(0);
    expect(await linkStatus()).toBe('open');
    expect(await travelRuleRows()).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['a non-string', 42],
    ['301 characters', 'A'.repeat(301)],
  ])('senderAddress %s -> 400 originator_invalid on senderAddress; the code not checked', async (_l, senderAddress) => {
    await liveOwner();
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await call(await payBody({ senderAddress }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'originator_invalid', fieldErrors: { senderAddress: PAY_SENDER_ADDRESS_INVALID_COPY } });
    expect(verify).not.toHaveBeenCalled();
    expect(await transfersN()).toBe(0);
    expect((await onFile()).address).toBe(false);
  });

  it('valid address -> 2xx; ONE customer.travel_rule_set row { source payment_link, fields [address], routeId: link id }; written before the mint', async () => {
    await liveOwner();
    await seedPartner(db, 'beta');
    const res = await call(await payBody({ senderAddress: `  ${ADDRESS} ` }));
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { ok: boolean; transferId: string };
    expect(body.ok).toBe(true);
    expect(await onFile()).toEqual({ address: true, dateOfBirth: false });
    expect(await onFile('beta')).toEqual({ address: false, dateOfBirth: false });
    expect(await travelRuleRows()).toEqual([
      { partner_id: OWNER, actor: 'pay-page', meta: { source: 'payment_link', fields: ['address'], routeId: LINK_ID } },
    ]);
    expect(seam.order.slice(0, 2)).toEqual(['writeOriginatorInfo', 'createTransfer']);
    expect((await customerStore.getCustomer(OWNER, PHONE))?.residentialAddress).toBe(ADDRESS);
  });

  it('a resume: the band is the minted row amountUsd (DOB at $3,000); the write happens before the re-screen', async () => {
    await liveOwner();
    // The first attempt stores the address; the declined charge leaves the row awaiting.
    const tid = await mintedUnpaid();
    await db.execute(sql`UPDATE transfers SET amount_usd = 3000 WHERE id = ${tid}`);
    // The DOB band now asks the date of birth: an old tab without it -> 409.
    const missing = await call(await payBody());
    expect(missing.status).toBe(409);
    expect((await missing.json()).reason).toBe('reload_required');
    const bad = await call(await payBody({ senderDob: 'not-a-date' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'originator_invalid', fieldErrors: { senderDob: PAY_SENDER_DOB_INVALID_COPY } });
    const ok = await call(await payBody({ senderDob: DOB }));
    expect(ok.status).toBeLessThan(300);
    expect(seam.order.slice(0, 2)).toEqual(['writeOriginatorInfo', 'rescreenBeforePay']);
    expect(await onFile()).toEqual({ address: true, dateOfBirth: true });
    expect((await travelRuleRows()).map((r) => r.meta)).toEqual([
      { source: 'payment_link', fields: ['address'], routeId: LINK_ID },
      { source: 'payment_link', fields: ['date_of_birth'], transferId: tid, routeId: LINK_ID },
    ]);
  });

  it('a resume of a funded row: the 409 carries funded: true', async () => {
    await liveOwner();
    const tid = await mintedUnpaid();
    await db.execute(sql`UPDATE transfers SET amount_usd = 3000 WHERE id = ${tid}`);
    expect(await createTransferRepo(db).bindFundingIntent(tid, OWNER, 'stripe', `pi_${tid}`)).toBeTruthy();
    const res = await call(await payBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'reload_required', funded: true });
  });

  it('the write throws (fresh) -> 503 approval_not_recorded, ONE payevidence alert, nothing minted, the link stays open', async () => {
    await liveOwner();
    seam.writeThrows = true;
    const before = consoleLines.length;
    const res = await call(await payBody({ senderAddress: ADDRESS }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    expect(await transfersN()).toBe(0);
    expect(await linkStatus()).toBe('open');
    const rows = await outboxRows();
    expect(rows.map((r) => [r.kind, r.dedupe_key])).toEqual([['ops.alert', `payevidence:${new Date().toISOString().slice(0, 13)}`]]);
    expect(JSON.stringify(rows[0].payload)).toContain('(link)');
    const lines = consoleLines.slice(before);
    expect(lines.find((l) => l.includes('paylink.originator_write'))).toContain('TypeError');
    for (const l of lines) expect(l).not.toContain('originator-write-secret');
  });

  it('the write throws (resume) -> 503, never charged, still awaiting', async () => {
    await liveOwner();
    const tid = await mintedUnpaid();
    await db.execute(sql`UPDATE transfers SET amount_usd = 3000 WHERE id = ${tid}`);
    seam.writeThrows = true;
    const res = await call(await payBody({ senderDob: DOB }));
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe('approval_not_recorded');
    expect(seam.order).toEqual(['writeOriginatorInfo']); // never re-screened or charged
    const t = await store.getTransfer(tid);
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef).toBeFalsy();
  });

  it('an address on file: the key may be absent; a typed value is ignored (no write)', async () => {
    await liveOwner();
    await seedOriginatorForTest(db, OWNER, PHONE, { address: true });
    const res = await call(await payBody());
    expect(res.status).toBeLessThan(300);
    expect(seam.order).not.toContain('writeOriginatorInfo');
    expect(await travelRuleRows()).toEqual([]);
    expect((await customerStore.getCustomer(OWNER, PHONE))?.residentialAddress).toBe('1 Test Street, Testville');
  });

  it('a typed value while on file is ignored', async () => {
    await liveOwner();
    await seedOriginatorForTest(db, OWNER, PHONE, { address: true });
    const res = await call(await payBody({ senderAddress: 'x' }));
    expect(res.status).toBeLessThan(300);
    expect(seam.order).not.toContain('writeOriginatorInfo');
    expect(await travelRuleRows()).toEqual([]);
  });

  it('the values never reach an outbox payload or an audit meta', async () => {
    await liveOwner();
    const tid = await mintedUnpaid();
    await db.execute(sql`UPDATE transfers SET amount_usd = 3000 WHERE id = ${tid}`);
    await call(await payBody({ senderDob: DOB }));
    const outbox = JSON.stringify(await outboxRows());
    const meta = JSON.stringify(((await db.execute(sql`SELECT meta FROM audit_events`)) as unknown as { rows: unknown[] }).rows);
    for (const p of [ADDRESS, DOB, '7 Invented']) {
      expect(outbox).not.toContain(p);
      expect(meta).not.toContain(p);
    }
  });
});

describe('link route, not real money: no field, no read (P0 rule 3)', { retry: 0 }, () => {
  const originatorReads = (qs: Array<{ sql: string }>) => qs.filter((q) => /"residential_address_enc" IS NOT NULL/i.test(q.sql));

  it('default owner: an old tab pays as before, no customers originator query, nothing written', async () => {
    await seedLink('default');
    await call({ action: 'request_otp' });
    const stop = captureQueries();
    let qs: Array<{ sql: string }> = [];
    let res: Response;
    try {
      res = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    } finally {
      qs = stop();
    }
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('paid');
    expect(originatorReads(qs)).toEqual([]);
    expect(seam.order).not.toContain('writeOriginatorInfo');
    expect(await travelRuleRows()).toEqual([]);
  });

  it('simulator rail of a non-default owner: an old tab pays as before, no originator read', async () => {
    await seedPartner(db, 'simco', 'Simco');
    await setRailProviderType(db, 'simco', 'simulator');
    await seedLink('simco');
    await call({ action: 'request_otp' });
    const stop = captureQueries();
    let qs: Array<{ sql: string }> = [];
    let res: Response;
    try {
      res = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt, senderAddress: 'x' });
    } finally {
      qs = stop();
    }
    const body = (await res.json()) as { reason?: string; fieldErrors?: unknown };
    expect(body.reason).not.toBe('reload_required');
    expect(body.fieldErrors).toBeUndefined();
    expect(originatorReads(qs)).toEqual([]);
    expect(await travelRuleRows()).toEqual([]);
  });
});
