import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
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
    // Unrouted: the instruction's partner_id is the OWNING partner's.
    expect(body.partner_id).toBe('acme');
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

describe('drainOnce — settlement.instruct (ROUTED via settlementPartnerId)', () => {
  beforeEach(async () => {
    // Owner 'acme' has its OWN rail config — which must NOT be used when routed.
    await seedPartner(db, 'railp');
    await store.saveTransfer({ ...transferFixture(), settlementPartnerId: 'railp' });
    const repo = createIntegrationsRepo(db, provider);
    await repo.saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://owner.example/settle', signingSecret: 'owner_sgn' },
        webhookSecret: 'owner_whk',
      },
      whatsapp: {},
    });
    await repo.saveIntegrations('railp', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://railp.example/settle', signingSecret: 'railp_sgn' },
        webhookSecret: 'railp_whk',
      },
      whatsapp: {},
    });
  });

  it("POSTs to the SETTLEMENT partner's URL, signed with THEIR secret, carrying THEIR partner_id", async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'railp-ref' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://railp.example/settle'); // NOT the owner's rail
    const raw = String(init.body);
    const body = JSON.parse(raw) as Record<string, unknown>;
    // The simulator rail verifies with the partner_id IN the instruction — when
    // routed it must be the settlement partner's id, signed with THEIR secret.
    expect(body.partner_id).toBe('railp');
    expect(body.reference).toBe('wk_t1');
    const expectedSig = createHmac('sha256', 'railp_sgn').update(raw).digest('hex');
    expect((init.headers as Record<string, string>)['x-signature']).toBe(expectedSig);
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBe('railp-ref');
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

describe('drainOnce — funding.refund (the money-back leg)', () => {
  function refundFixture(over: Partial<Transfer> = {}): Transfer {
    return {
      ...transferFixture(),
      status: 'cancelled',
      fundingRef: 'mockfund-wk_t1',
      refundStatus: 'pending',
      ...over,
    } as Transfer;
  }

  it("completes the refund and queues the customer message with the OWNING partner's creds (never the settlement partner's)", async () => {
    // Routed transfer: brand owner 'acme', settles via 'railp'. The refund
    // message must ride the OWNER's WhatsApp number — that's who the customer
    // has been talking to.
    await seedPartner(db, 'railp');
    const repo = createIntegrationsRepo(db, provider);
    await repo.saveIntegrations('acme', {
      kyc: {}, payment: { providerType: 'mock' },
      whatsapp: { phoneNumberId: 'pn_acme', token: 'tok_acme' },
    });
    await repo.saveIntegrations('railp', {
      kyc: {}, payment: { providerType: 'mock' },
      whatsapp: { phoneNumberId: 'pn_railp', token: 'tok_railp' },
    });
    await store.saveTransfer(refundFixture({ settlementPartnerId: 'railp' }));
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    let r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    const t = await store.getTransfer('wk_t1');
    expect(t?.refundStatus).toBe('completed');
    expect(t?.refundRef).toBe('mockrefund-wk_t1'); // the (real) mock provider's deterministic ref
    expect(t?.refundedAt).toBeTruthy();

    const rows = (await db.execute(
      sql`SELECT kind, dedupe_key FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ kind: string; dedupe_key: string }> };
    expect(rows.rows).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'refundmsg:wk_t1' }]);

    // Second pass delivers the message — owner creds, refund copy, no reasons.
    r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const [to, body, creds] = sendText.mock.calls[0] as [string, string, unknown];
    expect(to).toBe('15551230000');
    expect(body).toContain('refunded');
    expect(body).toContain('wk_t1');
    expect(body.toLowerCase()).not.toContain('compliance');
    expect(creds).toEqual({ phoneNumberId: 'pn_acme', token: 'tok_acme' });
  });

  it('a replay after completion is a clean no-op: provider untouched, no second message', async () => {
    const refund = vi.fn(async (t: Transfer) => ({ refundRef: `mockrefund-${t.id}` }));
    const d: WorkerDeps = {
      ...deps(),
      fundingProvider: {
        capture: async (t) => ({ fundingRef: `mockfund-${t.id}` }),
        refund,
        handleWebhook: async () => null,
      },
    };
    await store.saveTransfer(refundFixture());
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });
    await drainOnce(d, 'w1'); // refund + message enqueue
    await drainOnce(d, 'w1'); // message send
    expect(refund).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);

    // A second effect row (e.g. an ops retry after a presumed failure that
    // actually succeeded) replays the handler against a completed refund.
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1:retry:1' });
    const r = await drainOnce(d, 'w1');
    expect(r.processed).toBe(1); // clean no-op, not an error
    expect(refund).toHaveBeenCalledTimes(1); // provider NOT charged with a second refund
    const msgs = (await db.execute(
      sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(msgs.rows[0].n).toBe(1); // no second customer message
  });

  it('a provider failure retries with backoff (attempts increments; refund stays pending) and dead-letters at the cap', async () => {
    const d: WorkerDeps = {
      ...deps(),
      fundingProvider: {
        capture: async (t) => ({ fundingRef: `mockfund-${t.id}` }),
        refund: async () => { throw new Error('PSP 503'); },
        handleWebhook: async () => null,
      },
    };
    await store.saveTransfer(refundFixture());
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    let r = await drainOnce(d, 'w1');
    expect(r.failed).toBe(1);
    expect((await store.getTransfer('wk_t1'))?.refundStatus).toBe('pending'); // never falsely completed
    let row = (await db.execute(
      sql`SELECT attempts, status FROM outbox WHERE kind = 'funding.refund'`,
    )) as unknown as { rows: Array<{ attempts: number; status: string }> };
    expect(row.rows[0]).toEqual({ attempts: 1, status: 'failed' });

    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'funding.refund'`);
    r = await drainOnce(d, 'w1');
    expect(r.failed).toBe(1);
    row = (await db.execute(
      sql`SELECT attempts, status FROM outbox WHERE kind = 'funding.refund'`,
    )) as unknown as { rows: Array<{ attempts: number; status: string }> };
    expect(row.rows[0]).toEqual({ attempts: 2, status: 'failed' });

    // At MAX_ATTEMPTS the row dies and the EXISTING dead-letter alert flow fires.
    await db.execute(sql`
      UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now()
      WHERE kind = 'funding.refund'
    `);
    r = await drainOnce(d, 'w1');
    expect(r.dead).toBe(1);
    const alerts = (await db.execute(
      sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`,
    )) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].dedupe_key).toMatch(/^dead:\d+$/);
  });

  it('a vanished transfer is an idempotent no-op', async () => {
    await outbox.enqueue('funding.refund', { transferId: 'ghost' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('reconciliation query feed', () => {
  it('findStuckPaid sees a webhook-driven transfer stranded in paid', async () => {
    await store.saveTransfer({ ...transferFixture(), paidAt: '2026-06-09T00:00:00.000Z' });
    const stuck = await createTransferRepo(db).findStuckPaid(15);
    expect(stuck.map((t) => t.id)).toEqual(['wk_t1']);
  });
});
