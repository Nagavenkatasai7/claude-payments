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
import { evaluateCap } from '@/lib/tier-rules';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import type { ChatMessage } from '@/lib/types';
import type { Db } from '@/db/client';

const PHONE = '15551234567';
const MOCK_RATE = 85.2;

function toolCall(id: string, name: string, args: object): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

// Phase 3: the verify-before-send gate blocks any non-'verified' sender. These
// end-to-end flows exercise the send path, so seed the sender verified up front.
// firstSeenAt is "now", so the customer is still T0 within the 3-day window —
// cap behavior in the flows is unchanged.
async function seedVerifiedCustomer(
  customerStore: ReturnType<typeof createCustomerStore>,
  phone: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: phone, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
}

// Partner store is pg-backed (Stage 2a cutover): freshDb() truncates the shared
// PGlite and reseeds the 'default' partner, so it MUST run per-test.
let db: Db;

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: MOCK_RATE } }),
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('end-to-end happy path', () => {
  it('quotes, creates a transfer, sends a link, and delivers', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const scheduleStore = createScheduleStore(redis, customerStore);
    const draftStore = createDraftStore(redis);
    await seedVerifiedCustomer(customerStore, PHONE); // Phase 3: verified sender so the gate passes

    // Scripted Kimi: quote -> create -> link -> final reply.
    const script: ChatMessage[] = [
      toolCall('c1', 'get_quote', {
        amount_usd: 500,
        funding_method: 'bank_transfer',
      }),
      toolCall('c2', 'create_transfer', {
        amount_usd: 500,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'bank_transfer',
      }),
      toolCall('c3', 'generate_payment_link', {
        transfer_id: 'PLACEHOLDER',
      }),
      {
        role: 'assistant',
        content: 'Tap the link to pay securely and your mom gets the money.',
      },
    ];
    let turn = 0;
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const agent = createAgent({
      store,
      scheduleStore,
      draftStore,
      customerStore,
      dailyVolumeStore,
      monthlyVolumeStore,
      kycProvider,
      partnerStore: createPartnerStore(db), // pg-backed (Stage 2a cutover)
      async chat() {
        const msg = script[turn++];
        // Patch the real transfer id into the link tool call.
        if (msg.tool_calls?.[0].function.name === 'generate_payment_link') {
          const transferKey = [...redis.dump.keys()].find((k) =>
            k.startsWith('transfer:'),
          )!;
          const id = transferKey.replace('transfer:', '');
          msg.tool_calls[0].function.arguments = JSON.stringify({
            transfer_id: id,
          });
        }
        return msg;
      },
    });

    const reply = await agent.runAgentTurn(
      PHONE,
      'send $500 to my mom on UPI mom@upi',
    );
    expect(reply).toContain('pay');

    // A transfer was created and the user count incremented.
    const transferKey = [...redis.dump.keys()].find((k) =>
      k.startsWith('transfer:'),
    )!;
    const transferId = transferKey.replace('transfer:', '');
    expect(await store.getTransferCount(PHONE)).toBe(1);

    // Completing payment: stage 1 marks paid, stage 2 delivers.
    const stage1 = await completePaymentStage1(store, transferId);
    expect(stage1.transfer.status).toBe('paid');
    expect(stage1.senderMessages[0]).toContain('42,600');

    const stage2 = await completePaymentStage2(store, transferId);
    expect(stage2.transfer.status).toBe('delivered');
    expect(stage2.senderMessages[0]).toContain('42,600');

    // First transfer was free.
    expect(stage2.transfer.feeUsd).toBe(0);
  });
});

