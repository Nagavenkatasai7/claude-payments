import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo'; // the D11 case below
import { EnvKeyProvider } from '@/lib/field-crypto';
import { resetRateCacheForTests } from '@/lib/rate';
import { createTransaction, getTransaction, type PartnerApiDeps } from '@/lib/partner-api-service';
import type { Db } from '@/db/client';
import type { Partner, Transfer } from '@/lib/types';
import { easternDate, easternMonth } from '@/lib/dates';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import { sql } from 'drizzle-orm';
import { createAgent } from '@/lib/agent';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import type { ChatMessage } from '@/lib/types';

// tenant-boundary — the end-to-end pin for fix 1 (F44, F45, F47, F50, F52).
// Two tenants ('default' and 'acme') share ONE phone number. Nothing a
// partner-signed webhook or the partner API does under acme may read or move
// anything the default tenant holds for that number, and vice versa.

const PHONE = '15551230000';
const NOW = '2026-06-08T00:00:00Z';

// The inbound pipeline reads its singletons; bind them to the test engine.
let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
vi.mock('@/lib/whatsapp', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  sendText: vi.fn(async () => {}),
}));

import { processInboundWebhook } from '@/lib/whatsapp-inbound';

function metaBody(from: string, text: string, id: string): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ from, id, type: 'text', text: { body: text } }] } }] }],
  };
}

const partner = (over: Partial<Partner>): Partner => ({
  id: 'acme', name: 'Acme', countries: ['US'], status: 'active', createdAt: NOW, updatedAt: NOW, ...over,
});
const ACME = partner({ id: 'acme', kycMode: 'delegated', requireKycBeforeSend: false });

beforeEach(async () => {
  resetRateCacheForTests();
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'acme');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '' }));
});
afterEach(() => vi.restoreAllMocks());

async function seedDefaultOwner() {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: NOW, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default',
    fullName: 'Default Owner', govIdNumber: 'P1234567', passwordHash: 'pw-hash', optInAt: NOW,
    createdAt: NOW, updatedAt: NOW,
  });
  await store.upsertRecipient('default', PHONE, {
    name: 'Anita', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: 'REAL-0001', lastUsedAt: NOW,
  });
  await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 10 }); // one row today (fix 16: the ledger IS the counter)
  return { store, customerStore };
}

describe('F44: a forged partner-signed webhook cannot re-home another tenant customer', () => {
  it('creates acme\'s own row, leaves default\'s partner_id/kyc/PII/password intact, and enqueues the turn under acme', async () => {
    const { customerStore } = await seedDefaultOwner();
    const res = await processInboundWebhook(metaBody(PHONE, 'hi', 'wamid.FORGED1'), { routedPartnerId: 'acme' });
    expect(res).toEqual({ ok: true });
    const dflt = (await customerStore.getCustomer('default', PHONE))!;
    expect([dflt.partnerId, dflt.kycStatus, dflt.fullName, dflt.govIdNumber, dflt.passwordHash]).toEqual(
      ['default', 'verified', 'Default Owner', 'P1234567', 'pw-hash'],
    );
    const acme = (await customerStore.getCustomer('acme', PHONE))!;
    expect([acme.partnerId, acme.kycStatus, acme.fullName, acme.passwordHash]).toEqual(['acme', 'not_started', undefined, undefined]);
    // The durable effect: exactly one agent.turn row, carrying the ROUTED tenant (never creds).
    const raw = await db.execute(`SELECT payload FROM outbox WHERE kind = 'agent.turn'`);
    const payloads = (raw as unknown as { rows: { payload: { routedPartnerId: string | null; phone: string } }[] }).rows;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload).toMatchObject({ phone: PHONE, routedPartnerId: 'acme' });
  });

  it('STOP under acme never opts the default-tenant row out', async () => {
    const { customerStore } = await seedDefaultOwner();
    await processInboundWebhook(metaBody(PHONE, 'STOP', 'wamid.STOP1'), { routedPartnerId: 'acme' });
    expect((await customerStore.getCustomer('default', PHONE))!.optedOutAt).toBeUndefined();
  });
});

