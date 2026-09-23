import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { beginHold, releaseHold } from '@/lib/settlement';
import { alertCallbackOnHold } from '@/lib/rail-failure';
import { completePaymentStage1, completePaymentStage2 } from '@/lib/payment';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { ComplianceStatus, Transfer, TransferStatus } from '@/lib/types';

// Program-Fix 14 follow-up: payment status updates respect compliance holds.
// A status update (rail callback, mock settle, legacy stage helpers) may move a
// transfer from awaiting_payment toward paid / delivered ONLY when the ledger
// says compliance_status = 'cleared' — the predicate lives in the UPDATE, like
// markPaidIfAwaiting. A released hold (paid, compliance_status stays
// 'flagged' as evidence) still delivers: it already passed the audited release.
// Real Postgres (PGlite): the guarded UPDATE is the test.

const NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const MOCK_RAIL = { kyc: {}, whatsapp: {}, payment: { providerType: 'mock' } } as never;

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'hs_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: 'HDFC0001234 000000000000', fundingMethod: 'credit_card',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: minsAgo(3), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

type Row = { kind: string; dedupe_key: string | null; payload: Record<string, unknown> };
let db: Db;
let store: ReturnType<typeof createStore>;
const rows = async (): Promise<Row[]> =>
  ((await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox ORDER BY id`)) as unknown as { rows: Row[] }).rows;
const load = (id = 'hs_t1') => createTransferRepo(db).getTransfer(id);

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
});

const HELD: Array<{ label: string; status: TransferStatus; complianceStatus: ComplianceStatus }> = [
  { label: 'awaiting_payment + flagged', status: 'awaiting_payment', complianceStatus: 'flagged' },
  { label: 'awaiting_payment + blocked', status: 'awaiting_payment', complianceStatus: 'blocked' },
  { label: 'in_review + flagged', status: 'in_review', complianceStatus: 'flagged' },
  { label: 'blocked + blocked', status: 'blocked', complianceStatus: 'blocked' },
];

describe('updateTransferFromWebhook — status updates respect compliance holds', () => {
  for (const h of HELD) {
    for (const target of ['paid', 'delivered'] as const) {
      it(`${h.label}: a ${target} update does not advance the row`, async () => {
        await store.saveTransfer(fixture({ status: h.status, complianceStatus: h.complianceStatus }));
        expect(await createTransferRepo(db).updateTransferFromWebhook('hs_t1', target)).toBeNull();
        const t = await load();
        expect(t).toMatchObject({ status: h.status, complianceStatus: h.complianceStatus });
        expect(t!.paidAt).toBeUndefined();
        expect(t!.deliveredAt).toBeUndefined();
      });
    }
  }

  it('a paid row that is somehow compliance-blocked never flips to delivered', async () => {
    await store.saveTransfer(fixture({ status: 'paid', paidAt: minsAgo(2), complianceStatus: 'blocked' }));
    expect(await createTransferRepo(db).updateTransferFromWebhook('hs_t1', 'delivered')).toBeNull();
    expect((await load())!.status).toBe('paid');
  });

  it('a cleared transfer is unchanged: awaiting → paid → delivered', async () => {
    await store.saveTransfer(fixture());
    const repo = createTransferRepo(db);
    expect((await repo.updateTransferFromWebhook('hs_t1', 'paid'))!.status).toBe('paid');
    expect((await repo.updateTransferFromWebhook('hs_t1', 'delivered'))!.status).toBe('delivered');
  });

  it('a RELEASED hold (paid, compliance stays flagged) still delivers on the rail callback', async () => {
    await store.saveTransfer(fixture({ complianceStatus: 'flagged', complianceReasons: ['review'] }));
    const t = (await load())!;
    expect(await beginHold(db, t)).toEqual({ kind: 'held' });
    expect((await releaseHold(db, (await load())!, MOCK_RAIL)).kind).toBe('released');
    expect(await load()).toMatchObject({ status: 'paid', complianceStatus: 'flagged' });

    const delivered = await createTransferRepo(db).updateTransferFromWebhook('hs_t1', 'delivered');
    expect(delivered).toMatchObject({ status: 'delivered', complianceStatus: 'flagged' });
  });
});

describe('alertCallbackOnHold — the rail reported payment on a held transfer', () => {
  for (const h of HELD) {
    it(`${h.label}: ONE deduped railhold:<id> ops alert (transfer id only); the row is untouched`, async () => {
      await store.saveTransfer(fixture({ status: h.status, complianceStatus: h.complianceStatus }));
      expect(await alertCallbackOnHold(db, 'hs_t1')).toBe(true);
      expect(await alertCallbackOnHold(db, 'hs_t1')).toBe(false); // deduped
      const all = await rows();
      expect(all.map((r) => [r.kind, r.dedupe_key])).toEqual([['ops.alert', 'railhold:hs_t1']]);
      const msg = String(all[0].payload.message);
      expect(msg).toContain('hs_t1');
      expect(msg).not.toContain('15551230000');
      expect(msg).not.toContain('919876543210');
      expect(msg).not.toContain('Anita');
      expect(msg).not.toContain('acme');
      expect(await load()).toMatchObject({ status: h.status, complianceStatus: h.complianceStatus });
    });
  }

  it('is silent for rows that are not held: duplicate funded on paid, duplicate paid_out on delivered, a released hold, a missing row', async () => {
    await store.saveTransfer(fixture({ id: 'p1', status: 'paid', paidAt: minsAgo(2) }));
    await store.saveTransfer(fixture({ id: 'd1', status: 'delivered', paidAt: minsAgo(2), deliveredAt: minsAgo(1) }));
    await store.saveTransfer(fixture({ id: 'r1', status: 'paid', paidAt: minsAgo(2), complianceStatus: 'flagged' }));
    await store.saveTransfer(fixture({ id: 'c1', status: 'cancelled' }));
    for (const id of ['p1', 'd1', 'r1', 'c1', 'ghost']) {
      expect(await alertCallbackOnHold(db, id)).toBe(false);
    }
    expect(await rows()).toEqual([]);
  });
});

describe('completePaymentStage2 (mock settle) — respects compliance holds', () => {
  for (const h of HELD) {
    it(`${h.label}: not delivered, no messages`, async () => {
      await store.saveTransfer(fixture({ status: h.status, complianceStatus: h.complianceStatus }));
      const r = await completePaymentStage2(store, 'hs_t1');
      expect(r.senderMessages).toEqual([]);
      expect(r.transfer.status).toBe(h.status);
      expect((await load())!.status).toBe(h.status);
    });
  }

  it('a released hold (paid + flagged) delivers exactly as before', async () => {
    await store.saveTransfer(fixture({ status: 'paid', paidAt: minsAgo(2), complianceStatus: 'flagged' }));
    const r = await completePaymentStage2(store, 'hs_t1', { brand: 'Acme' });
    expect(r.transfer.status).toBe('delivered');
    expect(r.transfer.deliveredAt).toBeTruthy();
    expect(r.senderMessages).toHaveLength(1);
    expect((await load())!.status).toBe('delivered');
  });

  it('a cleared paid row delivers; a second run is a no-op', async () => {
    await store.saveTransfer(fixture({ status: 'paid', paidAt: minsAgo(2) }));
    expect((await completePaymentStage2(store, 'hs_t1')).senderMessages).toHaveLength(1);
    const again = await completePaymentStage2(store, 'hs_t1');
    expect(again.senderMessages).toEqual([]);
    expect(again.transfer.status).toBe('delivered');
  });

  it('never overwrites a concurrent change with a stale full-row save (payout ciphertext intact)', async () => {
    await store.saveTransfer(fixture({ status: 'paid', paidAt: minsAgo(2), recipientLegalName: 'Anita K' }));
    await completePaymentStage2(store, 'hs_t1');
    const t = await createTransferRepo(db).getTransfer('hs_t1', { decrypt: true });
    expect(t!.payoutDestination).toBe('HDFC0001234 000000000000');
    expect(t!.recipientLegalName).toBe('Anita K');
  });
});

describe('completePaymentStage1 (legacy mock stage 1) — respects compliance holds', () => {
  for (const h of HELD) {
    it(`${h.label}: not marked paid, no messages`, async () => {
      await store.saveTransfer(fixture({ status: h.status, complianceStatus: h.complianceStatus }));
      const r = await completePaymentStage1(store, 'hs_t1', { held: true });
      expect(r.senderMessages).toEqual([]);
      expect(r.transfer.status).toBe(h.status);
      expect((await load())!.status).toBe(h.status);
    });
  }

  it('a cancelled row is never resurrected to paid', async () => {
    await store.saveTransfer(fixture({ status: 'cancelled' }));
    const r = await completePaymentStage1(store, 'hs_t1');
    expect(r.senderMessages).toEqual([]);
    expect((await load())!.status).toBe('cancelled');
  });

  it('a cleared awaiting row is marked paid with the stage-1 message (unchanged)', async () => {
    await store.saveTransfer(fixture());
    const r = await completePaymentStage1(store, 'hs_t1');
    expect(r.transfer.status).toBe('paid');
    expect(r.transfer.paidAt).toBeTruthy();
    expect(r.senderMessages).toHaveLength(1);
    expect(r.senderMessages[0]).toContain('Transfer ID: hs_t1');
  });
});
