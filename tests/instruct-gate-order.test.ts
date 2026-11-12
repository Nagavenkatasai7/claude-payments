import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import { certifyPartnerForTest, seedOriginatorForTest } from './helpers-live';
import { seedLiveEvidence } from './helpers-sanctions';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { drainOnce, INSTRUCT_NOT_CERTIFIED_DEFER_SEC, type WorkerDeps } from '@/lib/outbox-worker';
import { invalidateFlagCache, SETTLEMENT_PAUSED_DEFER_SEC } from '@/lib/flags';
import { resetFlagReadAlertMemoForTests } from '@/lib/flag-read-alert';
import { INSTRUCT_GATE_ORDER } from '@/lib/instruct-gates';
import { INSTRUCT_TRAVEL_RULE_DEFER_SEC } from '@/lib/instruct-errors';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { railMessages } from '@/db/schema';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T6 (P8): the settlement.instruct handler is one fixed, named list
// of steps. The constant, the handler's `// gate: <id>` markers and the spec
// paragraph (tests/sanctions-spec-truth.test.ts) are the same list, and a row
// that fails two adjacent steps gets the EARLIER step's outcome.

// Seams: the switch-table read (Q5 unknown) and the rail integrations read.
const seam = vi.hoisted(() => ({ flagReadThrows: false, integrationsThrows: false, integrationsCalls: 0 }));
vi.mock('@/db/repos/feature-flag-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/feature-flag-repo')>();
  return {
    ...real,
    createFeatureFlagRepo: (d: Parameters<typeof real.createFeatureFlagRepo>[0]) => {
      const repo = real.createFeatureFlagRepo(d);
      return {
        ...repo,
        listEnabled: async () => {
          if (seam.flagReadThrows) throw new Error('neon down');
          return repo.listEnabled();
        },
      };
    },
  };
});
vi.mock('@/db/repos/integrations-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...a: Parameters<typeof real.createIntegrationsRepo>) => {
      const repo = real.createIntegrationsRepo(...a);
      return {
        ...repo,
        getIntegrations: async (...g: Parameters<typeof repo.getIntegrations>) => {
          seam.integrationsCalls += 1;
          if (seam.integrationsThrows) throw new Error('integrations read failed');
          return repo.getIntegrations(...g);
        },
      };
    },
  };
});

const SRC = join(process.cwd(), 'src');
const WORKER = join(SRC, 'lib', 'outbox-worker.ts');
const MARKER = /\/\/ gate: ([a-z_]+)/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
function handlerSlice(): string {
  const src = readFileSync(WORKER, 'utf8');
  const start = src.indexOf("case 'settlement.instruct': {");
  const end = src.indexOf("case 'rail.callback':");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}


/**
 * The real db, except that every insert into rail_messages throws (a NeonDbError).
 * Truth check F10 (F1): the gate `record` writes inside a transaction, so the
 * transaction handle is wrapped the same way.
 */
function railRecordDown<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => {
          if (table === railMessages) throw Object.assign(new Error('x'), { name: 'NeonDbError' });
          return (t as unknown as Db).insert(table as never);
        };
      }
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
          (t as unknown as { transaction: (f: (tx: object) => unknown, ...r: unknown[]) => unknown }).transaction((tx) => fn(railRecordDown(tx)), ...rest);
      }
      const v = Reflect.get(t, prop, receiver);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

describe('INSTRUCT_GATE_ORDER (P8)', () => {
  it('is frozen, unique and exactly the P8 list', () => {
    expect(Object.isFrozen(INSTRUCT_GATE_ORDER)).toBe(true);
    expect(new Set(INSTRUCT_GATE_ORDER).size).toBe(INSTRUCT_GATE_ORDER.length);
    expect([...INSTRUCT_GATE_ORDER]).toEqual([
      'read', 'sandbox', 'not_payable', 'not_paid', 'funding_state', 'railamount', 'paused', 'integrations',
      'pause_unknown', 'live_cert', 'rail_config', 'live_list', 'sender_hold', 'funding_mode', 'build',
      'travel_rule', 'record', 'send', 'provider_ref',
    ]);
  });

  it('the settlement.instruct handler carries one // gate: <id> marker per id, in that order', () => {
    const ids = [...handlerSlice().matchAll(MARKER)].map((m) => m[1]);
    expect(ids).toEqual([...INSTRUCT_GATE_ORDER]);
  });

  it('no // gate: marker anywhere else in src', () => {
    const slice = handlerSlice();
    const hits = walk(SRC).flatMap((f) => {
      let text = readFileSync(f, 'utf8');
      if (f === WORKER) text = text.replace(slice, '');
      return [...text.matchAll(MARKER)].map((m) => `${relative(SRC, f)}: ${m[1]}`);
    });
    expect(hits).toEqual([]);
  });
});

