import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, seedRealMoneyRail, seedOriginatorForTest, seedSettleRecordForTest } from './helpers-live';
import { createOutboxRepo, MAX_ATTEMPTS } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { railBodySha256 } from '@/db/repos/rail-message-repo';
import { issueRefund, approveRefund } from '@/lib/dashboard-ops';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { ctx } from '@/lib/crypto-context';
import { decryptField, defaultProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T15 (P15, P5, P4): inside funding.refund a real-money row is
// never "refunded" by the mock provider. The rail is read FIRST (a failed read
// retries, never falls into the mock); a real-money PARTNER-COLLECTED row gets
// a SIGNED, RECORDED reverse with funding.method 'partner_collected'; a
// real-money MOCK-class row moves nothing and closes as nofunds-<id> with no
// customer message. Simulator, mock and sandbox refunds are unchanged.

const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return { ...real, logWarn: (...a: Parameters<typeof real.logWarn>) => { logWarnSpy(...a); return real.logWarn(...a); } };
});

const railFault = vi.hoisted(() => ({ throws: false, calls: 0 }));
vi.mock('@/db/repos/integrations-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...a: Parameters<typeof real.createIntegrationsRepo>) => {
      const repo = real.createIntegrationsRepo(...a);
      return {
        ...repo,
        getIntegrations: async (...g: Parameters<typeof repo.getIntegrations>) => {
          railFault.calls++;
          if (railFault.throws) throw Object.assign(new Error('rail read down'), { name: 'NeonDbError' });
          return repo.getIntegrations(...g);
        },
      };
    },
  };
});

const ID = 'rm_r1';
const ACCOUNT = '123456789012';

function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: `${ACCOUNT}|HDFC0001234`, fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    refundStatus: 'pending',
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();
const providerRefund = vi.fn(async (t: Transfer) => ({ refundRef: `mockrefund-${t.id}` }));
let rowsAtFetch: number[] = [];

function deps(o: { injectProvider?: boolean } = {}): WorkerDeps {
  return {
    db,
    store,
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
    ...(o.injectProvider === false
      ? {}
      : {
          fundingProvider: {
            capture: async (t: Transfer) => ({ fundingRef: `mockfund-${t.id}` }),
            refund: providerRefund,
            handleWebhook: async () => null,
          },
        }),
  };
}

type RecRow = {
  id: string; partner_id: string | null; rail_partner_id: string | null; transfer_id: string | null;
  direction: number; kind: string; body_enc: string; body_sha256: string; signature_header: string | null;
};
async function records(): Promise<RecRow[]> {
  return ((await db.execute(sql`SELECT * FROM rail_messages ORDER BY created_at, id`)) as unknown as { rows: RecRow[] }).rows;
}
async function countRecords(): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM rail_messages`)) as unknown as { rows: Array<{ n: number }> };
  return Number(r.rows[0].n);
}
const open = (r: RecRow) => decryptField(r.body_enc, defaultProvider(), ctx.railMessage(r.id, 1, 'reverse'));
type RowState = { id: number; status: string; attempts: number; last_error: string | null };
async function refundRow(): Promise<RowState> {
  const r = (await db.execute(sql`SELECT id, status, attempts, last_error FROM outbox WHERE kind = 'funding.refund' ORDER BY id LIMIT 1`)) as unknown as { rows: RowState[] };
  return r.rows[0];
}
async function dedupeKeys(kind: string): Promise<string[]> {
  const r = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = ${kind} ORDER BY id`)) as unknown as { rows: Array<{ dedupe_key: string }> };
  return r.rows.map((x) => x.dedupe_key);
}
// Review round 1 RC2: the settle record of this row, for a rail partner, agoMs before now.
const seedSettle = (o: { id?: string; owner?: string; rail?: string; agoMs?: number } = {}) =>
  seedSettleRecordForTest(db, { transferId: o.id ?? ID, partnerId: o.owner ?? 'acme', railPartnerId: o.rail ?? 'acme', agoMs: o.agoMs });
