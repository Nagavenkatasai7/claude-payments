import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createOutboxRepo, INSTRUCT_MAX_ATTEMPTS } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createTransferRepo, TransferDecryptError } from '@/db/repos/transfer-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import {
  ComplianceBlockUnavailableError,
  INSTRUCT_FUNDING_MODE_DEFER_SEC,
  INSTRUCT_TRAVEL_RULE_DEFER_SEC,
  InstructFundingModeError,
  InstructPermanentError,
  InstructTravelRuleError,
  RailRecordError,
  railRecordAlertKey,
} from '@/lib/instruct-errors';
import { invalidateFlagCache } from '@/lib/flags';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T4 (P7, P8 G1 + the builder half of G15): drainOnce's
// dispositions for the pack's instruct error classes, each thrown from INSIDE
// the real settlement.instruct handler (the seams below), on a simulator rail
// that holds both secrets (not real money: G10-G13 never fire).

const seam = vi.hoisted(() => ({
  blockErr: null as unknown,
  readErr: null as unknown,
}));

// The compliance block load is the throw point for every class (T5/T6/T9/T14/T23
// throw them from their own gates later; the disposition is the same).
vi.mock('@/lib/instruction-compliance', async (orig) => {
  const real = await orig<typeof import('@/lib/instruction-compliance')>();
  return {
    ...real,
    loadComplianceBlock: (...a: Parameters<typeof real.loadComplianceBlock>) =>
      seam.blockErr ? Promise.reject(seam.blockErr) : real.loadComplianceBlock(...a),
  };
});

// G1: the FOR UPDATE read throws once (then reads as usual).
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const r = real.createTransferRepo(...a);
      return {
        ...r,
        getTransferForUpdate: async (...g: Parameters<typeof r.getTransferForUpdate>) => {
          if (seam.readErr) {
            const e = seam.readErr;
            seam.readErr = null;
            throw e;
          }
          return r.getTransferForUpdate(...g);
        },
      };
    },
  };
});

const logs = vi.hoisted(() => ({ warn: [] as unknown[][] }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (...a: unknown[]) => {
      logs.warn.push(a);
      return (real.logWarn as (...x: unknown[]) => unknown)(...a);
    },
  };
});

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const ID = 'disp_t1';
const H = 3_600_000;

function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - H).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();

