import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, paidRealMoneyTransfer, seedOriginatorForTest, seedRealMoneyRail } from './helpers-live';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { INSTRUCT_TRAVEL_RULE_DEFER_SEC } from '@/lib/instruct-errors';
import { invalidateFlagCache } from '@/lib/flags';
import type { Db } from '@/db/client';
import type { PartnerId } from '@/lib/types';

// Fix pack 5 T23 (P8 G16, P10, P22): on a real-money row the worker never
// POSTs an instruction whose travel-rule data (the sender's address, and in the
// DOB band the date of birth) is missing or cannot be sent (a routed row). G16
// raises ONE travelrule:<id> alert and defers UNCHARGED 900 s. When the band
// asks, the compliance block's originator carries `address` / `date_of_birth`.
// Demo / simulator rows see nothing new.

const seam = vi.hoisted(() => ({ exemptCalls: 0, onFileCalls: 0, onFileThrows: false, onFileForce: false, warns: [] as unknown[][] }));
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const r = real.createTransferRepo(...a);
      return {
        ...r,
        originatorExempt: async (...x: Parameters<typeof r.originatorExempt>) => {
          seam.exemptCalls += 1;
          return r.originatorExempt(...x);
        },
      };
    },
  };
});
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    createCustomerRepo: (...a: Parameters<typeof real.createCustomerRepo>) => {
      const r = real.createCustomerRepo(...a);
      return {
        ...r,
        originatorOnFile: async (...x: Parameters<typeof r.originatorOnFile>) => {
          seam.onFileCalls += 1;
          if (seam.onFileThrows) throw new RangeError('on-file read failed');
          if (seam.onFileForce) return { address: true, dateOfBirth: true };
          return r.originatorOnFile(...x);
        },
      };
    },
  };
});
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (...a: unknown[]) => {
      seam.warns.push(a);
      return (real.logWarn as (...x: unknown[]) => unknown)(...a);
    },
  };
});

const ID = 'tr_t1';
const PHONE = '15551239876';
const RAIL_URL = 'https://rail.acme-test.com/settle';
const ADDRESS = '1 Test Street, Testville';

const travelRuleText = (id: string, rail: string) =>
  `transfer ${id} (rail ${rail}) is paid but was not instructed: the travel rule needs the sender's address or date of birth, which is not on file or cannot go to a routed rail. It waits and is checked every 15 minutes. Return the sender's money with Issue refund in the dashboard (Cancel does not apply to a paid transfer).`;

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();

function deps(): WorkerDeps {
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
  };
}