async function reverseRecords(): Promise<RecRow[]> {
  return (await records()).filter((r) => r.kind === 'reverse');
}
async function alertKeys(): Promise<string[]> {
  return dedupeKeys('ops.alert');
}
async function alertMessages(): Promise<string[]> {
  const r = (await db.execute(sql`SELECT payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as { rows: Array<{ payload: { message: string } }> };
  return r.rows.map((x) => x.payload.message);
}
const enqueueRefund = (key = `refund:${ID}`) => outbox.enqueue('funding.refund', { transferId: ID }, { dedupeKey: key });
const ok = (providerRef = 'rev-1') => new Response(JSON.stringify({ providerRef }), { status: 200 });

beforeEach(async () => {
  railFault.throws = false;
  railFault.calls = 0;
  rowsAtFetch = [];
  logWarnSpy.mockClear();
  providerRefund.mockClear();
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  await certifyPartnerForTest(db, 'acme');
  await seedRealMoneyRail(db, 'acme');
  // Fix pack 5 T20a (P0 rule 9): the sender's travel-rule data on file, ahead of the T20b/T23 gates.
  await seedOriginatorForTest(db, 'acme', '15551230000', { address: true, dob: true });
  fetchFn.mockReset();
  fetchFn.mockImplementation(async () => {
    rowsAtFetch.push(await countRecords());
    return ok();
  });
});

describe('funding.refund on a real-money rail: partner-collected row (P15 step 5)', { retry: 0 }, () => {
  it("one signed POST to the stored URL: action 'reverse', reference 'reverse-<id>', funding partner_collected/null, partner_id = rail; completed with the providerRef; refundmsg queued; the mock provider never called", async () => {
    await store.saveTransfer(transferFixture());
    await seedSettle();
    await enqueueRefund();
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://rail.acme-test.com/settle');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      action: 'reverse',
      reference: `reverse-${ID}`,
      partner_id: 'acme',
      funding: { method: 'partner_collected', token: null },
      amount: { source: 200, currency: 'USD' },
    });
    expect(init.headers['x-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(init.headers['x-smartremit-signature']).toBeTruthy();
    const t = (await store.getTransfer(ID))!;
    expect(t.refundStatus).toBe('completed');
    expect(t.refundRef).toBe('rev-1');
    expect(await dedupeKeys('whatsapp.text')).toEqual([`refundmsg:${ID}`]);
    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('the reverse is recorded before the POST: the sealed body equals the POSTed bytes', async () => {
    await store.saveTransfer(transferFixture());
    await seedSettle();
    await enqueueRefund();
    await drainOnce(deps(), 'w1');
    expect(rowsAtFetch).toEqual([2]); // the seeded settle + the reverse
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    const [r] = await reverseRecords();
    expect(r).toMatchObject({ partner_id: 'acme', rail_partner_id: 'acme', transfer_id: ID, kind: 'reverse' });
    expect(Number(r.direction)).toBe(1);
    expect(open(r)).toBe(init.body);
    expect(r.body_sha256).toBe(railBodySha256(String(init.body)));
    expect(r.signature_header).toBe(init.headers['x-smartremit-signature']);
  });

  it('routed (review round 1 RF1): NO reverse to the settlement rail, no record, refund stays pending, no refundmsg, ONE refundrouted:<id> alert (ids only); a re-drain adds nothing', async () => {
    await seedPartner(db, 'railp');
    await certifyPartnerForTest(db, 'railp');
    await seedRealMoneyRail(db, 'railp', { url: 'https://railp.example/settle', signingSecret: 'rail-secret' });
    // The owner's own rail is a mock: the rail that matters is the settlement partner's.
    await createIntegrationsRepo(db).saveIntegrations('acme', { kyc: {}, whatsapp: {}, payment: { providerType: 'mock' } });
    await store.saveTransfer(transferFixture({ settlementPartnerId: 'railp' }));
    await seedSettle({ rail: 'railp' });
    await enqueueRefund();
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await reverseRecords()).toEqual([]);
    expect(providerRefund).not.toHaveBeenCalled();
    const t = (await store.getTransfer(ID))!;
    expect(t.refundStatus).toBe('pending');
    expect(t.refundRef).toBeUndefined();
    expect(await dedupeKeys('whatsapp.text')).toEqual([]);
    expect(await alertKeys()).toEqual([`refundrouted:${ID}`]);
    const [msg] = await alertMessages();
    expect(msg).toContain(ID);
    expect(msg).toContain('a person must arrange the return with the owner partner');
    for (const leak of [ACCOUNT, 'Anita', '15551230000', '200']) expect(msg).not.toContain(leak);
    await enqueueRefund(`refund:${ID}:retry:1`);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await alertKeys()).toEqual([`refundrouted:${ID}`]);
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');
  });

  it('a non-2xx reverse: refund stays pending, the row fails (default policy) and retries; dead at MAX_ATTEMPTS with dead:<id>', async () => {
    fetchFn.mockReset();
    fetchFn.mockImplementation(async () => new Response('no', { status: 500 }));
    await store.saveTransfer(transferFixture());
    await seedSettle();
    await enqueueRefund();
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(await refundRow()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'Reverse instruction rejected (500)' });
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');
    await db.execute(sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now() WHERE kind = 'funding.refund'`);
    expect((await drainOnce(deps(), 'w1')).dead).toBe(1);
    const row = await refundRow();
    expect(row.status).toBe('dead');
    expect(await dedupeKeys('ops.alert')).toContain(`dead:${row.id}`);
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');
    expect(await dedupeKeys('whatsapp.text')).toEqual([]);
  });

  it('no signing secret: no fetch, no record, UnsignedRailError in last_error, refund pending', async () => {
    await seedRealMoneyRail(db, 'acme', { signingSecret: null });
    await store.saveTransfer(transferFixture());
    await seedSettle();
    await enqueueRefund();
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await reverseRecords()).toEqual([]);
    expect(await refundRow()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'no_signing_secret' });
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');
    expect(providerRefund).not.toHaveBeenCalled();
  });
});