describe('end-to-end returning customer', () => {
  it('seeded recipient → picker → tap Mom → amount → quote → tap Approve → delivered', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const draftStore = createDraftStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const scheduleStore = createScheduleStore(redis, customerStore);
    await seedVerifiedCustomer(customerStore, PHONE); // Phase 3: verified sender so the gate passes

    // Pre-seed: Mom is a saved recipient from a previous (mock) transfer.
    await store.upsertRecipient(PHONE, {
      name: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      lastUsedAt: '2026-05-01T00:00:00Z',
    });

    // Turn 1: "[NEW CONVERSATION] hi" — bot calls list + send_recipient_picker.
    const turn1Script: ChatMessage[] = [
      toolCall('c1', 'list_saved_recipients', {}),
      toolCall('c2', 'send_recipient_picker', {
        recipients: [{ name: 'Mom', recipient_phone: '919876543210' }],
      }),
      { role: 'assistant', content: 'Welcome back 👋 Who are we sending to?' },
    ];
    // Turn 2: user taps Mom → bot asks "how much".
    const turn2Script: ChatMessage[] = [
      { role: 'assistant', content: 'How much do you want to send to Mom?' },
    ];
    // Turn 3: user says "$300" → bot calls send_approve_picker → asks for funding? In
    // this scripted run we assume the bot already knows enough; in reality the
    // prompt would have it ask for the funding method too. For test simplicity we
    // collapse that into a single tool call.
    const turn3Script: ChatMessage[] = [
      toolCall('c3', 'send_approve_picker', {
        amount_usd: 300,
        funding_method: 'bank_transfer',
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      }),
      { role: 'assistant', content: 'Quote ready — tap Approve to send.' },
    ];
    // Turn 4: user taps Approve → bot calls create_transfer (no args) → generate_payment_link.
    const turn4Script: ChatMessage[] = [
      toolCall('c4', 'create_transfer', {}),
      toolCall('c5', 'generate_payment_link', { transfer_id: 'PLACEHOLDER' }),
      { role: 'assistant', content: 'Tap to pay securely.' },
    ];

    const allScripts = [turn1Script, turn2Script, turn3Script, turn4Script];
    let activeScript: ChatMessage[] = [];
    let scriptIdx = 0;

    // Stub fetch for both FX and WhatsApp Cloud API (no-op success).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ rates: { INR: 85.2 } }),
        text: async () => '',
      }),
    );

    const dailyVolumeStore = createDailyVolumeStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const agent = createAgent({
      store,
      scheduleStore,
      draftStore,
      customerStore,
      dailyVolumeStore,
      monthlyVolumeStore,
      kycProvider,
      partnerStore: createPartnerStore(db), // pg-backed (Stage 2a cutover)
      async chat() {
        const msg = activeScript.shift()!;
        if (msg.tool_calls?.[0].function.name === 'generate_payment_link') {
          const key = [...redis.dump.keys()].find((k) =>
            k.startsWith('transfer:'),
          )!;
          msg.tool_calls[0].function.arguments = JSON.stringify({
            transfer_id: key.replace('transfer:', ''),
          });
        }
        return msg;
      },
    });

    // --- Turn 1: new conversation, picker should send.
    activeScript = [...allScripts[scriptIdx++]];
    await agent.runAgentTurn(PHONE, 'hi', { isNewConversation: true });

    // --- Turn 2: user taps Mom.
    activeScript = [...allScripts[scriptIdx++]];
    await agent.runAgentTurn(
      PHONE,
      `[Tapped: Send to recipient 919876543210]`,
      {
        isNewConversation: false,
        buttonTap: { kind: 'recipient', recipientPhone: '919876543210' },
      },
    );

    // --- Turn 3: user types "$300" — bot sends approve picker, creates draft.
    activeScript = [...allScripts[scriptIdx++]];
    await agent.runAgentTurn(PHONE, '$300', { isNewConversation: false });

    // A draft must now exist.
    const draftKey = [...redis.dump.keys()].find((k) =>
      k.startsWith('recipient_draft:'),
    );
    expect(draftKey).toBeDefined();
    const draftId = draftKey!.replace('recipient_draft:', '');

    // --- Turn 4: user taps Approve.
    activeScript = [...allScripts[scriptIdx++]];
    await agent.runAgentTurn(
      PHONE,
      '[Tapped: Approve & pay]',
      {
        isNewConversation: false,
        buttonTap: { kind: 'approve', draftId },
      },
    );

    // A transfer must have been created.
    const transferKey = [...redis.dump.keys()].find((k) =>
      k.startsWith('transfer:'),
    );
    expect(transferKey).toBeDefined();

    // The draft must have been consumed.
    expect(await draftStore.getDraft(draftId)).toBeNull();

    // The recipient's lastUsedAt must have advanced past the seed.
    const recipients = await store.listRecipients(PHONE, 3);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].lastUsedAt > '2026-05-01T00:00:00Z').toBe(true);
  });
});

