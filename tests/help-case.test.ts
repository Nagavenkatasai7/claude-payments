import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// R43: openHelpCase(tx) is the ONE path that opens a help case, for the
// request_human_help tool and the HELP keyword alike. The ticket, its triage row
// and the deduped ops alert are written in the caller's transaction, and the
// worker is poked only after that transaction commits.

const events = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('@/lib/outbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/outbox')>()),
  pokeWorker: () => {
    events.list.push('poke');
  },
}));

import { cancelCaseWanted, HELP_REASONS, openHelpCase, openHelpCaseAndPoke } from '@/lib/help-case';

const PHONE = '15551230000';
let db: Db;

async function outboxRows(kind: string) {
  const r = await db.execute(sql`SELECT payload, dedupe_key FROM outbox WHERE kind = ${kind} ORDER BY id`);
  return r.rows as Array<{ payload: Record<string, unknown>; dedupe_key: string | null }>;
}

beforeEach(async () => {
  db = await freshDb();
  events.list = [];
});

describe('openHelpCase(tx): ticket + triage + one deduped alert, in the caller transaction', () => {
  it('opens ONE customer human_help case and enqueues triage:<id> and help:<id>', async () => {
    const r = await db.transaction((tx) =>
      openHelpCase(tx, { partnerId: 'default', phone: PHONE, reason: 'question', channel: 'whatsapp', source: 'keyword' }),
    );
    expect(r.created).toBe(true);
    expect(r.caseId).toMatch(/^tk_/);
    const tickets = await createTicketRepo(db).listByCustomer(PHONE);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ id: r.caseId, partnerId: 'default', kind: 'customer', category: 'human_help', status: 'open' });
    expect((await outboxRows('ticket.triage')).map((x) => x.dedupe_key)).toEqual([`triage:${r.caseId}`]);
    const alerts = await outboxRows('ops.alert');
    expect(alerts.map((x) => x.dedupe_key)).toEqual([`help:${r.caseId}`]);
    expect(JSON.stringify(alerts[0].payload)).not.toContain(PHONE);
  });

  it('a keyword case stores fixed text only, never the customer message (crypto-06)', async () => {
    const r = await db.transaction((tx) =>
      openHelpCase(tx, { partnerId: 'default', phone: PHONE, reason: 'payment_problem', channel: 'telegram', source: 'keyword', summary: 'card 4111111111111111' }),
    );
    const [first] = await createTicketRepo(db).listMessages(r.caseId, { includeInternal: true });
    expect(first.body).toContain('payment_problem');
    expect(first.body).not.toContain('4111');
  });

  it('a tool case keeps the model summary, bounded', async () => {
    const r = await db.transaction((tx) =>
      openHelpCase(tx, { partnerId: 'default', phone: PHONE, reason: 'other', channel: 'whatsapp', source: 'tool', summary: 'A'.repeat(2000) }),
    );
    const [first] = await createTicketRepo(db).listMessages(r.caseId, { includeInternal: true });
    expect(first.body.startsWith('Reason: other. A')).toBe(true);
    expect(first.body.length).toBeLessThanOrEqual(400);
  });

  it('a rolled-back transaction leaves no ticket and no outbox row', async () => {
    await expect(
      db.transaction(async (tx) => {
        await openHelpCase(tx, { partnerId: 'default', phone: PHONE, reason: 'question', channel: 'whatsapp', source: 'keyword' });
        throw new Error('reply enqueue failed');
      }),
    ).rejects.toThrow('reply enqueue failed');
    expect(await createTicketRepo(db).listByCustomer(PHONE)).toEqual([]);
    expect(await outboxRows('ticket.triage')).toEqual([]);
    expect(await outboxRows('ops.alert')).toEqual([]);
  });

  it('a second request reuses the open case and adds nothing (a retried turn too)', async () => {
    const input = { partnerId: 'default', phone: PHONE, reason: 'question', channel: 'whatsapp', source: 'keyword' } as const;
    const a = await db.transaction((tx) => openHelpCase(tx, input));
    const b = await db.transaction((tx) => openHelpCase(tx, { ...input, reason: 'complaint' }));
    expect(b).toEqual({ caseId: a.caseId, partnerId: 'default', created: false });
    expect(await createTicketRepo(db).listByCustomer(PHONE)).toHaveLength(1);
    expect(await outboxRows('ticket.triage')).toHaveLength(1);
    expect(await outboxRows('ops.alert')).toHaveLength(1);
  });

  it("is tenant-scoped: a sibling tenant's open case for the same phone is never reused", async () => {
    await seedPartner(db, 'acme');
    const theirs = await db.transaction((tx) => openHelpCase(tx, { partnerId: 'acme', phone: PHONE, reason: 'question', channel: 'whatsapp', source: 'keyword' }));
    const mine = await db.transaction((tx) => openHelpCase(tx, { partnerId: 'default', phone: PHONE, reason: 'question', channel: 'whatsapp', source: 'keyword' }));
    expect(mine.caseId).not.toBe(theirs.caseId);
    expect(mine.partnerId).toBe('default');
  });

  it('the tool reasons are unchanged (the model-visible enum)', () => {
    expect(HELP_REASONS).toEqual(['question', 'complaint', 'payment_problem', 'account_access', 'other']);
  });
});

describe('openHelpCaseAndPoke: its own transaction, then the poke', () => {
  it('pokes the worker only after the case committed', async () => {
    const real = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((async (fn: Parameters<Db['transaction']>[0]) => {
      const out = await real(fn);
      events.list.push('commit');
      return out;
    }) as Db['transaction']);
    const r = await openHelpCaseAndPoke(db, { partnerId: 'default', phone: PHONE, reason: 'question', channel: 'web', source: 'tool' });
    expect(r.caseId).toMatch(/^tk_/);
    expect(events.list).toEqual(['commit', 'poke']);
  });
});

describe('cancelCaseWanted: a cancel request is recorded only when there is a paid transfer it can be about', () => {
  function transfer(over: Partial<Transfer>): Transfer {
    const now = new Date().toISOString();
    return {
      id: 'tx_c1', phone: PHONE, amountUsd: 100, feeUsd: 1, totalChargeUsd: 101, fxRate: 83, amountInr: 8300,
      recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'paid',
      createdAt: now, paidAt: now, sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
      destinationCurrency: 'INR', partnerId: 'default', amountSource: 100, feeSource: 1, totalChargeSource: 101,
      transferType: 'b2c', ...over,
    } as Transfer;
  }

  it('no transfer, or only an unpaid one ⇒ false (a draft cancel needs no person)', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await cancelCaseWanted(db, 'default', PHONE)).toBe(false);
    await store.saveTransfer(transfer({ id: 'tx_unpaid', status: 'awaiting_payment', paidAt: undefined }));
    expect(await cancelCaseWanted(db, 'default', PHONE)).toBe(false);
  });

  it('a paid or held transfer ⇒ true; a delivered one ⇒ false', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(transfer({ id: 'tx_done', status: 'delivered' }));
    expect(await cancelCaseWanted(db, 'default', PHONE)).toBe(false);
    await store.saveTransfer(transfer({ id: 'tx_held', status: 'in_review' }));
    expect(await cancelCaseWanted(db, 'default', PHONE)).toBe(true);
  });

  it("is tenant-scoped: another tenant's paid transfer for the same phone does not count", async () => {
    await seedPartner(db, 'acme');
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(transfer({ id: 'tx_acme', partnerId: 'acme' }));
    expect(await cancelCaseWanted(db, 'default', PHONE)).toBe(false);
    expect(await cancelCaseWanted(db, 'acme', PHONE)).toBe(true);
  });
});
