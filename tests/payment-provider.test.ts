import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

const sendText = vi.fn(async (..._a: unknown[]) => {});
const sendTemplate = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/whatsapp', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

import {
  MockPaymentProvider, getPaymentProvider, DELIVERY_DELAY_MS,
} from '@/lib/providers/payment-provider';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';

function fixture(): Transfer {
  return {
    id: 'pay_seam_1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-05-29T00:00:00.000Z', partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;

function workerDeps(): WorkerDeps {
  return {
    db,
    store,
    sendText: sendText as unknown as WorkerDeps['sendText'],
    sendTemplate: sendTemplate as unknown as WorkerDeps['sendTemplate'],
    fetchFn: vi.fn() as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  sendText.mockClear();
  sendTemplate.mockClear();
});

describe('DELIVERY_DELAY_MS', () => {
  it('is the same 120000ms (2 min) sandbox lag', () => {
    expect(DELIVERY_DELAY_MS).toBe(120000);
  });
});

describe('MockPaymentProvider.initiateTransfer (stage 1 + durable stage 2)', () => {
  it('marks paid, sends the sender text, and enqueues a DELAYED deduped mock.settle row', async () => {
    await store.saveTransfer(fixture());
    const provider = new MockPaymentProvider(store, outbox);

    const { providerRef } = await provider.initiateTransfer(fixture());

    expect(providerRef).toBe('mock-pay_seam_1');
    expect((await store.getTransfer('pay_seam_1'))!.status).toBe('paid');
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown[])[1]).toContain('Payment received');
    // Stage 2 is an outbox row, not a timer: present, delayed, dedupe-keyed.
    expect(await outbox.countPending()).toBe(1);
    expect(await outbox.claimBatch(10, 'w')).toHaveLength(0); // not due for 120s
    // Idempotent: re-initiating (crash replay) cannot enqueue a second settle.
    await provider.initiateTransfer(fixture());
    expect(await outbox.countPending()).toBe(1);
  });

  it('stage 2 delivers via the WORKER once due: delivered + sender text + recipient template', async () => {
    await store.saveTransfer(fixture());
    await new MockPaymentProvider(store, outbox).initiateTransfer(fixture());
    sendText.mockClear();

    // Make the delayed row due now (time travel), then drain like /api/worker.
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now()`);
    const result = await drainOnce(workerDeps(), 'w1');

    expect(result.processed).toBe(1);
    expect((await store.getTransfer('pay_seam_1'))!.status).toBe('delivered');
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown[])[1]).toContain('delivered');
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const tmCall = sendTemplate.mock.calls[0] as unknown[];
    expect(tmCall[0]).toBe('919876543210');
    expect(tmCall[1]).toBe('transfer_delivered');
    expect(tmCall[3]).toEqual(['Mom', '₹16,600', '+15551230000', 'bank account']);
    // Draining again is a no-op (row done; stage 2 idempotent regardless).
    expect((await drainOnce(workerDeps(), 'w1')).processed).toBe(0);
  });

  it('skips the recipient template when there is no recipientPhone', async () => {
    const t = fixture(); t.recipientPhone = '';
    await store.saveTransfer(t);
    await new MockPaymentProvider(store, outbox).initiateTransfer(t);
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now()`);
    await drainOnce(workerDeps(), 'w1');
    expect(sendTemplate).not.toHaveBeenCalled();
    expect((await store.getTransfer('pay_seam_1'))!.status).toBe('delivered');
  });

  it('WL1: the delivery message uses the PARTNER brand resolved at drain time', async () => {
    await seedPartner(db, 'acme');
    await db.execute(sql`UPDATE partners SET display_name = 'Acme Pay' WHERE id = 'acme'`);
    const t = { ...fixture(), partnerId: 'acme' };
    await store.saveTransfer(t);
    await new MockPaymentProvider(store, outbox, 'Acme Pay').initiateTransfer(t);
    sendText.mockClear();
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now()`);
    await drainOnce(workerDeps(), 'w1');
    const msg = (sendText.mock.calls[0] as unknown[])[1] as string;
    expect(msg).toContain('Thanks for using Acme Pay!');
    expect(msg).not.toContain('SmartRemit');
  });
});

describe('MockPaymentProvider.getStatus (derives from stored TransferStatus)', () => {
  it('maps awaiting_payment→created, paid→funded, delivered→paid_out', async () => {
    const t = fixture(); await store.saveTransfer(t);
    const provider = new MockPaymentProvider(store, outbox);
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('created');
    await store.saveTransfer({ ...t, status: 'paid' });
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('funded');
    await store.saveTransfer({ ...t, status: 'delivered' });
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('paid_out');
  });
  it('returns created for an unknown / malformed ref', async () => {
    const provider = new MockPaymentProvider(store, outbox);
    expect(await provider.getStatus('mock-nope')).toBe('created');
    expect(await provider.getStatus('garbage')).toBe('created');
  });
});

describe('MockPaymentProvider.handleWebhook + factory', () => {
  it('handleWebhook is a no-op returning null (mirrors MockKycProvider)', async () => {
    const provider = new MockPaymentProvider(store, outbox);
    expect(await provider.handleWebhook({ any: 'thing' })).toBeNull();
  });
  it('getPaymentProvider returns the mock under the default mode', () => {
    expect(getPaymentProvider(store, outbox)).toBeInstanceOf(MockPaymentProvider);
  });
  it('WL1: falls back to mock for absent / "mock" / unknown providerType', () => {
    expect(getPaymentProvider(store, outbox, undefined)).toBeInstanceOf(MockPaymentProvider);
    expect(getPaymentProvider(store, outbox, {})).toBeInstanceOf(MockPaymentProvider);
    expect(getPaymentProvider(store, outbox, { providerType: 'mock' })).toBeInstanceOf(MockPaymentProvider);
    // An unconfigured / not-yet-built real rail must NOT silently move money — mock.
    expect(getPaymentProvider(store, outbox, { providerType: 'some-future-rail' })).toBeInstanceOf(MockPaymentProvider);
  });
});
