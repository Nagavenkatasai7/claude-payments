import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { sql } from 'drizzle-orm';
import { createStore, type Store } from '@/lib/store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createTicketRepo, type TicketRepo } from '@/db/repos/ticket-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';

/**
 * U2 — out-of-band AI auto-triage of customer tickets via the durable outbox.
 *
 * A freshly created customer ticket lands category=null/priority='normal'; the
 * worker drains a 'ticket.triage' row out-of-band → triageSuggest → setTriage →
 * audit. The model (chat()) is STUBBED everywhere so triageSuggest never hits
 * Ollama; tests assert the CLAMPED value the worker persists and the audit row.
 *
 * Coverage:
 *  - the worker handler: runs triageSuggest, calls setTriage with the clamped
 *    value, and records the system audit; off-list output collapses to defaults;
 *  - a customer ticket triggers triage, an internal one is a no-op;
 *  - all three creation sites enqueue ONE deduped 'triage:<id>' outbox row.
 */

// chat() is the single Ollama seam triageSuggest calls — stub it (the prompt
// says: vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }))). vi.hoisted lets the
// hoisted factory reference the mock fn so tests can drive its return value.
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('@/lib/ollama', () => ({ chat: chatMock }));

const PHONE = '15551230000';
const OTHER_PHONE = '15559990000';

let db: Db;
let store: Store;
let ps: PartnerStore;
let repo: TicketRepo;

// ── Worker deps (mirrors outbox-worker.test.ts; only db/store are load-bearing
// for ticket.triage — the send/fetch/agent seams are never touched here). ──────
const sendText = vi.fn(async (..._a: unknown[]) => {});
const sendTemplate = vi.fn(async (..._a: unknown[]) => {});
const fetchFn = vi.fn();
const runAgentTurn = vi.fn(async (..._a: unknown[]) => '');

function deps(): WorkerDeps {
  return {
    db,
    store,
    sendText: sendText as unknown as WorkerDeps['sendText'],
    sendTemplate: sendTemplate as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    runAgentTurn: runAgentTurn as unknown as WorkerDeps['runAgentTurn'],
  };
}

/** The model "reply" shape chat() returns (a ChatMessage with .content). */
function chatReply(content: string) {
  return { role: 'assistant', content };
}

async function createCustomerTicket(over: { id?: string; subject?: string; body?: string } = {}) {
  return repo.createTicket({
    id: over.id ?? 'tk_cust1',
    partnerId: 'p1',
    kind: 'customer',
    customerPhone: PHONE,
    subject: over.subject ?? 'Refund please',
    body: over.body ?? 'I want my money back, it never arrived.',
  });
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p1');
  store = createStore(fakeRedis(), db);
  ps = createPartnerStore(db);
  repo = createTicketRepo(db);
  chatMock.mockReset();
  sendText.mockReset();
  sendTemplate.mockReset();
  fetchFn.mockReset();
  runAgentTurn.mockReset();
  runAgentTurn.mockResolvedValue('');
});

describe('outbox worker — ticket.triage handler', () => {
  it('runs triageSuggest, persists the clamped value via setTriage, and audits as system', async () => {
    const ticket = await createCustomerTicket();
    // Model returns a valid in-list classification.
    chatMock.mockResolvedValue(chatReply('{"category":"refund","priority":"urgent"}'));

    await createOutboxRepo(db).enqueue('ticket.triage', { ticketId: ticket.id }, { dedupeKey: `triage:${ticket.id}` });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    // chat() was the ONE call triageSuggest made — the worker, not the redirect.
    expect(chatMock).toHaveBeenCalledTimes(1);

    // setTriage wrote the clamped value onto the ticket.
    const after = await repo.getTicket(ticket.id);
    expect(after!.category).toBe('refund');
    expect(after!.priority).toBe('urgent');

    // A system audit row was recorded with source:'copilot'.
    const audits = await createAuditRepo(db).listByPartner('p1');
    const triageAudit = audits.find((a) => a.action === 'ticket.triage');
    expect(triageAudit).toBeTruthy();
    expect(triageAudit!.actorType).toBe('system');
    expect(triageAudit!.actor).toBe('system');
    expect(triageAudit!.subjectId).toBe(ticket.id);
    expect(triageAudit!.meta).toMatchObject({ source: 'copilot', category: 'refund', priority: 'urgent' });
  });

  it('clamps off-list model output to other/normal', async () => {
    const ticket = await createCustomerTicket({ id: 'tk_clamp' });
    chatMock.mockResolvedValue(chatReply('{"category":"banana","priority":"nuclear"}'));

    await createOutboxRepo(db).enqueue('ticket.triage', { ticketId: ticket.id }, { dedupeKey: `triage:${ticket.id}` });
    await drainOnce(deps(), 'w1');

    const after = await repo.getTicket(ticket.id);
    expect(after!.category).toBe('other');
    expect(after!.priority).toBe('normal');
  });

  it('is a no-op for an internal (employee-question) ticket — never calls the model', async () => {
    const internal = await repo.createTicket({
      id: 'tk_internal',
      partnerId: 'p1',
      kind: 'internal',
      openedBy: 'agent7',
      subject: 'Policy question',
      body: 'How do we handle X?',
    });
    chatMock.mockResolvedValue(chatReply('{"category":"refund","priority":"urgent"}'));

    await createOutboxRepo(db).enqueue('ticket.triage', { ticketId: internal.id }, { dedupeKey: `triage:${internal.id}` });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1); // handled cleanly (no-op), not failed

    expect(chatMock).not.toHaveBeenCalled();
    const after = await repo.getTicket(internal.id);
    expect(after!.category).toBeUndefined(); // untouched
    const audits = await createAuditRepo(db).listByPartner('p1');
    expect(audits.find((a) => a.action === 'ticket.triage')).toBeUndefined();
  });

  it('is a no-op for a missing ticket (idempotent — gone ⇒ nothing to do)', async () => {
    await createOutboxRepo(db).enqueue('ticket.triage', { ticketId: 'tk_gone' }, { dedupeKey: 'triage:tk_gone' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a model outage throws and retries (not done, not dead on first failure)', async () => {
    const ticket = await createCustomerTicket({ id: 'tk_down' });
    chatMock.mockRejectedValue(new Error('Ollama 500'));

    await createOutboxRepo(db).enqueue('ticket.triage', { ticketId: ticket.id }, { dedupeKey: `triage:${ticket.id}` });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.dead).toBe(0);

    // The ticket stays un-triaged for staff to hand-sort.
    const after = await repo.getTicket(ticket.id);
    expect(after!.category).toBeUndefined();
  });
});

