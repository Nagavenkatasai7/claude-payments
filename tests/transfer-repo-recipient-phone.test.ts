import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createTransferRepo, type TransferRepo } from '@/db/repos/transfer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const OWNER = '15551230000';

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_rp1',
    phone: OWNER,
    amountUsd: 200, feeUsd: 1.99, totalChargeUsd: 201.99,
    fxRate: 85.2, amountInr: 17040,
    recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234',
    recipientLegalName: 'Anita Test',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: new Date(Date.now() - 300_000).toISOString(),
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

describe('transfer-repo updateRecipientPhone', { retry: 0 }, () => {
  it('sets recipient_phone for the owner and returns the updated row', async () => {
    await repo.saveTransfer(fixture());
    const updated = await repo.updateRecipientPhone('tr_rp1', 'default', OWNER, '919811112222');
    expect(updated?.recipientPhone).toBe('919811112222');
    expect(updated?.status).toBe('awaiting_payment');
    expect((await repo.getTransfer('tr_rp1'))?.recipientPhone).toBe('919811112222');
  });

  it('leaves every other column exactly as it is', async () => {
    await repo.saveTransfer(fixture());
    const before = (await db.execute(sql`SELECT * FROM transfers WHERE id = 'tr_rp1'`)).rows[0] as Record<string, unknown>;
    await repo.updateRecipientPhone('tr_rp1', 'default', OWNER, '919811112222');
    const after = (await db.execute(sql`SELECT * FROM transfers WHERE id = 'tr_rp1'`)).rows[0] as Record<string, unknown>;
    expect(after.recipient_phone).toBe('919811112222');
    expect({ ...after, recipient_phone: before.recipient_phone }).toEqual(before);
  });

  it('is tenant-scoped: another partner gets null and nothing changes', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture());
    expect(await repo.updateRecipientPhone('tr_rp1', 'acme', OWNER, '919811112222')).toBeNull();
    expect((await repo.getTransfer('tr_rp1'))?.recipientPhone).toBe('919876543210');
  });

  it('is owner-scoped: another sender phone gets null and nothing changes', async () => {
    await repo.saveTransfer(fixture());
    expect(await repo.updateRecipientPhone('tr_rp1', 'default', '15559999999', '919811112222')).toBeNull();
    expect((await repo.getTransfer('tr_rp1'))?.recipientPhone).toBe('919876543210');
  });

  it('returns null for a missing row and never creates one', async () => {
    expect(await repo.updateRecipientPhone('tr_missing', 'default', OWNER, '919811112222')).toBeNull();
    expect(await repo.getTransfer('tr_missing')).toBeNull();
  });
});

// The recipient number is fixed once money is involved: only an unpaid,
// uncharged, not-yet-instructed transfer takes the edit. Each case below
// changes exactly ONE gating column on an otherwise editable row.
describe('transfer-repo updateRecipientPhone — unpaid transfers only', { retry: 0 }, () => {
  const lockedCases: Array<[string, ReturnType<typeof sql>]> = [
    ['paid', sql`UPDATE transfers SET status = 'paid', paid_at = now() WHERE id = 'tr_rp1'`],
    ['delivered', sql`UPDATE transfers SET status = 'delivered', paid_at = now(), delivered_at = now() WHERE id = 'tr_rp1'`],
    ['in_review', sql`UPDATE transfers SET status = 'in_review' WHERE id = 'tr_rp1'`],
    ['cancelled', sql`UPDATE transfers SET status = 'cancelled' WHERE id = 'tr_rp1'`],
    ['blocked', sql`UPDATE transfers SET status = 'blocked' WHERE id = 'tr_rp1'`],
    ['awaiting_payment + funding captured', sql`UPDATE transfers SET funding_ref = 'fund_x' WHERE id = 'tr_rp1'`],
    ['awaiting_payment + settlement instructed', sql`UPDATE transfers SET payment_provider_ref = 'prov_x' WHERE id = 'tr_rp1'`],
    ['awaiting_payment + paid_at set', sql`UPDATE transfers SET paid_at = now() WHERE id = 'tr_rp1'`],
  ];

  for (const [label, lock] of lockedCases) {
    it(`${label}: returns null and changes nothing`, async () => {
      await repo.saveTransfer(fixture());
      await db.execute(lock);
      const before = (await db.execute(sql`SELECT * FROM transfers WHERE id = 'tr_rp1'`)).rows[0];
      expect(await repo.updateRecipientPhone('tr_rp1', 'default', OWNER, '919811112222')).toBeNull();
      const after = (await db.execute(sql`SELECT * FROM transfers WHERE id = 'tr_rp1'`)).rows[0];
      expect(after).toEqual(before);
    });
  }

  it('an unpaid, uncharged, not-yet-instructed transfer still takes the edit', async () => {
    await repo.saveTransfer(fixture());
    expect((await repo.updateRecipientPhone('tr_rp1', 'default', OWNER, '919811112222'))?.recipientPhone).toBe('919811112222');
  });
});
