import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createCustomerStore } from '@/lib/customer-store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { resetRateCacheForTests } from '@/lib/rate';
import {
  createTransaction, getTransaction, confirmTransaction, listTransactions,
  type PartnerApiDeps,
} from '@/lib/partner-api-service';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import type { Db } from '@/db/client';
import type { Partner } from '@/lib/types';
import type { ApiKeyMode } from '@/lib/partner-api-scopes';

// Program-Fix 44 P2 — the Partner API service in SANDBOX mode. The key's mode
// (hash-covered plaintext prefix → guardPartner → deps.keyMode) decides the
// environment a transfer is minted in and the only environment it can see.

vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const NOW = new Date().toISOString();

let db: Db;
let base: Omit<PartnerApiDeps, 'keyMode'>;
const deps = (keyMode: ApiKeyMode): PartnerApiDeps => ({ ...base, keyMode });

const ACME: Partner = {
  id: 'acme', name: 'Acme', countries: ['US'], status: 'active', createdAt: NOW, updatedAt: NOW,
  kycMode: 'delegated', requireKycBeforeSend: false,
} as Partner;

const txBody = (over: Record<string, unknown> = {}) => ({
  amount_source: 200,
  sender: { phone: '15551230000', name: 'Sender Person', kyc_status: 'verified' },
  beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
  ...over,
});

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows;
}

beforeEach(async () => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '' })));
  db = await freshDb();
  await seedPartner(db, 'acme');
  const store = createStore(fakeRedis(), db);
  let n = 0;
  base = {
    store,
    customerStore: createCustomerStore(db, store),
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    integrationsStore: createPartnerIntegrationsStore(db, provider),
    db,
    genId: () => `sbx${n++}`,
  };
  await base.integrationsStore.saveIntegrations('acme', {
    kyc: {},
    payment: {
      providerType: 'http',
      credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
      webhookSecret: 'w',
    },
    whatsapp: {},
  });
});
afterEach(() => vi.restoreAllMocks());