type RowState = { status: string; attempts: number; last_error: string | null; backoff_s: number };
async function rowState(): Promise<RowState> {
  const r = (await db.execute(sql`
    SELECT status, attempts, last_error,
           round(extract(epoch FROM (next_attempt_at - now())))::int AS backoff_s
    FROM outbox WHERE dedupe_key = ${`instruct:${ID}`}`)) as unknown as { rows: RowState[] };
  return r.rows[0];
}
async function alerts(): Promise<Array<{ k: string; m: string }>> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k, payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ k: string; m: string }>;
  };
  return r.rows;
}
const travelAlerts = async () => (await alerts()).filter((a) => a.k.startsWith('travelrule:'));
async function railMessageCount(): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM rail_messages`)) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0].n;
}
const enqueueInstruct = () => outbox.enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });
const dueNow = () => db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
const dobOnFile = async (): Promise<string> => new Date(Date.now() - 40 * 365.25 * 86_400_000).toISOString().slice(0, 10);

function expectDeferred(st: RowState) {
  expect(st).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  expect(st.backoff_s).toBeGreaterThanOrEqual(INSTRUCT_TRAVEL_RULE_DEFER_SEC - 5);
  expect(st.backoff_s).toBeLessThanOrEqual(INSTRUCT_TRAVEL_RULE_DEFER_SEC + 5);
}
type Body = { compliance: { version: number; originator: Record<string, unknown> | null } };
function postedBody(): Body {
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const [url, init] = fetchFn.mock.calls[0] as [string, { body: string }];
  expect(url).toBe(RAIL_URL);
  return JSON.parse(init.body) as Body;
}

beforeEach(async () => {
  seam.exemptCalls = 0;
  seam.onFileCalls = 0;
  seam.onFileThrows = false;
  seam.onFileForce = false;
  seam.warns = [];
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  await seedRealMoneyRail(db, 'acme');
  await certifyPartnerForTest(db, 'acme');
  fetchFn.mockReset();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
});
afterEach(() => invalidateFlagCache(db));

describe('settlement.instruct travel_rule gate G16 (pack 5 T23)', { retry: 0 }, () => {
  it('real money, no address on file: no POST, no rail_messages row, ONE travelrule:<id> alert (ids only), deferred 900 s uncharged; a second drain adds no alert', async () => {
    await paidRealMoneyTransfer(db, { id: ID });
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ failed: 0, dead: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await railMessageCount()).toBe(0);
    expectDeferred(await rowState());
    expect(await travelAlerts()).toEqual([{ k: `travelrule:${ID}`, m: travelRuleText(ID, 'acme') }]);
    await dueNow();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expectDeferred(await rowState());
    expect(await travelAlerts()).toHaveLength(1);
  });

  it('a routed real-money row (rail certified, address on file) is deferred the same way: the data cannot go to another tenant\'s rail', async () => {
    await seedPartner(db, 'railp');
    await seedRealMoneyRail(db, 'railp', { url: 'https://railp.acme-test.com/settle' });
    await certifyPartnerForTest(db, 'railp');
    await paidRealMoneyTransfer(db, { id: ID, routedVia: 'railp', originator: { address: true, dob: true } });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await railMessageCount()).toBe(0);
    expectDeferred(await rowState());
    expect(await travelAlerts()).toEqual([{ k: `travelrule:${ID}`, m: travelRuleText(ID, 'railp') }]);
  });

  it('DOB band ($1,500 to DE) with an address but no DOB: deferred', async () => {
    await paidRealMoneyTransfer(db, { id: ID, amountUsd: 1500, destinationCountry: 'DE', originator: { address: true } });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expectDeferred(await rowState());
    expect((await travelAlerts()).map((a) => a.k)).toEqual([`travelrule:${ID}`]);
  });

  it('DOB band with address and DOB on file: POSTed; originator.address and .date_of_birth are the stored values; version 2', async () => {
    await paidRealMoneyTransfer(db, { id: ID, amountUsd: 1500, destinationCountry: 'DE', originator: { address: true, dob: true } });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    const body = postedBody();
    expect(body.compliance.version).toBe(2);
    expect(body.compliance.originator?.address).toBe(ADDRESS);
    expect(body.compliance.originator?.date_of_birth).toBe(await dobOnFile());
    expect((await rowState()).status).toBe('done');
    expect(await travelAlerts()).toEqual([]);
  });

  it('$200 to IN with an address on file: POSTed with originator.address and NO date_of_birth key (even with one on file)', async () => {
    await paidRealMoneyTransfer(db, { id: ID, originator: { address: true, dob: true } });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    const o = postedBody().compliance.originator!;
    expect(o.address).toBe(ADDRESS);
    expect('date_of_birth' in o).toBe(false);
    expect(Object.keys(o)).toEqual(['entity_type', 'name', 'country', 'phone', 'id_type', 'id_last4', 'address']);
  });

  it('an exempt Partner-API row with nothing on file: not deferred, no address key, no travelrule alert', async () => {
    await paidRealMoneyTransfer(db, { id: ID });
    await createIdempotencyRepo(db).claim('acme' as PartnerId, 'order-1', ID);
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    const o = postedBody().compliance.originator!;
    expect('address' in o).toBe(false);
    expect('date_of_birth' in o).toBe(false);
    expect(await travelAlerts()).toEqual([]);
  });

  it('an exempt Partner-API row with an address the API stored: the key is sent', async () => {
    await paidRealMoneyTransfer(db, { id: ID, originator: { address: true } });
    await createIdempotencyRepo(db).claim('acme' as PartnerId, 'order-1', ID);
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(postedBody().compliance.originator?.address).toBe(ADDRESS);
  });

  it('a business-sender b2c real-money row with an address on file is POSTed: no customer fields on a business originator, no defence-check hold', async () => {
    await paidRealMoneyTransfer(db, { id: ID, originator: { address: true, dob: true } });
    await db.execute(sql`UPDATE transfers SET sender_entity_type = 'business' WHERE id = ${ID}`);
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    const o = postedBody().compliance.originator!;
    expect(o.entity_type).toBe('business');
    expect('address' in o).toBe(false);
    expect('date_of_birth' in o).toBe(false);
    expect(await travelAlerts()).toEqual([]);
    expect((await rowState()).status).toBe('done');
  });

  it('the defence check: the read says on file but the built block lacks the address (a race) -> deferred the same way', async () => {
    await paidRealMoneyTransfer(db, { id: ID });
    await enqueueInstruct();
    seam.onFileForce = true;
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await railMessageCount()).toBe(0);
    expectDeferred(await rowState());
    expect(await travelAlerts()).toEqual([{ k: `travelrule:${ID}`, m: travelRuleText(ID, 'acme') }]);
  });

  it('the defence check in the DOB band: address built but no date_of_birth -> deferred', async () => {
    await paidRealMoneyTransfer(db, { id: ID, amountUsd: 3500, originator: { address: true } });
    await enqueueInstruct();
    seam.onFileForce = true;
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expectDeferred(await rowState());
    expect((await travelAlerts()).map((a) => a.k)).toEqual([`travelrule:${ID}`]);
  });

  it('the exemption is read once per drain on real money', async () => {
    await paidRealMoneyTransfer(db, { id: ID, originator: { address: true } });
    await enqueueInstruct();
    seam.exemptCalls = 0;
    await drainOnce(deps(), 'w1');
    expect(postedBody().compliance.originator?.address).toBe(ADDRESS);
    expect(seam.exemptCalls).toBe(1);
  });

  it('the travel-rule read throws: charged retry (plain), no travelrule alert, no POST', async () => {
    await paidRealMoneyTransfer(db, { id: ID, originator: { address: true } });
    await enqueueInstruct();
    seam.onFileThrows = true;
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await travelAlerts()).toEqual([]);
  });

  it('a simulator rail: no travel-rule read, no originator.address even with one on file', async () => {
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' },
      whatsapp: {},
    });
    await paidRealMoneyTransfer(db, { id: ID, amountUsd: 1500, destinationCountry: 'DE', originator: { address: true, dob: true } });
    await enqueueInstruct();
    seam.exemptCalls = 0;
    seam.onFileCalls = 0;
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, { body: string }])[1].body) as Body;
    expect(Object.keys(body.compliance.originator!)).toEqual(['entity_type', 'name', 'country', 'phone', 'id_type', 'id_last4']);
    expect(seam.exemptCalls).toBe(0);
    expect(seam.onFileCalls).toBe(0);
    expect(await travelAlerts()).toEqual([]);
  });

  it('a sandbox (test) row on the real-money rail: no travel-rule read, never instructed (unchanged)', async () => {
    await paidRealMoneyTransfer(db, { id: ID });
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${ID}`);
    await enqueueInstruct();
    seam.exemptCalls = 0;
    seam.onFileCalls = 0;
    await drainOnce(deps(), 'w1');
    expect(seam.exemptCalls).toBe(0);
    expect(seam.onFileCalls).toBe(0);
    expect(await travelAlerts()).toEqual([]);
  });

  it('the alert, the log lines and outbox.last_error never contain the address, the DOB or the phone', async () => {
    // Deferred row (DOB missing): alert + log written.
    await paidRealMoneyTransfer(db, { id: ID, amountUsd: 3500, originator: { address: true } });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(await travelAlerts()).toHaveLength(1);
    const dob = await dobOnFile();
    const lastErr = (await db.execute(sql`SELECT coalesce(string_agg(last_error, '|'), '') AS e FROM outbox`)) as unknown as { rows: Array<{ e: string }> };
    const texts = [JSON.stringify(seam.warns), JSON.stringify(await alerts()), lastErr.rows[0].e];
    for (const s of texts) for (const pii of [ADDRESS, 'Test Street', dob, PHONE]) expect(s).not.toContain(pii);
    expect(seam.warns.some((w) => w[0] === 'outbox.instruct-travel-rule')).toBe(true);
  });

  it('an originator on file for a DIFFERENT phone of the tenant does not count for this sender', async () => {
    // A seeded originator for a DIFFERENT phone does not count for this sender.
    await seedOriginatorForTest(db, 'acme', '15550000000', { address: true, dob: true });
    await paidRealMoneyTransfer(db, { id: ID });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await travelAlerts()).map((a) => a.k)).toEqual([`travelrule:${ID}`]);
  });
});
