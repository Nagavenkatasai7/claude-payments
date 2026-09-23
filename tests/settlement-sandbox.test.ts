import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { beginSettlement, beginHold, releaseHold, settleOrHold } from '@/lib/settlement';
import { reconcileSweep } from '@/lib/reconcile';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { easternDayStart, easternMonthStart } from '@/lib/dates';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';

// Program-Fix 44 P2 — sandbox (test-key) transfers can NEVER reach a real rail.
// Every case here drives the money functions from a row that really lives in
// PGlite (the real drizzle chain incl. migration 0021), because the chokepoint
// reads `environment` off the RETURNING row of the paid claim: a hand-built
// Transfer object would prove nothing.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

const HTTP: PartnerIntegrations = {
  kyc: {},
  payment: {
    providerType: 'http',
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
    webhookSecret: 'w',
  },
  whatsapp: {},
};

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'sb_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date().toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;

type OutboxRow = { kind: string; dedupe_key: string | null; payload: Record<string, unknown> };
async function outboxRows(): Promise<OutboxRow[]> {
  const r = await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox ORDER BY id`);
  return (r as unknown as { rows: OutboxRow[] }).rows;
}
async function envOf(id: string): Promise<string | undefined> {
  const r = await db.execute(sql`SELECT environment FROM transfers WHERE id = ${id}`);
  return (r as unknown as { rows: Array<{ environment: string }> }).rows[0]?.environment;
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  await createIntegrationsRepo(db, provider).saveIntegrations('acme', HTTP);
});

describe('transfers.environment — persistence (migration 0021)', { retry: 0 }, () => {
  it("a row saved without an environment reads back 'live' (the column default; every pre-P2 row)", async () => {
    await store.saveTransfer(fixture());
    expect(await envOf('sb_t1')).toBe('live');
    expect((await store.getTransfer('sb_t1'))!.environment).toBe('live');
  });

  it("a test transfer round-trips 'test' on every read shape", async () => {
    await store.saveTransfer(fixture({ environment: 'test' }));
    expect(await envOf('sb_t1')).toBe('test');
    expect((await store.getTransfer('sb_t1'))!.environment).toBe('test');
    expect((await createTransferRepo(db).getTransfer('sb_t1', { decrypt: true }))!.environment).toBe('test');
    expect((await createTransferRepo(db).getOwnedTransfer('acme', 'sb_t1'))!.environment).toBe('test');
  });

  it('is WRITE-ONCE: a read-modify-write save of a live-shaped object never flips a test row to live', async () => {
    await store.saveTransfer(fixture({ environment: 'test' }));
    const { environment: _e, ...withoutEnv } = (await store.getTransfer('sb_t1'))!;
    void _e;
    await store.saveTransfer({ ...withoutEnv, adminNote: 'touched' } as Transfer);
    await store.saveTransfer({ ...withoutEnv, environment: 'live' } as Transfer);
    expect(await envOf('sb_t1')).toBe('test');
  });

  it('the paid / in_review claims RETURN the environment (the chokepoint reads it off RETURNING)', async () => {
    await store.saveTransfer(fixture({ id: 'sb_a', environment: 'test' }));
    await store.saveTransfer(fixture({ id: 'sb_b', environment: 'test', complianceStatus: 'flagged' }));
    const repo = createTransferRepo(db);
    expect((await repo.markPaidIfAwaiting('sb_a'))!.environment).toBe('test');
    expect((await repo.markInReviewIfAwaiting('sb_b'))!.environment).toBe('test');
    expect((await repo.markPaidIfInReview('sb_b'))!.environment).toBe('test');
  });
});

describe('the rail chokepoint — a test transfer never gets settlement.instruct', { retry: 0 }, () => {
  it('beginSettlement on an http rail: ONLY the delayed mock.settle; the stage-1 message is marked sandbox', async () => {
    await store.saveTransfer(fixture({ environment: 'test' }));
    const r = await beginSettlement(db, (await store.getTransfer('sb_t1'))!, HTTP);
    expect(r).toEqual({ kind: 'started', webhookDriven: false });
    const rows = await outboxRows();
    expect(rows.map((x) => x.kind).sort()).toEqual(['mock.settle', 'whatsapp.text']);
    expect(rows.some((x) => x.kind === 'settlement.instruct')).toBe(false);
    expect(rows.find((x) => x.kind === 'whatsapp.text')!.payload.sandbox).toBe(true);
    expect((await store.getTransfer('sb_t1'))!.paymentProviderRef).toBe('mock-sb_t1');
  });

  it('even a caller holding a stale LIVE-shaped object cannot instruct: the ledger row decides', async () => {
    await store.saveTransfer(fixture({ environment: 'test' }));
    const stale = { ...(await store.getTransfer('sb_t1'))!, environment: 'live' as const };
    await settleOrHold(db, stale, HTTP);
    expect((await outboxRows()).some((x) => x.kind === 'settlement.instruct')).toBe(false);
  });

  it('a LIVE transfer is unchanged: signed instruct, stage-1 payload has no sandbox key', async () => {
    await store.saveTransfer(fixture());
    const r = await beginSettlement(db, (await store.getTransfer('sb_t1'))!, HTTP);
    expect(r).toEqual({ kind: 'started', webhookDriven: true });
    const rows = await outboxRows();
    expect(rows.map((x) => x.dedupe_key)).toEqual(['stage1:sb_t1', 'instruct:sb_t1']);
    expect('sandbox' in rows[0].payload).toBe(false);
  });

  it('beginHold marks the held stage-1 sandbox; releaseHold on an http rail enqueues mock.settle only', async () => {
    await store.saveTransfer(fixture({ environment: 'test', complianceStatus: 'flagged' }));
    expect((await beginHold(db, (await store.getTransfer('sb_t1'))!)).kind).toBe('held');
    expect((await outboxRows())[0].payload.sandbox).toBe(true);
    const rel = await releaseHold(db, (await store.getTransfer('sb_t1'))!, HTTP);
    expect(rel).toEqual({ kind: 'released', webhookDriven: false });
    const kinds = (await outboxRows()).map((x) => x.kind);
    expect(kinds).toContain('mock.settle');
    expect(kinds).not.toContain('settlement.instruct');
  });
});

describe('reconcileSweep — a stuck-paid test transfer is never re-instructed', { retry: 0 }, () => {
  it('classifies test as mock regardless of the rail config (no reinstruct: row)', async () => {
    await store.saveTransfer(
      fixture({ environment: 'test', status: 'paid', createdAt: '2026-06-01T00:00:00.000Z', paidAt: '2026-06-01T00:01:00.000Z' }),
    );
    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(0);
    const rows = await outboxRows();
    expect(rows.some((x) => x.kind === 'settlement.instruct')).toBe(false);
  });
});

describe('ledger aggregates — sandbox rows never count toward a live customer', { retry: 0 }, () => {
  const now = new Date();
  beforeEach(async () => {
    await store.saveTransfer(fixture({ id: 'sb_live', amountUsd: 100 }));
    await store.saveTransfer(fixture({ id: 'sb_test', amountUsd: 900, environment: 'test', createdAt: new Date(now.getTime() - 60_000).toISOString() }));
  });

  it('senderTotalsSince (caps, velocity, EDD month) counts live rows only', async () => {
    const t = await createTransferRepo(db).senderTotalsSince('acme', '15551230000', easternDayStart(now), easternMonthStart(now));
    expect(t).toEqual({ todayUsdCents: 10_000, todayCount: 1, monthUsdCents: 10_000 });
  });

  it('countByPhone (the fee tier) and firstTransferAt (the T0 clock) ignore test rows', async () => {
    const repo = createTransferRepo(db);
    expect(await repo.countByPhone('acme', '15551230000')).toBe(1);
    const first = await repo.firstTransferAt('acme', '15551230000');
    expect(first).toBe((await store.getTransfer('sb_live'))!.createdAt);
  });

  it('senderAmlStats (the 43B hold and the AML sweep) ignores test rows', async () => {
    const s = await createTransferRepo(db).senderAmlStats('acme', '15551230000', { at: new Date(now.getTime() + 60_000), id: 'zz' }, 3000, 0.8);
    expect(s.priorCount).toBe(1);
  });

  it('the AML sweep feed (listCreatedSince) and the velocity leaderboard skip test rows', async () => {
    const repo = createTransferRepo(db);
    const feed = await repo.listCreatedSince({ at: new Date(0), id: '' }, new Date(now.getTime() + 60_000), 50);
    expect(feed.map((t) => t.id)).toEqual(['sb_live']);
    expect(await repo.topVelocityToday(10, 'acme')).toEqual([{ phone: '15551230000', count: 1 }]);
  });

  it('adminList filters by environment only when asked (staff lists unchanged)', async () => {
    const repo = createTransferRepo(db);
    expect((await repo.adminList({ limit: 10, partnerId: 'acme' })).items).toHaveLength(2);
    expect((await repo.adminList({ limit: 10, partnerId: 'acme', environment: 'test' })).items.map((t) => t.id)).toEqual(['sb_test']);
    expect((await repo.adminList({ limit: 10, partnerId: 'acme', environment: 'live' })).items.map((t) => t.id)).toEqual(['sb_live']);
  });

  it("the partner's settlements statement is live-only", async () => {
    await db.execute(sql`UPDATE transfers SET status = 'delivered', paid_at = now()`);
    const page = await createTransferRepo(db).listSettledPage('acme', new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000), { limit: 10, cursor: null });
    expect(page.items.map((t) => t.id)).toEqual(['sb_live']);
  });
});
