/**
 * Fix pack 6 T6 (R46, P5, P7 link order): the E-SIGN consent gate of the
 * payment-link route.
 *   - asked AFTER the originator rule and BEFORE the code is checked; links are
 *     never exempt; the customer is the link OWNER (link.partnerId,
 *     link.customerPhone);
 *   - a link payer with NO customers row yet reads as "needed" (the row is
 *     created by ensureCustomer inside finalizeLinkPayment, and exists by the
 *     time processTransferPayment commits the evidence);
 *   - an old tab or a stale version -> 409 reload_required (funded-aware through
 *     linkFunded); an unreadable consent -> 503 temporarily_unavailable; neither
 *     spends the code or writes anything;
 *   - never at request_otp (P0 rule 12).
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
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { linkExpiresAt, newLinkToken } from '@/lib/payment-links';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import {
  PAY_APPROVAL_NOT_RECORDED_COPY,
  PAY_RELOAD_REQUIRED_COPY,
  PAY_RELOAD_REQUIRED_FUNDED_COPY,
  PAY_SENDER_ADDRESS_INVALID_COPY,
} from '@/lib/pay-outcome';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { readEsignConsent as realReadEsignConsent } from '@/db/repos/customer-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';
import { certifyPartnerForTest } from './helpers-live';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import type { Customer } from '@/lib/types';

// This file tests the E-SIGN gate, not the funding rule; stands in for a Stripe-funded
// row (the mock-funding refusal is pinned in tests/pay-funding-refusal.test.ts).
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
// A certified owner never sends codes on the shared number; every owner is given it here.
vi.mock('@/lib/direct-otp-channel', async (orig) => ({
  ...(await orig<typeof import('@/lib/direct-otp-channel')>()),
  resolveDirectOtpChannel: () => Promise.resolve({ ok: true as const, creds: undefined }),
}));
// The consent read (counted, may throw) and the consent write (counted, may miss).
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

import { POST } from '@/app/api/pay/l/[token]/route';

const PHONE = '14155550100';
const LINK_ID = 'pl_esign1';
const H = 3_600_000;
const V = ESIGN_CONSENT_VERSION;
const HTTP_RAIL = { providerType: 'http', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } };
const ADDRESS = '7 Invented Close, Mockford 11111';
const PII = [ADDRESS, '7 Invented', PHONE, 'Asha Patel', 'esign-read-secret'];
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
const customersN = () => count('SELECT count(*)::int AS n FROM customers');
const auditN = () => count('SELECT count(*)::int AS n FROM audit_events');
type AuditRow = { action: string; partner_id: string; subject_id: string; meta: Record<string, unknown> };
async function auditRows(): Promise<AuditRow[]> {
  const r = (await db.execute(sql`SELECT action, partner_id, subject_id, meta FROM audit_events ORDER BY id`)) as unknown as { rows: AuditRow[] };
  return r.rows;
}
const consentRows = async () => (await auditRows()).filter((r) => r.action === 'customer.consent.esign');
async function outboxRows() {
  const r = (await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as {
    rows: Array<{ kind: string; dedupe_key: string | null }>;
  };
  return r.rows;
}
const consentOnFile = async (partnerId: string) => (await realReadEsignConsent(db, partnerId, PHONE))?.version ?? null;
const transferRows = async () =>
  ((await db.execute(sql.raw('SELECT id, status FROM transfers ORDER BY created_at'))) as unknown as { rows: Array<{ id: string; status: string }> }).rows;
const disclosureHash = async (partnerId: string) => resolvePartnerDisclosure(await createPartnerRepo(db).getPartner(partnerId)).hash ?? undefined;

/** The complete pay body of the link (without esignConsentVersion unless given: an old tab). */
async function payBody(partnerId: string, o: Record<string, unknown> = {}) {
  return {
    otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt,
    disclosureVersion: DISCLOSURE_DRAFT_VERSION, disclosureHash: await disclosureHash(partnerId), ...o,
  };
}

