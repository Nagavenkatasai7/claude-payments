import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgent } from '@/lib/agent';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { completePaymentStage1, completePaymentStage2 } from '@/lib/payment';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import type { ChatMessage, Partner } from '@/lib/types';
import type { Db } from '@/db/client';

// WL1 lib-level integration test: drive the agent's runAgentTurn for a fully
// provisioned WHITE-LABEL + KYC-DELEGATED partner end-to-end on the mock rail,
// asserting (1) the partner's brand reaches the system prompt, (2) the KYC gate
// + [UNVERIFIED SENDER] note are short-circuited, (3) sanctions STILL run, and
// (4) the default partner is byte-for-byte unchanged.

const PHONE = '15551234567';
const now = '2026-06-08T00:00:00Z';

function toolCall(id: string, name: string, args: object): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function buildHarness(redis: FakeRedis) {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const scheduleStore = createScheduleStore(db);
  const draftStore = createDraftStore(redis);
  const dailyVolumeStore = createDailyVolumeStore(redis);
  const monthlyVolumeStore = createMonthlyVolumeStore(redis);
  const partnerStore = createPartnerStore(db); // pg-backed (Stage 2a cutover)
  const kycProvider = new MockKycProvider(customerStore, 'https://example.com');

  // Capture the system-message content of every chat() call so we can assert on
  // the branded prompt + whether the verify notes were injected.
  const systemSnapshots: string[] = [];
  let active: ChatMessage[] = [];

  const agent = createAgent({
    store, scheduleStore, draftStore, customerStore, dailyVolumeStore,
    monthlyVolumeStore, kycProvider, partnerStore,
    async chat(messages) {
      systemSnapshots.push(
        messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
      );
      return active.shift()!;
    },
  });

  return {
    store, customerStore, partnerStore, draftStore,
    systemSnapshots,
    setScript: (s: ChatMessage[]) => { active = [...s]; },
    agent,
  };
}

function partnerRecord(over: Partial<Partner>): Partner {
  return { id: 'acme', name: 'Acme', countries: ['US'], status: 'active', createdAt: now, updatedAt: now, ...over };
}

