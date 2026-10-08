import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Batch B4: a referral code in an inbound WhatsApp message links the customer to the
// referral partner, under the customer's OWN tenant, safely when WhatsApp delivers the
// same message twice, and never blocks the message (an error only logs).

const PHONE = '15551230000';

let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
vi.mock('@/lib/whatsapp', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  sendText: vi.fn(async () => {}),
}));
const repoFault = vi.hoisted(() => ({ on: false }));
vi.mock('@/db/repos/referral-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/referral-repo')>();
  return {
    ...real,
    createReferralRepo: (d: Parameters<typeof real.createReferralRepo>[0]) => {
      const repo = real.createReferralRepo(d);
      return {
        ...repo,
        recordAttribution: async (...a: Parameters<typeof repo.recordAttribution>) => {
          if (repoFault.on) throw Object.assign(new Error('Connection terminated unexpectedly'), { name: 'DatabaseError' });
          return repo.recordAttribution(...a);
        },
      };
    },
  };
});
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn }));

import { processInboundWebhook } from '@/lib/whatsapp-inbound';
import { createReferralRepo } from '@/db/repos/referral-repo';

type Msg = Record<string, unknown>;
const text = (body: string, id: string, from = PHONE): Msg => ({ from, id, type: 'text', text: { body } });
const webhook = (messages: Msg[]) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages } }] }] });

async function attributions() {
  const raw = await db.execute(sql`SELECT partner_id, phone, referral_partner_id, channel FROM referral_attributions ORDER BY phone`);
  return (raw as unknown as { rows: Record<string, unknown>[] }).rows;
}
const agentTurns = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'agent.turn'`)) as unknown as { rows: { n: number }[] }).rows[0].n;

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'acme');
  repoFault.on = false;
  logWarn.mockClear();
  const repo = createReferralRepo(db);
  await repo.insertPartner({ id: 'rp_tana', name: 'TANA', contact: 'events@tana.org', commissionCents: 100, createdBy: 'admin' });
  await repo.insertCode({ code: 'REF-TANA01', referralPartnerId: 'rp_tana', createdBy: 'admin' });
  await repo.insertPartner({ id: 'rp_other', name: 'Other', contact: '', commissionCents: 0, createdBy: 'admin' });
  await repo.insertCode({ code: 'REF-OTHER1', referralPartnerId: 'rp_other', createdBy: 'admin' });
});
afterEach(() => vi.restoreAllMocks());

describe('WhatsApp referral code', () => {
  it('a new customer sending the code is linked (channel whatsapp) and the agent turn is still queued', async () => {
    await processInboundWebhook(webhook([text("Hi SmartRemit, I'd like to send money. My referral code is REF-TANA01.", 'wamid.R1')]), { routedPartnerId: null });
    expect(await attributions()).toEqual([{ partner_id: 'default', phone: PHONE, referral_partner_id: 'rp_tana', channel: 'whatsapp' }]);
    expect(await agentTurns()).toBe(1);
  });

  it('the same message delivered twice links once and queues one turn', async () => {
    const body = webhook([text('ref-tana01', 'wamid.R2')]);
    await processInboundWebhook(body, { routedPartnerId: null });
    redis.dump.clear(); // the msgq: fast skip is gone; the DB dedups
    await processInboundWebhook(body, { routedPartnerId: null });
    expect(await attributions()).toHaveLength(1);
    expect(await agentTurns()).toBe(1);
  });

  it('first referral wins: a later code does not move the customer', async () => {
    await processInboundWebhook(webhook([text('REF-TANA01', 'wamid.R3')]), { routedPartnerId: null });
    await processInboundWebhook(webhook([text('REF-OTHER1', 'wamid.R4')]), { routedPartnerId: null });
    expect((await attributions())[0].referral_partner_id).toBe('rp_tana');
  });

  it('a customer with a delivered transfer is not linked', async () => {
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 10, status: 'delivered' });
    await processInboundWebhook(webhook([text('REF-TANA01', 'wamid.R5')]), { routedPartnerId: null });
    expect(await attributions()).toEqual([]);
    expect(await agentTurns()).toBe(1);
  });

  it("a code sent to a partner's number links the customer under THAT tenant; the tenant never changes", async () => {
    await processInboundWebhook(webhook([text('REF-TANA01', 'wamid.R6')]), { routedPartnerId: 'acme' });
    expect(await attributions()).toEqual([{ partner_id: 'acme', phone: PHONE, referral_partner_id: 'rp_tana', channel: 'whatsapp' }]);
    const customers = (await db.execute(sql`SELECT partner_id FROM customers WHERE phone = ${PHONE}`)) as unknown as { rows: { partner_id: string }[] };
    expect(customers.rows.map((r) => r.partner_id)).toEqual(['acme']);
  });

  it('an unknown code or a message without a code records nothing', async () => {
    await processInboundWebhook(webhook([text('REF-NOPE00 hello', 'wamid.R7'), text('send 200 to mom', 'wamid.R8', '15550000009')]), { routedPartnerId: null });
    expect(await attributions()).toEqual([]);
    expect(await agentTurns()).toBe(2);
  });

  it('an attribution error only logs: the message is still processed', async () => {
    repoFault.on = true;
    const r = await processInboundWebhook(webhook([text('REF-TANA01', 'wamid.R9')]), { routedPartnerId: null });
    expect(r).toMatchObject({ ok: true });
    expect(await agentTurns()).toBe(1);
    expect(logWarn.mock.calls.some((c) => c[0] === 'referral.attribution')).toBe(true);
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).not.toContain(PHONE);
  });
});