describe('F45/F47: the partner API cannot plant a payout destination in another tenant address book or bump its counters', () => {
  async function apiDeps() {
    const store = createStore(redis, db);
    const customerStore = createCustomerStore(db, store);
    const deps: PartnerApiDeps = {
      store, partnerStore: createPartnerStore(db), monthlyVolumeStore: createMonthlyVolumeStore(store),
      integrationsStore: createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))),
      customerStore, db, keyMode: 'live', now: () => NOW,
    };
    return { deps, store, customerStore };
  }

  it('acme mint for default\'s number: default recipients/velocity/monthly untouched; acme accrues its own (and, fix 5, writes no address book)', async () => {
    await seedDefaultOwner();
    const { deps, store } = await apiDeps();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-tb-1', {
      amount_source: 200,
      sender: { phone: PHONE, kyc_status: 'not_started' },
      beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: 'PLANTED-9999' },
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect((await store.listRecipients('default', PHONE, 5))[0].payoutDestination).toBe('REAL-0001');
    expect(await store.listRecipients('acme', PHONE, 5)).toEqual([]); // fix 5: saveRecipient: false
    expect(await store.getTodayTransferCount('default', PHONE)).toBe(1); // the seeded one, unchanged
    expect(await store.getTodayTransferCount('acme', PHONE)).toBe(1);
    expect(await deps.monthlyVolumeStore.getMonthCents('default', PHONE)).toBe(1_000); // the seeded $10 row, unchanged
    expect(await deps.monthlyVolumeStore.getMonthCents('acme', PHONE)).toBe(20_000);
  });

  it("fix 5 (regression pin on fix 1): acme's API mint for default's number never shows in default's round-0 customer context", async () => {
    await seedDefaultOwner();
    const { deps, store, customerStore } = await apiDeps();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-tb-ctx', {
      amount_source: 100, sender: { phone: PHONE, kyc_status: 'not_started' },
      beneficiary: { name: 'Acme Planted', phone: '919811112222', payout_method: 'bank', payout_destination: '999988887777' },
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store, customerStore, partnerStore: deps.partnerStore, monthlyVolumeStore: deps.monthlyVolumeStore,
      scheduleStore: createScheduleStore(db), draftStore: createDraftStore(redis), dailyVolumeStore: createDailyVolumeStore(store), // fix 16: ledger-backed
      kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
      partnerId: 'default',
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn(PHONE, 'what did I send recently?', { isNewConversation: false, buttonTap: { kind: 'recipient', recipientPhone: '919811112222' } });
    const everything = JSON.stringify(seen);
    expect(everything).not.toContain('Acme Planted');
    expect(everything).not.toContain('999988887777');
    // fix 16's seedDefaultOwner mints one $10 ledger row for default, so the
    // round-0 context pair exists — and carries ONLY default's own row. default
    // has no saved recipient at the tapped number, so no selected_recipient and
    // no [RECIPIENT SELECTED] note at all.
    const r0 = seen[0];
    const ctxMsg = r0.find((m) => m.tool_call_id === 'ctx_r0');
    expect(ctxMsg).toBeDefined();
    const ctxResult = JSON.parse(ctxMsg?.content ?? '{}') as { recent_transfers: { recipient_name: string }[]; selected_recipient?: unknown };
    expect(ctxResult.recent_transfers.map((t) => t.recipient_name)).toEqual(['Seeded Recipient']);
    expect(ctxResult.selected_recipient).toBeUndefined();
    expect(r0.some((m) => m.role === 'system' && (m.content ?? '').startsWith('[RECIPIENT SELECTED]'))).toBe(false);
  });

  it('F50/F52: the partner API never returns another tenant decrypted legal name', async () => {
    await seedDefaultOwner();
    const { deps } = await apiDeps();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-tb-2', {
      amount_source: 100, sender: { phone: PHONE, kyc_status: 'not_started' },
      beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
    });
    if (!r.ok) throw new Error('unexpected');
    expect((r.data as { sender_name: string | null }).sender_name).toBeNull();
    const got = await getTransaction(deps, 'acme', (r.data as { id: string }).id);
    expect(got.ok && (got.data as { sender_name: string | null }).sender_name).toBeNull();
    expect(JSON.stringify(r.data)).not.toContain('Default Owner');
  });
});

