import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
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
