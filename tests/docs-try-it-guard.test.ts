import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis } from './helpers';
import { apiKeys } from '@/db/schema';
import type { Db } from '@/db/client';
import type { Partner } from '@/lib/types';
import type { ApiKeyMode } from '@/lib/partner-api-scopes';
import { TRY_IT_LIVE_KEY_ERROR } from '@/lib/docs/try-it';

// UI redesign M4 PR-5 (Task 5.2 Step 1b, review round 1): the try-it proxy through the REAL
// partner route handlers and the REAL guardPartner, on a PGlite ledger. The mocked-handler test
// cannot prove these; this one does:
//   1. a live key never reaches the key store (0 authenticate calls);
//   2. tenant isolation: a sandbox key sees only its own partner's SANDBOX rows (another partner's
//      sandbox row and its own live row are 404);
//   3. scopes are the guard's: a narrowed test key is 403 (the proxy never widens a key).
// Only the edges are stubbed: Redis → fake, the IP limiter → allow, the outbox → no-op, FX → stub.

const h = vi.hoisted(() => ({
  db: null as unknown as Db,
  redis: null as unknown as ReturnType<typeof import('./helpers').fakeRedis>,
  authCalls: 0,
}));
const PEPPER = 'tryit-guard-test-pepper';

vi.mock('@/lib/partner-api-key', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-api-key')>();
  return {
    ...actual,
    getPartnerApiKeyStore: () => {
      const store = actual.createPartnerApiKeyStore(h.db, { pepper: PEPPER, redis: h.redis });
      return {
        ...store,
        authenticate: (plaintext: string) => {
          h.authCalls++;
          return store.authenticate(plaintext);
        },
      };
    },
  };
});
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/store', async (orig) => {
  const actual = await orig<typeof import('@/lib/store')>();
  return { ...actual, getStore: () => actual.createStore(h.redis, h.db) };
});
vi.mock('@/lib/customer-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/customer-store')>();
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(h.db, store) };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-store')>();
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(h.db) };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));

const { POST } = await import('@/app/api/docs/try-it/route');
const { createStore } = await import('@/lib/store');
const { createCustomerStore } = await import('@/lib/customer-store');
const { createPartnerStore } = await import('@/lib/partner-store');
const { createMonthlyVolumeStore } = await import('@/lib/monthly-volume-store');
const { createPartnerIntegrationsStore } = await import('@/lib/partner-integrations-store');
const { EnvKeyProvider } = await import('@/lib/field-crypto');
const { resetRateCacheForTests } = await import('@/lib/rate');
const { createTransaction } = await import('@/lib/partner-api-service');
const { createPartnerApiKeyStore } = await import('@/lib/partner-api-key');

const ORIGIN = 'https://smartremit.ai';
const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const NOW = new Date().toISOString();

async function tryIt(payload: Record<string, unknown>) {
  const res = await POST(
    new NextRequest(`${ORIGIN}/api/docs/try-it`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', host: 'smartremit.ai' },
      body: JSON.stringify(payload),
    }),
  );
  return { status: res.status, json: (await res.json()) as { upstreamStatus?: number; body?: unknown; error?: string } };
}

const partner = (id: string): Partner =>
  ({ id, name: id, countries: ['US'], status: 'active', createdAt: NOW, updatedAt: NOW, kycMode: 'delegated', requireKycBeforeSend: false }) as Partner;

const txBody = {
  amount_source: 200,
  sender: { phone: '15551230000', name: 'Sender Person', kyc_status: 'verified' },
  beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
};

let keys: { acmeLive: string; acmeTest: string; betaTest: string };
let ids: { acmeSandbox: string; acmeLive: string; betaSandbox: string };

async function mint(partnerId: string, mode: ApiKeyMode, idem: string, id: string): Promise<string> {
  const store = createStore(h.redis, h.db);
  const r = await createTransaction(
    {
      store,
      customerStore: createCustomerStore(h.db, store),
      partnerStore: createPartnerStore(h.db),
      monthlyVolumeStore: createMonthlyVolumeStore(store),
      integrationsStore: createPartnerIntegrationsStore(h.db, provider),
      db: h.db,
      genId: () => id,
      keyMode: mode,
    },
    partner(partnerId),
    mode === 'test' ? 'pk_test_seed' : 'pk_seed',
    idem,
    txBody,
  );
  expect(r, `${partnerId} ${mode}`).toMatchObject({ ok: true, status: 201 });
  return id;
}