describe('funding.refund: the rail read comes first (P15 step 3)', { retry: 0 }, () => {
  it('the rail read throws: the row fails, refund pending, the mock provider is NEVER called, no refundmsg', async () => {
    await store.saveTransfer(transferFixture({ fundingRef: 'mockfund-x' }));
    railFault.throws = true;
    await enqueueRefund();
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(providerRefund).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');
    expect(await refundRow()).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await dedupeKeys('whatsapp.text')).toEqual([]);
  });
});

describe('funding.refund on a real-money rail: mock-class row (P15 step 6)', { retry: 0 }, () => {
  for (const variant of ['funding_provider mock', 'NULL provider with a mockfund ref'] as const) {
    it(`${variant}: no POST, no provider refund, no record; completed as nofunds-<id>, NO refundmsg, one outbox.refund-nofunds warn; a re-drain is a no-op`, async () => {
      await store.saveTransfer(transferFixture({ fundingRef: 'mockfund-x' }));
      if (variant === 'funding_provider mock') await db.execute(sql`UPDATE transfers SET funding_provider = 'mock' WHERE id = ${ID}`);
      else await db.execute(sql`UPDATE transfers SET funding_provider = NULL WHERE id = ${ID}`);
      await enqueueRefund();
      expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(providerRefund).not.toHaveBeenCalled();
      expect(await countRecords()).toBe(0);
      const t = (await store.getTransfer(ID))!;
      expect(t.refundStatus).toBe('completed');
      expect(t.refundRef).toBe(`nofunds-${ID}`);
      expect(t.refundRef).not.toMatch(/^mockrefund-/);
      expect(await dedupeKeys('whatsapp.text')).toEqual([]);
      const warns = logWarnSpy.mock.calls.filter((c) => c[0] === 'outbox.refund-nofunds');
      expect(warns).toHaveLength(1);
      expect(warns[0][2]).toEqual({ transferId: ID });

      await enqueueRefund(`refund:${ID}:retry:1`);
      expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
      expect(logWarnSpy.mock.calls.filter((c) => c[0] === 'outbox.refund-nofunds')).toHaveLength(1);
      expect((await store.getTransfer(ID))!.refundRef).toBe(`nofunds-${ID}`);
    });
  }
});