// ── Adjacent pairs: a row failing both steps gets the earlier outcome ────────

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const ID = 'go_t1';
const STORED = 'https://rail.example/settle';
const DAY = 86_400_000;

function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    // createdAt = now, so listScreenEvidence's window holds the seeded evidence.
    createdAt: new Date().toISOString(), paidAt: new Date().toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

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

async function saveRail(providerType: 'http' | 'simulator', url: string | null = STORED) {
  const credentials: Record<string, string> = url === null ? { signingSecret: 'sgn' } : { settlementUrl: url, signingSecret: 'sgn' };
  await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
    kyc: {},
    payment: { providerType, credentials, webhookSecret: 'whk' },
    whatsapp: {},
  } as Parameters<ReturnType<typeof createIntegrationsRepo>['saveIntegrations']>[1]);
}

type RowState = { status: string; attempts: number; last_error: string | null; backoff_s: number };
async function rowState(): Promise<RowState> {
  const r = (await db.execute(sql`
    SELECT status, attempts, last_error,
           round(extract(epoch FROM (next_attempt_at - now())))::int AS backoff_s
    FROM outbox WHERE dedupe_key = ${`instruct:${ID}`}`)) as unknown as { rows: RowState[] };
  return r.rows[0];
}
async function alertKeys(): Promise<string[]> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ k: string }>;
  };
  return r.rows.map((x) => x.k);
}
const hasPrefix = async (prefix: string) => (await alertKeys()).some((k) => k.startsWith(prefix));
const enqueueInstruct = () => outbox.enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });
async function pauseGlobal() {
  await createFeatureFlagRepo(db).upsert({ key: 'settlement.paused', scopeType: 'global', scopeId: '', enabled: true, reason: 'rail incident', updatedBy: 'admin' });
  invalidateFlagCache(db);
}
function expectDeferred(st: RowState, seconds: number) {
  expect(st).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  expect(st.backoff_s).toBeGreaterThanOrEqual(seconds - 5);
  expect(st.backoff_s).toBeLessThanOrEqual(seconds + 5);
}

beforeEach(async () => {
  seam.flagReadThrows = false;
  seam.integrationsThrows = false;
  seam.integrationsCalls = 0;
  resetFlagReadAlertMemoForTests();
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  // Fix pack 5 T20a (P0 rule 9): the sender's travel-rule data on file, ahead of the T20b/T23 gates.
  await seedOriginatorForTest(db, 'acme', '15551230000', { address: true, dob: true });
  fetchFn.mockReset();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
});
afterEach(() => invalidateFlagCache(db));