// ── Enqueue at the three creation sites ──────────────────────────────────────
// Each site mocks the modules it pulls (requireCustomer / getDb / stores), then
// asserts exactly one 'ticket.triage' outbox row with the deduped key. The model
// is never invoked at create time (the whole point — out-of-band).

function outboxKinds(): Promise<string[]> {
  return db
    .execute(sql`SELECT kind, payload, dedupe_key FROM outbox ORDER BY id`)
    .then((res) => (res as unknown as { rows: { kind: string }[] }).rows.map((r) => r.kind));
}

async function triageRows(): Promise<{ ticketId: string; dedupeKey: string }[]> {
  const res = await db.execute(
    sql`SELECT payload, dedupe_key FROM outbox WHERE kind = 'ticket.triage' ORDER BY id`,
  );
  return (res as unknown as { rows: { payload: { ticketId: string }; dedupe_key: string }[] }).rows.map((r) => ({
    ticketId: r.payload.ticketId,
    dedupeKey: r.dedupe_key,
  }));
}

describe('enqueue sites — every customer ticket creation queues a triage', () => {
  it('the worker NEVER hit the model at create time', () => {
    expect(chatMock).not.toHaveBeenCalled();
  });

  describe('createTicketAction (account/support)', () => {
    let sessionCustomer: Customer | null;
    beforeEach(() => {
      sessionCustomer = {
        senderPhone: PHONE,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        kycStatus: 'verified',
        senderCountry: 'US',
        partnerId: 'p1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as Customer;
    });

    it('enqueues one deduped triage row for the new ticket', async () => {
      vi.resetModules();
      const redirectMock = vi.fn((p: string) => { throw new Error(`REDIRECT:${p}`); });
      vi.doMock('@/lib/ollama', () => ({ chat: chatMock }));
      vi.doMock('@/lib/customer-auth', () => ({ requireCustomer: async () => sessionCustomer }));
      vi.doMock('@/db/client', async (orig) => ({ ...(await orig() as object), getDb: () => db }));
      vi.doMock('@/lib/partner-store', async (orig) => ({ ...(await orig() as object), getPartnerStore: () => ps }));
      vi.doMock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => store }));
      vi.doMock('next/navigation', () => ({
        redirect: (p: string) => redirectMock(p),
        notFound: () => { throw new Error('NOT_FOUND'); },
      }));
      const { createTicketAction } = await import('@/app/account/support/actions');

      const f = new FormData();
      f.set('subject', 'My transfer is late');
      f.set('message', 'It has been three days and nothing arrived yet.');
      await expect(createTicketAction(f)).rejects.toThrow(/REDIRECT:\/account\/support\/tk_/);

      const rows = await triageRows();
      expect(rows).toHaveLength(1);
      const mine = await repo.listByCustomer(PHONE);
      expect(rows[0].ticketId).toBe(mine[0].id);
      expect(rows[0].dedupeKey).toBe(`triage:${mine[0].id}`);
      expect(chatMock).not.toHaveBeenCalled(); // out-of-band — never inline
      vi.resetModules();
    });
  });

  describe('requestRecallAction (receipt page)', () => {
    let sessionCustomer: Customer | null;
    beforeEach(() => {
      sessionCustomer = {
        senderPhone: PHONE,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        kycStatus: 'verified',
        senderCountry: 'US',
        partnerId: 'p1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as Customer;
    });

    it('enqueues one deduped triage row for the recall ticket', async () => {
      // A delivered transfer inside the 24h window (relative dates).
      await store.saveTransfer({
        id: 'T_recall', phone: PHONE, amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99,
        fxRate: 85.2, amountInr: 8520, recipientName: 'Mom', recipientPhone: '919876543210',
        payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
        complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
        createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        paidAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        deliveredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        partnerId: 'p1',
        sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
        amountSource: 100, feeSource: 1.99, totalChargeSource: 101.99,
      } as Parameters<Store['saveTransfer']>[0]);

      vi.resetModules();
      const redirectMock = vi.fn((p: string) => { throw new Error(`REDIRECT:${p}`); });
      vi.doMock('@/lib/ollama', () => ({ chat: chatMock }));
      vi.doMock('@/lib/customer-auth', () => ({ requireCustomer: async () => sessionCustomer }));
      vi.doMock('@/db/client', async (orig) => ({ ...(await orig() as object), getDb: () => db }));
      vi.doMock('@/lib/partner-store', async (orig) => ({ ...(await orig() as object), getPartnerStore: () => ps }));
      vi.doMock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => store }));
      vi.doMock('next/navigation', () => ({
        redirect: (p: string) => redirectMock(p),
        notFound: () => { throw new Error('NOT_FOUND'); },
      }));
      const { requestRecallAction } = await import('@/app/account/receipt/recall-actions');

      const f = new FormData();
      f.set('transferId', 'T_recall');
      f.set('reason', 'not_received');
      await expect(requestRecallAction(f)).rejects.toThrow(/REDIRECT:\/account\/support\/tk_/);

      const rows = await triageRows();
      expect(rows).toHaveLength(1);
      const mine = await repo.listByCustomer(PHONE);
      expect(rows[0].ticketId).toBe(mine[0].id);
      expect(rows[0].dedupeKey).toBe(`triage:${mine[0].id}`);
      expect(chatMock).not.toHaveBeenCalled();
      vi.resetModules();
    });
  });

  describe('openRecallDisputeTool (agent tool)', () => {
    it('enqueues one deduped triage row via the outboxRepo seam', async () => {
      const { executeTool } = await import('@/lib/tools');
      const { createTransferRepo } = await import('@/db/repos/transfer-repo');
      const { createDraftStore } = await import('@/lib/draft-store');
      const { createScheduleStore } = await import('@/lib/schedule-store');
      const { createCustomerStore } = await import('@/lib/customer-store');
      const { createDailyVolumeStore } = await import('@/lib/daily-volume-store');
      const { createMonthlyVolumeStore } = await import('@/lib/monthly-volume-store');
      const { MockKycProvider } = await import('@/lib/providers/mock-kyc-provider');

      const redis = fakeRedis();
      const customerStore = createCustomerStore(db, store);
      const nowIso = new Date().toISOString();
      await customerStore.saveCustomer({
        senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
        senderCountry: 'US', partnerId: 'p1', createdAt: nowIso, updatedAt: nowIso,
      } as Customer);

      // A delivered transfer inside the 24h recall window.
      await store.saveTransfer({
        id: 'T_tool', phone: PHONE, amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99,
        fxRate: 85.2, amountInr: 8520, recipientName: 'Mom', recipientPhone: '919876543210',
        payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
        complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
        createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        paidAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        deliveredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        partnerId: 'p1',
        sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
        amountSource: 100, feeSource: 1.99, totalChargeSource: 101.99,
      } as Parameters<Store['saveTransfer']>[0]);

      const ctx = {
        phone: PHONE,
        store,
        scheduleStore: createScheduleStore(db),
        draftStore: createDraftStore(redis),
        turn: { isNewConversation: false } as const,
        customerStore,
        dailyVolumeStore: createDailyVolumeStore(redis),
        monthlyVolumeStore: createMonthlyVolumeStore(redis),
        kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
        partnerStore: ps,
        transferRepo: createTransferRepo(db),
        ticketRepo: repo,
        outboxRepo: createOutboxRepo(db), // PGlite-bound seam — assert the enqueue here
      };

      const r = await executeTool('open_recall_dispute', { transfer_id: 'T_tool', reason: 'wrong_recipient' }, ctx as never);
      expect(r.opened).toBe(true);

      const rows = await triageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].ticketId).toBe(r.case_id);
      expect(rows[0].dedupeKey).toBe(`triage:${r.case_id}`);
      expect(chatMock).not.toHaveBeenCalled(); // never inline in the agent turn
    });
  });

  it('no stray non-triage rows leaked from the worker setup (sanity)', async () => {
    // Fresh db each test; this just guards the helper shape.
    expect(await outboxKinds()).toEqual([]);
  });
});
