import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { fakeRedis } from './helpers';
import { fakeGateRedis } from './helpers-gate-redis';
import { freshDb } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache, tenantScopeId } from '@/lib/flags';
import type { Db } from '@/db/client';

// Fix pack 3 T7 (R26, contract 10): the PRODUCTION /api/worker deps wire the
// agent.turn router's paused slot to the agent.paused kill switch. Harness of
// tests/worker-route-llmdown.test.ts; the model call is mocked and counted.

const SECRET = 'worker-route-agent-paused-secret';
process.env.CRON_SECRET = SECRET;

const box = vi.hoisted(() => ({ db: null as unknown, redis: null as unknown, chatCalls: 0 }));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => box.db };
});
vi.mock('@/lib/redis', async (orig) => {
  const real = await orig<typeof import('@/lib/redis')>();
  return { ...real, getRedis: () => box.redis };
});
vi.mock('@/lib/worker-cadence', async (orig) => {
  const real = await orig<typeof import('@/lib/worker-cadence')>();
  return { ...real, cadenceRedis: () => box.redis };
});
const gateBox = vi.hoisted(() => ({ gate: null as unknown }));
vi.mock('@/lib/worker-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/worker-gate')>();
  return { ...real, gateRedis: () => gateBox.gate };
});
vi.mock('@/lib/aml-sweep', async (orig) => {
  const real = await orig<typeof import('@/lib/aml-sweep')>();
  const { fakeAmlRedis } = await import('./helpers-aml-redis');
  return { ...real, amlRedis: () => fakeAmlRedis() };
});
vi.mock('@/lib/llm', () => ({
  chat: vi.fn(async () => {
    box.chatCalls += 1;
    return { role: 'assistant' as const, content: 'Hello from the agent!' };
  }),
}));

import { POST } from '@/app/api/worker/route';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  box.db = db;
  box.redis = fakeRedis();
  box.chatCalls = 0;
  gateBox.gate = fakeGateRedis();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in test')));
});
afterEach(() => {
  invalidateFlagCache(db);
  vi.unstubAllGlobals();
});

async function runTurn(): Promise<void> {
  await createOutboxRepo(db).enqueue('agent.turn', { phone: '15551230000', messageText: 'send $100 to Mom', turn: {} });
  const res = await POST(
    new NextRequest('https://smartremit.test/api/worker', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }),
  );
  expect(res.status).toBe(200);
}

describe('/api/worker runAgentTurn wiring — agent.paused', () => {
  it('agent.paused global row -> the turn makes no model call', async () => {
    await createFeatureFlagRepo(db).upsert({
      key: 'agent.paused', scopeType: 'global', scopeId: '', enabled: true, reason: 'model incident', updatedBy: 'admin',
    });
    invalidateFlagCache(db);
    await runTurn();
    expect(box.chatCalls).toBe(0);
  });

  // Pack 3 final check K2: the route passes the TURN's tenant to the flag read (a partner-set
  // tenant:<id> row from /partner/controls). The queued turn carries no partnerId and arrives on
  // the shared number, so its tenant is 'default'.
  it("a partner-set agent.paused row for the turn's tenant -> no model call", async () => {
    await createFeatureFlagRepo(db).upsert({
      key: 'agent.paused', scopeType: 'partner', scopeId: tenantScopeId('default'), enabled: true, reason: 'model incident', updatedBy: 'admin',
    });
    invalidateFlagCache(db);
    await runTurn();
    expect(box.chatCalls).toBe(0);
  });

  it('a partner-set agent.paused row for a DIFFERENT tenant -> one model call', async () => {
    await createFeatureFlagRepo(db).upsert({
      key: 'agent.paused', scopeType: 'partner', scopeId: tenantScopeId('other'), enabled: true, reason: 'model incident', updatedBy: 'admin',
    });
    invalidateFlagCache(db);
    await runTurn();
    expect(box.chatCalls).toBe(1);
  });

  it('no row -> one model call', async () => {
    await runTurn();
    expect(box.chatCalls).toBe(1);
  });
});
