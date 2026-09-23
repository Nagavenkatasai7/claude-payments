import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { listSettlements, type PartnerApiDeps } from '@/lib/partner-api-service';
import { STATEMENT_COLUMNS } from '@/lib/settlement-statement';
import type { Db } from '@/db/client';
import type { Transfer, TransferStatus } from '@/lib/types';

// Program-Fix 31 PR A (rail-11): the service behind GET
// /api/partner/v1/settlements — tenant scope from the key, the JSON/CSV
// shapes, page totals in minor units, and 400s before any SQL.

vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));

const NOW = '2026-09-23T15:30:00.000Z';
const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

let db: Db;
let deps: PartnerApiDeps;

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
  const redis = fakeRedis();
  const store = createStore(redis, db);
  deps = {
    store,
    customerStore: createCustomerStore(db, store),
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    integrationsStore: createPartnerIntegrationsStore(db, provider),
    db,
    now: () => NOW,
  };
});

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
    createdAt: '2026-09-22T08:00:00.000Z',
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

async function put(id: string, status: TransferStatus, paidAt: string, over: Partial<Transfer> = {}) {
  await createTransferRepo(db, provider).insertTransfer(fixture({ id, ...over }));
  await db.execute(
    sql`UPDATE transfers SET status = ${status}, paid_at = ${paidAt}::timestamptz, payment_provider_ref = ${`sim-${id}`} WHERE id = ${id}`,
  );
}

type Json = {
  settlements: Array<Record<string, unknown>>;
  next_cursor: string | null;
  totals: { count: number; amount_source_minor_by_currency: Record<string, number>; amount_destination_minor_by_currency: Record<string, number> };
  window: { from: string; to: string };
};

async function json(query: Record<string, string>, partnerId = 'acme') {
  const r = await listSettlements(deps, partnerId, query);
  if (!r.ok) throw new Error(`expected ok: ${r.status} ${r.error}`);
  expect(r.data.format).toBe('json');
  return (r.data as { format: 'json'; body: Json }).body;
}

describe('listSettlements', () => {
  it('defaults to yesterday (UTC) relative to deps.now and returns the JSON shape', async () => {
    await put('p1', 'paid', '2026-09-22 10:00:00+00');
    await put('d1', 'delivered', '2026-09-22 11:00:00+00', { amountSource: 50.5, amountInr: 4302.6 });
    await put('today', 'paid', '2026-09-23 01:00:00+00'); // outside yesterday
    const body = await json({});
    expect(body.window).toEqual({ from: '2026-09-22T00:00:00.000Z', to: '2026-09-23T00:00:00.000Z' });
    expect(body.settlements.map((s) => s.reference)).toEqual(['p1', 'd1']);
    expect(Object.keys(body.settlements[0])).toEqual([...STATEMENT_COLUMNS]);
    expect(body.next_cursor).toBeNull();
    expect(body.totals).toEqual({
      count: 2,
      amount_source_minor_by_currency: { USD: 25050 },
      amount_destination_minor_by_currency: { INR: 2134260 },
    });
  });

  it('is scoped to the partner passed in (from the key); another tenant never sees the rows', async () => {
    await put('mine', 'paid', '2026-09-22 10:00:00+00');
    await put('theirs', 'paid', '2026-09-22 10:00:00+00', { partnerId: 'globex' });
    expect((await json({})).settlements.map((s) => s.reference)).toEqual(['mine']);
    expect((await json({}, 'globex')).settlements.map((s) => s.reference)).toEqual(['theirs']);
  });

  it('ignores a partner_id query param (the partner comes from the key only)', async () => {
    await put('mine', 'paid', '2026-09-22 10:00:00+00');
    await put('theirs', 'paid', '2026-09-22 10:00:00+00', { partnerId: 'globex' });
    const body = await json({ partner_id: 'globex' });
    expect(body.settlements.map((s) => s.reference)).toEqual(['mine']);
  });

  it('never exposes the settlement partner, a payout destination or recipient identity', async () => {
    await put('routed', 'paid', '2026-09-22 10:00:00+00', { settlementPartnerId: 'globex' });
    const body = await json({});
    const s = JSON.stringify(body);
    expect(s).not.toMatch(/settlement_partner|settlementPartner/);
    expect(s).not.toContain('globex');
    expect(s).not.toContain('HDFC');
    expect(s).not.toContain('123456789012');
    expect(s).not.toContain('Anita');
    expect(s).not.toContain('919876543210');
  });

  it('pages with next_cursor; totals are for the page only', async () => {
    await put('a', 'paid', '2026-09-22 10:00:00+00');
    await put('b', 'paid', '2026-09-22 11:00:00+00');
    await put('c', 'paid', '2026-09-22 12:00:00+00');
    const p1 = await json({ limit: '2' });
    expect(p1.settlements.map((s) => s.reference)).toEqual(['a', 'b']);
    expect(p1.totals.count).toBe(2);
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = await json({ limit: '2', cursor: p1.next_cursor! });
    expect(p2.settlements.map((s) => s.reference)).toEqual(['c']);
    expect(p2.totals).toEqual({
      count: 1,
      amount_source_minor_by_currency: { USD: 20000 },
      amount_destination_minor_by_currency: { INR: 1704000 },
    });
    expect(p2.next_cursor).toBeNull();
  });

  it('400 for a bad window, limit, format or cursor — before any query', async () => {
    for (const q of [
      { from: '2026-09-10', to: '2026-09-01' },
      { from: '2026-07-01', to: '2026-09-01' },
      { from: 'nope' },
      { limit: '0' },
      { format: 'xml' },
      { cursor: 'garbage!!' },
      { cursor: Buffer.from("x'::timestamptz|a").toString('base64url') },
    ]) {
      const r = await listSettlements(deps, 'acme', q);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it('CSV: RFC 4180 with the header, a filename and the next cursor', async () => {
    await put('a', 'paid', '2026-09-22 10:00:00+00');
    await put('b', 'delivered', '2026-09-22 11:00:00+00');
    const r = await listSettlements(deps, 'acme', { format: 'csv', limit: '1' });
    if (!r.ok || r.data.format !== 'csv') throw new Error('expected csv');
    const lines = r.data.csv.split('\r\n');
    expect(lines[0]).toBe(STATEMENT_COLUMNS.join(','));
    expect(lines[1].startsWith('"a","paid","cleared","none",200,"USD",')).toBe(true);
    expect(r.data.filename).toBe('settlements_2026-09-22T00-00-00Z_2026-09-23T00-00-00Z.csv');
    expect(r.data.nextCursor).toEqual(expect.any(String));
  });
});
