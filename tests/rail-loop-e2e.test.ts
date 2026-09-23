import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import type { RedisLike } from '@/lib/store';

// Program-Fix 29: the WHOLE simulator loop on real Postgres (PGlite), with no
// network — the injected fetchFn routes the worker's POSTs straight into the
// real route handlers:
//   settlement.instruct (worker) ─signed→ POST /api/partner-rail
//     → delayed rail.callback row (amount echoed)
//   rail.callback (worker) ─signed→ POST /api/payment-webhook/simulator
//     → delivered (or HELD when the reported amount differs).

let db: Db;
let redis: RedisLike;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => real.createStore(redis, db) };
});
vi.mock('@/lib/partner-integrations-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-integrations-store')>();
  return { ...real, getPartnerIntegrationsStore: () => real.createPartnerIntegrationsStore(db) };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  return { ...real, getPartnerStore: () => real.createPartnerStore(db) };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {} }));
const afterPending: Promise<void>[] = [];
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (cb: () => Promise<void> | void) => { afterPending.push(Promise.resolve().then(cb)); } };
});
const sendText = vi.fn(async (..._a: unknown[]) => {});
const sendTemplate = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/whatsapp', async (orig) => {
  const real = await orig<typeof import('@/lib/whatsapp')>();
  return {
    ...real,
    sendText: (...a: unknown[]) => sendText(...a),
    sendTemplate: (...a: unknown[]) => sendTemplate(...a),
    sendTemplateOrText: async (_to: string, send: () => Promise<void>) => { await send(); },
  };
});

import { POST as railPOST } from '@/app/api/partner-rail/route';
import { POST as webhookPOST } from '@/app/api/payment-webhook/[provider]/route';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { createStore } from '@/lib/store';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { env } from '@/lib/env';

const RAIL_URL = `${env.appBaseUrl}/api/partner-rail`;
const HOOK_URL = `${env.appBaseUrl}/api/payment-webhook/simulator`;

function transferFixture(): Transfer {
  return {
    id: 'e2e_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: 'HDFC0001234 123456789012', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), paidAt: new Date().toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

type Call = { url: string; headers: Record<string, string>; status: number };
let calls: Call[];

/** Route the worker's rail POSTs into the real handlers. */
const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
  const req = new NextRequest(url, { method: 'POST', headers: init.headers as Record<string, string>, body: String(init.body) });
  let res: Response;
  if (url === RAIL_URL) res = await railPOST(req);
  else if (url === HOOK_URL) res = await webhookPOST(req, { params: Promise.resolve({ provider: 'simulator' }) });
  else throw new Error(`unexpected fetch ${url}`);
  calls.push({ url, headers: { ...(init.headers as Record<string, string>) }, status: res.status });
  return res;
};

function deps(): WorkerDeps {
  return {
    db,
    store: createStore(redis, db),
    sendText: sendText as unknown as WorkerDeps['sendText'],
    sendTemplate: sendTemplate as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: (async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

const releaseDelayedCallback = () =>
  db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'rail.callback'`);
const keys = async () =>
  ((await db.execute(sql`SELECT dedupe_key FROM outbox WHERE dedupe_key IS NOT NULL ORDER BY id`)) as unknown as {
    rows: Array<{ dedupe_key: string }>;
  }).rows.map((r) => r.dedupe_key);

beforeEach(async () => {
  db = await freshDb();
  redis = fakeRedis();
  calls = [];
  afterPending.length = 0;
  sendText.mockClear(); sendTemplate.mockClear();
  await seedPartner(db, 'acme');
  await createIntegrationsRepo(db).saveIntegrations('acme', {
    kyc: {},
    payment: {
      providerType: 'simulator',
      credentials: { settlementUrl: RAIL_URL, signingSecret: 'sgn_e2e' },
      webhookSecret: 'whk_e2e',
    },
    whatsapp: {},
  });
  await createStore(redis, db).saveTransfer(transferFixture());
  await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: 'e2e_t1' }, { dedupeKey: 'instruct:e2e_t1' });
});

describe('rail loop end to end (fix 29)', () => {
  it('signed instruction → rail ack → signed callback with the echoed amount → delivered', async () => {
    await drainOnce(deps(), 'w1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: RAIL_URL, status: 200 });
    expect(calls[0].headers['x-smartremit-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(calls[0].headers['x-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect((await createStore(redis, db).getTransfer('e2e_t1'))!.paymentProviderRef).toBe('simrail-e2e_t1');

    await releaseDelayedCallback();
    await drainOnce(deps(), 'w2');
    const cb = calls.find((c) => c.url === HOOK_URL)!;
    expect(cb.status).toBe(200);
    expect(cb.headers['x-smartremit-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect((await createStore(redis, db).getTransfer('e2e_t1'))!.status).toBe('delivered');
    expect((await keys()).some((k) => k.startsWith('railamount:'))).toBe(false);
    await Promise.all(afterPending.splice(0));
    expect(sendText).toHaveBeenCalled(); // the stage-2 "delivered" message
  });

  it('a tampered callback amount → stays paid, ONE railamount: alert, and a later re-instruct makes NO rail POST', async () => {
    await drainOnce(deps(), 'w1');
    await db.execute(sql`
      UPDATE outbox SET payload = jsonb_set(payload, '{amount,destination}', '99999'::jsonb), next_attempt_at = now()
      WHERE kind = 'rail.callback'`);
    await drainOnce(deps(), 'w2');
    const cb = calls.find((c) => c.url === HOOK_URL)!;
    expect(cb.status).toBe(200); // held, so the rail stops retrying
    expect((await createStore(redis, db).getTransfer('e2e_t1'))!.status).toBe('paid');
    expect((await keys()).filter((k) => k.startsWith('railamount:'))).toEqual(['railamount:e2e_t1']);

    // reconcile / a dead-letter retry queues a re-instruction — it must not POST.
    const before = calls.filter((c) => c.url === RAIL_URL).length;
    await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: 'e2e_t1' }, { dedupeKey: 'reinstruct:e2e_t1' });
    await drainOnce(deps(), 'w3');
    expect(calls.filter((c) => c.url === RAIL_URL).length).toBe(before);
    const st = ((await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = 'reinstruct:e2e_t1'`)) as unknown as { rows: Array<{ status: string }> }).rows[0].status;
    expect(st).toBe('done');
  });
});
