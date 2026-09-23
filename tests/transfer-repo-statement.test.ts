import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createTransferRepo, type TransferRepo } from '@/db/repos/transfer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { decodeStatementCursor } from '@/lib/settlement-statement';
import type { Db } from '@/db/client';
import type { Transfer, TransferStatus } from '@/lib/types';

// Program-Fix 31 PR A (rail-11): transfer-repo.listSettledPage — the tenant-
// scoped, paid_at-windowed keyset page behind GET /api/partner/v1/settlements.
// Real Postgres (PGlite): the µs keyset, the half-open window and the status
// filter are SQL behaviour a fake could not prove.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_1',
    phone: '15551230000',
    amountUsd: 200,
    feeUsd: 1.99,
    totalChargeUsd: 201.99,
    fxRate: 85.2,
    amountInr: 17040,
    recipientName: 'Anita',
    recipientPhone: '919876543210',
    payoutMethod: 'bank',
    payoutDestination: '123456789012|HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: '2026-09-20T10:00:00.000Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'acme',
    amountSource: 200,
    feeSource: 1.99,
    totalChargeSource: 201.99,
    ...over,
  };
}

let db: Db;
let repo: TransferRepo;

/** Insert a row, then set status / paid_at / provider ref with RAW SQL — the
 *  domain save goes through a JS ISO string (ms), and these tests need µs. */
async function put(
  id: string,
  status: TransferStatus,
  paidAt: string | null,
  over: Partial<Transfer> & { providerRef?: string | null } = {},
) {
  const { providerRef, ...rest } = over;
  await repo.insertTransfer(fixture({ id, ...rest }));
  await db.execute(sql`UPDATE transfers
    SET status = ${status},
        paid_at = ${paidAt}::timestamptz,
        payment_provider_ref = ${providerRef === undefined ? `sim-${id}` : providerRef}
    WHERE id = ${id}`);
}

const FROM = new Date('2026-09-22T00:00:00.000Z');
const TO = new Date('2026-09-23T00:00:00.000Z');

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
  repo = createTransferRepo(db, provider);
});

async function allPages(limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor = null as ReturnType<typeof decodeStatementCursor>;
  for (let i = 0; i < 50; i++) {
    const page = await repo.listSettledPage('acme', FROM, TO, { limit, cursor });
    ids.push(...page.items.map((t) => t.id));
    if (!page.nextCursor) return ids;
    cursor = decodeStatementCursor(page.nextCursor);
    expect(cursor).not.toBeNull(); // the cursor we emit always validates
  }
  throw new Error('pagination did not terminate');
}

