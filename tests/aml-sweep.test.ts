import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { fakeAmlRedis, type FakeAmlRedis } from './helpers-aml-redis';
// A switch that makes the outbox enqueue throw for one transfer id — the
// "a DB error on one row" case (the real repo otherwise).
const failBox = vi.hoisted(() => ({ failFor: null as string | null }));
vi.mock('@/db/repos/outbox-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/outbox-repo')>();
  return {
    ...real,
    createOutboxRepo: (dbx: Parameters<typeof real.createOutboxRepo>[0]) => {
      const r = real.createOutboxRepo(dbx);
      return {
        ...r,
        enqueue: async (...args: Parameters<typeof r.enqueue>) => {
          const payload = args[1] as { message?: string };
          if (failBox.failFor && String(payload.message ?? '').endsWith(failBox.failFor)) throw new Error('db down');
          return r.enqueue(...args);
        },
      };
    },
  };
});

// A switch that makes the partner lookup throw for one partner id.
const partnerFail = vi.hoisted(() => ({ id: null as string | null }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (dbx: Parameters<typeof real.createPartnerRepo>[0]) => {
      const r = real.createPartnerRepo(dbx);
      return {
        ...r,
        getPartner: async (id: string) => {
          if (partnerFail.id === id) throw new Error('partner lookup failed');
          return r.getPartner(id);
        },
      };
    },
  };
});

import { amlSweep, AML_CURSOR_KEY, AML_LOCK_KEY } from '@/lib/aml-sweep';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { settleOrHold } from '@/lib/settlement';
import { newTransferId } from '@/lib/id';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

// Program-Fix 43 (PR A): the behavioural AML sweep. PGlite ledger + an
// in-memory Upstash stand-in. Alerts and review items ONLY: a hit never changes
// a transfer (the no-hold pin at the bottom), and every alert is idempotent by
// construction (outbox dedupe key + audit row only when the enqueue was new).

const MIN = 60_000;
const DAY = 86_400_000;
const DEST_A = '000011112222|HDFC0000001';
const DEST_B = '999988887777|ICIC0000002';

let db: Db;
let redis: FakeAmlRedis;
let now: Date;

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p2');
  redis = fakeAmlRedis();
  now = new Date();
  failBox.failFor = null;
  partnerFail.id = null;
});

async function seed(input: {
  phone: string;
  amountUsd: number;
  agoMs: number;
  dest?: string;
  partnerId?: string;
  status?: Transfer['status'];
  id?: string;
}): Promise<string> {
  const id = input.id ?? newTransferId();
  const status = input.status ?? 'awaiting_payment';
  await createTransferRepo(db).saveTransfer({
    id,
    phone: input.phone,
    amountUsd: input.amountUsd, feeUsd: 0, totalChargeUsd: input.amountUsd,
    fxRate: 85, amountInr: input.amountUsd * 85,
    recipientName: 'Seeded Recipient', recipientPhone: '919000000000',
    payoutMethod: 'bank', payoutDestination: input.dest ?? DEST_A,
    fundingMethod: 'bank_transfer',
    complianceStatus: status === 'blocked' ? 'blocked' : 'cleared',
    complianceReasons: [],
    status,
    createdAt: new Date(now.getTime() - input.agoMs).toISOString(),
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    partnerId: input.partnerId ?? 'default',
    amountSource: input.amountUsd, feeSource: 0, totalChargeSource: input.amountUsd,
  });
  return id;
}

