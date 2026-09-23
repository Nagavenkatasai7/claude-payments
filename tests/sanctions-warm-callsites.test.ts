import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, seedLedgerSpend } from './helpers-db';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { rescreenBeforePay } from '@/lib/pay-rescreen';
import { GLOBAL_DEFAULTS } from '@/lib/compliance-config';
import { NEWLY_LISTED_PERSON, primeStaleOfacSource, restoreOfacSource } from './helpers-sanctions';

// Program-Fix 14 PR C (review r1 MEDIUM): the OFAC source serves its cached
// list until warm() re-checks the active version. Every screen OUTSIDE a
// transaction must warm first, or a long-lived instance screens a stale list
// forever. The mint warms before its lock (transfer-create.test.ts); the pay
// re-screen is covered here, the two tool screens in tools.test.ts.
describe('rescreenBeforePay warms the OFAC list before screening', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => restoreOfacSource(original));

  it('a name added in the newly activated version blocks the payment', async () => {
    const db = await freshDb();
    const id = await seedLedgerSpend(db, { partnerId: 'default', phone: '15550190001', amountUsd: 50, status: 'awaiting_payment' });
    const t = (await createTransferRepo(db).getTransfer(id))!;
    await primeStaleOfacSource();
    const out = await rescreenBeforePay(db, t, { senderName: 'Clean Sender', recipientName: NEWLY_LISTED_PERSON }, GLOBAL_DEFAULTS);
    expect(out.kind).toBe('blocked');
  });
});