describe('createTransaction — a test key mints a SANDBOX transfer', { retry: 0 }, () => {
  it("stamps environment 'test' on the ledger row", async () => {
    const r = await createTransaction(deps('test'), ACME, 'pk_test_1', 'k1', txBody());
    expect(r).toMatchObject({ ok: true, status: 201 });
    const rows = await q<{ id: string; environment: string; settlement_partner_id: string | null }>(
      sql`SELECT id, environment, settlement_partner_id FROM transfers`,
    );
    expect(rows).toEqual([{ id: 'sbx0', environment: 'test', settlement_partner_id: null }]);
  });

  it('a live key mints live (unchanged)', async () => {
    await createTransaction(deps('live'), ACME, 'pk_1', 'k1', txBody());
    expect(await q(sql`SELECT environment FROM transfers`)).toEqual([{ environment: 'live' }]);
  });

  it('a test mint never creates the live customers row (it would start a live T0 clock)', async () => {
    await createTransaction(deps('test'), ACME, 'pk_test_1', 'k1', txBody());
    expect(await q(sql`SELECT phone FROM customers`)).toEqual([]);
    await createTransaction(deps('live'), ACME, 'pk_1', 'k2', txBody());
    expect(await q(sql`SELECT phone FROM customers`)).toEqual([{ phone: '15551230000' }]);
  });

  it('a sandbox mint spends NONE of the live daily cap', async () => {
    // T0 sender ($500/day). Without the fix the $400 test mint would leave only
    // $100 of live headroom and the $400 live mint would be refused.
    await seedSender(db, { partnerId: 'acme', phone: '15551230000', firstSeenDaysAgo: 0 });
    expect(await createTransaction(deps('test'), ACME, 'pk_test_1', 'k1', txBody({ amount_source: 400 }))).toMatchObject({ ok: true, status: 201 });
    expect(await createTransaction(deps('live'), ACME, 'pk_1', 'k2', txBody({ amount_source: 400 }))).toMatchObject({ ok: true, status: 201 });
  });

  it('sanctions screening still runs in sandbox (a watchlist hit is blocked, 422)', async () => {
    const r = await createTransaction(deps('test'), ACME, 'pk_test_1', 'k1', txBody({
      beneficiary: { name: 'John Doe', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
    }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(await q(sql`SELECT status, environment FROM transfers`)).toEqual([{ status: 'blocked', environment: 'test' }]);
  });
});

describe('idempotency — the claim is namespaced by environment', { retry: 0 }, () => {
  it('the same Idempotency-Key under a live and a test key mints TWO transfers (never replays across)', async () => {
    const live = await createTransaction(deps('live'), ACME, 'pk_1', 'k1', txBody());
    const test = await createTransaction(deps('test'), ACME, 'pk_test_1', 'k1', txBody());
    expect(live).toMatchObject({ ok: true, status: 201 });
    expect(test).toMatchObject({ ok: true, status: 201 });
    const keys = await q<{ key: string; transfer_id: string }>(sql`SELECT key, transfer_id FROM idempotency_keys ORDER BY key`);
    expect(keys).toEqual([{ key: 'k1', transfer_id: 'sbx0' }, { key: 'test:k1', transfer_id: 'sbx1' }]);
  });

  it("a client Idempotency-Key starting 'test:' is reserved (400 for any key, nothing claimed or minted)", async () => {
    for (const m of ['live', 'test'] as const) {
      const r = await createTransaction(deps(m), ACME, 'pk_1', 'test:k1', txBody());
      expect(r).toMatchObject({ ok: false, status: 400 });
    }
    expect(await q(sql`SELECT count(*)::int AS n FROM idempotency_keys`)).toEqual([{ n: 0 }]);
    expect(await q(sql`SELECT count(*)::int AS n FROM transfers`)).toEqual([{ n: 0 }]);
  });

  it('defence in depth: a pre-existing live claim on test:k1 is never replayed to a test key (409)', async () => {
    // Only reachable for a claim written before the reservation shipped.
    await createTransaction(deps('live'), ACME, 'pk_1', 'kx', txBody()); // mints sbx0 live
    await db.execute(sql`INSERT INTO idempotency_keys (partner_id, key, transfer_id) VALUES ('acme', 'test:k1', 'sbx0')`);
    const r = await createTransaction(deps('test'), ACME, 'pk_test_1', 'k1', txBody());
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(await q(sql`SELECT count(*)::int AS n FROM transfers`)).toEqual([{ n: 1 }]);
  });

  it('a test-key replay returns its own sandbox transfer (200)', async () => {
    await createTransaction(deps('test'), ACME, 'pk_test_1', 'k1', txBody());
    const again = await createTransaction(deps('test'), ACME, 'pk_test_1', 'k1', txBody());
    expect(again).toMatchObject({ ok: true, status: 200 });
    expect(await q(sql`SELECT count(*)::int AS n FROM transfers`)).toEqual([{ n: 1 }]);
  });
});

describe('reads and confirm are confined to the key environment (404, never 403)', { retry: 0 }, () => {
  beforeEach(async () => {
    await createTransaction(deps('live'), ACME, 'pk_1', 'kl', txBody()); // sbx0 live
    await createTransaction(deps('test'), ACME, 'pk_test_1', 'kt', txBody()); // sbx1 test
  });

  it('getTransaction: each key sees only its own environment', async () => {
    expect(await getTransaction(deps('live'), 'acme', 'sbx0')).toMatchObject({ ok: true });
    expect(await getTransaction(deps('live'), 'acme', 'sbx1')).toMatchObject({ ok: false, status: 404 });
    expect(await getTransaction(deps('test'), 'acme', 'sbx1')).toMatchObject({ ok: true });
    expect(await getTransaction(deps('test'), 'acme', 'sbx0')).toMatchObject({ ok: false, status: 404 });
  });

  it('listTransactions: each key lists only its own environment', async () => {
    const ids = async (m: ApiKeyMode) => {
      const r = await listTransactions(deps(m), 'acme', {});
      return r.ok ? (r.data as { transactions: Array<{ id: string }> }).transactions.map((t) => t.id) : r;
    };
    expect(await ids('live')).toEqual(['sbx0']);
    expect(await ids('test')).toEqual(['sbx1']);
  });

  it('confirmTransaction across environments is a 404 and moves nothing', async () => {
    expect(await confirmTransaction(deps('test'), ACME, 'pk_test_1', 'sbx0')).toMatchObject({ ok: false, status: 404 });
    expect(await confirmTransaction(deps('live'), ACME, 'pk_1', 'sbx1')).toMatchObject({ ok: false, status: 404 });
    expect(await q(sql`SELECT status FROM transfers ORDER BY id`)).toEqual([
      { status: 'awaiting_payment' }, { status: 'awaiting_payment' },
    ]);
  });

  it('a test-key confirm on an http rail settles via the MOCK rail only (no settlement.instruct)', async () => {
    const r = await confirmTransaction(deps('test'), ACME, 'pk_test_1', 'sbx1');
    expect(r).toMatchObject({ ok: true, status: 200 });
    const kinds = await q<{ kind: string; dedupe_key: string }>(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
    expect(kinds).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'stage1:sbx1' },
      { kind: 'mock.settle', dedupe_key: 'mocksettle:sbx1' },
    ]);
  });
});