function deps(overrideDb?: Db): WorkerDeps {
  return {
    db: overrideDb ?? db,
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

async function saveSimulatorRail(partnerId: string) {
  await createIntegrationsRepo(db, provider).saveIntegrations(partnerId, {
    kyc: {},
    payment: { providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' },
    whatsapp: {},
  });
}

type RowState = { id: number; status: string; attempts: number; last_error: string | null; backoff_s: number };
async function rowState(key = `instruct:${ID}`): Promise<RowState> {
  const r = (await db.execute(sql`
    SELECT id, status, attempts, last_error,
           round(extract(epoch FROM (next_attempt_at - now())))::int AS backoff_s
    FROM outbox WHERE dedupe_key = ${key}`)) as unknown as { rows: RowState[] };
  return r.rows[0];
}
async function alerts(): Promise<Array<{ k: string; m: string }>> {
  const r = (await db.execute(
    sql`SELECT dedupe_key AS k, payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert' ORDER BY id`,
  )) as unknown as { rows: Array<{ k: string; m: string }> };
  return r.rows;
}
const keys = async () => (await alerts()).map((a) => a.k);
const enqueueInstruct = (id = ID) => outbox.enqueue('settlement.instruct', { transferId: id }, { dedupeKey: `instruct:${id}` });
/** Run the instruct row as attempt `n` (claim increments attempts). */
const drainAt = async (n: number, key = `instruct:${ID}`) => {
  await db.execute(sql`UPDATE outbox SET attempts = ${n - 1}, next_attempt_at = now(), status = 'pending' WHERE dedupe_key = ${key}`);
  return drainOnce(deps(), 'w1');
};

beforeEach(async () => {
  seam.blockErr = null;
  seam.readErr = null;
  logs.warn = [];
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  await saveSimulatorRail('acme');
  fetchFn.mockReset();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
  await store.saveTransfer(transferFixture());
});
afterEach(() => {
  vi.useRealTimers();
  invalidateFlagCache(db);
});

describe('instruct dispositions: the baseline', { retry: 0 }, () => {
  it('a valid row on the simulator rail is POSTed and done (the seams are transparent)', async () => {
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 1, failed: 0, dead: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await rowState()).status).toBe('done');
  });
});

describe('instruct dispositions: uncharged defers (G14b, G16)', { retry: 0 }, () => {
  for (const [label, make, delay] of [
    ['InstructFundingModeError', () => new InstructFundingModeError(), INSTRUCT_FUNDING_MODE_DEFER_SEC],
    ['InstructTravelRuleError', () => new InstructTravelRuleError(), INSTRUCT_TRAVEL_RULE_DEFER_SEC],
  ] as const) {
    it(`${label} -> deferred uncharged ~900 s: attempts 0, pending, no fetch, no alert`, async () => {
      seam.blockErr = make();
      await enqueueInstruct();
      const r = await drainOnce(deps(), 'w1');
      expect(r).toMatchObject({ processed: 0, failed: 0, dead: 0, released: 1 });
      expect(fetchFn).not.toHaveBeenCalled();
      const st = await rowState();
      expect(st).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
      expect(delay).toBe(900);
      expect(st.backoff_s).toBeGreaterThanOrEqual(delay - 5);
      expect(st.backoff_s).toBeLessThanOrEqual(delay + 5);
      expect(await alerts()).toEqual([]);
    });
  }
});

describe('instruct dispositions: ComplianceBlockUnavailableError (G15 transient)', { retry: 0 }, () => {
  it('charged retry; attempts 1-2 no alert; attempt 3 ONE instructblock alert; a second row adds none; never railfail', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    seam.blockErr = new ComplianceBlockUnavailableError(ID, 'acme');
    await enqueueInstruct();
    let r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ failed: 1, dead: 0 });
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1, last_error: `compliance_block_unavailable:${ID}` });
    expect(fetchFn).not.toHaveBeenCalled();
    await drainAt(2);
    expect(await alerts()).toEqual([]);
    await drainAt(3);
    const hour = Math.floor(Date.now() / H);
    const a = await alerts();
    expect(a.map((x) => x.k)).toEqual([`instructblock:acme:${hour}`]);
    expect(a[0].m).toBe(
      `⚠️ SmartRemit ops: settlement instructions for rail acme are waiting: the compliance block could not be read ` +
        `(transfer ${ID}, attempt 3 of ${INSTRUCT_MAX_ATTEMPTS}; a database, network or key-configuration error). ` +
        'Nothing was sent. They keep retrying for about a day, then dead-letter (partner Replay / ops Retry). ' +
        'Further failures on this rail this hour are coalesced into this alert.',
    );
    expect(a[0].m).not.toContain('123456789012');

    // A second row on the same rail this hour adds none.
    await store.saveTransfer(transferFixture({ id: 'disp_t2' }));
    await enqueueInstruct('disp_t2');
    seam.blockErr = new ComplianceBlockUnavailableError('disp_t2', 'acme');
    r = await drainAt(4, 'instruct:disp_t2');
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect((await keys()).filter((k) => k.startsWith('instructblock:'))).toEqual([`instructblock:acme:${hour}`]);
    expect((await keys()).some((k) => k.startsWith('railfail:'))).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('instruct dispositions: RailRecordError (G17)', { retry: 0 }, () => {
  it('charged retry under the instruct policy; one railrecord alert; dead at the ceiling with dead:<id> too; never railfail', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    seam.blockErr = new RailRecordError(ID);
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    const st = await rowState();
    expect(st).toMatchObject({ status: 'failed', attempts: 1, last_error: `rail_record_failed:${ID}` });
    const a = await alerts();
    expect(a.map((x) => x.k)).toEqual([railRecordAlertKey()]);
    expect(a[0].m).toBe(
      `⚠️ SmartRemit ops: a rail message could not be recorded before sending (transfer ${ID}, outbox #${st.id}, settlement.instruct, ` +
        `attempt 1 of ${INSTRUCT_MAX_ATTEMPTS}), so it was NOT sent. ` +
        'It retries under its outbox policy (a dead row also raises dead:<id>); nothing is sent without its record. ' +
        'Check the database (rail_messages). Further failures this hour are coalesced into this alert.',
    );
    // Past the default ceiling (8) it still retries: the instruct policy.
    expect((await drainAt(9)).dead).toBe(0);
    expect((await rowState()).status).toBe('failed');
    // At the instruct ceiling: dead, with dead:<id>; the railrecord alert stays the one per hour.
    expect((await drainAt(INSTRUCT_MAX_ATTEMPTS)).dead).toBe(1);
    expect((await rowState()).status).toBe('dead');
    const k = await keys();
    expect(k.filter((x) => x === `dead:${st.id}`)).toHaveLength(1);
    expect(k.filter((x) => x.startsWith('railrecord:'))).toHaveLength(1);
    expect(k.some((x) => x.startsWith('railfail:'))).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();

    // A dead outcome in a NEW hour raises the railrecord alert of that hour too.
    vi.setSystemTime(Date.now() + H);
    await outbox.retryDead(st.id);
    await drainAt(INSTRUCT_MAX_ATTEMPTS);
    expect((await keys()).filter((x) => x.startsWith('railrecord:'))).toHaveLength(2);
  });
});

