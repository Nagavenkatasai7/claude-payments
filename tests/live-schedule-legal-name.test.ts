/**
 * Fix pack 4 T15 (C18, C19, C20): a LIVE schedule (certified owner with the
 * `schedules` opt-in and an approved provider block, http rail, live list) and
 * the recipient's account-holder name, end to end: the cron mint, the pay page
 * and settlement.
 *   - a clean saved legal name rides the cron mint (screened) and the pay page
 *     pays without asking; the row settles cleared;
 *   - no saved name: the customer types one, it is written, re-screened, the row
 *     settles and the book is filled;
 *   - no name anywhere, paid without the pay page: held RECIPIENT_IDENTITY_MISSING.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createScheduleStore } from '@/lib/schedule-store';
import { runDueSchedules } from '@/lib/cron-run';
import { resetRateCacheForTests } from '@/lib/rate';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { RECIPIENT_IDENTITY_MISSING_REASON } from '@/lib/compliance-config';
import { processTransferPayment } from '@/lib/pay-process';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';
import { okVerify, realMoneyPayBody, testEvidence } from './helpers-pay-evidence';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import type { KycProvider } from '@/lib/providers/kyc-provider';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Schedule, Transfer } from '@/lib/types';

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
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: async () => okVerify(),
  }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
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

import { POST } from '@/app/api/pay/[transferId]/route';

const OWNER = 'acme';
const SENDER = '15551234567';
const RP = '919133001840';
const ACCOUNT = '123456789012|HDFC0001234';
const H = 3_600_000;
const HTTP_RAIL: PartnerIntegrations['payment'] = {
  providerType: 'http',
  credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' },
};
const kycProvider: KycProvider = {
  startVerification: async () => ({ url: 'https://kyc.example/verify', providerRef: 'ref_1' }),
  getStatus: async () => 'pending',
  handleWebhook: async () => null,
};

/** Today's day of month in Eastern time (the cron's calendar), so the schedule is due now. */
function easternDayOfMonth(now: number): number {
  return Number(new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(8, 10));
}

function liveSchedule(id: string, now: number): Schedule {
  return {
    id, phone: SENDER, amountUsd: 200,
    recipientName: 'Mom', recipientPhone: RP,
    payoutMethod: 'bank', payoutDestination: ACCOUNT, fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: easternDayOfMonth(now), status: 'active',
    createdAt: new Date(now - 30 * 24 * H).toISOString(),
    partnerId: OWNER, sourceCurrency: 'USD', amountSource: 200,
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

async function liveOwner() {
  await seedPartner(db, OWNER, 'Acme');
  await certifyPartnerForTest(db, OWNER, { approvedDisclosure: true }); // every capability, schedules included
  await setRailProviderType(db, OWNER, 'http');
  rails.byPartner[OWNER] = HTTP_RAIL;
  primeOfacSource({ checkedAgoMs: H });
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: SENDER, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US',
    partnerId: OWNER, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso, fullName: 'Alex Sender',
  });
}

async function saveBook(legalName?: string) {
  await createRecipientRepo(db).upsertRecipient(
    OWNER,
    SENDER,
    { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: ACCOUNT, lastUsedAt: new Date().toISOString() },
    legalName === undefined ? {} : { legalName },
  );
}

/** Fire the due schedule through the cron on the same db; returns the minted row. */
async function fireSchedule(id: string): Promise<Transfer> {
  const now = Date.now();
  const scheduleStore = createScheduleStore(db);
  await scheduleStore.saveSchedule(liveSchedule(id, now));
  const notified: string[] = [];
  const result = await runDueSchedules({
    db, store, partnerStore: createPartnerStore(db), customerStore,
    monthlyVolumeStore: createMonthlyVolumeStore(store), scheduleStore, kycProvider, now,
    sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
  });
  expect(result).toEqual({ fired: 1, failed: 0 });
  expect(notified).toHaveLength(1);
  const [t] = await store.listTransfers();
  return t;
}

async function screenParties(id: string): Promise<string[][]> {
  const r = (await db.execute(
    sql`SELECT meta FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = ${id} ORDER BY id`,
  )) as unknown as { rows: Array<{ meta: { parties: Array<{ role: string }> } }> };
  return r.rows.map((x) => x.meta.parties.map((p) => p.role));
}
async function outboxKinds(): Promise<string[]> {
  const r = (await db.execute(sql`SELECT kind FROM outbox ORDER BY id`)) as unknown as { rows: Array<{ kind: string }> };
  return r.rows.map((x) => x.kind);
}
async function legalNameSetCount(): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'transfer.legal_name_set'`)) as unknown as {
    rows: Array<{ n: number }>;
  };
  return r.rows[0].n;
}

const originalList = process.env.SANCTIONS_LIST;
beforeEach(async () => {
  resetRateCacheForTests();
  rails.byPartner = {};
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreOfacSource(originalList);
});

describe('a live schedule and the account-holder name (pack 4 T15)', { retry: 0 }, () => {
  it('a clean saved legal name: the cron mint carries and screens it, the pay page pays without asking, the row settles cleared', async () => {
    await liveOwner();
    await saveBook('Anita Legal');
    const t = await fireSchedule('sch-saved');
    expect((await store.getTransferDecrypted(t.id))?.recipientLegalName).toBe('Anita Legal');
    expect(await screenParties(t.id)).toEqual([['recipient', 'sender', 'recipient']]);

    const { accountHolder: _drop, ...noHolder } = realMoneyPayBody();
    expect(await (await post(t.id, noHolder)).json()).toEqual({ ok: true, status: 'processing' });
    const paid = await store.getTransfer(t.id);
    expect(paid?.status).toBe('paid');
    expect(paid?.complianceReasons).toEqual([]);
    expect(await outboxKinds()).toContain('settlement.instruct');
    expect(await legalNameSetCount()).toBe(0);
  });

  it('no saved name: the customer types a clean name; written, re-screened, settles cleared, the book is filled', async () => {
    await liveOwner();
    await saveBook();
    const t = await fireSchedule('sch-typed');
    expect((await store.getTransferDecrypted(t.id))?.recipientLegalName).toBeUndefined();

    expect(await (await post(t.id, realMoneyPayBody({ accountHolder: 'Anita Legal' }))).json()).toEqual({ ok: true, status: 'processing' });
    expect((await store.getTransferDecrypted(t.id))?.recipientLegalName).toBe('Anita Legal');
    expect(await legalNameSetCount()).toBe(1);
    // The mint screened (recipient, sender); the pay-time re-screen covers the typed name too.
    expect((await screenParties(t.id)).at(-1)).toEqual(['recipient', 'sender', 'recipient']);
    const paid = await store.getTransfer(t.id);
    expect(paid?.status).toBe('paid');
    expect(paid?.complianceReasons).toEqual([]);
    expect(await outboxKinds()).toContain('settlement.instruct');
    expect(await createRecipientRepo(db).getRecipientLegalName(OWNER, SENDER, RP)).toBe('Anita Legal');
  });

  it('no legal name anywhere, paid without the pay page -> held RECIPIENT_IDENTITY_MISSING, no instruct', async () => {
    await liveOwner();
    const t = await fireSchedule('sch-none');
    const fresh = await store.getTransfer(t.id);
    const res = await processTransferPayment(store, fresh!, testEvidence({ routeId: t.id }));
    expect(await res.json()).toEqual({ ok: true, status: 'in_review' });
    const held = await store.getTransfer(t.id);
    expect(held?.complianceReasons).toContain(RECIPIENT_IDENTITY_MISSING_REASON);
    expect(await outboxKinds()).not.toContain('settlement.instruct');
  });
});
