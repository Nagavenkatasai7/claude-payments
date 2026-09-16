import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { sql } from 'drizzle-orm';
import { createOutboxRepo, MAX_ATTEMPTS, LEASE_MS } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { drainOnce, ROW_DEADLINE_MS, type WorkerDeps } from '@/lib/outbox-worker';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { RAIL_TIMEOUT_MS } from '@/lib/providers/http-payment-provider';

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
    listStaff: async () => [],
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

describe('drainOnce — email.send (partner-lead notification)', () => {
  it('calls the injected sendEmail with the recipients + subject and marks done', async () => {
    const sent: { to: string[]; subject: string; text: string }[] = [];
    const d: WorkerDeps = { ...deps(), sendEmail: async (m) => { sent.push(m); } };
    await outbox.enqueue(
      'email.send',
      { to: ['venkat@smartremit.ai', 'rohan@smartremit.ai'], subject: 'New partner request: Acme Remit', text: 'Company: Acme Remit\nEmail: a@acme.com' },
      { dedupeKey: 'preq:abc123' },
    );
    const r = await drainOnce(d, 'w1');
    expect(r.processed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['venkat@smartremit.ai', 'rohan@smartremit.ai']);
    expect(sent[0].subject).toContain('Acme Remit');
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
      expect.objectContaining({ routedPartnerId: null, signal: expect.any(AbortSignal) }),
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
    expect(((runAgentTurn.mock.calls[0] as unknown[])[4] as { routedPartnerId: string }).routedPartnerId).toBe('acme'); // the routed tenant reaches the agent
  });

  it('a routedPartnerId that names NO partner runs the turn under DEFAULT and raises one deduped ops alert (a malformed/legacy row never runs under a nonexistent tenant)', async () => {
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {}, routedPartnerId: 'ghost_partner' }, { dedupeKey: 'wamid:ghost1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const opts = (runAgentTurn.mock.calls[0] as unknown[])[4] as { routedPartnerId: string | null };
    expect(opts.routedPartnerId).toBeNull(); // ⇒ DEFAULT_PARTNER_ID in the route wiring
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toEqual([expect.stringMatching(/^badtenant:\d+$/)]);
  });

  it('a routedPartnerId naming a SUSPENDED partner is treated the same: default tenant + one deduped badtenant alert (a suspended tenant must not keep serving customers through the shared number / its BYO pnid)', async () => {
    await seedPartner(db, 'dormant');
    const repo = createPartnerRepo(db);
    await repo.savePartner({ ...(await repo.getPartner('dormant'))!, status: 'suspended', updatedAt: new Date().toISOString() }); // the non-active value Partner['status'] allows — check src/lib/types.ts
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {}, routedPartnerId: 'dormant' }, { dedupeKey: 'wamid:dormant1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const opts = (runAgentTurn.mock.calls[0] as unknown[])[4] as { routedPartnerId: string | null };
    expect(opts.routedPartnerId).toBeNull();
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toEqual([expect.stringMatching(/^badtenant:\d+$/)]);
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

describe('drainOnce — funding.refund on a B2B ach_pull (NON-CUSTODIAL partner reverse, not a PSP refund)', () => {
  beforeEach(async () => {
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

  it('POSTs a SIGNED reverse instruction to the rail and completes the refund — no funds-provider capture', async () => {
    // A paid ach_pull transfer with a reversal already requested+approved
    // (refundStatus pending), exactly as reverseB2bSettlement leaves it.
    await store.saveTransfer({
      ...transferFixture(),
      fundingMethod: 'ach_pull',
      transferType: 'b2b',
      achTokenRef: 'ach_deadbeef',
      senderBusinessName: 'Raj Trading Co',
      recipientBusinessName: 'Wilson HK Ltd',
      refundStatus: 'pending',
    } as Transfer);
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'reverse-rail-9' }) });
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    // The ONLY outbound HTTP is the signed reverse instruction to the partner rail.
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rail.example/settle');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.action).toBe('reverse'); // return-ACH path, NOT a fresh payout
    // DISTINCT reference from the original settle (reverse-<id>) so a rail that
    // dedupes on reference cannot swallow the reverse as a replay of the settle.
    expect(body.reference).toBe('reverse-wk_t1');
    expect(body.partner_id).toBe('acme');
    expect((init.headers as Record<string, string>)['x-signature']).toMatch(/^[0-9a-f]{64}$/);

    // Refund lifecycle completes off the rail ack; the customer hears "reversed".
    const t = (await store.getTransfer('wk_t1'))!;
    expect(t.refundStatus).toBe('completed');
    expect(t.refundRef).toBe('reverse-rail-9');
    const dead = await outbox.listDead();
    expect(dead).toHaveLength(0);
  });
});

describe('drainOnce — lease reclaim (a worker killed mid-row)', () => {
  it('a row abandoned by a dead worker is re-handled on the next drain and marked done', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    const [row] = await outbox.claimBatch(1, 'w_dead'); // w_dead never comes back
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '10 minutes' WHERE id = ${row.id}`);

    const r = await drainOnce(deps(), 'w_new');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const res = await db.execute(sql`SELECT status, attempts, lease_owner FROM outbox WHERE id = ${row.id}`);
    const [{ status, attempts, lease_owner }] =
      (res as unknown as { rows: Array<{ status: string; attempts: number; lease_owner: string | null }> }).rows;
    expect(status).toBe('done');
    expect(attempts).toBe(2); // the reclaim counted as a retry
    expect(lease_owner).toBeNull();
  });

  it('a LIVE lease is left alone — no double execution', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    await outbox.claimBatch(1, 'w_alive');
    const r = await drainOnce(deps(), 'w_other');
    expect(r.processed + r.failed + r.dead).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('a NON-agent row that exceeds the per-row deadline fails RETRYABLY and does not starve the rest of the batch', async () => {
    // A hung Graph POST that ignores its own signal (the deadline is the backstop).
    sendText.mockImplementationOnce(() => new Promise<void>(() => {})); // never resolves
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'slow' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'next' });

    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 50 });
    expect(r).toMatchObject({ failed: 1, processed: 1, dead: 0 });
    const res = await db.execute(sql`SELECT status, last_error FROM outbox WHERE payload->>'body' = 'slow'`);
    const [{ status, last_error }] = (res as unknown as { rows: Array<{ status: string; last_error: string }> }).rows;
    expect(status).toBe('failed');
    expect(last_error).toMatch(/row deadline/);
    expect(ROW_DEADLINE_MS).toBeLessThan(45_000); // under TIME_BUDGET_MS (route.ts:36) and maxDuration
  });

  it('a deadline-failed row is NOT re-claimable while its abandoned handler may still run (backoff ≥ LEASE_MS)', async () => {
    // The abandoned send keeps running inside the live invocation (up to maxDuration);
    // a second worker must not be able to run the same row beside it.
    sendText.mockImplementationOnce(() => new Promise<void>(() => {})); // never resolves
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'slow' });
    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 50 });
    expect(r).toMatchObject({ failed: 1, dead: 0 });

    // Immediately: nothing to re-run.
    await drainOnce(deps(), 'w2');
    expect(sendText).toHaveBeenCalledTimes(1);
    // Even a few seconds later (past the ordinary 2^1 = 2s backoff) it stays parked.
    await db.execute(sql`UPDATE outbox SET next_attempt_at = next_attempt_at - interval '5 seconds' WHERE payload->>'body' = 'slow'`);
    await drainOnce(deps(), 'w3');
    expect(sendText).toHaveBeenCalledTimes(1);
    const res = await db.execute(
      sql`SELECT extract(epoch FROM (next_attempt_at - now()))::float AS wait_s FROM outbox WHERE payload->>'body' = 'slow'`,
    );
    const [{ wait_s }] = (res as unknown as { rows: Array<{ wait_s: number }> }).rows;
    expect(wait_s).toBeGreaterThan(LEASE_MS / 1000 - 10); // ≥ ~5 min, past maxDuration
  });

  it('markDone is owner-checked: a handler whose lease was taken mid-run does not mark the row done', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    sendText.mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE outbox SET lease_owner = 'w_new' WHERE kind = 'whatsapp.text'`);
    });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 0 });
    const res = await db.execute(sql`SELECT status, lease_owner FROM outbox WHERE kind = 'whatsapp.text'`);
    const [{ status, lease_owner }] = (res as unknown as { rows: Array<{ status: string; lease_owner: string }> }).rows;
    expect(status).toBe('processing');
    expect(lease_owner).toBe('w_new');
  });

  it('markFailed is owner-checked: a throwing handler whose lease was taken mid-run is \'lost\' — no failed/dead count', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    sendText.mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE outbox SET lease_owner = 'w_new' WHERE kind = 'whatsapp.text'`);
      throw new Error('graph 500');
    });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 0 });
    const res = await db.execute(sql`SELECT status, lease_owner, last_error FROM outbox WHERE kind = 'whatsapp.text'`);
    const [{ status, lease_owner, last_error }] =
      (res as unknown as { rows: Array<{ status: string; lease_owner: string; last_error: string | null }> }).rows;
    expect(status).toBe('processing');
    expect(lease_owner).toBe('w_new');
    expect(last_error).toBeNull();
  });

  it('agent.turn receives an AbortSignal that fires BEFORE the row deadline (COOP_GRACE_MS), and a turn that honours it (fallback reply) is marked DONE with its reply SENT', async () => {
    // `runAgentTurn` is declared `vi.fn(async (..._a: unknown[]) => '')` at :39 — an implementation
    // whose 5th parameter is annotated `opts?: { signal?: AbortSignal }` does not type-check under
    // strictFunctionTypes (tsconfig includes tests/), so keep the rest-`unknown[]` shape and cast.
    runAgentTurn.mockImplementation(async (..._a: unknown[]) => {
      const opts = _a[4] as { signal?: AbortSignal } | undefined;
      expect(opts?.signal).toBeInstanceOf(AbortSignal); // 5th argument: (phone, message, turn, waCreds, opts)
      await new Promise((res) => opts!.signal!.addEventListener('abort', res, { once: true }));
      return "Sorry, I'm having trouble right now. Could you send that again?"; // the agent's own FALLBACK_REPLY on abort
    });
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'slow', turn: {} });
    // rowDeadlineMs 200 ⇒ the COOPERATIVE signal fires at max(1, 200 − COOP_GRACE_MS) = 1ms,
    // the hard race timer at 200ms. The agent returns inside that grace, so the row
    // is a normal completion even though `signal.aborted` is true — the worker
    // discriminates on the row's `abandoned` flag (set only by the race timer).
    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 200 });
    expect(r).toMatchObject({ processed: 1, failed: 0, dead: 0 });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String((sendText.mock.calls[0] as unknown[])[1])).toMatch(/send that again/);
  });

  it('agent.turn that IGNORES the deadline is TERMINAL (dead + one deduped alert), never retried, and its late reply is never sent', async () => {
    // A tool hung past the signal: the handler promise is abandoned by withRowDeadline…
    let resolveLate!: (v: string) => void;
    runAgentTurn.mockImplementation(() => new Promise<string>((res) => { resolveLate = res; }));
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'slow', turn: {} });

    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 50 });
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 1 });
    const res = await db.execute(sql`SELECT status, last_error FROM outbox WHERE kind = 'agent.turn'`);
    const [{ status, last_error }] = (res as unknown as { rows: Array<{ status: string; last_error: string }> }).rows;
    expect(status).toBe('dead'); // NOT 'failed': a retry would re-run the same inbound message beside the abandoned turn
    expect(last_error).toMatch(/row deadline/);
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toHaveLength(1);
    expect(alerts.rows[0].dedupe_key).toMatch(/^dead:/);
    // A second drain does NOT re-run the turn (terminal), and only drains the alert.
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    await drainOnce(deps(), 'w2');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    // …and when the abandoned turn finally resolves, the worker's agent.turn branch sees the row's
    // `abandoned` flag (set by the race timer — NOT `signal.aborted`, which is also true on the
    // cooperative path above) and SKIPS sendText.
    resolveLate('late reply');
    await new Promise((res) => setTimeout(res, 10));
    expect(sendText.mock.calls.map((c) => String((c as unknown[])[1]))).not.toContain('late reply');
  });

  it('an agent.turn that could still be running at hardStopAt is RELEASED unstarted — never started, killed by the platform and re-run beside its ghost — while a money row still starts', async () => {
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {} });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'fits' });
    // 10s of invocation left, 40s row deadline: the non-idempotent turn cannot fit; the send can.
    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 40_000, hardStopAt: Date.now() + 10_000 });
    expect(r).toMatchObject({ processed: 1, released: 1, failed: 0, dead: 0 });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await outbox.countPending()).toBe(1); // the turn waits for the next invocation, attempt refunded
  });

  it('stopAfter RELEASES unstarted rows (owner-only, attempt refunded) instead of parking them under a 5-minute lease', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'a' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'b' });
    const r = await drainOnce(deps(), 'w1', 10, { stopAfter: Date.now() - 1 });
    expect(r).toMatchObject({ released: 2, processed: 0 });
    expect(sendText).not.toHaveBeenCalled();
    expect(await outbox.countPending()).toBe(2);
    const r2 = await drainOnce(deps(), 'w2');
    expect(r2.processed).toBe(2);
  });
});

describe('drainOnce — outbound deadlines (rail-09 / obs-03)', () => {
  const timeoutError = () =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

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

  it('settlement.instruct POSTs with an AbortSignal carrying the rail deadline', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({}) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    await drainOnce(deps(), 'w1');
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
    expect(RAIL_TIMEOUT_MS).toBe(15_000);
  });

  it('an aborted rail POST is a RETRYABLE failure (failed + backoff), not a dead letter on attempt 1', async () => {
    fetchFn.mockRejectedValue(timeoutError());
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ failed: 1, dead: 0, processed: 0 });
    expect(await outbox.listDead()).toHaveLength(0);
    const res = await db.execute(sql`SELECT status, last_error, next_attempt_at FROM outbox WHERE kind = 'settlement.instruct'`);
    const [{ status, last_error, next_attempt_at }] =
      (res as unknown as { rows: Array<{ status: string; last_error: string; next_attempt_at: string }> }).rows;
    expect(status).toBe('failed');
    expect(last_error).toMatch(/aborted/i);
    expect(new Date(next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // rides the 2^attempts backoff
  });

  it('an aborted settlement.instruct never writes providerRef', async () => {
    fetchFn.mockRejectedValue(timeoutError());
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    await drainOnce(deps(), 'w1');
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBeFalsy();
  });

  it('rail.callback and the non-custodial reverse POST also carry the deadline signal', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({}) });
    await outbox.enqueue('rail.callback', { reference: 'wk_t1', partner_id: 'acme' });
    await store.saveTransfer({
      ...transferFixture(), fundingMethod: 'ach_pull', transferType: 'b2b',
      achTokenRef: 'ach_deadbeef', refundStatus: 'pending',
    } as Transfer);
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const call of fetchFn.mock.calls) {
      const [, init] = call as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