/** A payable link of `partnerId` for PHONE; a verified customers row only when `customer`; NO consent on file. */
async function seedLink(partnerId: string, o: { customer?: boolean } = {}) {
  const now = new Date().toISOString();
  if (o.customer) {
    await customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: now, kycStatus: 'verified', fullName: 'Asha Patel', senderCountry: 'US',
      partnerId, createdAt: now, updatedAt: now,
    } as Customer);
  }
  const payees = createPayeeRepo(db);
  await payees.insert({
    id: `pye_${partnerId}`, partnerId, legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
    payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
  });
  await payees.decide(`pye_${partnerId}`, ['pending'], 'approved', 'admin');
  token = newLinkToken();
  await createPaymentLinkRepo(db).insertLinks([{
    id: LINK_ID, partnerId, payeeId: `pye_${partnerId}`, token, reference: 'INV-6', customerName: 'Asha Patel',
    customerPhone: PHONE, amountInr: 25000, purpose: 'education', expiresAt: linkExpiresAt(), createdBy: 'pa',
  }]);
  lockedAt = (await quotes.lock(LINK_ID, { toInr: 85, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' })).lockedAt;
}

/** A fresh code for the link (a fresh OTP store: no issue cooldown, the last code was spent). */
async function freshCode() {
  txOtp = createTransactionOtpStore(fakeRedis(), { randomInt: () => 654321 });
  await txOtp.issue(`paylink:${LINK_ID}`, PHONE);
}

/** 'acme': certified, on a signed http rail, a live OFAC list; a verified customer; NO consent on file. */
async function liveOwner(o: { approvedDisclosure?: boolean } = {}) {
  await seedPartner(db, 'acme', 'Acme');
  await certifyPartnerForTest(db, 'acme', { approvedDisclosure: o.approvedDisclosure ?? true });
  await setRailProviderType(db, 'acme', 'http');
  linkRails.byPartner.acme = HTTP_RAIL;
  primeOfacSource({ checkedAgoMs: H });
  await seedLink('acme', { customer: true });
  await freshCode();
}

const originalList = process.env.SANCTIONS_LIST;
beforeEach(async () => {
  vi.stubEnv('DEMO_PHONES', '*');
  linkRails.byPartner = {};
  funding.decline = false;
  fault.reads = 0;
  fault.esignReadThrows = false;
  fault.recordMiss = false;
  fault.recordCalls = 0;
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
  // No phone, address, name or error message ever reaches a console line in this file.
  for (const line of consoleLines) {
    for (const p of PII) expect(line).not.toContain(p);
  }
});

describe('link route: the E-SIGN gate before the code (P5, P7 link order)', { retry: 0 }, () => {
  it('a link payer with NO customers row and no key -> 409 reload_required; the code is not checked; nothing minted, no customers row, no audit row', async () => {
    await seedLink('default');
    await freshCode();
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await call(await payBody('default'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(verify).not.toHaveBeenCalled();
    expect(fault.reads).toBe(1);
    expect(await transfersN()).toBe(0);
    expect(await customersN()).toBe(0);
    expect(await auditN()).toBe(0);
    expect(await outboxRows()).toEqual([]);
  });

  it('no customers row, the current version posted -> paid; ensureCustomer created the row; the evidence commit recorded the consent on (link owner, link phone)', async () => {
    await seedLink('default');
    await freshCode();
    const res = await call(await payBody('default', { esignConsentVersion: V }));
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { ok: boolean; transferId: string };
    expect(body.ok).toBe(true);
    const [minted] = await transferRows();
    expect(body.transferId).toBe(minted.id);
    expect(await customersN()).toBe(1);
    expect(await consentOnFile('default')).toBe(V);
    // The row existed by the evidence commit: the first write landed.
    expect(fault.recordCalls).toBe(1);
    const consent = await consentRows();
    expect(consent).toHaveLength(1);
    expect(consent[0].partner_id).toBe('default');
    expect(consent[0].subject_id).toBe(minted.id);
    expect(consent[0].meta).toMatchObject({ version: V, surface: 'link', on: true, routeId: LINK_ID });
    expect(typeof consent[0].meta.customerRef).toBe('string');
    expect(JSON.stringify(consent[0].meta)).not.toContain(PHONE);
  });

  it('consent already on file -> pays with no key; no new consent row; nothing written to the consent', async () => {
    await seedLink('default');
    await seedEsignConsentForTest(db, 'default', PHONE);
    fault.recordCalls = 0; // the seed itself wrote through the wrapped writer
    await freshCode();
    const res = await call(await payBody('default'));
    expect(res.status).toBeLessThan(300);
    expect((await res.json()).ok).toBe(true);
    expect(await consentRows()).toEqual([]);
    expect(fault.recordCalls).toBe(0);
  });

  it.each([['a stale version', 'esign-2025-old'], ['an empty version', ''], ['a non-string', 42]])(
    '%s posted -> the same 409; the code is not checked',
    async (_l, esignConsentVersion) => {
      await seedLink('default', { customer: true });
      await freshCode();
      const verify = vi.spyOn(txOtp, 'verify');
      const res = await call(await payBody('default', { esignConsentVersion }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
      expect(verify).not.toHaveBeenCalled();
      expect(await consentOnFile('default')).toBeNull();
    },
  );

  it('consent withdrawn after it was given -> asked again; the version then pays and records it', async () => {
    await seedLink('default', { customer: true });
    await seedEsignConsentForTest(db, 'default', PHONE, { withdrawn: true });
    await freshCode();
    const refused = await call(await payBody('default'));
    expect(refused.status).toBe(409);
    expect((await refused.json()).reason).toBe('reload_required');
    const res = await call(await payBody('default', { esignConsentVersion: V }));
    expect(res.status).toBeLessThan(300);
    expect(await consentRows()).toHaveLength(1);
  });

  it('a consent on file for an OLDER version -> asked again', async () => {
    await seedLink('default', { customer: true });
    await seedEsignConsentForTest(db, 'default', PHONE, { version: 'esign-2025-old' });
    await freshCode();
    expect((await call(await payBody('default'))).status).toBe(409);
    expect(await consentOnFile('default')).toBe('esign-2025-old');
  });

  it('the consent read throws -> 503 temporarily_unavailable; the code is not checked; nothing minted; the error name only in the log', async () => {
    await seedLink('default', { customer: true });
    await freshCode();
    const verify = vi.spyOn(txOtp, 'verify');
    fault.esignReadThrows = true;
    const before = consoleLines.length;
    const res = await call(await payBody('default', { esignConsentVersion: V }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable' });
    expect(verify).not.toHaveBeenCalled();
    expect(await transfersN()).toBe(0);
    expect(await auditN()).toBe(0);
    expect(await outboxRows()).toEqual([]);
    expect(consoleLines.slice(before).some((l) => l.includes('pay.esign-gate') && l.includes('TypeError'))).toBe(true);
  });

  it('the consent write misses -> 503 approval_not_recorded, uncharged; ONE payevidence alert; the minted row stays awaiting_payment; a retry with a fresh code pays', async () => {
    await seedLink('default', { customer: true });
    await freshCode();
    fault.recordMiss = true;
    const res = await call(await payBody('default', { esignConsentVersion: V }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    expect(fault.recordCalls).toBe(2);
    const rows = await transferRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('awaiting_payment');
    expect((await store.getTransfer(rows[0].id))?.fundingRef).toBeFalsy();
    expect((await outboxRows()).map((r) => [r.kind, r.dedupe_key])).toEqual([
      ['ops.alert', `payevidence:${new Date().toISOString().slice(0, 13)}`],
    ]);
    expect((await auditRows()).map((r) => r.action).filter((a) => a === 'otp.verified' || a === 'customer.consent.esign')).toEqual([]);
    expect(await consentOnFile('default')).toBeNull();

    // The link resume path pays the same minted row on retry with the version.
    fault.recordMiss = false;
    await freshCode();
    const retry = await call(await payBody('default', { esignConsentVersion: V }));
    expect(retry.status).toBeLessThan(300);
    const out = (await retry.json()) as { ok: boolean; transferId: string };
    expect(out.ok).toBe(true);
    expect(out.transferId).toBe(rows[0].id);
    expect(await transfersN()).toBe(1);
    expect(await consentOnFile('default')).toBe(V);
    expect((await consentRows()).map((r) => r.subject_id)).toEqual([rows[0].id]);
  });

  it('a resumed link whose minted row is funded, no key -> 409 with funded: true and the funded copy', async () => {
    await seedLink('default', { customer: true });
    await freshCode();
    // A first attempt whose charge is declined leaves a minted, unpaid row (consent recorded then).
    funding.decline = true;
    expect((await call(await payBody('default', { esignConsentVersion: V }))).status).toBe(402);
    funding.decline = false;
    const [minted] = await transferRows();
    expect(await createTransferRepo(db).bindFundingIntent(minted.id, 'default', 'stripe', 'pi_link_es')).toBeTruthy();
    // The customer then withdrew: the resume asks again.
    await seedEsignConsentForTest(db, 'default', PHONE, { withdrawn: true });
    await freshCode();
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await call(await payBody('default'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', funded: true, error: PAY_RELOAD_REQUIRED_FUNDED_COPY });
    expect(verify).not.toHaveBeenCalled();
  });

  it('request_otp with no consent on file -> 200 sent; the consent is never read (P0 rule 12)', async () => {
    await seedLink('default');
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(fault.reads).toBe(0);
  });

  it('tenant scope: a consent on file for the same phone under ANOTHER partner does not count for this link owner', async () => {
    await seedPartner(db, 'beta', 'Beta');
    await seedEsignConsentForTest(db, 'beta', PHONE);
    await seedLink('default', { customer: true });
    await freshCode();
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await call(await payBody('default'));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(verify).not.toHaveBeenCalled();
    expect(await consentOnFile('default')).toBeNull();
    expect(await consentOnFile('beta')).toBe(V);
  });
});

describe('order (P7 link): every cheaper pre-verify check answers before the E-SIGN gate', { retry: 0 }, () => {
  it('a lapsed quote -> 409 quote_expired; the consent never read', async () => {
    await seedLink('default', { customer: true });
    await freshCode();
    const res = await call(await payBody('default', { quoteLockedAt: 'not-the-lock' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('quote_expired');
    expect(fault.reads).toBe(0);
  });

  it('an unapproved block on a real-money owner -> the R18 answer; the consent never read', async () => {
    await liveOwner({ approvedDisclosure: false });
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await call(await payBody('acme', { senderAddress: ADDRESS }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('not_available');
    expect(fault.reads).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it('a bad senderAddress on real money -> 400 originator_invalid; the consent never read', async () => {
    await liveOwner();
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await call(await payBody('acme', { senderAddress: '' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'originator_invalid', fieldErrors: { senderAddress: PAY_SENDER_ADDRESS_INVALID_COPY } });
    expect(fault.reads).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it('real money, a valid address and no consent: the E-SIGN gate answers next (409), the code not checked', async () => {
    await liveOwner();
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await call(await payBody('acme', { senderAddress: ADDRESS }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(fault.reads).toBe(1);
    expect(verify).not.toHaveBeenCalled();
    expect(await transfersN()).toBe(0);
  });
});
