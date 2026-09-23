import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis } from './helpers';
import { apiKeys } from '@/db/schema';
import type { Db } from '@/db/client';
import type { ApiScope } from '@/lib/partner-api-scopes';

// Program-Fix 44 P1 — every guardPartner handler declares a scope, and the REAL
// guard enforces it. Only the edges are stubbed (key store → PGlite, Redis →
// fake, partner store → active, service → 200). Pinned:
//   • the route table below equals the handlers actually exported under
//     src/app/api/partner/v1 (a new route without a scope fails this file);
//   • each handler passes exactly its scope to guardPartner;
//   • a test key gets 403 on the 8 out-of-scope handlers (no service call);
//   • a PRE-FIX legacy key (pk_<id> id + sr_live_ plaintext) and a new live key
//     pass all 11.

const h = vi.hoisted(() => ({
  db: null as unknown as Db,
  redis: null as unknown as ReturnType<typeof import('./helpers').fakeRedis>,
  scopesSeen: [] as string[],
  svcCalls: 0,
}));

const PEPPER = 'scope-test-pepper';

vi.mock('@/lib/partner-api-key', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-api-key')>();
  return {
    ...actual,
    getPartnerApiKeyStore: () => actual.createPartnerApiKeyStore(h.db, { pepper: 'scope-test-pepper', redis: h.redis }),
  };
});
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async (id: string) => ({ id, name: id, countries: ['US'], status: 'active' }),
  }),
}));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/monthly-volume-store', () => ({ getMonthlyVolumeStore: () => ({}) }));
vi.mock('@/lib/partner-integrations-store', () => ({ getPartnerIntegrationsStore: () => ({}) }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/partner-api', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-api')>();
  return {
    ...actual,
    guardPartner: (req: NextRequest, scope: string) => {
      h.scopesSeen.push(scope);
      return actual.guardPartner(req, scope as ApiScope);
    },
  };
});
vi.mock('@/lib/partner-api-service', () => {
  const ok = () => {
    h.svcCalls++;
    return { ok: true, status: 200, data: { ok: true } };
  };
  return {
    listCorridors: () => {
      h.svcCalls++;
      return { corridors: [] };
    },
    createQuote: async () => ok(),
    validateBeneficiary: () => ok(),
    createBeneficiary: async () => ok(),
    createTransaction: async () => ok(),
    listTransactions: async () => ok(),
    getTransaction: async () => ok(),
    confirmTransaction: async () => ok(),
    pushPartnerRate: async () => ok(),
    listPartnerRates: async () => ok(),
    listSettlements: async () => {
      h.svcCalls++;
      return { ok: true, status: 200, data: { format: 'json', body: { settlements: [] } } };
    },
  };
});

const corridors = await import('@/app/api/partner/v1/corridors/route');
const quote = await import('@/app/api/partner/v1/quote/route');
const validate = await import('@/app/api/partner/v1/beneficiaries/validate/route');
const beneficiaries = await import('@/app/api/partner/v1/beneficiaries/route');
const transactions = await import('@/app/api/partner/v1/transactions/route');
const transaction = await import('@/app/api/partner/v1/transactions/[id]/route');
const confirm = await import('@/app/api/partner/v1/transactions/[id]/confirm/route');
const rates = await import('@/app/api/partner/v1/rates/route');
const settlements = await import('@/app/api/partner/v1/settlements/route');

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

interface Row {
  route: string; // path under src/app/api/partner/v1
  method: 'GET' | 'POST' | 'PUT';
  scope: ApiScope;
  handler: Handler;
  testKey: 'allowed' | 'denied';
}

const ROUTES: Row[] = [
  { route: 'corridors', method: 'GET', scope: 'corridors:read', handler: corridors.GET as Handler, testKey: 'allowed' },
  { route: 'quote', method: 'POST', scope: 'quote', handler: quote.POST as Handler, testKey: 'allowed' },
  { route: 'beneficiaries/validate', method: 'POST', scope: 'beneficiaries:validate', handler: validate.POST as Handler, testKey: 'allowed' },
  { route: 'beneficiaries', method: 'POST', scope: 'beneficiaries:write', handler: beneficiaries.POST as Handler, testKey: 'denied' },
  { route: 'transactions', method: 'GET', scope: 'transactions:read', handler: transactions.GET as Handler, testKey: 'denied' },
  { route: 'transactions', method: 'POST', scope: 'transactions:write', handler: transactions.POST as Handler, testKey: 'denied' },
  { route: 'transactions/[id]', method: 'GET', scope: 'transactions:read', handler: transaction.GET as Handler, testKey: 'denied' },
  { route: 'transactions/[id]/confirm', method: 'POST', scope: 'transactions:write', handler: confirm.POST as Handler, testKey: 'denied' },
  { route: 'rates', method: 'GET', scope: 'rates:read', handler: rates.GET as Handler, testKey: 'denied' },
  { route: 'rates', method: 'PUT', scope: 'rates:write', handler: rates.PUT as Handler, testKey: 'denied' },
  { route: 'settlements', method: 'GET', scope: 'settlements:read', handler: settlements.GET as Handler, testKey: 'denied' },
];