describe('end-to-end new customer with cap', () => {
  it('greeted → over-cap → under-cap → approve creates transfer + increments daily volume', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const scheduleStore = createScheduleStore(redis, customerStore);
    const draftStore = createDraftStore(redis);
    // Phase 3: a verified sender (still T0 within the 3-day window, so the cap UX
    // below is unchanged) — required for send_approve_picker/create_transfer to
    // pass the verify-before-send gate. The observation invariant (verified
    // mid-window stays T0/$500) is still asserted at the end of this test.
    await seedVerifiedCustomer(customerStore, PHONE);

    // Turn 1: [NEW CUSTOMER] greeting — bot calls check_send_limit({amount_usd: 0})
    const turn1: ChatMessage[] = [
      toolCall('c1', 'check_send_limit', { amount_usd: 0 }),
      { role: 'assistant', content: 'Welcome! $500/day cap for 3 days. Verify: <url>. How much?' },
    ];
    // Turn 2: user asks $700 → bot calls check_send_limit({700}) → over_per_transfer_cap → bot replies
    const turn2: ChatMessage[] = [
      toolCall('c2', 'check_send_limit', { amount_usd: 700 }),
      { role: 'assistant', content: 'You can send up to $500 per transfer right now. Want $500?' },
    ];
    // Turn 3: user agrees to $400 → check_send_limit OK → send_approve_picker → bot waits
    const turn3: ChatMessage[] = [
      toolCall('c3', 'check_send_limit', { amount_usd: 400 }),
      toolCall('c4', 'send_approve_picker', {
        amount_usd: 400, funding_method: 'bank_transfer',
        recipient_name: 'Mom', recipient_phone: '919876543210',
        payout_method: 'upi', payout_destination: 'mom@upi',
      }),
      { role: 'assistant', content: 'Tap Approve to send.' },
    ];
    // Turn 4: user taps Approve → bot calls create_transfer (no args, from ctx) → generate_payment_link
    const turn4: ChatMessage[] = [
      toolCall('c5', 'create_transfer', {}),
      toolCall('c6', 'generate_payment_link', { transfer_id: 'PLACEHOLDER' }),
      { role: 'assistant', content: 'Tap to pay.' },
    ];

    const scripts = [turn1, turn2, turn3, turn4];
    let active: ChatMessage[] = [];
    let idx = 0;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '',
    }));

    const agent = createAgent({
      store, scheduleStore, draftStore, customerStore, dailyVolumeStore, monthlyVolumeStore, kycProvider,
      partnerStore: createPartnerStore(db), // pg-backed (Stage 2a cutover)
      async chat() {
        const msg = active.shift()!;
        if (msg.tool_calls?.[0].function.name === 'generate_payment_link') {
          const key = [...redis.dump.keys()].find((k) => k.startsWith('transfer:'))!;
          msg.tool_calls[0].function.arguments = JSON.stringify({
            transfer_id: key.replace('transfer:', ''),
          });
        }
        return msg;
      },
    });

    // Turn 1: NEW CUSTOMER
    active = [...scripts[idx++]];
    await agent.runAgentTurn(PHONE, 'hi', { isNewConversation: true, isNewCustomer: true });
    const customerAfterT1 = await customerStore.getCustomer(PHONE);
    expect(customerAfterT1?.kycStatus).toBe('verified'); // Phase 3: seeded verified so the send path passes the gate

    // Turn 2: over-cap
    active = [...scripts[idx++]];
    await agent.runAgentTurn(PHONE, 'send 700', { isNewConversation: false });

    // Turn 3: under-cap
    active = [...scripts[idx++]];
    await agent.runAgentTurn(PHONE, 'send 400 to mom upi mom@upi 919876543210 via bank', { isNewConversation: false });

    // A draft should now exist
    const draftKey = [...redis.dump.keys()].find((k) => k.startsWith('recipient_draft:'));
    expect(draftKey).toBeDefined();
    const draftId = draftKey!.replace('recipient_draft:', '');

    // Turn 4: approve tap
    active = [...scripts[idx++]];
    await agent.runAgentTurn(PHONE, '[Tapped: Approve & pay]', {
      isNewConversation: false,
      buttonTap: { kind: 'approve', draftId },
    });

    // Transfer must exist
    const transferKey = [...redis.dump.keys()].find((k) => k.startsWith('transfer:'));
    expect(transferKey).toBeDefined();
    // Daily volume must be 40000 cents
    expect(await dailyVolumeStore.getTodayCents(PHONE)).toBe(40_000);

    // Now mark verified mid-window — cap stays $500/day (observation invariant)
    await customerStore.saveCustomer({
      ...(await customerStore.getCustomer(PHONE))!,
      kycStatus: 'verified',
      kycVerifiedAt: new Date().toISOString(),
    });

    // $400 used today + $200 requested = $600 > $500 cap → over_daily_cap
    // (Verifies the observation invariant: KYC verified mid-window does NOT
    //  lift the cap. If verification lifted, $200 would fit in T1's $2,999.)
    const ev = evaluateCap(
      (await customerStore.getCustomer(PHONE))!,
      new Date(),
      await dailyVolumeStore.getTodayCents(PHONE),
      20_000,
    );
    expect(ev.tier).toBe('T0'); // still in window despite verification
    expect(ev.withinCap).toBe(false);
    expect(ev.reason).toBe('over_daily_cap');

    // Asking for $100 (which fits the $100 remaining of the $500 cap) → within
    const within = evaluateCap(
      (await customerStore.getCustomer(PHONE))!,
      new Date(),
      await dailyVolumeStore.getTodayCents(PHONE),
      10_000,
    );
    expect(within.withinCap).toBe(true);
  });
});