describe('adjacent pairs: a row that fails both steps gets the earlier outcome', { retry: 0 }, () => {
  it('read + sandbox: a sandbox row with a corrupt sealed destination -> dead at once (G1), no sandboxinstruct:', async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture({ environment: 'test' } as Partial<Transfer>));
    await db.execute(sql`UPDATE transfers SET payout_destination_enc = 'v2.k0.not-a-blob' WHERE id = ${ID}`);
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).dead).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'dead', last_error: `instruct_permanent:decrypt:${ID}` });
    expect(await hasPrefix('sandboxinstruct:')).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sandbox + not_payable: a cancelled sandbox row -> done + sandboxinstruct:<id>', async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture({ environment: 'test', status: 'cancelled' } as Partial<Transfer>));
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect((await rowState()).status).toBe('done');
    expect(await alertKeys()).toEqual([`sandboxinstruct:${ID}`]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("not_payable + not_paid: cancelled with refund 'requested' -> done, no retry", async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture({ status: 'cancelled' }));
    await db.execute(sql`UPDATE transfers SET refund_status = 'requested' WHERE id = ${ID}`);
    await enqueueInstruct();
    expect(await drainOnce(deps(), 'w1')).toMatchObject({ processed: 1, failed: 0 });
    expect(await rowState()).toMatchObject({ status: 'done', last_error: null });
    expect(await alertKeys()).toEqual([]);
  });

  it("not_paid + funding_state: awaiting_payment with funding 'returned' -> charged retry, no instructreturned:", async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture({ status: 'awaiting_payment', paidAt: undefined }));
    await db.execute(sql`UPDATE transfers SET funding_state = 'returned' WHERE id = ${ID}`);
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    const st = await rowState();
    expect(st).toMatchObject({ status: 'failed', attempts: 1 });
    expect(st.last_error).toContain('Settlement instruction held: transfer is awaiting_payment');
    expect(await hasPrefix('instructreturned:')).toBe(false);
  });

  it('funding_state + railamount: returned and a railamount:<id> marker -> done + instructreturned:<id>', async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture());
    await db.execute(sql`UPDATE transfers SET funding_state = 'returned' WHERE id = ${ID}`);
    await outbox.enqueue('ops.alert', { message: 'amount mismatch' }, { dedupeKey: `railamount:${ID}` });
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).processed).toBeGreaterThanOrEqual(1);
    expect((await rowState()).status).toBe('done');
    expect(await alertKeys()).toEqual([`railamount:${ID}`, `instructreturned:${ID}`]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('railamount + paused: a railamount marker and a global pause -> done (not deferred)', async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture());
    await db.execute(sql`INSERT INTO outbox (kind, payload, dedupe_key, status) VALUES ('ops.alert', '{}'::jsonb, ${`railamount:${ID}`}, 'done')`);
    await pauseGlobal();
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'done', attempts: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('paused + integrations: a global pause and a failing integrations read -> deferred 300 s; the integrations read never ran', async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture());
    await pauseGlobal();
    seam.integrationsThrows = true;
    seam.integrationsCalls = 0;
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).released).toBe(1);
    expectDeferred(await rowState(), SETTLEMENT_PAUSED_DEFER_SEC);
    expect(seam.integrationsCalls).toBe(0);
  });

  // integrations + pause_unknown: no case. The unknown rule needs the
  // integrations read (realMoney comes from the rail type it returns).

  it('pause_unknown + live_cert: an unreadable switch on an uncertified http rail -> deferred 300 s, no livegate:', async () => {
    await saveRail('http');
    await store.saveTransfer(transferFixture());
    await enqueueInstruct();
    seam.flagReadThrows = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await drainOnce(deps(), 'w1')).released).toBe(1);
    expectDeferred(await rowState(), SETTLEMENT_PAUSED_DEFER_SEC);
    expect(await hasPrefix('livegate:')).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('live_cert + rail_config: an uncertified http rail with no URL -> deferred 900 s, no railfail:', async () => {
    await saveRail('http', null);
    await store.saveTransfer(transferFixture());
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).released).toBe(1);
    expect(INSTRUCT_NOT_CERTIFIED_DEFER_SEC).toBe(900);
    expectDeferred(await rowState(), INSTRUCT_NOT_CERTIFIED_DEFER_SEC);
    expect(await alertKeys()).toEqual([`livegate:${ID}`]);
  });

  it('rail_config + live_list: a certified http rail with no URL and stale live evidence -> RailInstructError, no instructnotlive:', async () => {
    await saveRail('http', null);
    await certifyPartnerForTest(db, 'acme');
    const t = transferFixture();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t, { listFitness: 'live', screenedAgoMs: 3 * DAY });
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'Settlement endpoint not configured.' });
    expect(await hasPrefix('instructnotlive:')).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('live_list + sender_hold: stale evidence and an active sender hold -> instructnotlive:<id> only', async () => {
    await saveRail('http');
    await certifyPartnerForTest(db, 'acme');
    const t = transferFixture();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t, { listFitness: 'live', screenedAgoMs: 3 * DAY });
    await seedSender(db, { partnerId: 'acme', phone: '15551230000' });
    await db.execute(sql`UPDATE customers SET screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = '15551230000'`);
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'failed', last_error: 'Last screen older than the list age limit.' });
    expect(await alertKeys()).toEqual([`instructnotlive:${ID}`]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('build + send: a masked destination and a rail that would 503 -> dead at once, fetch never called', async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture({ payoutDestination: '****9012' }));
    fetchFn.mockResolvedValue(new Response('down', { status: 503 }));
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).dead).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'dead', attempts: 1, last_error: `instruct_permanent:build:${ID}` });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await hasPrefix('railfail:')).toBe(false);
  });

  it('sender_hold + funding_mode: an active sender hold and a mock-class row -> instructsenderhold:<id> only, InstructNotLiveError', async () => {
    await saveRail('http');
    await certifyPartnerForTest(db, 'acme');
    const t = transferFixture({ fundingRef: `mockfund-${ID}` });
    await store.saveTransfer(t);
    await db.execute(sql`UPDATE transfers SET funding_provider = 'mock' WHERE id = ${ID}`);
    await seedLiveEvidence(db, t, { listFitness: 'live' });
    await seedSender(db, { partnerId: 'acme', phone: '15551230000' });
    await db.execute(sql`UPDATE customers SET screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = '15551230000'`);
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'Sender under an active screening hold.' });
    expect(await alertKeys()).toEqual([`instructsenderhold:${ID}`]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('funding_mode + build: a mock-class row with a destination the builder rejects -> done + mockfund:<id>, not dead', async () => {
    await saveRail('http');
    await certifyPartnerForTest(db, 'acme');
    const t = transferFixture({ payoutDestination: '****9012', fundingRef: `mockfund-${ID}` });
    await store.saveTransfer(t);
    await db.execute(sql`UPDATE transfers SET funding_provider = 'mock' WHERE id = ${ID}`);
    await seedLiveEvidence(db, t, { listFitness: 'live' });
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 1, dead: 0, failed: 0 });
    expect(await rowState()).toMatchObject({ status: 'done', last_error: null });
    expect(await alertKeys()).toEqual([`mockfund:${ID}`]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('build + travel_rule: a masked destination and no address on file -> dead at once (build), no travelrule:', async () => {
    await saveRail('http');
    await certifyPartnerForTest(db, 'acme');
    const t = transferFixture({ payoutDestination: '****9012' });
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t, { listFitness: 'live' });
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = '15551230000'`);
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).dead).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'dead', attempts: 1, last_error: `instruct_permanent:build:${ID}` });
    expect(await hasPrefix('travelrule:')).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('travel_rule + record: no address on file and the record seam failing -> deferred 900 s, no rail_messages row, no railrecord:', async () => {
    await saveRail('http');
    await certifyPartnerForTest(db, 'acme');
    const t = transferFixture();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t, { listFitness: 'live' });
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = '15551230000'`);
    await enqueueInstruct();
    const recordDown = railRecordDown(db);
    await drainOnce({ ...deps(), db: recordDown }, 'w1');
    expectDeferred(await rowState(), INSTRUCT_TRAVEL_RULE_DEFER_SEC);
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM rail_messages`)) as unknown as { rows: Array<{ n: number }> };
    expect(n.rows[0].n).toBe(0);
    expect(await alertKeys()).toEqual([`travelrule:${ID}`]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('record + send: the record append fails AND the rail would 500 -> the record outcome (no fetch, RailRecordError, no railfail:)', async () => {
    await saveRail('simulator');
    await store.saveTransfer(transferFixture());
    fetchFn.mockResolvedValue(new Response('down', { status: 500 }));
    await enqueueInstruct();
    await db.execute(sql`UPDATE outbox SET attempts = 2 WHERE dedupe_key = ${`instruct:${ID}`}`); // attempt 3: where railfail: would fire
    const recordDown = railRecordDown(db);
    expect((await drainOnce({ ...deps(), db: recordDown }, 'w1')).failed).toBe(1);
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 3, last_error: `rail_record_failed:${ID}` });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await hasPrefix('railfail:')).toBe(false);
    expect(await hasPrefix('railrecord:')).toBe(true);
  });
});