describe('D9/D10 transitional fallback: legacy phone-only keys belong to the PRE-FIX tenant only', () => {
  it('an acme sibling created after the rename never reads default\'s legacy kyc_audit / conv — and the pre-fix counter keys are inert (fix 16)', async () => {
    const { store, customerStore } = await seedDefaultOwner(); // default is the oldest row
    const day = easternDate(Date.now());
    const month = easternMonth(Date.now());
    // Pre-fix Redis counters may still exist for their TTL. Since Program fix 16
    // they decide NOTHING: every cap figure is a ledger aggregate. Leave them in
    // place and assert both tenants read only their own ledger rows.
    await redis.set(`velocity:${PHONE}:${day}`, '4');
    await redis.set(`daily_volume:${PHONE}:${day}`, '250000');
    await redis.set(`monthly_volume:${PHONE}:${month}`, '290000');
    await redis.hset(`kyc_audit:${PHONE}`, { '1': JSON.stringify({ at: NOW, actor: 'persona', action: 'legacy.event' }) });
    await customerStore.upsertOnFirstInbound('acme', PHONE); // the post-fix sibling
    const daily = createDailyVolumeStore(store);
    const monthly = createMonthlyVolumeStore(store);
    const kyc = createKycCaseStore(redis, customerStore); // (redis, customers, now?) — src/lib/kyc-case-store.ts:31-35
    // The pre-fix owner sees its own ledger (the one $10 row seedDefaultOwner minted) and its audit…
    expect(await store.getTodayTransferCount('default', PHONE)).toBe(1);
    expect(await daily.getTodayCents('default', PHONE)).toBe(1_000);
    expect(await monthly.getMonthCents('default', PHONE)).toBe(1_000);
    expect((await kyc.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['legacy.event']);
    // …and the sibling sees NOTHING of it (no cap oracle, no audit leak).
    expect(await store.getTodayTransferCount('acme', PHONE)).toBe(0);
    expect(await daily.getTodayCents('acme', PHONE)).toBe(0);
    expect(await monthly.getMonthCents('acme', PHONE)).toBe(0);
    expect(await kyc.getAudit('acme', PHONE)).toEqual([]);
    expect(await store.getConversation('acme', PHONE)).toEqual([]);
  });

  // The D9 rule ("oldest customers row = pre-fix owner") is only true because
  // customer-repo.freshCustomer never backdates createdAt. Pre-fix, the partner
  // API minted transfers WITHOUT a customers row, so an acme sibling created
  // after deploy for a phone with old acme ledger history is GRANDFATHERED
  // (firstSeenAt = its first transfer) — but must still sort AFTER the real
  // pre-fix owner, whether that owner registered later on the portal (T2 > T1)
  // or was itself grandfathered at the phone-wide minimum (a tie at T1, where
  // findByPhone's asc(partnerId) tie-break would otherwise put 'acme' first).
  it.each([
    ['the default row was portal-registered at T2 > T1', '2026-04-01T00:00:00.000Z'],
    ['the default row was grandfathered at T1 (a tie with acme\'s first transfer)', '2026-03-01T00:00:00.000Z'],
  ])('createdAt is never backdated: acme\'s post-fix sibling never becomes the legacy tenant when %s', async (_label, defaultCreatedAt) => {
    const T1 = '2026-03-01T00:00:00.000Z';
    const store = createStore(redis, db);
    const customerStore = createCustomerStore(db, store);
    // acme's API minted for PHONE at T1 — no customers row existed for it pre-fix.
    await store.saveTransfer({
      id: 'tb_legacy1', phone: PHONE, amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 85, amountInr: 8500,
      recipientName: 'Anita', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'anita@upi',
      fundingMethod: 'bank_transfer', status: 'delivered', complianceStatus: 'cleared', complianceReasons: [],
      createdAt: T1, partnerId: 'acme', sourceCountry: 'US', sourceCurrency: 'USD',
      destinationCountry: 'IN', destinationCurrency: 'INR', amountSource: 100, feeSource: 0, totalChargeSource: 100,
    } as Transfer);
    // The real pre-fix owner: default's row (created pre-fix at defaultCreatedAt, later than or equal to T1).
    await customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: defaultCreatedAt, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default',
      passwordHash: 'pw-hash', createdAt: defaultCreatedAt, updatedAt: defaultCreatedAt,
    });
    await redis.hset(`kyc_audit:${PHONE}`, { '1': JSON.stringify({ at: NOW, actor: 'persona', action: 'legacy.event' }) });

    // Both post-fix creation paths for the sibling: the partner API (Step 8) and the inbound webhook (Step 5).
    const viaApi = await customerStore.ensureCustomer('acme', PHONE);
    await customerStore.upsertOnFirstInbound('acme', PHONE);
    expect(viaApi.kycStatus).toBe('grandfathered'); // acme's OWN ledger history grandfathers it…
    expect(viaApi.firstSeenAt).toBe(T1);
    expect(viaApi.createdAt > defaultCreatedAt).toBe(true); // …but createdAt is "now", never T1

    expect(await store.legacyTenantOf(PHONE)).toBe('default');
    const kyc = createKycCaseStore(redis, customerStore);
    expect(await kyc.getAudit('acme', PHONE)).toEqual([]); // the no-TTL legacy trail never reaches the sibling
    expect((await kyc.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['legacy.event']);
  });
});