beforeEach(async () => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '' })));
  h.db = await freshDb();
  h.redis = fakeRedis();
  h.authCalls = 0;
  const integrations = createPartnerIntegrationsStore(h.db, provider);
  for (const p of ['acme', 'beta']) {
    await seedPartner(h.db, p);
    await integrations.saveIntegrations(p, {
      kyc: {},
      payment: { providerType: 'http', credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' }, webhookSecret: 'w' },
      whatsapp: {},
    });
  }
  const ks = createPartnerApiKeyStore(h.db, { pepper: PEPPER });
  keys = {
    acmeLive: (await ks.issue('acme')).plaintext,
    acmeTest: (await ks.issue('acme', 'test')).plaintext,
    betaTest: (await ks.issue('beta', 'test')).plaintext,
  };
  ids = {
    acmeSandbox: await mint('acme', 'test', 'k1', 'txAcmeSbx'),
    acmeLive: await mint('acme', 'live', 'k2', 'txAcmeLive'),
    betaSandbox: await mint('beta', 'test', 'k3', 'txBetaSbx'),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('try-it through the REAL partner guard (tenant suite)', { retry: 0 }, () => {
  it('1. a real live key never reaches the key store: 400 and 0 authenticate calls', async () => {
    expect(keys.acmeLive.startsWith('sr_live_')).toBe(true);
    for (const operationId of ['listCorridors', 'listTransactions']) {
      const r = await tryIt({ operationId, key: keys.acmeLive });
      expect(r).toEqual({ status: 400, json: { error: TRY_IT_LIVE_KEY_ERROR } });
    }
    const g = await tryIt({ operationId: 'getTransaction', key: keys.acmeLive, params: { id: ids.acmeLive } });
    expect(g.status).toBe(400);
    expect(h.authCalls).toBe(0);
    // Control: the spy IS on the path the guard uses (a sandbox key does authenticate).
    expect((await tryIt({ operationId: 'listCorridors', key: keys.acmeTest })).json.upstreamStatus).toBe(200);
    expect(h.authCalls).toBe(1);
  });

  it("2. tenant isolation: a sandbox key sees only its own partner's sandbox rows", async () => {
    const get = (id: string) => tryIt({ operationId: 'getTransaction', key: keys.acmeTest, params: { id } });
    expect((await get(ids.acmeSandbox)).json.upstreamStatus).toBe(200);
    expect((await get(ids.betaSandbox)).json.upstreamStatus).toBe(404); // another tenant
    expect((await get(ids.acmeLive)).json.upstreamStatus).toBe(404); // its own LIVE row
    const list = await tryIt({ operationId: 'listTransactions', key: keys.acmeTest });
    expect(list.json.upstreamStatus).toBe(200);
    const listed = JSON.stringify(list.json.body);
    expect(listed).toContain(ids.acmeSandbox);
    expect(listed).not.toContain(ids.betaSandbox);
    expect(listed).not.toContain(ids.acmeLive);
  });

  it('3. scopes are the guard\'s: a test key narrowed to corridors:read is 403 on createQuote', async () => {
    const keyId = (await h.db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.partnerId, 'acme'))).map((r) => r.id).find((id) => id.startsWith('pk_test_'));
    expect(keyId).toBeDefined();
    await h.db.update(apiKeys).set({ scopes: ['corridors:read'] }).where(eq(apiKeys.id, keyId!));
    h.redis = fakeRedis(); // drop any cached auth for the key
    const q = await tryIt({ operationId: 'createQuote', key: keys.acmeTest, body: { amount_source: 100 } });
    expect(q.status).toBe(200);
    expect(q.json.upstreamStatus).toBe(403);
    expect((await tryIt({ operationId: 'listCorridors', key: keys.acmeTest })).json.upstreamStatus).toBe(200);
  });

  it('an unknown sandbox key gets the upstream single 401 message (no oracle)', async () => {
    const r = await tryIt({ operationId: 'listCorridors', key: 'sr_test_FAKEunknownFAKEunknown' });
    expect(r).toEqual({ status: 200, json: { upstreamStatus: 401, retryAfter: null, body: { error: 'Invalid or revoked API key.' } } });
  });
});
