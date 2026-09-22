import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { createTransferRepo, type TransferRepo } from '@/db/repos/transfer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_r1',
    phone: '15551230000',
    amountUsd: 200, feeUsd: 1.99, totalChargeUsd: 201.99,
    fxRate: 85.2, amountInr: 17040,
    recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: minsAgo(5),
    sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 200, feeSource: 1.99, totalChargeSource: 201.99,
    ...over,
  };
}

let db: Db;
let repo: TransferRepo;
beforeEach(async () => {
  db = await freshDb();
  repo = createTransferRepo(db, provider);
});

describe('funding ref (write-once)', () => {
  it('setFundingRef persists once and never clobbers', async () => {
    await repo.saveTransfer(fixture());
    await repo.setFundingRef('tr_r1', 'mockfund-tr_r1');
    await repo.setFundingRef('tr_r1', 'EVIL-overwrite');
    expect((await repo.getTransfer('tr_r1'))?.fundingRef).toBe('mockfund-tr_r1');
  });

  it('a fresh transfer reads back refundStatus none and no fundingRef', async () => {
    await repo.saveTransfer(fixture());
    const t = await repo.getTransfer('tr_r1');
    expect(t?.refundStatus).toBe('none');
    expect(t?.fundingRef).toBeUndefined();
  });
});

describe('updateRefund — guarded lifecycle', () => {
  it('none → requested → pending → completed, with refs and timestamp', async () => {
    await repo.saveTransfer(fixture());
    expect((await repo.updateRefund('tr_r1', { refundStatus: 'requested' }))?.refundStatus).toBe('requested');
    expect((await repo.updateRefund('tr_r1', { refundStatus: 'pending' }))?.refundStatus).toBe('pending');
    const done = await repo.updateRefund('tr_r1', {
      refundStatus: 'completed', refundRef: 'mockrefund-tr_r1', refundedAt: NOW.toISOString(),
    });
    expect(done?.refundStatus).toBe('completed');
    expect(done?.refundRef).toBe('mockrefund-tr_r1');
    expect(done?.refundedAt).toBeTruthy();
  });

  it('illegal transitions are no-ops returning null', async () => {
    await repo.saveTransfer(fixture());
    // completed straight from none — illegal
    expect(await repo.updateRefund('tr_r1', { refundStatus: 'completed' })).toBeNull();
    // requested twice — second is illegal (already requested)
    await repo.updateRefund('tr_r1', { refundStatus: 'requested' });
    expect(await repo.updateRefund('tr_r1', { refundStatus: 'requested' })).toBeNull();
    // a completed refund can never go back to pending… complete it first:
    await repo.updateRefund('tr_r1', { refundStatus: 'pending' });
    await repo.updateRefund('tr_r1', { refundStatus: 'completed' });
    expect(await repo.updateRefund('tr_r1', { refundStatus: 'pending' })).toBeNull();
    expect(await repo.updateRefund('tr_r1', { refundStatus: 'none' })).toBeNull();
  });

  it('failed → pending retry works; requested → none dismissal works', async () => {
    await repo.saveTransfer(fixture({ id: 'tr_r2' }));
    await repo.updateRefund('tr_r2', { refundStatus: 'pending' }); // none → pending (ops-initiated)
    await repo.updateRefund('tr_r2', { refundStatus: 'failed' });
    expect((await repo.updateRefund('tr_r2', { refundStatus: 'pending' }))?.refundStatus).toBe('pending');
    await repo.saveTransfer(fixture({ id: 'tr_r3' }));
    await repo.updateRefund('tr_r3', { refundStatus: 'requested' });
    expect((await repo.updateRefund('tr_r3', { refundStatus: 'none' }))?.refundStatus).toBe('none');
  });
});