describe('instruct dispositions: InstructPermanentError (terminal)', { retry: 0 }, () => {
  // markFailed is passed the instruct ceiling (56), which makes the status dead;
  // the attempts column keeps the attempts actually spent (1).
  it("compliance_block -> dead at attempt 1 (markFailed at the ceiling), ONE dead:<id> alert naming the code; ops retryDead dies again under the same key", async () => {
    seam.blockErr = new InstructPermanentError(ID, 'compliance_block');
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ dead: 1, failed: 0 });
    const st = await rowState();
    expect(st).toMatchObject({ status: 'dead', attempts: 1, last_error: `instruct_permanent:compliance_block:${ID}` });
    expect(fetchFn).not.toHaveBeenCalled();
    const a = await alerts();
    expect(a.map((x) => x.k)).toEqual([`dead:${st.id}`]);
    expect(a[0].m).toContain('DEAD (terminal: the settlement instruction cannot be built (compliance_block); nothing was sent.');
    expect(a[0].m).toContain(`instruct_permanent:compliance_block:${ID}`);
    expect(a[0].m).not.toContain('railfail');

    await outbox.retryDead(st.id);
    expect((await rowState()).status).toBe('pending');
    const again = await drainOnce(deps(), 'w1');
    expect(again.dead).toBe(1);
    expect((await rowState()).status).toBe('dead');
    expect((await keys()).filter((k) => k.startsWith('dead:'))).toEqual([`dead:${st.id}`]);
  });
});

describe('instruct dispositions: G1 the FOR UPDATE decrypt read', { retry: 0 }, () => {
  it('a decrypt failure -> dead at once as InstructPermanentError(decrypt); no fetch; the log names the transfer and the error NAME only', async () => {
    await db.execute(sql`UPDATE transfers SET payout_destination_enc = 'v2.k0.not-a-blob' WHERE id = ${ID}`);
    // Confirm the decrypt throws before relying on it.
    await expect(
      db.transaction((tx) => createTransferRepo(tx).getTransferForUpdate(ID, { decrypt: true })),
    ).rejects.toBeInstanceOf(TransferDecryptError);
    logs.warn = [];
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    const st = await rowState();
    expect(st).toMatchObject({ status: 'dead', attempts: 1, last_error: `instruct_permanent:decrypt:${ID}` });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await keys()).toEqual([`dead:${st.id}`]);
    const line = logs.warn.find((l) => l[0] === 'outbox.instruct-read');
    expect(line).toEqual(['outbox.instruct-read', 'TransferDecryptError', { transferId: ID }]);
    expect(JSON.stringify(logs.warn)).not.toContain('not-a-blob');
  });

  it('a transient read failure (a driver-shaped error) stays a charged retry', async () => {
    seam.readErr = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
    });
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ failed: 1, dead: 0 });
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await keys()).some((k) => k.startsWith('dead:'))).toBe(false);
  });

  it('a pool connect timeout from the transaction seam stays a charged retry (never dead-letters a demo payout)', async () => {
    let once = true;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (...a: Parameters<Db['transaction']>) => {
            if (once) {
              once = false;
              return Promise.reject(new Error('timeout exceeded when trying to connect'));
            }
            return target.transaction(...a);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await enqueueInstruct();
    const r = await drainOnce(deps(flaky), 'w1');
    expect(r).toMatchObject({ failed: 1, dead: 0 });
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await keys()).some((k) => k.startsWith('dead:'))).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a key-ring misconfiguration (cause names unknown key id) is a charged retry, not terminal', async () => {
    seam.readErr = new TransferDecryptError(ID, { cause: new Error('field-crypto: unknown key id') });
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ failed: 1, dead: 0 });
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1, last_error: `transfer_decrypt_failed:${ID}` });
    expect((await keys()).some((k) => k.startsWith('dead:'))).toBe(false);
  });
});

describe('instruct dispositions: the builder (G15, builder half)', { retry: 0 }, () => {
  it("a consumer row with fundingMethod 'ach_pull' -> dead at once, instruct_permanent:build, no fetch, no railfail", async () => {
    await db.execute(sql`DELETE FROM transfers WHERE id = ${ID}`);
    await store.saveTransfer(transferFixture({ fundingMethod: 'ach_pull' } as Partial<Transfer>));
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'dead', last_error: `instruct_permanent:build:${ID}` });
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await keys()).some((k) => k.startsWith('railfail:'))).toBe(false);
    expect(logs.warn.find((l) => l[0] === 'outbox.instruct-build')).toEqual([
      'outbox.instruct-build',
      `settlement_funding_invalid:${ID}`,
      { transferId: ID },
    ]);
  });

  it('a masked payout destination -> the same', async () => {
    await db.execute(sql`DELETE FROM transfers WHERE id = ${ID}`);
    await store.saveTransfer(transferFixture({ payoutDestination: '' }));
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'dead', last_error: `instruct_permanent:build:${ID}` });
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await keys()).some((k) => k.startsWith('railfail:'))).toBe(false);
  });
});

describe('instruct dispositions: RailInstructError keeps the railfail path', { retry: 0 }, () => {
  it('fetch 503 at attempt 3 -> one railfail:<rail>:<hour>, no instructblock, no railrecord', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fetchFn.mockResolvedValue(new Response('down', { status: 503 }));
    await enqueueInstruct();
    await drainAt(3);
    const k = await keys();
    expect(k).toEqual([`railfail:acme:${Math.floor(Date.now() / H)}`]);
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 3 });
  });
});
