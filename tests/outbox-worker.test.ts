import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { sql } from 'drizzle-orm';
import { createOutboxRepo, MAX_ATTEMPTS } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// The durability engine's failure paths: retry with backoff, dead-letter with
// exactly-one ops alert, and the settlement.instruct happy path (signed POST +
// write-once providerRef) — all on real Postgres.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

function transferFixture(): Transfer {
  return {
    id: 'wk_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-06-09T00:00:00.000Z', paidAt: '2026-06-09T00:01:00.000Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const sendText = vi.fn(async (..._a: unknown[]) => {});
const sendTemplate = vi.fn(async (..._a: unknown[]) => {});
const fetchFn = vi.fn();
const runAgentTurn = vi.fn(async (..._a: unknown[]) => '');

function deps(): WorkerDeps {
  return {
    db, store,
    sendText: sendText as unknown as WorkerDeps['sendText'],
    sendTemplate: sendTemplate as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    runAgentTurn: runAgentTurn as unknown as WorkerDeps['runAgentTurn'],
  };
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  sendText.mockReset();
  sendTemplate.mockReset();
  fetchFn.mockReset();
  runAgentTurn.mockReset();
  runAgentTurn.mockResolvedValue('');
});

describe('drainOnce — settlement.instruct (the real-rail outbound leg)', () => {
  beforeEach(async () => {
    await store.saveTransfer(transferFixture());
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' },
        webhookSecret: 'whk',
      },
      whatsapp: {},
    });
  });

  it('POSTs the SIGNED instruction with the DECRYPTED account and persists providerRef once', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rail-xyz' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rail.example/settle');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.reference).toBe('wk_t1');
    // The instruction carries the REAL account (decrypted read), not the mask.
    expect(JSON.stringify(body)).toContain('123456789012');
    expect((init.headers as Record<string, string>)['x-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBe('rail-xyz');
  });

  it('rail failure → retry with backoff; at MAX_ATTEMPTS → dead + EXACTLY ONE ops alert', async () => {
    fetchFn.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });

    // First failure: retried, not dead, no alert.
    let r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(1);
    expect(r.dead).toBe(0);
    expect(await outbox.listDead()).toHaveLength(0);

    // Fast-forward to the brink of death, then fail once more.
    await db.execute(
      sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now() WHERE kind = 'settlement.instruct'`,
    );
    r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    expect(await outbox.listDead()).toHaveLength(1);

    // The death enqueued a deduped ops.alert; with OPS_ALERT_PHONE set it sends.
    process.env.OPS_ALERT_PHONE = '15715466207';
    r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown[])[0]).toBe('15715466207');
    expect((sendText.mock.calls[0] as unknown[])[1]).toContain('DEAD');
    // Re-dying the same row can never alert twice (dedupe key).
    const again = await outbox.enqueue('ops.alert', { message: 'dup' }, { dedupeKey: `dead:${(await outbox.listDead())[0].id}` });
    expect(again).toBe(false);
  });
});

describe('drainOnce — rail.callback (the reference rail settle leg)', () => {
  it('POSTs the signed paid_out callback to the public webhook', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://x', signingSecret: 's' }, webhookSecret: 'whk_cb' },
      whatsapp: {},
    });
    fetchFn.mockResolvedValue({ ok: true });
    await outbox.enqueue('rail.callback', { reference: 'wk_t1', partner_id: 'acme' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/payment-webhook/simulator');
    expect(JSON.parse(String(init.body))).toEqual({ reference: 'wk_t1', status: 'paid_out' });
    expect((init.headers as Record<string, string>)['x-signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('drainOnce — plain sends', () => {
  it('whatsapp.text and whatsapp.template flow through with creds', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi', creds: { phoneNumberId: '111', token: 't' } });
    await outbox.enqueue('whatsapp.template', { to: '919876543210', template: 'transfer_delivered', lang: 'en', params: ['a'] });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hi', { phoneNumberId: '111', token: 't' });
    expect(sendTemplate).toHaveBeenCalledWith('919876543210', 'transfer_delivered', 'en', ['a'], undefined);
  });

  it('an unknown kind dead-letters instead of looping forever', async () => {
    await db.execute(sql`INSERT INTO outbox (kind, payload) VALUES ('bogus.kind', '{}'::jsonb)`);
    await db.execute(sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}`);
    const r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
  });
});

describe('drainOnce — agent.turn (the durable inbound turn)', () => {
  it('runs the agent and sends a non-empty reply (default number: no creds)', async () => {
    runAgentTurn.mockResolvedValue('Here is your quote!');
    await outbox.enqueue(
      'agent.turn',
      { phone: '15551230000', messageText: 'send $200 to mom', turn: { isNewConversation: true } },
      { dedupeKey: 'wamid:abc123' },
    );

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(runAgentTurn).toHaveBeenCalledWith(
      '15551230000', 'send $200 to mom', { isNewConversation: true }, undefined,
    );
    expect(sendText).toHaveBeenCalledWith('15551230000', 'Here is your quote!', undefined);
  });

  it("resolves the ROUTED partner's creds at run time and replies from their number", async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'mock' },
      whatsapp: { phoneNumberId: 'pn_acme', token: 'tok_acme' },
    });
    runAgentTurn.mockResolvedValue('hola');
    await outbox.enqueue('agent.turn', {
      phone: '15551230000', messageText: 'hi', turn: {}, routedPartnerId: 'acme',
    });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const creds = (runAgentTurn.mock.calls[0] as unknown[])[3];
    expect(creds).toMatchObject({ phoneNumberId: 'pn_acme' });
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hola', creds);
  });

  it('an empty reply sends nothing; an agent failure retries instead of eating the message', async () => {
    runAgentTurn.mockResolvedValue('   ');
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'ok', turn: {} });
    let r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).not.toHaveBeenCalled();

    runAgentTurn.mockRejectedValue(new Error('ollama blip'));
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'again', turn: {} });
    r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(1); // retried with backoff — NOT lost
  });
});

describe('reconciliation query feed', () => {
  it('findStuckPaid sees a webhook-driven transfer stranded in paid', async () => {
    await store.saveTransfer({ ...transferFixture(), paidAt: '2026-06-09T00:00:00.000Z' });
    const stuck = await createTransferRepo(db).findStuckPaid(15);
    expect(stuck.map((t) => t.id)).toEqual(['wk_t1']);
  });
});