describe('refund queues + crash-resume query', () => {
  it('listByRefundStatus returns only the asked-for state', async () => {
    await repo.saveTransfer(fixture({ id: 'q1' }));
    await repo.saveTransfer(fixture({ id: 'q2' }));
    await repo.saveTransfer(fixture({ id: 'q3' }));
    await repo.updateRefund('q1', { refundStatus: 'requested' });
    await repo.updateRefund('q2', { refundStatus: 'pending' });
    expect((await repo.listByRefundStatus('requested')).map((t) => t.id)).toEqual(['q1']);
    expect((await repo.listByRefundStatus('pending')).map((t) => t.id)).toEqual(['q2']);
    expect(await repo.listByRefundStatus('failed')).toEqual([]);
  });

  it('listActiveRefunds returns every non-none refund, newest first, and excludes none', async () => {
    await repo.saveTransfer(fixture({ id: 'a1', createdAt: minsAgo(30) }));
    await repo.saveTransfer(fixture({ id: 'a2', createdAt: minsAgo(20) }));
    await repo.saveTransfer(fixture({ id: 'a3', createdAt: minsAgo(10) })); // stays none
    await repo.updateRefund('a1', { refundStatus: 'requested' });
    await repo.updateRefund('a2', { refundStatus: 'pending' });
    await repo.updateRefund('a2', { refundStatus: 'completed', refundRef: 'r', refundedAt: NOW.toISOString() });
    const all = await repo.listActiveRefunds();
    expect(all.map((t) => t.id)).toEqual(['a2', 'a1']); // newest createdAt first; a3 (none) excluded
    expect(all.map((t) => t.refundStatus)).toEqual(['completed', 'requested']);
  });

  it('listActiveRefunds scopes to a partner when partnerId is given', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'p1', partnerId: 'default' }));
    await repo.saveTransfer(fixture({ id: 'p2', partnerId: 'acme' }));
    await repo.updateRefund('p1', { refundStatus: 'requested' });
    await repo.updateRefund('p2', { refundStatus: 'requested' });
    expect((await repo.listActiveRefunds({ partnerId: 'acme' })).map((t) => t.id)).toEqual(['p2']);
    expect((await repo.listActiveRefunds()).map((t) => t.id).sort()).toEqual(['p1', 'p2']);
  });

  it('findStuckPaid excludes paid transfers that are being refunded (money-safety: no re-instruct of a clawback)', async () => {
    // A normal stuck-paid transfer (no refund) — still found, still re-instructed.
    await repo.saveTransfer(fixture({ id: 'sp_none', status: 'paid', paidAt: minsAgo(30) }));
    // A paid transfer with a refund in flight — must NOT be returned, or the sweep
    // would re-deliver money that is being refunded (recipient paid AND sender refunded).
    await repo.saveTransfer(fixture({ id: 'sp_ref', status: 'paid', paidAt: minsAgo(30) }));
    await repo.updateRefund('sp_ref', { refundStatus: 'pending' });
    // A paid transfer whose refund already completed — also excluded.
    await repo.saveTransfer(fixture({ id: 'sp_done', status: 'paid', paidAt: minsAgo(30) }));
    await repo.updateRefund('sp_done', { refundStatus: 'pending' });
    await repo.updateRefund('sp_done', { refundStatus: 'completed', refundRef: 'r', refundedAt: NOW.toISOString() });

    const stuck = await repo.findStuckPaid(15);
    expect(stuck.map((t) => t.id)).toEqual(['sp_none']);
  });

  it('listAwaitingWithFunding finds charged-but-unsettled transfers past the cutoff only', async () => {
    // charged 20 minutes ago, still awaiting_payment — the crash victim
    await repo.saveTransfer(fixture({ id: 'crash1', createdAt: minsAgo(20) }));
    await repo.setFundingRef('crash1', 'mockfund-crash1');
    // charged but FRESH (2 min) — normal in-flight pay, not picked up
    await repo.saveTransfer(fixture({ id: 'fresh1', createdAt: minsAgo(2) }));
    await repo.setFundingRef('fresh1', 'mockfund-fresh1');
    // old but never charged — abandoned link, nothing to resume
    await repo.saveTransfer(fixture({ id: 'uncharged', createdAt: minsAgo(60) }));
    // charged AND settled (paid) — already resumed
    await repo.saveTransfer(fixture({ id: 'settled', createdAt: minsAgo(30), status: 'paid', paidAt: minsAgo(29) }));
    await repo.setFundingRef('settled', 'mockfund-settled');

    const victims = await repo.listAwaitingWithFunding(10 * 60_000, NOW);
    expect(victims.map((t) => t.id)).toEqual(['crash1']);
  });
});