describe('transfer-repo.listSettledPage', () => {
  it('lists paid + delivered + instructed-cancelled rows, ascending by paid_at', async () => {
    await put('d1', 'delivered', '2026-09-22 12:00:00+00');
    await put('p1', 'paid', '2026-09-22 09:00:00+00');
    await put('c1', 'cancelled', '2026-09-22 15:00:00+00', { refundStatus: 'pending' });
    const page = await repo.listSettledPage('acme', FROM, TO, { limit: 100, cursor: null });
    expect(page.items.map((t) => t.id)).toEqual(['p1', 'd1', 'c1']);
    expect(page.nextCursor).toBeNull();
    const c1 = page.items[2];
    expect(c1).toMatchObject({ status: 'cancelled', refundStatus: 'pending', paymentProviderRef: 'sim-c1' });
    expect(page.items[0]).toMatchObject({
      amountSource: 200,
      feeSource: 1.99,
      fxRate: 85.2,
      amountInr: 17040,
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      payoutMethod: 'bank',
      paidAt: '2026-09-22T09:00:00.000Z',
    });
  });

  it('never returns another tenant’s rows', async () => {
    await put('mine', 'paid', '2026-09-22 10:00:00+00');
    await put('theirs', 'delivered', '2026-09-22 10:00:00+00', { partnerId: 'globex' });
    const page = await repo.listSettledPage('acme', FROM, TO, { limit: 100, cursor: null });
    expect(page.items.map((t) => t.id)).toEqual(['mine']);
    const other = await repo.listSettledPage('globex', FROM, TO, { limit: 100, cursor: null });
    expect(other.items.map((t) => t.id)).toEqual(['theirs']);
  });

  it('excludes in_review, a staff-rejected hold (cancelled, no ref), blocked and unpaid rows — each WITH a paid_at', async () => {
    await put('ok', 'paid', '2026-09-22 10:00:00+00');
    await put('held', 'in_review', '2026-09-22 10:00:01+00');
    await put('rejected', 'cancelled', '2026-09-22 10:00:02+00', { providerRef: null });
    await put('blocked', 'blocked', '2026-09-22 10:00:03+00');
    await put('unpaid', 'awaiting_payment', '2026-09-22 10:00:04+00');
    await put('nopaidat', 'paid', null);
    const page = await repo.listSettledPage('acme', FROM, TO, { limit: 100, cursor: null });
    expect(page.items.map((t) => t.id)).toEqual(['ok']);
  });

  it('the window is half-open [from, to) on paid_at', async () => {
    await put('before', 'paid', '2026-09-21 23:59:59.999999+00');
    await put('onfrom', 'paid', '2026-09-22 00:00:00+00');
    await put('lastus', 'paid', '2026-09-22 23:59:59.999999+00');
    await put('onto', 'paid', '2026-09-23 00:00:00+00');
    const page = await repo.listSettledPage('acme', FROM, TO, { limit: 100, cursor: null });
    expect(page.items.map((t) => t.id)).toEqual(['onfrom', 'lastus']);
  });

  it('keyset: no duplicates or gaps across rows in the SAME ms but different µs', async () => {
    // ids deliberately in the OPPOSITE order to their µs order, so a cursor
    // truncated to ms (tie broken on id) would visibly skip or repeat rows.
    await put('zz', 'paid', '2026-09-22 12:00:00.123401+00');
    await put('yy', 'delivered', '2026-09-22 12:00:00.123402+00');
    await put('xx', 'paid', '2026-09-22 12:00:00.123403+00');
    await put('ww', 'paid', '2026-09-22 12:00:00.1234+00'); // .123400 — Postgres prints 4 digits
    for (const limit of [1, 2, 3]) {
      expect(await allPages(limit)).toEqual(['ww', 'zz', 'yy', 'xx']);
    }
  });

  it('keyset: ties on the exact same paid_at break on id', async () => {
    await put('b', 'paid', '2026-09-22 12:00:00.5+00');
    await put('a', 'paid', '2026-09-22 12:00:00.5+00');
    await put('c', 'paid', '2026-09-22 12:00:00.5+00');
    expect(await allPages(1)).toEqual(['a', 'b', 'c']);
  });

  it('the emitted cursor carries the Postgres µs text, not a JS ms date', async () => {
    await put('r1', 'paid', '2026-09-22 12:00:00.123456+00');
    await put('r2', 'paid', '2026-09-22 12:00:01+00');
    const page = await repo.listSettledPage('acme', FROM, TO, { limit: 1, cursor: null });
    const cur = decodeStatementCursor(page.nextCursor!);
    expect(cur?.id).toBe('r1');
    // Postgres prints in the SESSION time zone (with its offset); the µs survive.
    expect(cur?.paidAtText).toMatch(/:00\.123456[+-]\d{2}/);
    expect(new Date(cur!.paidAtText.replace(' ', 'T').replace(/\.(\d{3})\d+/, '.$1').replace(/([+-]\d{2})$/, '$1:00')).toISOString()).toBe(
      '2026-09-22T12:00:00.123Z',
    );
  });

  it('never selects the settlement partner or the payout destination', async () => {
    await put('routed', 'paid', '2026-09-22 10:00:00+00', { settlementPartnerId: 'globex' });
    const page = await repo.listSettledPage('acme', FROM, TO, { limit: 100, cursor: null });
    const row = page.items[0] as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty('settlementPartnerId');
    expect(row).not.toHaveProperty('payoutDestination');
    expect(row).not.toHaveProperty('recipientName');
    expect(row).not.toHaveProperty('phone');
    expect(JSON.stringify(row)).not.toContain('globex');
  });
});
