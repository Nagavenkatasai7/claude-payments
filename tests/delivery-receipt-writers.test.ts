import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import type { RedisLike } from '@/lib/store';

// UI redesign M2-11b (plan Task 11.5, review round 1 M7): the automatic receipt, per `delivered`
// WRITER, end to end on real Postgres (PGlite). The two writers that move a transfer to
// 'delivered' (both through Store.updateTransferFromWebhook):
//   1. POST /api/payment-webhook/[provider] — a partner rail's (or the simulator's) signed paid_out;
//   2. the outbox worker's mock.settle → completePaymentStage2 (payment.ts).
// Each: receipts ON + verified → one sealed email.send row, opened by the worker's email.send path
// with the masked destination; a replay → still one; receipts OFF → none; sandbox → none.

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
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {}, pokeWorkerDelayed: () => {} }));
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
    sendTemplateOrText: async (_to: string, send: () => Promise<void>) => { await send(); return { ok: true, via: 'template' }; },
  };
});

import { POST as railPOST } from '@/app/api/partner-rail/route';
import { POST as webhookPOST } from '@/app/api/payment-webhook/[provider]/route';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { createStore } from '@/lib/store';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { emailVerifiedTag, markEmailVerified, setEmailReceipts } from '@/lib/portal-prefs';
import { env } from '@/lib/env';

const RAIL_URL = `${env.appBaseUrl}/api/partner-rail`;
const HOOK_URL = `${env.appBaseUrl}/api/payment-webhook/simulator`;
const PHONE = '15551230000';
const EMAIL = 'sender@example.com';
const FULL_ACCOUNT = '123456789012';

function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'rw_t1', phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: `HDFC0001234 ${FULL_ACCOUNT}`, fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), paidAt: new Date().toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
  const req = new NextRequest(url, { method: 'POST', headers: init.headers as Record<string, string>, body: String(init.body) });
  if (url === RAIL_URL) return railPOST(req);
  if (url === HOOK_URL) return webhookPOST(req, { params: Promise.resolve({ provider: 'simulator' }) });
  throw new Error(`unexpected fetch ${url}`);
};

const sendEmail = vi.fn(async (_m: { to: string[]; subject: string; text: string }) => undefined);