// ── Program-Fix 8: the rail-failure claim (money-02 / rail-02) ───────────────
// `failPaidFromRail` runs SELECT … FOR UPDATE then ONE guarded UPDATE in the
// caller's transaction. Only a `paid` row moves; the refund column follows the
// table in docs/superpowers (task-04 §2): none/requested + refundable → pending,
// everything else unchanged. Every other status returns updated: null.
describe('failPaidFromRail — the rail-failure claim (fix 8)', () => {
  const failed = (id: string) => repo.failPaidFromRail(id, 'rail failed: account_unreachable');

  it('a paid CHARGED row (fundingRef) → cancelled + refund pending, note recorded; prior is the pre-claim row', async () => {
    await repo.saveTransfer(fixture({ id: 'rf1', status: 'paid', paidAt: minsAgo(1), fundingRef: 'mockfund-rf1' }));
    const r = await failed('rf1');
    expect(r.prior?.status).toBe('paid');
    expect(r.prior?.refundStatus).toBe('none');
    expect(r.updated).toMatchObject({ status: 'cancelled', refundStatus: 'pending', adminNote: 'rail failed: account_unreachable' });
    expect((await repo.getTransfer('rf1'))).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
  });

  it('a paid PARTNER-PULLED row (bank_pull, no fundingRef) is refundable: → pending (the worker posts the signed REVERSE)', async () => {
    await repo.saveTransfer(fixture({ id: 'rf2', status: 'paid', paidAt: minsAgo(1), fundingMethod: 'bank_pull', transferType: 'b2b' }));
    expect((await failed('rf2')).updated).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
  });

  it('a paid PARTNER-FUNDED row (no fundingRef, card/bank funding) is NOT refundable: cancelled, refund stays none', async () => {
    await repo.saveTransfer(fixture({ id: 'rf3', status: 'paid', paidAt: minsAgo(1) }));
    expect((await failed('rf3')).updated).toMatchObject({ status: 'cancelled', refundStatus: 'none' });
  });

  it('prior refund requested → pending; pending / completed / failed are left as they are', async () => {
    for (const [id, prior, expected] of [
      ['rf4', 'requested', 'pending'],
      ['rf5', 'pending', 'pending'],
      ['rf6', 'completed', 'completed'],
      ['rf7', 'failed', 'failed'],
    ] as const) {
      await repo.saveTransfer(fixture({ id, status: 'paid', paidAt: minsAgo(1), fundingRef: `mockfund-${id}` }));
      if (prior === 'requested') await repo.updateRefund(id, { refundStatus: 'requested' });
      if (prior === 'pending' || prior === 'completed' || prior === 'failed') await repo.updateRefund(id, { refundStatus: 'pending' });
      if (prior === 'completed') await repo.updateRefund(id, { refundStatus: 'completed', refundRef: 'r', refundedAt: NOW.toISOString() });
      if (prior === 'failed') await repo.updateRefund(id, { refundStatus: 'failed' });
      const r = await failed(id);
      expect(r.prior?.refundStatus).toBe(prior);
      expect(r.updated).toMatchObject({ status: 'cancelled', refundStatus: expected });
    }
  });

  it('every non-paid status is untouched (updated null, prior returned); a missing row is { prior: null, updated: null }', async () => {
    for (const status of ['awaiting_payment', 'in_review', 'blocked', 'delivered', 'cancelled'] as const) {
      const id = `np_${status}`;
      await repo.saveTransfer(fixture({ id, status, fundingRef: 'mockfund-x', adminNote: 'keep' }));
      const r = await failed(id);
      expect(r.prior?.status).toBe(status);
      expect(r.updated).toBeNull();
      expect(await repo.getTransfer(id)).toMatchObject({ status, refundStatus: 'none', adminNote: 'keep' });
    }
    expect(await repo.failPaidFromRail('nope', 'x')).toEqual({ prior: null, updated: null });
  });

  it('a second claim on the same row is a no-op (prior is now cancelled)', async () => {
    await repo.saveTransfer(fixture({ id: 'rf8', status: 'paid', paidAt: minsAgo(1), fundingRef: 'mockfund-rf8' }));
    await failed('rf8');
    const again = await failed('rf8');
    expect(again.prior?.status).toBe('cancelled');
    expect(again.updated).toBeNull();
  });

  it('is excluded from findStuckPaid afterwards (status left paid) — the sweep can never re-instruct it', async () => {
    await repo.saveTransfer(fixture({ id: 'rf9', status: 'paid', paidAt: minsAgo(30), fundingRef: 'mockfund-rf9' }));
    expect((await repo.findStuckPaid(15)).map((t) => t.id)).toEqual(['rf9']);
    await failed('rf9');
    expect(await repo.findStuckPaid(15)).toEqual([]);
  });
});
