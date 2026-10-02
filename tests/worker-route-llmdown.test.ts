import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { fakeGateRedis } from './helpers-gate-redis';
import { freshDb } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { OllamaHttpError } from '@/lib/llm-provider-error';
import type { Db } from '@/db/client';

// LLM provider outages reach ops: the PRODUCTION wiring in /api/worker's
// runAgentTurn must forward the agent's onFallback to drainOnce. Without it the
// route compiles but only ever raises the generic botfallback. The model call
// is mocked to fail with a billing rejection (HTTP 402); everything between it
// and the ops.alert row (createAgent, the worker) is real.

const SECRET = 'worker-route-llmdown-secret';
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
// Only chat() is mocked: the provider-error types live in their own leaf module.
vi.mock('@/lib/ollama', () => ({
  chat: vi.fn(async () => {
    box.chatCalls += 1;
    const { OllamaHttpError: E } = await import('@/lib/llm-provider-error');
    throw new E(402, 'out of credit');
  }),
}));

import { POST } from '@/app/api/worker/route';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  box.db = db;
  box.redis = fakeRedis();
  box.chatCalls = 0;
  gateBox.gate = fakeGateRedis();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in test')));
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/worker runAgentTurn wiring — llmdown', () => {
  it('a 402 from the model raises llmdown:402:<hour> (no botfallback), with one model call', async () => {
    expect(new OllamaHttpError(402, '').permanent).toBe(true);
    await createOutboxRepo(db).enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {} });
    const res = await POST(
      new NextRequest('https://smartremit.test/api/worker', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(200);
    expect(box.chatCalls).toBe(1); // a permanent error is not retried
    const rows = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as {
      rows: Array<{ dedupe_key: string | null }>;
    };
    const keys = rows.rows.map((r) => String(r.dedupe_key));
    expect(keys.filter((k) => /^llmdown:402:\d+$/.test(k))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith('botfallback:'))).toHaveLength(0);
  });
});