// Partner store is pg-backed (Stage 2a cutover): freshDb() truncates the shared
// PGlite and reseeds the 'default' partner, so it runs per-test in beforeEach.
let db: Db;

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '',
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('WL1 branded + KYC-delegated partner (mock rail)', () => {
  it('brands the prompt, skips the KYC gate for an UNVERIFIED sender, and delivers', async () => {
    const redis = fakeRedis();
    const h = buildHarness(redis);
    // A fully-provisioned delegated partner + an UNVERIFIED customer under it.
    await h.partnerStore.savePartner(partnerRecord({ id: 'acme', displayName: 'Acme Pay', kycMode: 'delegated', requireKycBeforeSend: false }));
    await h.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: now, kycStatus: 'not_started',
      senderCountry: 'US', partnerId: 'acme', createdAt: now, updatedAt: now,
    });

    // Turn 1: the bot sends the Approve & Pay card despite the sender being unverified.
    h.setScript([
      toolCall('c1', 'send_approve_picker', {
        amount_usd: 200, funding_method: 'bank_transfer',
        recipient_name: 'Anita', recipient_phone: '919876543210',
        payout_method: 'bank', payout_destination: '1234567890', destination_country: 'IN',
      }),
      { role: 'assistant', content: 'Tap Approve to send.' },
    ]);
    await h.agent.runAgentTurn(PHONE, 'send $200 to Anita, bank 1234567890, 919876543210');

    // (1) the system prompt carries the PARTNER brand, never SmartRemit
    expect(h.systemSnapshots[0]).toContain('Acme Pay');
    expect(h.systemSnapshots[0]).not.toContain('SmartRemit');
    // (2) the verify-leading note is NOT injected for a delegated partner
    expect(h.systemSnapshots[0]).not.toContain('[UNVERIFIED SENDER]');

    // (2b) the gate was skipped → a draft was actually created (default would 403)
    const draftKey = [...redis.dump.keys()].find((k) => k.startsWith('recipient_draft:'));
    expect(draftKey).toBeDefined();
    const draftId = draftKey!.replace('recipient_draft:', '');

    // Turn 2: tap Approve → the transfer mints despite the sender being unverified.
    h.setScript([toolCall('c2', 'create_transfer', {}), { role: 'assistant', content: 'Paying now.' }]);
    await h.agent.runAgentTurn(PHONE, '[Tapped: Approve & pay]', {
      isNewConversation: false, buttonTap: { kind: 'approve', draftId },
    });

    // Transfers live in Postgres now — find the minted row via the store API.
    const mintedAll = await h.store.listTransfers();
    expect(mintedAll).toHaveLength(1);
    const transferId = mintedAll[0].id;
    const minted = await h.store.getTransfer(transferId);
    expect(minted!.status).toBe('awaiting_payment'); // not blocked, not kyc-gated

    // (4) mock rail: paid → delivered
    const s1 = await completePaymentStage1(h.store, transferId);
    expect(s1.transfer.status).toBe('paid');
    const s2 = await completePaymentStage2(h.store, transferId);
    expect(s2.transfer.status).toBe('delivered');
  });

  it('SANCTIONS SURVIVE DELEGATION: a watchlisted recipient is still blocked through the agent', async () => {
    const redis = fakeRedis();
    const h = buildHarness(redis);
    await h.partnerStore.savePartner(partnerRecord({ id: 'acme', displayName: 'Acme Pay', kycMode: 'delegated', requireKycBeforeSend: false }));
    await h.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: now, kycStatus: 'not_started',
      senderCountry: 'US', partnerId: 'acme', createdAt: now, updatedAt: now,
    });

    // Legacy explicit-args create_transfer (no draft) with a WATCHLISTED recipient.
    h.setScript([
      toolCall('c1', 'create_transfer', {
        amount_usd: 100, recipient_name: 'John Doe', recipient_phone: '919876543210',
        payout_method: 'bank', payout_destination: '1234567890',
        funding_method: 'bank_transfer', destination_country: 'IN',
      }),
      { role: 'assistant', content: "We can't process this transfer." },
    ]);
    await h.agent.runAgentTurn(PHONE, 'send $100 to John Doe 919876543210 bank 1234567890');

    const blockedAll = await h.store.listTransfers();
    expect(blockedAll).toHaveLength(1);
    const t = await h.store.getTransfer(blockedAll[0].id);
    // Delegated lifted OUR KYC gate, but sanctions screening still blocked the send.
    expect(t!.complianceStatus).toBe('blocked');
    expect(t!.status).toBe('blocked');
  });
});

describe('WL1 default partner is byte-for-byte unchanged', () => {
  it('brands as SmartRemit, injects [UNVERIFIED SENDER], and the gate blocks an unverified sender', async () => {
    const redis = fakeRedis();
    const h = buildHarness(redis);
    // Default partner (seeded) + an UNVERIFIED customer under 'default'.
    await h.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: now, kycStatus: 'not_started',
      senderCountry: 'US', partnerId: 'default', createdAt: now, updatedAt: now,
    });

    h.setScript([
      toolCall('c1', 'send_approve_picker', {
        amount_usd: 200, funding_method: 'bank_transfer',
        recipient_name: 'Anita', recipient_phone: '919876543210',
        payout_method: 'bank', payout_destination: '1234567890', destination_country: 'IN',
      }),
      { role: 'assistant', content: 'Please verify your identity first.' },
    ]);
    await h.agent.runAgentTurn(PHONE, 'send $200 to Anita, bank 1234567890, 919876543210');

    // prompt is SmartRemit-branded and the verify note IS injected
    expect(h.systemSnapshots[0]).toContain('You are the assistant for SmartRemit');
    expect(h.systemSnapshots[0]).toContain('[UNVERIFIED SENDER]');
    // the gate blocked the send → NO draft (still Redis), NO transfer minted (Postgres)
    expect([...redis.dump.keys()].some((k) => k.startsWith('recipient_draft:'))).toBe(false);
    expect(await h.store.listTransfers()).toHaveLength(0);
  });
});
