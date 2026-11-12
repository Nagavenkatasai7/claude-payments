import type { DbOrTx } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { logWarn } from './log';
import type { Transfer } from './types';

/**
 * Fix pack 8 (R44, P5): the server reader of the two facts the pure routing
 * (error-notice.ts) cannot read. Reads only, never writes. Each read fails to
 * null on its own and logs the error NAME only (never the error object, never
 * customer data):
 * - snapshotDays: the acknowledged disclosure snapshot's delivery days, read
 *   (tenant-scoped) ONLY when the row has no days of its own; null -> the
 *   default days (the max rule keeps the customer's favour when deliveredAt exists).
 * - chargedAt: now - the age of the `stage1:<id>` outbox row (the sender-cancel
 *   source); null -> refundDisposition falls back to paidAt (a hint only; the
 *   locked cancel decides).
 */
export async function errorNoticeFacts(
  db: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'deliveryBusinessDays'>,
  now: number = Date.now(),
): Promise<{ snapshotDays: number | null; chargedAt: number | null }> {
  let snapshotDays: number | null = null;
  if (t.deliveryBusinessDays == null) {
    try {
      const snap = await createTransferRepo(db).getDisclosureSnapshot(t.id, t.partnerId);
      snapshotDays = snap ? snap.deliveryBusinessDays : null;
    } catch (err) {
      logWarn('error-notice.facts', err instanceof Error ? err.name : 'error', { transferId: t.id });
    }
  }

  let chargedAt: number | null = null;
  try {
    const age = await createOutboxRepo(db).chargeAgeMs(t.id);
    chargedAt = age === null ? null : now - age;
  } catch (err) {
    logWarn('error-notice.facts', err instanceof Error ? err.name : 'error', { transferId: t.id });
  }

  return { snapshotDays, chargedAt };
}