describe('D11: routing is identity — the routing inputs are locked', () => {
  it('the platform phone_number_id and another partner\'s phone_number_id are both refused at write time, and the index refuses a raw duplicate', async () => {
    const integ = createIntegrationsRepo(db);
    await integ.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't' } });
    // drizzle wraps the driver error: the constraint text lives on `.cause`.
    const e = await db
      .execute(sql`INSERT INTO partner_integrations (partner_id, wa_phone_number_id) VALUES ('default', 'pn_acme')`)
      .then(() => null, (err: { cause?: { message?: string; code?: string } }) => err);
    expect(e?.cause?.code).toBe('23505');
    expect(e?.cause?.message).toMatch(/partner_integrations_wa_pnid/);
    // The write-time refusals are pinned in tests/partners-actions.test.ts (Step 5A); the webhook secret rule in tests/whatsapp-route.test.ts.
  });
});

describe('D12: the bot\'s own state is per tenant', () => {
  it('a customer of default who messages acme\'s number starts a FRESH conversation there and acme\'s replies never see default\'s thread', async () => {
    const { store } = await seedDefaultOwner();
    await store.saveConversation('default', PHONE, [{ role: 'user', content: 'send $900 to Zubeida' }]);
    await processInboundWebhook(metaBody(PHONE, 'hi', 'wamid.CONV1'), { routedPartnerId: 'acme' });
    const raw = await db.execute(`SELECT payload FROM outbox WHERE kind = 'agent.turn'`);
    const [{ payload }] = (raw as unknown as { rows: { payload: { routedPartnerId: string; turn: { isNewConversation: boolean } } }[] }).rows;
    expect(payload.routedPartnerId).toBe('acme');
    expect(payload.turn.isNewConversation).toBe(true); // lastmsg is per tenant too
    expect(await store.getConversation('acme', PHONE)).toEqual([]);
  });
});