describe('funding.refund: other classes unchanged', { retry: 0 }, () => {
  it('a real-money Stripe row: refundProviderFor (fails, no fake completion)', async () => {
    await store.saveTransfer(transferFixture({ fundingRef: 'pi_x' }));
    await db.execute(sql`UPDATE transfers SET funding_provider = 'stripe', funding_intent_ref = 'pi_x', funding_state = 'succeeded' WHERE id = ${ID}`);
    await enqueueRefund();
    expect((await drainOnce(deps({ injectProvider: false }), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    const t = (await store.getTransfer(ID))!;
    expect(t.refundStatus).toBe('pending');
    expect(t.refundRef).toBeUndefined();
    expect(await dedupeKeys('whatsapp.text')).toEqual([]);
  });

  it('a simulator rail, mock-funded row: mockrefund-<id> as today (demo unchanged), with its refundmsg', async () => {
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {}, whatsapp: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sim' }, webhookSecret: 'simw' },
    });
    await store.saveTransfer(transferFixture({ fundingRef: 'mockfund-x' }));
    await db.execute(sql`UPDATE transfers SET funding_provider = 'mock' WHERE id = ${ID}`);
    await enqueueRefund();
    expect((await drainOnce(deps({ injectProvider: false }), 'w1')).processed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    const t = (await store.getTransfer(ID))!;
    expect(t.refundStatus).toBe('completed');
    expect(t.refundRef).toBe(`mockrefund-${ID}`);
    expect(await dedupeKeys('whatsapp.text')).toEqual([`refundmsg:${ID}`]);
  });

  it('a sandbox row: sandbox-reverse-<id> with NO rail read', async () => {
    await store.saveTransfer(transferFixture({ fundingRef: 'mockfund-x' }));
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${ID}`);
    await enqueueRefund();
    railFault.calls = 0;
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(railFault.calls).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await store.getTransfer(ID))!.refundRef).toBe(`sandbox-reverse-${ID}`);
  });
});

describe('funding.refund: no PII in logs or last_error', { retry: 0 }, () => {
  it('no log line or last_error carries the account digits or a name', async () => {
    fetchFn.mockReset();
    fetchFn.mockImplementation(async () => new Response('no', { status: 502 }));
    await store.saveTransfer(transferFixture());
    await seedSettle();
    await enqueueRefund();
    await drainOnce(deps(), 'w1');
    // and a mock-class nofunds close on a second row
    await store.saveTransfer(transferFixture({ id: 'rm_r2', fundingRef: 'mockfund-y' }));
    await db.execute(sql`UPDATE transfers SET funding_provider = 'mock' WHERE id = 'rm_r2'`);
    await outbox.enqueue('funding.refund', { transferId: 'rm_r2' }, { dedupeKey: 'refund:rm_r2' });
    await drainOnce(deps(), 'w1');
    const logged = JSON.stringify(logWarnSpy.mock.calls);
    const errs = JSON.stringify((await db.execute(sql`SELECT last_error FROM outbox`)) as unknown);
    for (const leak of [ACCOUNT, 'Anita', '15551230000']) {
      expect(logged).not.toContain(leak);
      expect(errs).not.toContain(leak);
    }
  });
});

// Review round 1 RC2: a row settled in the demo era (simulator rail, or a settle
// record older than the rail partner's go-live) and refunded after the partner
// went live gets NO reverse: it closes as nofunds-<id> with one
// refundnosettle:<id> alert and no customer message.
describe('funding.refund: a partner-collected reverse only for a settle sent to this rail after go-live (review round 1 RC2)', { retry: 0 }, () => {
  async function simulatorRail(): Promise<void> {
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {}, whatsapp: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sim' }, webhookSecret: 'simw' },
    });
  }
  async function expectClosedNoSettle(): Promise<void> {
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await reverseRecords()).toEqual([]);
    expect(providerRefund).not.toHaveBeenCalled();
    const t = (await store.getTransfer(ID))!;
    expect(t.refundStatus).toBe('completed');
    expect(t.refundRef).toBe(`nofunds-${ID}`);
    expect(await dedupeKeys('whatsapp.text')).toEqual([]);
    expect(await alertKeys()).toEqual([`refundnosettle:${ID}`]);
    const [msg] = await alertMessages();
    expect(msg).toContain(ID);
    expect(msg).toContain('no settle instruction went to this rail after it went live');
    expect(msg).toContain('the partner must return the money outside SmartRemit');
    for (const leak of [ACCOUNT, 'Anita', '15551230000', '200']) expect(msg).not.toContain(leak);
    const warns = logWarnSpy.mock.calls.filter((c) => c[0] === 'outbox.refund-nosettle');
    expect(warns).toHaveLength(1);
    expect(warns[0][2]).toEqual({ transferId: ID });
  }

  it('settled on a simulator rail (no settle record), the rail becomes real money, the customer refund is approved: no POST, nofunds-<id>, one refundnosettle:<id>', async () => {
    await simulatorRail();
    await store.saveTransfer(transferFixture({ status: 'delivered', refundStatus: 'requested' }));
    await seedRealMoneyRail(db, 'acme');
    await approveRefund(db, ID);
    expect((await drainOnce(deps(), 'w1')).processed).toBeGreaterThanOrEqual(1);
    await expectClosedNoSettle();
  });

  it('a settle record OLDER than the go-live (the simulator era): no POST, nofunds-<id>, one refundnosettle:<id>', async () => {
    await store.saveTransfer(transferFixture());
    await seedSettle({ agoMs: 2 * 3_600_000 });
    await enqueueRefund();
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    await expectClosedNoSettle();
  });

  it("a settle record for ANOTHER rail partner does not count", async () => {
    await store.saveTransfer(transferFixture());
    await seedSettle({ rail: 'default' });
    await enqueueRefund();
    await drainOnce(deps(), 'w1');
    await expectClosedNoSettle();
  });

  it('issueRefund refuses the demo-era row (no settle record after go-live), as before pack 5, and enqueues nothing', async () => {
    await store.saveTransfer(transferFixture({ refundStatus: 'none' }));
    await expect(issueRefund(db, ID)).rejects.toThrow('never charged');
    await seedSettle({ agoMs: 2 * 3_600_000 });
    await expect(issueRefund(db, ID)).rejects.toThrow('never charged');
    expect(await dedupeKeys('funding.refund')).toEqual([]);
  });

  it('positive: a settle recorded after go-live; issueRefund admits it and carries collectedOnRealMoney; ONE signed reverse', async () => {
    await store.saveTransfer(transferFixture({ refundStatus: 'none' }));
    await seedSettle();
    await issueRefund(db, ID);
    const r = (await db.execute(sql`SELECT payload FROM outbox WHERE kind = 'funding.refund'`)) as unknown as { rows: Array<{ payload: unknown }> };
    expect(r.rows.map((x) => x.payload)).toEqual([{ transferId: ID, collectedOnRealMoney: true }]);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await reverseRecords()).toHaveLength(1);
    expect((await store.getTransfer(ID))!.refundStatus).toBe('completed');
    expect(await alertKeys()).toEqual([]);
  });

  it('a failed settle-record read throws (retry), never falls through: no POST, refund pending', async () => {
    await store.saveTransfer(transferFixture());
    await seedSettle();
    await enqueueRefund();
    await db.execute(sql`ALTER TABLE rail_messages RENAME TO rail_messages_gone`);
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    await db.execute(sql`ALTER TABLE rail_messages_gone RENAME TO rail_messages`);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');
    expect(await dedupeKeys('whatsapp.text')).toEqual([]);
    expect(await alertKeys()).toEqual([]);
  });
});

// Review round 1 RC3: the issue-time real-money decision rides the payload; a
// rail that is no longer real money at the drain never sends it down the mock.
describe('funding.refund: collectedOnRealMoney in the payload (review round 1 RC3)', { retry: 0 }, () => {
  it('issueRefund on a real-money partner-collected row, then the rail switches to simulator: the row fails, never mockrefund-, refund pending, no refundmsg', async () => {
    await store.saveTransfer(transferFixture({ refundStatus: 'none' }));
    await seedSettle();
    await issueRefund(db, ID);
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {}, whatsapp: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sim' }, webhookSecret: 'simw' },
    });
    expect((await drainOnce(deps({ injectProvider: false }), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    const t = (await store.getTransfer(ID))!;
    expect(t.refundRef ?? '').not.toBe(`mockrefund-${ID}`);
    expect(t.refundStatus).toBe('pending');
    expect(await dedupeKeys('whatsapp.text')).toEqual([]);
    expect((await refundRow()).last_error).toBe('refund_collected_on_real_money_rail_not_real_money');
  });

  it('a payload without the field on a simulator rail keeps today: mockrefund-<id> with its refundmsg', async () => {
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {}, whatsapp: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sim' }, webhookSecret: 'simw' },
    });
    await store.saveTransfer(transferFixture());
    await enqueueRefund();
    expect((await drainOnce(deps({ injectProvider: false }), 'w1')).processed).toBe(1);
    expect((await store.getTransfer(ID))!.refundRef).toBe(`mockrefund-${ID}`);
    expect(await dedupeKeys('whatsapp.text')).toEqual([`refundmsg:${ID}`]);
  });
});

// Review round 1 RF1: issueRefund refuses a routed partner-collected row.
describe('issueRefund: a routed partner-collected row is refused (review round 1 RF1)', { retry: 0 }, () => {
  it('routed to a real-money rail with a settle record after go-live: refused, nothing enqueued', async () => {
    await seedPartner(db, 'railp');
    await certifyPartnerForTest(db, 'railp');
    await seedRealMoneyRail(db, 'railp', { url: 'https://railp.example/settle', signingSecret: 'rail-secret' });
    await store.saveTransfer(transferFixture({ settlementPartnerId: 'railp', refundStatus: 'none' }));
    await seedSettle({ rail: 'railp' });
    await expect(issueRefund(db, ID)).rejects.toThrow('never charged');
    expect(await dedupeKeys('funding.refund')).toEqual([]);
  });
});
