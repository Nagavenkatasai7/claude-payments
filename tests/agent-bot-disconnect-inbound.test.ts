import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Stage C2: "disconnect apps" in WhatsApp revokes the customer's AI-app grants in their own
// tenant, answers with a fixed reply and queues no agent turn.

const PHONE = '15551230000';
const OTHER = '15551230099';
const CID = 'agc_AAAAAAAAAAAAAAAAAAAAAA';
const CID_ACME = 'agc_BBBBBBBBBBBBBBBBBBBBBB';

let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
vi.mock('@/lib/whatsapp', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  sendText: vi.fn(async () => {}),
}));

import { processInboundWebhook } from '@/lib/whatsapp-inbound';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';

type Msg = Record<string, unknown>;
const text = (body: string, id: string, from = PHONE): Msg => ({ from, id, type: 'text', text: { body } });
const webhook = (messages: Msg[]) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages } }] }] });

const rows = async (q: ReturnType<typeof sql>) => (((await db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows);
const replies = () => rows(sql`SELECT payload->>'body' AS body, payload->>'to' AS "to" FROM outbox WHERE kind = 'whatsapp.text' ORDER BY id`);
const agentTurns = async () => (await rows(sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'agent.turn'`))[0].n;
const live = (partnerId: string, phone: string) => createAgentOAuthRepo(db).listCustomerGrants(partnerId, phone, new Date());

async function grant(id: string, partnerId = 'default', phone = PHONE, clientId = CID) {
  await createAgentOAuthRepo(db).insertGrant({
    id,
    partnerId,
    phone,
    clientId,
    scopes: ['quotes:read'],
    refreshHash: `h-${id}`,
    now: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'acme');
  const repo = createAgentOAuthRepo(db);
  await repo.insertClient({ id: CID, partnerId: 'default', name: 'Claude', redirectUris: ['https://claude.ai/cb'], authMethod: 'none', secretHash: null });
  await repo.insertClient({ id: CID_ACME, partnerId: 'acme', name: 'Claude', redirectUris: ['https://claude.ai/cb'], authMethod: 'none', secretHash: null });
  await grant('agg_GGGGGGGGGGGGGGGGGGGGG1');
  await grant('agg_GGGGGGGGGGGGGGGGGGGGG2');
  await grant('agg_GGGGGGGGGGGGGGGGGGGGG3', 'default', OTHER);
  await grant('agg_GGGGGGGGGGGGGGGGGGGGG4', 'acme', PHONE, CID_ACME);
});
afterEach(() => vi.restoreAllMocks());

describe('"disconnect apps" in WhatsApp', () => {
  it("revokes the customer's grants in this tenant only, replies, and runs no agent turn", async () => {
    await processInboundWebhook(webhook([text('Disconnect apps', 'wamid.D1')]), { routedPartnerId: null });
    expect(await live('default', PHONE)).toEqual([]);
    expect(await live('default', OTHER)).toHaveLength(1); // another customer
    expect(await live('acme', PHONE)).toHaveLength(1); // the same phone in another tenant
    expect(await replies()).toEqual([{ body: 'Done. 2 AI apps are disconnected. They can no longer use your SmartRemit account.', to: PHONE }]);
    expect(await agentTurns()).toBe(0);
    const audit = await rows(sql`SELECT action, actor_type FROM audit_events WHERE action = 'agent.grant.revoked'`);
    expect(audit).toHaveLength(2);
  });

  it('with nothing connected it says so', async () => {
    await processInboundWebhook(webhook([text('disconnect apps', 'wamid.D2', '15551230055')]), { routedPartnerId: null });
    expect((await replies())[0].body).toBe('No AI apps are connected to your SmartRemit account.');
  });

  it('a sentence that only mentions it goes to the assistant', async () => {
    await processInboundWebhook(webhook([text('how do I disconnect apps?', 'wamid.D3')]), { routedPartnerId: null });
    expect(await live('default', PHONE)).toHaveLength(2);
    expect(await agentTurns()).toBe(1);
  });
});