const V1_DIR = join(process.cwd(), 'src/app/api/partner/v1');

function exportedHandlers(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'route.ts') {
        const route = relative(V1_DIR, dir);
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
          out.push(`${m[1]} ${route}`);
        }
      }
    }
  };
  walk(V1_DIR);
  return out.sort();
}

function call(row: Row, bearer: string): Promise<Response> {
  const url = `https://x.test/api/partner/v1/${row.route.replace('[id]', 'tx_1')}`;
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: row.method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
  };
  if (row.method !== 'GET') init.body = '{}';
  return row.handler(new NextRequest(url, init), { params: Promise.resolve({ id: 'tx_1' }) });
}

const LEGACY_ID = 'pk_LegacyId0123456789ab';
const LEGACY_PLAINTEXT = 'sr_live_LEGACYsecretAAAABBBBCCCCDDDD';

let liveKey: string;
let testKey: string;

beforeEach(async () => {
  h.db = await freshDb();
  h.redis = fakeRedis();
  h.scopesSeen = [];
  h.svcCalls = 0;
  await seedPartner(h.db, 'acme');
  const { createPartnerApiKeyStore } = await import('@/lib/partner-api-key');
  const store = createPartnerApiKeyStore(h.db, { pepper: PEPPER });
  liveKey = (await store.issue('acme')).plaintext;
  testKey = (await store.issue('acme', 'test')).plaintext;
  // A pre-fix key, stored exactly as the old build stored it.
  await h.db.insert(apiKeys).values({
    id: LEGACY_ID,
    partnerId: 'acme',
    keyHash: createHash('sha256').update(`${LEGACY_PLAINTEXT}${PEPPER}`).digest('hex'),
    last4: LEGACY_PLAINTEXT.slice(-4),
    createdAt: new Date('2026-06-01T00:00:00Z'),
  });
});

describe('partner API route scopes (Program-Fix 44 P1)', () => {
  it('the table covers EVERY exported handler under /api/partner/v1 (11)', () => {
    const table = ROUTES.map((r) => `${r.method} ${r.route}`).sort();
    expect(table).toEqual(exportedHandlers());
    expect(table).toHaveLength(11);
  });

  it('each handler passes exactly its declared scope to guardPartner', async () => {
    for (const row of ROUTES) {
      h.scopesSeen = [];
      await call(row, liveKey);
      expect(h.scopesSeen, `${row.method} ${row.route}`).toEqual([row.scope]);
    }
  });

  it('a TEST key is 403 on the 8 out-of-scope handlers and never reaches the service', async () => {
    const denied = ROUTES.filter((r) => r.testKey === 'denied');
    expect(denied).toHaveLength(8);
    for (const row of denied) {
      h.svcCalls = 0;
      const res = await call(row, testKey);
      expect(res.status, `${row.method} ${row.route}`).toBe(403);
      expect(await res.json()).toEqual({ error: 'This key cannot perform this action.' });
      expect(h.svcCalls, `${row.method} ${row.route}`).toBe(0);
    }
  });

  it('a TEST key passes corridors, quote and beneficiaries/validate', async () => {
    for (const row of ROUTES.filter((r) => r.testKey === 'allowed')) {
      const res = await call(row, testKey);
      expect(res.status, `${row.method} ${row.route}`).toBe(200);
    }
  });

  it('PINNED: a pre-fix legacy key (pk_<id> + sr_live_) passes ALL 11 handlers', async () => {
    for (const row of ROUTES) {
      const res = await call(row, LEGACY_PLAINTEXT);
      expect(res.status, `${row.method} ${row.route}`).toBe(200);
    }
    expect(h.svcCalls).toBe(11);
  });

  it('a new live key passes ALL 11 handlers', async () => {
    for (const row of ROUTES) {
      const res = await call(row, liveKey);
      expect(res.status, `${row.method} ${row.route}`).toBe(200);
    }
  });

  it('an unknown sr_test_ key is 401 (not 403) — unknown keys never learn about scopes', async () => {
    const res = await call(ROUTES[0], 'sr_test_x');
    expect(res.status).toBe(401);
  });
});