type OutboxRow = { kind: string; dedupe_key: string; payload: { message: string } };
async function alerts(prefix = 'aml:'): Promise<OutboxRow[]> {
  const r = await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox WHERE dedupe_key LIKE ${prefix + '%'} ORDER BY id`);
  return r.rows as OutboxRow[];
}
type AuditRow = { partner_id: string; actor_type: string; subject_id: string; meta: Record<string, unknown> };
async function amlAudits(rule?: string): Promise<AuditRow[]> {
  const r = await db.execute(sql`SELECT partner_id, actor_type, subject_id, meta FROM audit_events WHERE action = 'aml.alert' ORDER BY id`);
  return (r.rows as AuditRow[]).filter((a) => !rule || a.meta.rule === rule);
}

const sweep = (at: Date = now, opts: Parameters<typeof amlSweep>[2] = {}) => amlSweep(db, redis, { now: at, ...opts });

describe('amlSweep — structuring', () => {
  it('four in-band sends raise exactly one structuring alert and one audit row; a re-scan raises nothing', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seed({ phone: '15550000001', amountUsd: 900, agoMs: (20 - i) * MIN }));

    const r1 = await sweep();
    expect(r1).toMatchObject({ scanned: 4, skipped: null });

    const s = await alerts('aml:structuring:');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: 'ops.alert', dedupe_key: `aml:structuring:${ids[2]}` });
    // The payload is the message only: ids, no phone / name / destination.
    expect(s[0].payload).toEqual({ message: `AML structuring on ${ids[2]}` });
    const a = await amlAudits('structuring');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ partner_id: 'default', actor_type: 'system', subject_id: ids[2] });
    expect(a[0].meta).toMatchObject({ rule: 'structuring', window: '7d', count: 3 });

    // A lost cursor re-scans the same rows: nothing new anywhere.
    const before = { outbox: (await alerts()).length, audit: (await amlAudits()).length };
    redis.strings.delete(AML_CURSOR_KEY);
    await sweep();
    expect((await alerts()).length).toBe(before.outbox);
    expect((await amlAudits()).length).toBe(before.audit);
  });

  it('sends at the large-amount threshold are not structuring (the existing flag owns them)', async () => {
    for (let i = 0; i < 4; i++) await seed({ phone: '15550000002', amountUsd: 1000, agoMs: (20 - i) * MIN });
    await sweep();
    expect(await alerts('aml:structuring:')).toEqual([]);
  });

  it('the no-hold pin: after alerts the transfer stays cleared + awaiting_payment, and paying it goes straight to paid', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seed({ phone: '15550000003', amountUsd: 900, agoMs: (20 - i) * MIN }));
    await sweep();
    expect(await alerts('aml:structuring:')).toHaveLength(1);
    const repo = createTransferRepo(db);
    const t = (await repo.getTransfer(ids[2]))!;
    expect(t.status).toBe('awaiting_payment');
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
    const MOCK: PartnerIntegrations = { kyc: {}, payment: {}, whatsapp: {} };
    const res = await settleOrHold(db, t, MOCK);
    expect(res.kind).not.toBe('held');
    expect((await repo.getTransfer(ids[2]))!.status).toBe('paid');
  });
});

describe('amlSweep — first transfer / new beneficiary', () => {
  it("a sender's first-ever send >= $500 alerts once", async () => {
    const id = await seed({ phone: '15550000004', amountUsd: 600, agoMs: 10 * MIN });
    await seed({ phone: '15550000004', amountUsd: 600, agoMs: 9 * MIN }); // same destination, not first
    await sweep();
    const f = await alerts('aml:first_transfer:');
    expect(f.map((r) => r.dedupe_key)).toEqual([`aml:first_transfer:${id}`]);
    expect(await alerts('aml:new_beneficiary:')).toEqual([]);
  });

  it('a pre-existing sender with no Redis set is SEEDED silently; a later new destination alerts', async () => {
    // History older than the 24 h look-back: never scanned, so the set does not exist.
    await seed({ phone: '15550000005', amountUsd: 100, agoMs: 3 * DAY, dest: DEST_A });
    const seeded = await seed({ phone: '15550000005', amountUsd: 700, agoMs: 30 * MIN, dest: DEST_B });
    await sweep();
    expect(await alerts('aml:new_beneficiary:')).toEqual([]);
    expect(await alerts(`aml:first_transfer:${seeded}`)).toEqual([]);

    const again = await seed({ phone: '15550000005', amountUsd: 700, agoMs: 20 * MIN, dest: DEST_B }); // known now
    const fresh = await seed({ phone: '15550000005', amountUsd: 700, agoMs: 10 * MIN, dest: '1234|SBIN0000003' });
    await sweep();
    const nb = await alerts('aml:new_beneficiary:');
    expect(nb.map((r) => r.dedupe_key)).toEqual([`aml:new_beneficiary:${fresh}`]);
    expect(nb.some((r) => r.dedupe_key.endsWith(again))).toBe(false);
  });
});

describe('amlSweep — beneficiary clustering', () => {
  it('three distinct senders to one destination raise exactly one cluster alert (monthly dedupe)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seed({ phone: `1555100000${i}`, amountUsd: 50, agoMs: (20 - i) * MIN, dest: DEST_A }));
    await sweep();
    const c = await alerts('aml:cluster:');
    expect(c).toHaveLength(1);
    expect(c[0].dedupe_key).toMatch(/^aml:cluster:default:[0-9a-f]{64}:\d{4}-\d{2}$/);
    expect(c[0].payload).toEqual({ message: `AML cluster on ${ids[2]}` });
    expect(await amlAudits('cluster')).toHaveLength(1);
  });

  it('a sender older than 30 days is not counted', async () => {
    await seed({ phone: '15552000001', amountUsd: 50, agoMs: 40 * DAY, dest: DEST_A });
    await seed({ phone: '15552000002', amountUsd: 50, agoMs: 20 * MIN, dest: DEST_A });
    await seed({ phone: '15552000003', amountUsd: 50, agoMs: 19 * MIN, dest: DEST_A });
    // Start the cursor before the old row so the sweep sees all three.
    redis.strings.set(AML_CURSOR_KEY, `${new Date(now.getTime() - 41 * DAY).toISOString()}|`);
    await sweep();
    expect(await alerts('aml:cluster:')).toEqual([]);
  });

  it('clusters are per partner (no cross-tenant key)', async () => {
    await seed({ phone: '15553000001', amountUsd: 50, agoMs: 20 * MIN, dest: DEST_A });
    await seed({ phone: '15553000002', amountUsd: 50, agoMs: 19 * MIN, dest: DEST_A });
    await seed({ phone: '15553000003', amountUsd: 50, agoMs: 18 * MIN, dest: DEST_A, partnerId: 'p2' });
    await sweep();
    expect(await alerts('aml:cluster:')).toEqual([]);
  });

  it('the destination ZSET is capped at 2x the threshold and carries a TTL', async () => {
    for (let i = 0; i < 9; i++) await seed({ phone: `1555400000${i}`, amountUsd: 50, agoMs: (30 - i) * MIN, dest: DEST_A });
    await sweep();
    const [key, z] = [...redis.zsets].find(([k]) => k.startsWith('aml:dst:default:'))!;
    expect(z.size).toBeLessThanOrEqual(6);
    expect(redis.ttls.get(key)).toBe(31 * 86_400);
  });
});

describe('amlSweep — lock, cursor and commit lag', () => {
  it('two concurrent sweeps: one runs, the other skips on the lock; the lock is released after', async () => {
    await seed({ phone: '15555000001', amountUsd: 600, agoMs: 10 * MIN });
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect([a.skipped, b.skipped].sort()).toEqual(['locked', null].sort());
    expect(await alerts('aml:first_transfer:')).toHaveLength(1);
    expect(redis.strings.has(AML_LOCK_KEY)).toBe(false);
  });

  it("a lock held by someone else is never released by this sweep", async () => {
    redis.strings.set(AML_LOCK_KEY, 'someone-else');
    expect((await sweep()).skipped).toBe('locked');
    expect(redis.strings.get(AML_LOCK_KEY)).toBe('someone-else');
  });

  it('a row inside the 2-minute commit-lag window is not scanned now, and is caught on the next poke', async () => {
    await seed({ phone: '15556000001', amountUsd: 50, agoMs: 10 * MIN });
    const late = await seed({ phone: '15556000002', amountUsd: 600, agoMs: MIN });
    expect((await sweep()).scanned).toBe(1);
    expect(await alerts(`aml:first_transfer:${late}`)).toEqual([]);
    const r = await sweep(new Date(now.getTime() + 3 * MIN));
    expect(r.scanned).toBe(1);
    expect(await alerts(`aml:first_transfer:${late}`)).toHaveLength(1);
  });

  it('the cursor is forward-only', async () => {
    await seed({ phone: '15557000001', amountUsd: 50, agoMs: 10 * MIN });
    const ahead = `${new Date(now.getTime() - MIN).toISOString()}|zzz`;
    redis.strings.set(AML_CURSOR_KEY, ahead);
    await sweep();
    expect(redis.strings.get(AML_CURSOR_KEY)).toBe(ahead);
  });

  it('blocked rows are skipped (the sanctions path owns them)', async () => {
    await seed({ phone: '15558000001', amountUsd: 900, agoMs: 10 * MIN, status: 'blocked' });
    await sweep();
    expect(await alerts()).toEqual([]);
  });

  it('a spent time budget stops the batch and the cursor advances only past completed rows', async () => {
    for (let i = 0; i < 3; i++) await seed({ phone: `1555900000${i}`, amountUsd: 600, agoMs: (20 - i) * MIN });
    const r = await sweep(now, { budgetMs: 0 });
    expect(r.scanned).toBe(0);
    expect(await alerts()).toEqual([]);
    expect((await sweep()).scanned).toBe(3);
  });
});

describe('amlSweep — Redis outage and PII', () => {
  it('Redis down: ledger rules still run, clustering is skipped, nothing throws', async () => {
    redis.down = true;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seed({ phone: `1555600000${i % 1}`, amountUsd: 900, agoMs: (20 - i) * MIN, dest: DEST_A }));
    for (let i = 0; i < 3; i++) await seed({ phone: `1555700000${i}`, amountUsd: 50, agoMs: (15 - i) * MIN, dest: DEST_B });
    const r = await sweep();
    expect(r.redis).toBe('down');
    expect(await alerts('aml:structuring:')).toHaveLength(1);
    expect(await alerts('aml:cluster:')).toEqual([]);
    // The first Redis failure marks it down for the rest of the sweep: no call per row.
    expect(redis.calls).toBeLessThanOrEqual(2);
  });

  it('no phone or destination plaintext reaches Redis keys, values or alert payloads', async () => {
    for (let i = 0; i < 3; i++) await seed({ phone: `1555800000${i}`, amountUsd: 900, agoMs: (20 - i) * MIN, dest: DEST_A });
    await sweep();
    const blobs = [
      ...redis.strings.keys(), ...redis.strings.values(),
      ...redis.sets.keys(), ...[...redis.sets.values()].flatMap((s) => [...s]),
      ...redis.zsets.keys(), ...[...redis.zsets.values()].flatMap((z) => [...z.keys()]),
      ...(await alerts()).map((a) => JSON.stringify(a)),
    ].join('\n');
    expect(blobs).not.toMatch(/15558000/);
    expect(blobs).not.toContain('000011112222');
    expect(blobs).not.toContain('HDFC');
  });
});

describe('amlSweep — resilience (review follow-ups)', () => {
  it("the per-sender destination set's TTL slides on every visit, not only on a new destination", async () => {
    await seed({ phone: '15551110001', amountUsd: 50, agoMs: 20 * MIN, dest: DEST_A });
    await sweep();
    const sdKey = [...redis.sets.keys()].find((k) => k.startsWith('aml:sd:default:'))!;
    expect(redis.ttls.get(sdKey)).toBe(90 * 86_400);
    redis.ttls.delete(sdKey);
    await seed({ phone: '15551110001', amountUsd: 50, agoMs: 10 * MIN, dest: DEST_A }); // known destination
    await sweep();
    expect(redis.ttls.get(sdKey)).toBe(90 * 86_400);
  });

  it('a row that throws stops the batch but keeps progress: the cursor covers the completed rows, and the next poke resumes', async () => {
    const a = await seed({ phone: '15551120001', amountUsd: 600, agoMs: 20 * MIN });
    const b = await seed({ phone: '15551120002', amountUsd: 600, agoMs: 19 * MIN });
    const c = await seed({ phone: '15551120003', amountUsd: 600, agoMs: 18 * MIN });
    failBox.failFor = b;
    const r1 = await sweep();
    expect(r1.scanned).toBe(1);
    expect(redis.strings.get(AML_CURSOR_KEY)).toMatch(new RegExp(`\\|${a}$`));
    expect(redis.strings.has(AML_LOCK_KEY)).toBe(false);
    failBox.failFor = null;
    const r2 = await sweep();
    expect(r2.scanned).toBe(2);
    expect((await alerts('aml:first_transfer:')).map((r) => r.dedupe_key)).toEqual(
      [a, b, c].map((id) => `aml:first_transfer:${id}`),
    );
  });
});

describe('amlSweep — coordinator review follow-ups', () => {
  it('a throwing partner lookup stops the batch like any row failure: the cursor covers completed rows, the lock is released', async () => {
    const a = await seed({ phone: '15551130001', amountUsd: 600, agoMs: 20 * MIN });
    await seed({ phone: '15551130002', amountUsd: 600, agoMs: 19 * MIN, partnerId: 'p2' });
    partnerFail.id = 'p2';
    const r = await sweep();
    expect(r.scanned).toBe(1);
    expect(redis.strings.get(AML_CURSOR_KEY)).toMatch(new RegExp(`\\|${a}$`));
    expect(redis.strings.has(AML_LOCK_KEY)).toBe(false);
    partnerFail.id = null;
    expect((await sweep()).scanned).toBe(1);
  });

  it('cancelled rows are skipped (no alert), but the cursor moves past them', async () => {
    const c = await seed({ phone: '15551140001', amountUsd: 600, agoMs: 20 * MIN, status: 'cancelled' });
    const r = await sweep();
    expect(r.scanned).toBe(1);
    expect(await alerts()).toEqual([]);
    expect(await amlAudits()).toEqual([]);
    expect(redis.strings.get(AML_CURSOR_KEY)).toMatch(new RegExp(`\\|${c}$`));
  });
});