function deps(): WorkerDeps {
  return {
    db,
    store: createStore(redis, db),
    sendText: sendText as unknown as WorkerDeps['sendText'],
    sendTemplate: sendTemplate as unknown as WorkerDeps['sendTemplate'],
    sendEmail: sendEmail as unknown as WorkerDeps['sendEmail'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: (async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

async function optIn(receipts = true) {
  await seedSender(db, { partnerId: 'acme', phone: PHONE });
  await createCustomerRepo(db, async () => null).setEmail('acme', PHONE, EMAIL);
  await markEmailVerified(db, 'acme', PHONE, emailVerifiedTag('acme', PHONE, EMAIL));
  await setEmailReceipts(db, 'acme', PHONE, receipts);
}

type Row = { dedupe_key: string | null; status: string; payload: Record<string, unknown> };
async function receiptRows(): Promise<Row[]> {
  const r = (await db.execute(
    sql`SELECT dedupe_key, status, payload FROM outbox WHERE kind = 'email.send' ORDER BY id`,
  )) as unknown as { rows: Row[] };
  return r.rows;
}
const statusOf = async () => (await createStore(redis, db).getTransfer('rw_t1'))!.status;

afterEach(() => {
  delete process.env.CUSTOMER_PORTAL_ENABLED;
});

beforeEach(async () => {
  db = await freshDb();
  redis = fakeRedis();
  afterPending.length = 0;
  sendText.mockClear(); sendTemplate.mockClear(); sendEmail.mockClear();
  await seedPartner(db, 'acme');
  await db.execute(sql`UPDATE partners SET display_name = 'Acme Remit' WHERE id = 'acme'`);
  // M2-14 (#417 L2): receipts need the portal ON (platform switch + this partner enabled).
  process.env.CUSTOMER_PORTAL_ENABLED = '1';
  await db.execute(sql`INSERT INTO partner_portal_settings (partner_id, portal_enabled_at) VALUES ('acme', now())`);
  await createIntegrationsRepo(db).saveIntegrations('acme', {
    kyc: {},
    payment: {
      providerType: 'simulator',
      credentials: { settlementUrl: RAIL_URL, signingSecret: 'sgn_rw' },
      webhookSecret: 'whk_rw',
    },
    whatsapp: {},
  });
});

/** Writer 1: instruct → simulator rail → signed paid_out → POST /api/payment-webhook/simulator. */
async function runRailLoop(): Promise<void> {
  await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: 'rw_t1' }, { dedupeKey: 'instruct:rw_t1' });
  await drainOnce(deps(), 'w1');
  await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'rail.callback'`);
  await drainOnce(deps(), 'w2');
  await Promise.all(afterPending.splice(0));
}

describe('writer 1 — the rail callback route (/api/payment-webhook/[provider])', () => {
  it('receipts ON + verified → delivered and ONE sealed receipt, sent by the worker with the masked destination', async () => {
    await optIn();
    await createStore(redis, db).saveTransfer(transferFixture());
    await runRailLoop();
    expect(await statusOf()).toBe('delivered');
    const rows = await receiptRows();
    expect(rows.map((r) => r.dedupe_key)).toEqual(['rcpt-auto:rw_t1']);
    expect(JSON.stringify(rows[0].payload)).not.toContain(FULL_ACCOUNT);

    await drainOnce(deps(), 'w3'); // the email.send row drains through the existing path
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0][0];
    expect(msg.to).toEqual([EMAIL]);
    expect(msg.subject).toBe('Your SmartRemit transfer receipt');
    expect(msg.text).toContain('****9012');
    expect(msg.text).not.toContain(FULL_ACCOUNT);
  });

  it('a replayed paid_out callback → still ONE receipt row', async () => {
    await optIn();
    await createStore(redis, db).saveTransfer(transferFixture());
    await runRailLoop();
    // The rail retries: the callback row runs again (same signed body).
    await db.execute(sql`UPDATE outbox SET status = 'pending', next_attempt_at = now(), attempts = 0 WHERE kind = 'rail.callback'`);
    await drainOnce(deps(), 'w4');
    expect(await statusOf()).toBe('delivered');
    expect(await receiptRows()).toHaveLength(1);
  });

  it('receipts OFF → delivered, no receipt', async () => {
    await optIn(false);
    await createStore(redis, db).saveTransfer(transferFixture());
    await runRailLoop();
    expect(await statusOf()).toBe('delivered');
    expect(await receiptRows()).toHaveLength(0);
  });
});

describe('writer 2 — the worker mock.settle → completePaymentStage2 (payment.ts)', () => {
  it('receipts ON + verified → delivered and ONE sealed receipt, sent with the masked destination', async () => {
    await optIn();
    await createStore(redis, db).saveTransfer(transferFixture());
    await createOutboxRepo(db).enqueue('mock.settle', { transferId: 'rw_t1', partnerId: 'acme' }, { dedupeKey: 'mocksettle:rw_t1' });
    await drainOnce(deps(), 'w1');
    expect(await statusOf()).toBe('delivered');
    expect((await receiptRows()).map((r) => r.dedupe_key)).toEqual(['rcpt-auto:rw_t1']);
    await drainOnce(deps(), 'w2');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].text).toContain('****9012');
    expect(sendEmail.mock.calls[0][0].text).not.toContain(FULL_ACCOUNT);
  });

  it('a second mock.settle for the same transfer → still ONE receipt row', async () => {
    await optIn();
    await createStore(redis, db).saveTransfer(transferFixture());
    await createOutboxRepo(db).enqueue('mock.settle', { transferId: 'rw_t1', partnerId: 'acme' }, { dedupeKey: 'mocksettle:rw_t1' });
    await createOutboxRepo(db).enqueue('mock.settle', { transferId: 'rw_t1', partnerId: 'acme' }, { dedupeKey: 'mocksettle:rw_t1:again' });
    await drainOnce(deps(), 'w1');
    await drainOnce(deps(), 'w2');
    expect(await statusOf()).toBe('delivered');
    expect(await receiptRows()).toHaveLength(1);
  });

  it('receipts OFF → delivered, no receipt', async () => {
    await optIn(false);
    await createStore(redis, db).saveTransfer(transferFixture());
    await createOutboxRepo(db).enqueue('mock.settle', { transferId: 'rw_t1', partnerId: 'acme' }, { dedupeKey: 'mocksettle:rw_t1' });
    await drainOnce(deps(), 'w1');
    expect(await statusOf()).toBe('delivered');
    expect(await receiptRows()).toHaveLength(0);
  });

  it('a sandbox (test) transfer → delivered, no receipt, no messages', async () => {
    await optIn();
    await createStore(redis, db).saveTransfer(transferFixture({ environment: 'test' }));
    await createOutboxRepo(db).enqueue('mock.settle', { transferId: 'rw_t1', partnerId: 'acme' }, { dedupeKey: 'mocksettle:rw_t1' });
    await drainOnce(deps(), 'w1');
    expect(await statusOf()).toBe('delivered');
    expect(await receiptRows()).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });
});
